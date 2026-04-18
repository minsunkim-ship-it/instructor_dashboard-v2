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

import { prisma } from "@/lib/prisma";
import type { NormalizedContractRow } from "./contract-sheet-normalizer";
import { toDateOnlyString } from "@/lib/contract-sheet-parser";
import { COURSE_COUNT_SOURCE_TYPES } from "./teaching-history-sources";
import {
  countGroupedTeachingHistories,
  getTeachingHistoryDedupSignature,
} from "@/lib/teaching-history-display";

const PREFERRED_CONTRACT_WORKSHEET_GID = 158052384;

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

function buildNormalizedRowSignature(row: NormalizedContractRow): string {
  return getTeachingHistoryDedupSignature({
    course_name: row.courseName,
    company_name: row.companyName,
    course_id: row.courseId,
    deal_fee_hourly: row.dealFeeHourly,
    contract_type: row.contractType,
    detail_type: row.detailType,
    fee_extra: row.feeExtra,
    special_notes: row.specialNotes,
    start_date: row.startDate,
    end_date: row.endDate,
    date_label: row.dateLabel,
    total_sessions: row.totalSessions,
    total_hours: row.totalHours !== null ? Number(row.totalHours) : null,
  });
}

function buildStoredRowSignature(row: {
  companyName: string | null;
  courseName: string | null;
  courseId: string | null;
  dealFeeHourly: number | null;
  contractType: string | null;
  detailType: string | null;
  feeExtra: string | null;
  specialNotes: string | null;
  startDate: Date | null;
  endDate: Date | null;
  dateLabel: string | null;
  totalSessions: number | null;
  totalHours: unknown;
}): string {
  return getTeachingHistoryDedupSignature({
    course_name: row.courseName,
    company_name: row.companyName,
    course_id: row.courseId,
    deal_fee_hourly: row.dealFeeHourly,
    contract_type: row.contractType,
    detail_type: row.detailType,
    fee_extra: row.feeExtra,
    special_notes: row.specialNotes,
    start_date: row.startDate,
    end_date: row.endDate,
    date_label: row.dateLabel,
    total_sessions: row.totalSessions,
    total_hours: asComparableHours(row.totalHours),
  });
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
  rowNumber: number;
}): string {
  return [input.instructorDbId, input.spreadsheetId, input.rowNumber].join(
    "::"
  );
}

function compareContractRowPreference(
  a: { sourceRef: unknown; createdAt: Date },
  b: { sourceRef: unknown; createdAt: Date }
): number {
  const aWorksheet = getWorksheetGid(a.sourceRef);
  const bWorksheet = getWorksheetGid(b.sourceRef);
  const aPreferred = aWorksheet === PREFERRED_CONTRACT_WORKSHEET_GID ? 1 : 0;
  const bPreferred = bWorksheet === PREFERRED_CONTRACT_WORKSHEET_GID ? 1 : 0;

  if (aPreferred !== bPreferred) {
    return bPreferred - aPreferred;
  }

  return a.createdAt.getTime() - b.createdAt.getTime();
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

async function cleanupLegacyCrossWorksheetContractDuplicates(
  instructorIds: Iterable<string>
): Promise<number> {
  let deletedCount = 0;

  for (const instructorId of instructorIds) {
    const rows = await prisma.teachingHistory.findMany({
      where: {
        instructorDbId: instructorId,
        sourceType: "contract_sheet",
      },
      select: {
        id: true,
        companyName: true,
        courseName: true,
        courseId: true,
        startDate: true,
        endDate: true,
        dateLabel: true,
        dealFeeHourly: true,
        feeExtra: true,
        totalHours: true,
        totalSessions: true,
        contractType: true,
        detailType: true,
        specialNotes: true,
        sourceRef: true,
        createdAt: true,
      },
    });

    const groupedByRowIdentity = new Map<string, typeof rows>();

    for (const row of rows) {
      const spreadsheetId = getSpreadsheetId(row.sourceRef);
      const rowNumber = getRowNumber(row.sourceRef);
      if (!spreadsheetId || rowNumber === null) {
        continue;
      }

      const identity = `${spreadsheetId}::${rowNumber}`;
      const bucket = groupedByRowIdentity.get(identity) ?? [];
      bucket.push(row);
      groupedByRowIdentity.set(identity, bucket);
    }

    for (const bucket of groupedByRowIdentity.values()) {
      if (bucket.length <= 1) continue;

      const sorted = [...bucket].sort(compareContractRowPreference);
      const [survivor, ...duplicates] = sorted;

      if (duplicates.length === 0) continue;

      const mergedData = {
        companyName:
          survivor.companyName ??
          duplicates.find((row) => row.companyName)?.companyName ??
          null,
        courseName:
          survivor.courseName ??
          duplicates.find((row) => row.courseName)?.courseName ??
          null,
        courseId:
          survivor.courseId ??
          duplicates.find((row) => row.courseId)?.courseId ??
          null,
        startDate:
          survivor.startDate ??
          duplicates.find((row) => row.startDate)?.startDate ??
          null,
        endDate:
          survivor.endDate ??
          duplicates.find((row) => row.endDate)?.endDate ??
          null,
        dateLabel:
          survivor.dateLabel ??
          duplicates.find((row) => row.dateLabel)?.dateLabel ??
          null,
        dealFeeHourly:
          survivor.dealFeeHourly ??
          duplicates.find((row) => row.dealFeeHourly !== null)?.dealFeeHourly ??
          null,
        feeExtra:
          survivor.feeExtra ??
          duplicates.find((row) => row.feeExtra)?.feeExtra ??
          null,
        totalHours:
          survivor.totalHours ??
          duplicates.find((row) => row.totalHours !== null)?.totalHours ??
          null,
        totalSessions:
          survivor.totalSessions ??
          duplicates.find((row) => row.totalSessions !== null)?.totalSessions ??
          null,
        contractType:
          survivor.contractType ??
          duplicates.find((row) => row.contractType)?.contractType ??
          null,
        detailType:
          survivor.detailType ??
          duplicates.find((row) => row.detailType)?.detailType ??
          null,
        specialNotes:
          survivor.specialNotes ??
          duplicates.find((row) => row.specialNotes)?.specialNotes ??
          null,
      };

      await prisma.teachingHistory.update({
        where: { id: survivor.id },
        data: mergedData,
      });

      await prisma.teachingHistory.deleteMany({
        where: {
          id: {
            in: duplicates.map((row) => row.id),
          },
        },
      });

      deletedCount += duplicates.length;
    }

    const remainingRows = await prisma.teachingHistory.findMany({
      where: {
        instructorDbId: instructorId,
        sourceType: "contract_sheet",
      },
      select: {
        id: true,
        companyName: true,
        courseName: true,
        courseId: true,
        startDate: true,
        endDate: true,
        dateLabel: true,
        dealFeeHourly: true,
        feeExtra: true,
        totalHours: true,
        totalSessions: true,
        contractType: true,
        detailType: true,
        specialNotes: true,
        sourceRef: true,
        createdAt: true,
      },
    });

    const groupedBySignature = new Map<string, typeof remainingRows>();
    for (const row of remainingRows) {
      const signature = buildStoredRowSignature(row);
      const bucket = groupedBySignature.get(signature) ?? [];
      bucket.push(row);
      groupedBySignature.set(signature, bucket);
    }

    for (const bucket of groupedBySignature.values()) {
      if (bucket.length <= 1) continue;

      const sorted = [...bucket].sort(compareContractRowPreference);
      const [, ...duplicates] = sorted;
      if (duplicates.length === 0) continue;

      await prisma.teachingHistory.deleteMany({
        where: {
          id: {
            in: duplicates.map((row) => row.id),
          },
        },
      });

      deletedCount += duplicates.length;
    }
  }

  return deletedCount;
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

  const existingInstructors = await prisma.instructor.findMany({
    where: {
      name: {
        in: uniqueNames,
      },
    },
    select: {
      id: true,
      name: true,
    },
  });

  const instructorsByName = new Map(existingInstructors.map((row) => [row.name, row]));
  const missingNames = uniqueNames.filter((name) => !instructorsByName.has(name));

  if (missingNames.length > 0) {
    await prisma.instructor.createMany({
      data: missingNames.map((name) => ({
        name,
        displayName: name,
      })),
      skipDuplicates: true,
    });

    const createdInstructors = await prisma.instructor.findMany({
      where: {
        name: {
          in: missingNames,
        },
      },
      select: {
        id: true,
        name: true,
      },
    });

    for (const instructor of createdInstructors) {
      if (!instructorsByName.has(instructor.name)) {
        result.instructorsCreated++;
      }
      instructorsByName.set(instructor.name, instructor);
    }
  }

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
    instructorIds.length === 0
      ? []
      : await prisma.teachingHistory.findMany({
          where: {
            sourceType: "contract_sheet",
            instructorDbId: {
              in: instructorIds,
            },
          },
          select: {
            id: true,
            instructorDbId: true,
            companyName: true,
            courseName: true,
            courseId: true,
            startDate: true,
            endDate: true,
            dateLabel: true,
            dealFeeHourly: true,
            feeExtra: true,
            totalHours: true,
            totalSessions: true,
            contractType: true,
            detailType: true,
            specialNotes: true,
            sourceRef: true,
            createdAt: true,
          },
        });

  const existingRowsByIdentity = new Map<
    string,
    (typeof existingContractRows)[number]
  >();

  for (const row of existingContractRows) {
    const spreadsheetId = getSpreadsheetId(row.sourceRef);
    const worksheetGid = getWorksheetGid(row.sourceRef);
    const rowNumber = getRowNumber(row.sourceRef);
    if (!spreadsheetId || worksheetGid === null || rowNumber === null) {
      continue;
    }

    existingRowsByIdentity.set(
      buildSourceIdentity({
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
        rowNumber: row.rowNumber,
      });

      const duplicate = existingRowsByIdentity.get(identity);

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
          courseName: row.courseName ?? duplicate.courseName,
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
          JSON.stringify(duplicate.sourceRef ?? {}) !== JSON.stringify(nextData.sourceRef);

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
        courseName: row.courseName,
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
 */
export async function recomputeAggregatesForInstructors(
  instructorIds: Iterable<string>,
  now: Date = new Date()
): Promise<number> {
  const sixMonthsAgo = new Date(now);
  sixMonthsAgo.setUTCMonth(sixMonthsAgo.getUTCMonth() - 6);

  let updatedCount = 0;

  for (const instructorId of instructorIds) {
    const histories = await prisma.teachingHistory.findMany({
      where: { instructorDbId: instructorId },
      select: {
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

    const allItems = histories.map((row) => ({
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

    const courseCountableItems = histories
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
      untilDate: now.toISOString().split("T")[0],
    });
    const totalCourses = countGroupedTeachingHistories(allItems, {
      fromDate: "2025-01-01",
      untilDate: now.toISOString().split("T")[0],
    });
    const recentCourses6mo = countGroupedTeachingHistories(allItems, {
      fromDate: sixMonthsAgo.toISOString().split("T")[0],
      untilDate: now.toISOString().split("T")[0],
    });

    await prisma.instructor.update({
      where: { id: instructorId },
      data: {
        contractSheetRows,
        totalCourses,
        recentCourses6mo,
      },
    });

    updatedCount++;
  }

  return updatedCount;
}
