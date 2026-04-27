import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { NormalizedInstructorDispatchRow } from "./instructor-dispatch-sheet-normalizer";
import { buildCanonicalInstructorByNameMap } from "@/lib/instructor-name-canonical";

export interface InstructorDispatchSheetStoreResult {
  appended: number;
  updated: number;
  skipped: number;
  deduped: number;
  instructorsCreated: number;
  errors: Array<{ rowNumber: number; message: string }>;
  instructorIdsAffected: Set<string>;
}

export interface InstructorDispatchSheetStoreProgress {
  stage:
    | "prepare_instructors"
    | "prepare_existing_rows"
    | "plan_rows"
    | "apply_updates"
    | "apply_creates"
    | "done";
  processed?: number;
  total?: number;
  appended: number;
  updated: number;
  skipped: number;
  deduped: number;
  instructorsCreated: number;
  errors: number;
}

function emptyResult(): InstructorDispatchSheetStoreResult {
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

export async function storeInstructorDispatchRows(
  rows: NormalizedInstructorDispatchRow[],
  options?: {
    onProgress?: (
      progress: InstructorDispatchSheetStoreProgress
    ) => Promise<void> | void;
    progressInterval?: number;
  }
): Promise<InstructorDispatchSheetStoreResult> {
  const result = emptyResult();
  const progressInterval = Math.max(options?.progressInterval ?? 50, 1);

  const emitProgress = async (
    progress: Omit<InstructorDispatchSheetStoreProgress, "errors">
  ) => {
    await options?.onProgress?.({
      ...progress,
      errors: result.errors.length,
    });
  };

  const validRows = rows.filter(
    (row) =>
      Boolean(row.name) &&
      Boolean(row.companyName || row.courseName || row.startDate || row.endDate)
  );
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
      createdAt: true,
    },
  });

  const instructorsByName = buildCanonicalInstructorByNameMap(existingInstructors);
  const missingNames = uniqueNames.filter((name) => !instructorsByName.has(name));

  if (missingNames.length > 0) {
    await withPrismaRetry(() =>
      prisma.instructor.createMany({
        data: missingNames.map((name) => ({
          name,
          displayName: name,
        })),
        skipDuplicates: true,
      })
    );

    const createdInstructors = await prisma.instructor.findMany({
      where: {
        name: {
          in: missingNames,
        },
      },
      select: {
        id: true,
        name: true,
        createdAt: true,
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

  const existingDispatchRows =
    instructorIds.length === 0
      ? []
      : await prisma.teachingHistory.findMany({
          where: {
            sourceType: "instructor_dispatch_sheet",
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
          },
        });

  const existingRowsByIdentity = new Map<
    string,
    (typeof existingDispatchRows)[number]
  >();

  for (const row of existingDispatchRows) {
    const sourceRef =
      row.sourceRef && typeof row.sourceRef === "object" && !Array.isArray(row.sourceRef)
        ? (row.sourceRef as Record<string, unknown>)
        : null;
    const spreadsheetId =
      typeof sourceRef?.spreadsheet_id === "string" ? sourceRef.spreadsheet_id : null;
    const worksheetGid =
      typeof sourceRef?.worksheet_gid === "number" ? sourceRef.worksheet_gid : null;
    const rowNumber =
      typeof sourceRef?.row_number === "number" ? sourceRef.row_number : null;

    if (!spreadsheetId || worksheetGid === null || rowNumber === null) continue;

    existingRowsByIdentity.set(
      [row.instructorDbId, spreadsheetId, worksheetGid, rowNumber].join("::"),
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
    sourceType: "instructor_dispatch_sheet";
    sourceRef: Prisma.InputJsonValue;
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
      sourceRef: Prisma.InputJsonValue;
    };
  }> = [];

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    try {
      if (!row.name) {
        result.skipped++;
      } else {
        const instructor = instructorsByName.get(row.name);
        if (!instructor) {
          throw new Error(`instructor preload failed for name=${row.name}`);
        }

        const sourceRef: Prisma.InputJsonValue = {
          spreadsheet_id: row.spreadsheetId,
          worksheet_gid: row.worksheetGid,
          row_number: row.rowNumber,
          ...row.sourceRefExtras,
        };
        const duplicate = existingRowsByIdentity.get(
          [instructor.id, row.spreadsheetId, row.worksheetGid, row.rowNumber].join("::")
        );

        if (duplicate) {
          const changed =
            duplicate.companyName !== row.companyName ||
            duplicate.courseName !== row.courseName ||
            duplicate.courseId !== row.courseId ||
            asDateOnly(duplicate.startDate) !== asDateOnly(row.startDate) ||
            asDateOnly(duplicate.endDate) !== asDateOnly(row.endDate) ||
            duplicate.dateLabel !== row.dateLabel ||
            duplicate.dealFeeHourly !== row.dealFeeHourly ||
            duplicate.feeExtra !== row.feeExtra ||
            asComparableHours(duplicate.totalHours) !==
              asComparableHours(row.totalHours) ||
            duplicate.totalSessions !== row.totalSessions ||
            duplicate.contractType !== row.contractType ||
            duplicate.detailType !== row.detailType ||
            duplicate.specialNotes !== row.specialNotes ||
            JSON.stringify(duplicate.sourceRef ?? {}) !== JSON.stringify(sourceRef);

          if (changed) {
            updatePayloads.push({
              id: duplicate.id,
              data: {
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
                sourceRef,
              },
            });
            result.updated++;
          }

          result.deduped++;
          result.instructorIdsAffected.add(instructor.id);
        } else {
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
            sourceType: "instructor_dispatch_sheet",
            sourceRef,
          });

          result.appended++;
          result.instructorIdsAffected.add(instructor.id);
        }
      }
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
    await withPrismaRetry(() =>
      Promise.all(
        batch.map((payload) =>
          prisma.teachingHistory.updateMany({
            where: { id: payload.id },
            data: payload.data,
          })
        )
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
    await withPrismaRetry(() =>
      prisma.teachingHistory.createMany({
        data: batch,
        skipDuplicates: false,
      })
    );
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
  });

  return result;
}
