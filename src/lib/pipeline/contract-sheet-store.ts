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
import { countGroupedTeachingHistories } from "@/lib/teaching-history-display";

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

/**
 * 정규화된 계약시트 행을 teaching_histories 테이블에 저장한다.
 *
 * - 강사명이 없는 행: skip
 * - instructors.name exact match 실패: 최소 instructor 생성 (BLOCKER 2 B안)
 * - source_ref identity 이미 존재: dedupe (BLOCKER 3 A안)
 * - 그 외: teaching_histories insert
 */
export async function storeContractRows(
  rows: NormalizedContractRow[]
): Promise<WorksheetStoreResult> {
  const result = emptyResult();

  for (const row of rows) {
    try {
      if (!row.name) {
        result.skipped++;
        continue;
      }

      // 1. instructor 매칭 (exact match) 또는 최소 생성
      let instructor = await prisma.instructor.findFirst({
        where: { name: row.name },
      });

      if (!instructor) {
        instructor = await prisma.instructor.create({
          data: {
            name: row.name,
            displayName: row.name, // 03_data_model 4-1: display_name 기본값 = name
          },
        });
        result.instructorsCreated++;
      }

      // 2. dedupe 검사 — source_ref identity (spreadsheetId + worksheetGid + rowNumber)
      // Prisma Json 필드는 equals 매칭이 가능하지만, 확실하게 path 기반으로 검색한다.
      const duplicate = await prisma.teachingHistory.findFirst({
        where: {
          sourceType: "contract_sheet",
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
        timestamp_raw: row.timestampRaw,
        recorded_at: toDateOnlyString(row.recordedAt),
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

      // 3. insert
      await prisma.teachingHistory.create({
        data: {
          instructorDbId: instructor.id,
          companyName: row.companyName, // null
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
