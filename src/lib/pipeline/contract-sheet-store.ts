/**
 * Contract Sheet Store — Pilot 4-1
 *
 * 03_data_model.md 4-2절: teaching_histories 저장
 * 04_data_pipeline.md 7-2절: teaching_histories는 계약시트 기준 생성
 * 04_data_pipeline.md 18-1: source-specific 식별자로 중복 판정
 *
 * Pilot 4-1 확정 사항 (BLOCKER 2, 3 결정):
 * - 계약시트-only 강사(instructors.name exact match 실패) → 최소 instructor 레코드 생성
 *   (name, display_name=name, 나머지 NULL/default)
 * - teaching_histories 중복 판정: source_ref 의 (spreadsheet_id, worksheet_gid, row_number) 조합
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { NormalizedContractRow } from "./contract-sheet-normalizer";
import { toDateOnlyString } from "@/lib/contract-sheet-parser";
import { COURSE_COUNT_SOURCE_TYPES } from "./teaching-history-sources";
import {
  countGroupedTeachingHistories,
} from "@/lib/teaching-history-display";
import { loadCourseIdFallbackRegistry } from "./course-id-fallback";
import { loadNotionCourseIdFallbackRegistry } from "./notion-course-id-fallback";

const PREFERRED_CONTRACT_WORKSHEET_GID = 158052384;
const INSTRUCTOR_LOOKUP_BATCH_SIZE = 200;
const INSTRUCTOR_CREATE_BATCH_SIZE = 200;
const MAX_NOTION_FALLBACK_PAGE_FETCHES = 12;

export interface WorksheetStoreResult {
  appended: number;
  updated: number;
  skipped: number; // 강사명 없음
  deduped: number; // source_ref 동일 행 이미 존재
  instructorsCreated: number; // 계약시트-only 최소 생성
  errors: Array<{ rowNumber: number; message: string }>;
  /** 이번 실행에서 영향을 받은 instructor PK 집합. 호출부가 집계 갱신에 사용한다. */
  instructorIdsAffected: Set<string>;
}

export interface ContractSheetStoreProgress {
  stage:
    | "prepare_instructors"
    | "prepare_course_fallbacks"
    | "prepare_existing_rows"
    | "plan_rows"
    | "apply_updates"
    | "apply_creates"
    | "cleanup_duplicates"
    | "done";
  processed?: number;
  total?: number;
  appended: number;
  updated: number;
  skipped: number;
  deduped: number;
  instructorsCreated: number;
  errors: number;
  deletedDuplicates?: number;
}

function emptyResult(): WorksheetStoreResult {
  return {
    appended: 0,
    updated: 0,
    skipped: 0,
    deduped: 0,
    instructorsCreated: 0,
    errors: [],
    instructorIdsAffected: new Set<string>(),
  };
}

function asDateOnly(value: Date | null | undefined): string | null {
  return value ? value.toISOString().split("T")[0] : null;
}

function asComparableHours(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  if (
    typeof value === "object" &&
    value !== null &&
    "toString" in value &&
    typeof value.toString === "function"
  ) {
    return value.toString();
  }
  return String(value);
}

function isRetryablePrismaError(error: unknown): boolean {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  return code === "P1001" || code === "P1002" || code === "P1017";
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withPrismaRetry<T>(
  fn: () => Promise<T>,
  retries = 3
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryablePrismaError(error) || attempt === retries) {
        throw error;
      }
      await prisma.$disconnect().catch(() => undefined);
      await sleep(attempt * 1_000);
    }
  }

  throw lastError;
}

function getWorksheetGid(sourceRef: unknown): number | null {
  if (!sourceRef || typeof sourceRef !== "object" || Array.isArray(sourceRef)) {
    return null;
  }

  const raw = (sourceRef as Record<string, unknown>).worksheet_gid;
  return typeof raw === "number" ? raw : null;
}

function getSpreadsheetId(sourceRef: unknown): string | null {
  if (!sourceRef || typeof sourceRef !== "object" || Array.isArray(sourceRef)) {
    return null;
  }

  const raw = (sourceRef as Record<string, unknown>).spreadsheet_id;
  return typeof raw === "string" ? raw : null;
}

function getRowNumber(sourceRef: unknown): number | null {
  if (!sourceRef || typeof sourceRef !== "object" || Array.isArray(sourceRef)) {
    return null;
  }

  const raw = (sourceRef as Record<string, unknown>).row_number;
  return typeof raw === "number" ? raw : null;
}

function buildSourceIdentity(input: {
  instructorDbId: string;
  spreadsheetId: string;
  worksheetGid: number;
  rowNumber: number;
}): string {
  return [
    input.instructorDbId,
    input.spreadsheetId,
    input.worksheetGid,
    input.rowNumber,
  ].join("::");
}

/**
 * Legacy contract_sheet rows (source_ref without worksheet_gid) use this
 * identity for dedupe. Verified empty in prod as of 2026-04-20 via
 * `npm run test:db:contract-legacy-collisions` — the fallback code path is
 * dormant. If legacy rows ever reappear AND the same (instructor, spreadsheet,
 * row_number) exists in multiple worksheets, fallback dedupe can misattribute
 * a legacy row to the wrong incoming row (see review finding 2026-04-20).
 * Re-run the diagnostic before trusting this path.
 */
function buildLegacySourceIdentity(input: {
  instructorDbId: string;
  spreadsheetId: string;
  rowNumber: number;
}): string {
  return [input.instructorDbId, input.spreadsheetId, input.rowNumber].join("::");
}

/**
 * Alias of buildLegacySourceIdentity. Intentionally does NOT include
 * worksheet_gid: callers use this key to count incoming rows per legacy scope
 * and skip fallback dedupe when count != 1 (prevents misattribution across
 * worksheets). Does not provide uniqueness across worksheets by itself.
 */
function buildSourceIdentityDisambiguationKey(input: {
  instructorDbId: string;
  spreadsheetId: string;
  rowNumber: number;
}): string {
  return buildLegacySourceIdentity(input);
}

function mergeContractSourceRef(
  duplicateSourceRef: unknown,
  incoming: {
    spreadsheet_id: string;
    worksheet_gid: number;
    row_number: number;
    timestamp_raw: string | null;
    recorded_at: string | null;
  }
) {
  const existing =
    duplicateSourceRef &&
    typeof duplicateSourceRef === "object" &&
    !Array.isArray(duplicateSourceRef)
      ? (duplicateSourceRef as Record<string, unknown>)
      : null;

  const prefersExistingWorksheet =
    getWorksheetGid(duplicateSourceRef) === PREFERRED_CONTRACT_WORKSHEET_GID;

  return {
    spreadsheet_id:
      typeof existing?.spreadsheet_id === "string"
        ? existing.spreadsheet_id
        : incoming.spreadsheet_id,
    worksheet_gid:
      prefersExistingWorksheet &&
      typeof existing?.worksheet_gid === "number"
        ? existing.worksheet_gid
        : incoming.worksheet_gid,
    row_number:
      typeof existing?.row_number === "number"
        ? existing.row_number
        : incoming.row_number,
    timestamp_raw:
      typeof existing?.timestamp_raw === "string" || existing?.timestamp_raw === null
        ? (existing.timestamp_raw as string | null)
        : incoming.timestamp_raw,
    recorded_at:
      typeof existing?.recorded_at === "string" || existing?.recorded_at === null
        ? (existing.recorded_at as string | null)
        : incoming.recorded_at,
  };
}

function sourceRefEquals(
  left: unknown,
  right: {
    spreadsheet_id: string;
    worksheet_gid: number;
    row_number: number;
    timestamp_raw: string | null;
    recorded_at: string | null;
  }
): boolean {
  const existing =
    left && typeof left === "object" && !Array.isArray(left)
      ? (left as Record<string, unknown>)
      : null;

  return (
    (typeof existing?.spreadsheet_id === "string"
      ? existing.spreadsheet_id
      : null) === right.spreadsheet_id &&
    (typeof existing?.worksheet_gid === "number"
      ? existing.worksheet_gid
      : null) === right.worksheet_gid &&
    (typeof existing?.row_number === "number"
      ? existing.row_number
      : null) === right.row_number &&
    ((typeof existing?.timestamp_raw === "string" || existing?.timestamp_raw === null)
      ? (existing.timestamp_raw as string | null)
      : null) === right.timestamp_raw &&
    ((typeof existing?.recorded_at === "string" || existing?.recorded_at === null)
      ? (existing.recorded_at as string | null)
      : null) === right.recorded_at
  );
}

/**
 * 정규화된 계약시트 행을 teaching_histories 테이블에 저장한다.
 *
 * - 강사명이 없는 행: skip
 * - instructors.name exact match 실패: 최소 instructor 생성 (BLOCKER 2 B안)
 * - source_ref identity 이미 존재: dedupe (BLOCKER 3 A안)
 * - 그 외: teaching_histories insert
 */
export async function storeContractRows(
  rows: NormalizedContractRow[],
  options?: {
    onProgress?: (
      progress: ContractSheetStoreProgress
    ) => Promise<void> | void;
    progressInterval?: number;
  }
): Promise<WorksheetStoreResult> {
  const result = emptyResult();
  const progressInterval = Math.max(options?.progressInterval ?? 100, 1);
  const driveCourseIdFallbacks = loadCourseIdFallbackRegistry();

  const emitProgress = async (
    progress: Omit<ContractSheetStoreProgress, "errors">
  ) => {
    await options?.onProgress?.({
      ...progress,
      errors: result.errors.length,
    });
  };

  const validRows = rows.filter((row) => Boolean(row.name));
  const uniqueNames = Array.from(
    new Set(validRows.map((row) => row.name!).filter(Boolean))
  );

  await emitProgress({
    stage: "prepare_instructors",
    processed: 0,
    total: uniqueNames.length,
    appended: result.appended,
    updated: result.updated,
    skipped: result.skipped,
    deduped: result.deduped,
    instructorsCreated: result.instructorsCreated,
  });

  const existingInstructors: Array<{ id: string; name: string }> = [];
  for (let i = 0; i < uniqueNames.length; i += INSTRUCTOR_LOOKUP_BATCH_SIZE) {
    const batch = uniqueNames.slice(i, i + INSTRUCTOR_LOOKUP_BATCH_SIZE);
    existingInstructors.push(
      ...(await withPrismaRetry(() =>
        prisma.instructor.findMany({
          where: {
            name: {
              in: batch,
            },
          },
          select: {
            id: true,
            name: true,
          },
        })
      ))
    );
  }

  const instructorsByName = new Map(existingInstructors.map((row) => [row.name, row]));
  const missingNames = uniqueNames.filter((name) => !instructorsByName.has(name));

  if (missingNames.length > 0) {
    for (let i = 0; i < missingNames.length; i += INSTRUCTOR_CREATE_BATCH_SIZE) {
      const batch = missingNames.slice(i, i + INSTRUCTOR_CREATE_BATCH_SIZE);
      await withPrismaRetry(() =>
        prisma.instructor.createMany({
          data: batch.map((name) => ({
            name,
            displayName: name,
          })),
          skipDuplicates: true,
        })
      );
    }

    const createdInstructors: Array<{ id: string; name: string }> = [];
    for (let i = 0; i < missingNames.length; i += INSTRUCTOR_LOOKUP_BATCH_SIZE) {
      const batch = missingNames.slice(i, i + INSTRUCTOR_LOOKUP_BATCH_SIZE);
      createdInstructors.push(
        ...(await withPrismaRetry(() =>
          prisma.instructor.findMany({
            where: {
              name: {
                in: batch,
              },
            },
            select: {
              id: true,
              name: true,
            },
          })
        ))
      );
    }

    for (const instructor of createdInstructors) {
      if (!instructorsByName.has(instructor.name)) {
        result.instructorsCreated++;
      }
      instructorsByName.set(instructor.name, instructor);
    }
  }

  const missingCourseNameWithCourseIdRows = validRows.filter(
    (row) => !row.courseName && row.courseId
  );
  const uniqueMissingCourseIds = new Set(
    missingCourseNameWithCourseIdRows
      .map((row) => row.courseId)
      .filter((courseId): courseId is string => Boolean(courseId))
  );

  await emitProgress({
    stage: "prepare_course_fallbacks",
    processed: 0,
    total: uniqueMissingCourseIds.size,
    appended: result.appended,
    updated: result.updated,
    skipped: result.skipped,
    deduped: result.deduped,
    instructorsCreated: result.instructorsCreated,
  });

  const notionCourseIdFallbacks = await loadNotionCourseIdFallbackRegistry({
    rows: validRows,
    instructorsByName,
    existingFallbacks: driveCourseIdFallbacks,
    maxDistinctPageIds: MAX_NOTION_FALLBACK_PAGE_FETCHES,
  });

  await emitProgress({
    stage: "prepare_course_fallbacks",
    processed: notionCourseIdFallbacks.size,
    total: uniqueMissingCourseIds.size,
    appended: result.appended,
    updated: result.updated,
    skipped: result.skipped,
    deduped: result.deduped,
    instructorsCreated: result.instructorsCreated,
  });

  await emitProgress({
    stage: "prepare_existing_rows",
    processed: 0,
    total: validRows.length,
    appended: result.appended,
    updated: result.updated,
    skipped: result.skipped,
    deduped: result.deduped,
    instructorsCreated: result.instructorsCreated,
  });

  const instructorIds = Array.from(
    new Set(Array.from(instructorsByName.values()).map((row) => row.id))
  );

  const existingContractRows =
    instructorIds.length === 0 || validRows.length === 0
      ? []
      : await (async () => {
          const rowGroups = new Map<string, { spreadsheetId: string; worksheetGid: number; rowNumbers: number[] }>();
          for (const row of validRows) {
            const key = `${row.spreadsheetId}::${row.worksheetGid}`;
            const existing = rowGroups.get(key);
            if (existing) {
              existing.rowNumbers.push(row.rowNumber);
            } else {
              rowGroups.set(key, {
                spreadsheetId: row.spreadsheetId,
                worksheetGid: row.worksheetGid,
                rowNumbers: [row.rowNumber],
              });
            }
          }

          const groupPredicates = Array.from(rowGroups.values()).map((group) => {
            const rowNumbers = Array.from(new Set(group.rowNumbers)).sort((a, b) => a - b);
            return Prisma.sql`
              (
                source_ref->>'spreadsheet_id' = ${group.spreadsheetId}
                AND (
                  (
                    source_ref ? 'worksheet_gid'
                    AND (source_ref->>'worksheet_gid')::int = ${group.worksheetGid}
                  )
                  OR NOT (source_ref ? 'worksheet_gid')
                )
                AND (
                  source_ref ? 'row_number'
                  AND (source_ref->>'row_number')::int IN (${Prisma.join(rowNumbers)})
                )
              )
            `;
          });

          if (groupPredicates.length === 0) {
            return [];
          }

          return prisma.$queryRaw<Array<{
            id: string;
            instructorDbId: string;
            companyName: string | null;
            courseName: string | null;
            courseId: string | null;
            startDate: Date | null;
            endDate: Date | null;
            dateLabel: string | null;
            dealFeeHourly: number | null;
            feeExtra: string | null;
            totalHours: unknown;
            totalSessions: number | null;
            contractType: string | null;
            detailType: string | null;
            specialNotes: string | null;
            sourceRef: Prisma.JsonValue;
            createdAt: Date;
          }>>(Prisma.sql`
            SELECT
              id,
              instructor_db_id AS "instructorDbId",
              company_name AS "companyName",
              course_name AS "courseName",
              course_id AS "courseId",
              start_date AS "startDate",
              end_date AS "endDate",
              date_label AS "dateLabel",
              deal_fee_hourly AS "dealFeeHourly",
              fee_extra AS "feeExtra",
              total_hours AS "totalHours",
              total_sessions AS "totalSessions",
              contract_type AS "contractType",
              detail_type AS "detailType",
              special_notes AS "specialNotes",
              source_ref AS "sourceRef",
              created_at AS "createdAt"
            FROM teaching_histories
            WHERE source_type = 'contract_sheet'
              AND (${Prisma.join(groupPredicates, " OR ")})
          `);
        })();

  const existingRowsByIdentity = new Map<
    string,
    (typeof existingContractRows)[number]
  >();
  const legacyRowsByIdentity = new Map<
    string,
    (typeof existingContractRows)[number]
  >();
  const incomingIdentityCounts = new Map<string, number>();

  for (const row of validRows) {
    const instructor = row.name ? instructorsByName.get(row.name) : null;
    if (!instructor) continue;
    const key = buildSourceIdentityDisambiguationKey({
      instructorDbId: instructor.id,
      spreadsheetId: row.spreadsheetId,
      rowNumber: row.rowNumber,
    });
    incomingIdentityCounts.set(key, (incomingIdentityCounts.get(key) ?? 0) + 1);
  }

  for (const row of existingContractRows) {
    const spreadsheetId = getSpreadsheetId(row.sourceRef);
    const worksheetGid = getWorksheetGid(row.sourceRef);
    const rowNumber = getRowNumber(row.sourceRef);
    if (!spreadsheetId || rowNumber === null) {
      continue;
    }

    if (worksheetGid !== null) {
      existingRowsByIdentity.set(
        buildSourceIdentity({
          instructorDbId: row.instructorDbId,
          spreadsheetId,
          worksheetGid,
          rowNumber,
        }),
        row
      );
      continue;
    }

    legacyRowsByIdentity.set(
      buildLegacySourceIdentity({
        instructorDbId: row.instructorDbId,
        spreadsheetId,
        rowNumber,
      }),
      row
    );
  }

  const createPayloads: Array<{
    instructorDbId: string;
    companyName: string | null;
    courseName: string | null;
    courseId: string | null;
    startDate: Date | null;
    endDate: Date | null;
    dateLabel: string | null;
    dealFeeHourly: number | null;
    feeExtra: string | null;
    totalHours: typeof rows[number]["totalHours"];
    totalSessions: number | null;
    contractType: string | null;
    detailType: string | null;
    specialNotes: string | null;
    sourceType: "contract_sheet";
    sourceRef: {
      spreadsheet_id: string;
      worksheet_gid: number;
      row_number: number;
      timestamp_raw: string | null;
      recorded_at: string | null;
    };
  }> = [];
  const updatePayloads: Array<{
    id: string;
    data: {
      companyName: string | null;
      courseName: string | null;
      courseId: string | null;
      startDate: Date | null;
      endDate: Date | null;
      dateLabel: string | null;
      dealFeeHourly: number | null;
      feeExtra: string | null;
      totalHours: typeof rows[number]["totalHours"];
      totalSessions: number | null;
      contractType: string | null;
      detailType: string | null;
      specialNotes: string | null;
      sourceRef: {
        spreadsheet_id: string;
        worksheet_gid: number;
        row_number: number;
        timestamp_raw: string | null;
        recorded_at: string | null;
      };
    };
  }> = [];

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    try {
      if (!row.name) {
        result.skipped++;
        const processed = index + 1;
        if (processed % progressInterval === 0 || processed === rows.length) {
          await emitProgress({
            stage: "plan_rows",
            processed,
            total: rows.length,
            appended: result.appended,
            updated: result.updated,
            skipped: result.skipped,
            deduped: result.deduped,
            instructorsCreated: result.instructorsCreated,
          });
        }
        continue;
      }

      // 1. instructor 매칭 (exact match) 또는 최소 생성
      const instructor = instructorsByName.get(row.name);

      if (!instructor) {
        throw new Error(`instructor preload failed for name=${row.name}`);
      }

      const identity = buildSourceIdentity({
        instructorDbId: instructor.id,
        spreadsheetId: row.spreadsheetId,
        worksheetGid: row.worksheetGid,
        rowNumber: row.rowNumber,
      });

      const fallbackIdentity = buildSourceIdentityDisambiguationKey({
        instructorDbId: instructor.id,
        spreadsheetId: row.spreadsheetId,
        rowNumber: row.rowNumber,
      });

      const duplicate =
        existingRowsByIdentity.get(identity) ??
        (incomingIdentityCounts.get(fallbackIdentity) === 1
          ? legacyRowsByIdentity.get(fallbackIdentity)
          : undefined);

      const fallbackCourseName =
        !row.courseName && row.courseId
          ? (
              driveCourseIdFallbacks.get(row.courseId)?.courseName ??
              notionCourseIdFallbacks.get(row.courseId)?.courseName ??
              null
            )
          : null;
      const effectiveCourseName = row.courseName ?? fallbackCourseName;

      const sourceRef = {
        spreadsheet_id: row.spreadsheetId,
        worksheet_gid: row.worksheetGid,
        row_number: row.rowNumber,
        timestamp_raw: row.timestampRaw,
        recorded_at: toDateOnlyString(row.recordedAt),
      };

      if (duplicate) {
        const nextSourceRef = mergeContractSourceRef(duplicate.sourceRef, sourceRef);
        const nextData = {
          companyName: row.companyName ?? duplicate.companyName,
          courseName: effectiveCourseName ?? duplicate.courseName,
          courseId: row.courseId ?? duplicate.courseId,
          startDate: row.startDate ?? duplicate.startDate,
          endDate: row.endDate ?? duplicate.endDate,
          dateLabel: row.dateLabel ?? duplicate.dateLabel,
          dealFeeHourly: row.dealFeeHourly ?? duplicate.dealFeeHourly,
          feeExtra: row.feeExtra ?? duplicate.feeExtra,
          totalHours:
            row.totalHours ??
            (duplicate.totalHours !== null
              ? Number(duplicate.totalHours)
              : null),
          totalSessions: row.totalSessions ?? duplicate.totalSessions,
          contractType: row.contractType ?? duplicate.contractType,
          detailType: row.detailType ?? duplicate.detailType,
          specialNotes: row.specialNotes ?? duplicate.specialNotes,
          sourceRef: nextSourceRef,
        };
        const changed =
          duplicate.companyName !== nextData.companyName ||
          duplicate.courseName !== nextData.courseName ||
          duplicate.courseId !== nextData.courseId ||
          asDateOnly(duplicate.startDate) !== asDateOnly(nextData.startDate) ||
          asDateOnly(duplicate.endDate) !== asDateOnly(nextData.endDate) ||
          duplicate.dateLabel !== nextData.dateLabel ||
          duplicate.dealFeeHourly !== nextData.dealFeeHourly ||
          duplicate.feeExtra !== nextData.feeExtra ||
          asComparableHours(duplicate.totalHours) !==
            asComparableHours(nextData.totalHours) ||
          duplicate.totalSessions !== nextData.totalSessions ||
          duplicate.contractType !== nextData.contractType ||
          duplicate.detailType !== nextData.detailType ||
          duplicate.specialNotes !== nextData.specialNotes ||
          !sourceRefEquals(duplicate.sourceRef, nextData.sourceRef);

        if (changed) {
          updatePayloads.push({
            id: duplicate.id,
            data: nextData,
          });
          result.updated++;
        }

        result.deduped++;
        result.instructorIdsAffected.add(instructor.id);
        continue;
      }

      // 3. insert
      createPayloads.push({
        instructorDbId: instructor.id,
        companyName: row.companyName,
        courseName: effectiveCourseName,
        courseId: row.courseId,
        startDate: row.startDate,
        endDate: row.endDate,
        dateLabel: row.dateLabel,
        dealFeeHourly: row.dealFeeHourly,
        feeExtra: row.feeExtra,
        totalHours: row.totalHours,
        totalSessions: row.totalSessions,
        contractType: row.contractType,
        detailType: row.detailType,
        specialNotes: row.specialNotes,
        sourceType: "contract_sheet",
        sourceRef,
      });

      result.appended++;
      result.instructorIdsAffected.add(instructor.id);
    } catch (err) {
      result.errors.push({
        rowNumber: row.rowNumber,
        message: err instanceof Error ? err.message : String(err),
      });
    }

    const processed = index + 1;
    if (processed % progressInterval === 0 || processed === rows.length) {
      await emitProgress({
        stage: "plan_rows",
        processed,
        total: rows.length,
        appended: result.appended,
        updated: result.updated,
        skipped: result.skipped,
        deduped: result.deduped,
        instructorsCreated: result.instructorsCreated,
      });
    }
  }

  await emitProgress({
    stage: "apply_updates",
    processed: 0,
    total: updatePayloads.length,
    appended: result.appended,
    updated: result.updated,
    skipped: result.skipped,
    deduped: result.deduped,
    instructorsCreated: result.instructorsCreated,
  });

  const updateConcurrency = 50;
  let appliedUpdates = 0;
  for (let i = 0; i < updatePayloads.length; i += updateConcurrency) {
    const batch = updatePayloads.slice(i, i + updateConcurrency);
    await Promise.all(
      batch.map((payload) =>
        prisma.teachingHistory.updateMany({
          where: { id: payload.id },
          data: payload.data,
        })
      )
    );
    appliedUpdates += batch.length;
    await emitProgress({
      stage: "apply_updates",
      processed: appliedUpdates,
      total: updatePayloads.length,
      appended: result.appended,
      updated: result.updated,
      skipped: result.skipped,
      deduped: result.deduped,
      instructorsCreated: result.instructorsCreated,
    });
  }

  await emitProgress({
    stage: "apply_creates",
    processed: 0,
    total: createPayloads.length,
    appended: result.appended,
    updated: result.updated,
    skipped: result.skipped,
    deduped: result.deduped,
    instructorsCreated: result.instructorsCreated,
  });

  const createBatchSize = 200;
  let appliedCreates = 0;
  for (let i = 0; i < createPayloads.length; i += createBatchSize) {
    const batch = createPayloads.slice(i, i + createBatchSize);
    await prisma.teachingHistory.createMany({
      data: batch,
      skipDuplicates: false,
    });
    appliedCreates += batch.length;
    await emitProgress({
      stage: "apply_creates",
      processed: appliedCreates,
      total: createPayloads.length,
      appended: result.appended,
      updated: result.updated,
      skipped: result.skipped,
      deduped: result.deduped,
      instructorsCreated: result.instructorsCreated,
    });
  }

  await emitProgress({
    stage: "done",
    processed: rows.length,
    total: rows.length,
    appended: result.appended,
    updated: result.updated,
    skipped: result.skipped,
    deduped: result.deduped,
    instructorsCreated: result.instructorsCreated,
    deletedDuplicates: 0,
  });

  return result;
}

/**
 * 04_data_pipeline.md 18-1, 05_api_spec.md 5-5, 06_implementation_spec.md 5-4:
 *
 * teaching_histories 변경 이후 파생 집계값을 같은 실행 안에서 갱신한다.
 * - contract_sheet_rows: legacy 필드명. contract_sheet + instructor_dispatch_sheet
 *   teaching_histories 건수를 함께 저장한다.
 * - total_courses: 해당 instructor의 전체 teaching_histories 건수
 * - recent_courses_6mo: start_date >= now - 6개월인 teaching_histories 건수
 *
 * 영향을 받은 instructor만 갱신한다.
 *
 * @returns 실제로 집계값이 바뀐 instructor 수 (입력 instructor 수 아님).
 *          기존 값과 새 계산값이 같은 경우는 skip되어 반환 수치에 포함되지 않는다.
 *          로그/대시보드에서 "aggregates_updated"를 사용할 때 이전 semantic("처리된 수")
 *          과 다르다는 점을 유의.
 */
export async function recomputeAggregatesForInstructors(
  instructorIds: Iterable<string>,
  now: Date = new Date()
): Promise<number> {
  const uniqueInstructorIds = Array.from(new Set(instructorIds)).filter(Boolean);
  if (uniqueInstructorIds.length === 0) return 0;

  const sixMonthsAgo = new Date(now);
  sixMonthsAgo.setUTCMonth(sixMonthsAgo.getUTCMonth() - 6);
  const today = now.toISOString().split("T")[0];
  const sixMonthsAgoDate = sixMonthsAgo.toISOString().split("T")[0];

  const histories = await prisma.teachingHistory.findMany({
    where: { instructorDbId: { in: uniqueInstructorIds } },
    select: {
      instructorDbId: true,
      sourceType: true,
      companyName: true,
      courseName: true,
      courseId: true,
      detailType: true,
      feeExtra: true,
      specialNotes: true,
      startDate: true,
      endDate: true,
      dateLabel: true,
      totalSessions: true,
      totalHours: true,
    },
  });

  const historiesByInstructor = new Map<string, typeof histories>();
  for (const row of histories) {
    const bucket = historiesByInstructor.get(row.instructorDbId) ?? [];
    bucket.push(row);
    historiesByInstructor.set(row.instructorDbId, bucket);
  }

  const currentInstructors = await prisma.instructor.findMany({
    where: { id: { in: uniqueInstructorIds } },
    select: {
      id: true,
      contractSheetRows: true,
      totalCourses: true,
      recentCourses6mo: true,
    },
  });
  const currentById = new Map(
    currentInstructors.map((instructor) => [instructor.id, instructor])
  );

  const updatePayloads = uniqueInstructorIds.map((instructorId) => {
    const rows = historiesByInstructor.get(instructorId) ?? [];

    const allItems = rows.map((row) => ({
      company_name: row.companyName,
      course_name: row.courseName,
      course_id: row.courseId,
      detail_type: row.detailType,
      fee_extra: row.feeExtra,
      special_notes: row.specialNotes,
      start_date: row.startDate?.toISOString().split("T")[0] ?? null,
      end_date: row.endDate?.toISOString().split("T")[0] ?? null,
      date_label: row.dateLabel,
      total_sessions: row.totalSessions,
      total_hours: row.totalHours !== null ? Number(row.totalHours) : null,
    }));

    const courseCountableItems = rows
      .filter((row) => COURSE_COUNT_SOURCE_TYPES.includes(row.sourceType as typeof COURSE_COUNT_SOURCE_TYPES[number]))
      .map((row) => ({
        company_name: row.companyName,
        course_name: row.courseName,
        course_id: row.courseId,
        detail_type: row.detailType,
        fee_extra: row.feeExtra,
        special_notes: row.specialNotes,
        start_date: row.startDate?.toISOString().split("T")[0] ?? null,
        end_date: row.endDate?.toISOString().split("T")[0] ?? null,
        date_label: row.dateLabel,
        total_sessions: row.totalSessions,
        total_hours: row.totalHours !== null ? Number(row.totalHours) : null,
      }));

    const contractSheetRows = countGroupedTeachingHistories(courseCountableItems, {
      fromDate: "2025-01-01",
      untilDate: today,
    });
    const totalCourses = countGroupedTeachingHistories(allItems, {
      fromDate: "2025-01-01",
      untilDate: today,
    });
    const recentCourses6mo = countGroupedTeachingHistories(allItems, {
      fromDate: sixMonthsAgoDate,
      untilDate: today,
    });

    return {
      instructorId,
      data: {
        contractSheetRows,
        totalCourses,
        recentCourses6mo,
      },
    };
  }).filter((payload) => {
    const current = currentById.get(payload.instructorId);
    if (!current) return true;
    return (
      current.contractSheetRows !== payload.data.contractSheetRows ||
      current.totalCourses !== payload.data.totalCourses ||
      current.recentCourses6mo !== payload.data.recentCourses6mo
    );
  });

  const updateBatchSize = 100;
  for (let i = 0; i < updatePayloads.length; i += updateBatchSize) {
    const batch = updatePayloads.slice(i, i + updateBatchSize);
    if (batch.length === 0) continue;

    const valuesSql = Prisma.join(
      batch.map(
        (payload) =>
          Prisma.sql`(${payload.instructorId}::uuid, ${payload.data.contractSheetRows}, ${payload.data.totalCourses}, ${payload.data.recentCourses6mo})`
      )
    );

    await prisma.$executeRaw`
      UPDATE instructors AS i
      SET
        contract_sheet_rows = v.contract_sheet_rows,
        total_courses = v.total_courses,
        recent_courses_6mo = v.recent_courses_6mo
      FROM (VALUES ${valuesSql})
        AS v(id, contract_sheet_rows, total_courses, recent_courses_6mo)
      WHERE i.id = v.id
    `;
  }

  return updatePayloads.length;
}
