import { prisma } from "@/lib/prisma";
import type { NormalizedInstructorDispatchRow } from "./instructor-dispatch-sheet-normalizer";

export interface InstructorDispatchSheetStoreResult {
  appended: number;
  updated: number;
  skipped: number;
  deduped: number;
  instructorsCreated: number;
  errors: Array<{ rowNumber: number; message: string }>;
  instructorIdsAffected: Set<string>;
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

export async function storeInstructorDispatchRows(
  rows: NormalizedInstructorDispatchRow[]
): Promise<InstructorDispatchSheetStoreResult> {
  const result = emptyResult();

  for (const row of rows) {
    try {
      if (!row.name) {
        result.skipped++;
        continue;
      }

      let instructor = await prisma.instructor.findFirst({
        where: { name: row.name },
      });

      if (!instructor) {
        instructor = await prisma.instructor.create({
          data: {
            name: row.name,
            displayName: row.name,
          },
        });
        result.instructorsCreated++;
      }

      const duplicate = await prisma.teachingHistory.findFirst({
        where: {
          sourceType: "instructor_dispatch_sheet",
          instructorDbId: instructor.id,
          AND: [
            {
              sourceRef: {
                path: ["spreadsheet_id"],
                equals: row.spreadsheetId,
              },
            },
            {
              sourceRef: {
                path: ["worksheet_gid"],
                equals: row.worksheetGid,
              },
            },
            {
              sourceRef: {
                path: ["row_number"],
                equals: row.rowNumber,
              },
            },
          ],
        },
      });

      const sourceRef = {
        spreadsheet_id: row.spreadsheetId,
        worksheet_gid: row.worksheetGid,
        row_number: row.rowNumber,
        ...row.sourceRefExtras,
      };

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
          await prisma.teachingHistory.update({
            where: { id: duplicate.id },
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
        continue;
      }

      await prisma.teachingHistory.create({
        data: {
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
        },
      });

      result.appended++;
      result.instructorIdsAffected.add(instructor.id);
    } catch (err) {
      result.errors.push({
        rowNumber: row.rowNumber,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}
