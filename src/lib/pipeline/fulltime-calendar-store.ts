/**
 * Fulltime Calendar Store — Phase 1-2
 *
 * NormalizedFulltimeRow를 TeachingHistory로 upsert.
 *   - source_ref: { spreadsheet_id, tab_title, row_number, origin: "fulltime_calendar" }
 *   - source_type: "fulltime_calendar"
 *   - dedup: (sourceType=fulltime_calendar, sourceRef.spreadsheet_id + tab_title + row_number)
 *   - 강사 매칭: name exact match. canonical alias 통과. 없으면 skip (계약시트와 달리 auto-create 안 함).
 *   - 강사 매칭 실패 row는 skipped로 카운트.
 *
 * 효과: 전임강사 TH가 계약시트와 분리된 캘린더 시트에서 정규 TeachingHistory로 sync.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { NormalizedFulltimeRow } from "./fulltime-calendar-normalizer";
import { buildCanonicalInstructorByNameMap } from "@/lib/instructor-name-canonical";

export const FULLTIME_CALENDAR_SOURCE_TYPE = "fulltime_calendar";

export interface FulltimeStoreResult {
  fetched: number;
  appended: number;
  updated: number;
  deduped: number;
  skippedNoInstructor: number;
  skippedNoDate: number;
  errors: Array<{ row: number; tab: string; message: string }>;
  instructorIdsAffected: Set<string>;
}

function emptyResult(): FulltimeStoreResult {
  return {
    fetched: 0,
    appended: 0,
    updated: 0,
    deduped: 0,
    skippedNoInstructor: 0,
    skippedNoDate: 0,
    errors: [],
    instructorIdsAffected: new Set<string>(),
  };
}

interface ExistingTHKey {
  id: string;
  data: {
    companyName: string | null;
    courseName: string | null;
    startDate: Date | null;
    endDate: Date | null;
    dateLabel: string | null;
    detailType: string | null;
    totalHours: Prisma.Decimal | null;
  };
}

function tsKey(spreadsheetId: string, tabTitle: string, rowNumber: number): string {
  return `${spreadsheetId}::${tabTitle}::${rowNumber}`;
}

function decimalEqual(a: Prisma.Decimal | null, b: number | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return Math.abs(Number(a) - b) < 0.0001;
}

function dateEqual(a: Date | null, b: Date | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.getTime() === b.getTime();
}

export async function storeFulltimeRows(
  rows: NormalizedFulltimeRow[]
): Promise<FulltimeStoreResult> {
  const result = emptyResult();
  result.fetched = rows.length;
  if (rows.length === 0) return result;

  // 1) Instructor name → id 매핑 (alias 포함)
  const allInstructors = await prisma.instructor.findMany({
    select: { id: true, name: true, flag: true, createdAt: true },
  });
  const canonical = buildCanonicalInstructorByNameMap(allInstructors);

  // 2) 기존 TH lookup: sourceType=fulltime_calendar, sourceRef 조합
  const existing = await prisma.teachingHistory.findMany({
    where: { sourceType: FULLTIME_CALENDAR_SOURCE_TYPE },
    select: {
      id: true,
      sourceRef: true,
      companyName: true,
      courseName: true,
      startDate: true,
      endDate: true,
      dateLabel: true,
      detailType: true,
      totalHours: true,
    },
  });
  const existingByKey = new Map<string, ExistingTHKey>();
  for (const t of existing) {
    const r = t.sourceRef as Record<string, unknown> | null;
    const sid = typeof r?.spreadsheet_id === "string" ? r.spreadsheet_id : "";
    const tab = typeof r?.tab_title === "string" ? r.tab_title : "";
    const rn = typeof r?.row_number === "number" ? r.row_number : -1;
    if (!sid || !tab || rn < 0) continue;
    existingByKey.set(tsKey(sid, tab, rn), {
      id: t.id,
      data: {
        companyName: t.companyName,
        courseName: t.courseName,
        startDate: t.startDate,
        endDate: t.endDate,
        dateLabel: t.dateLabel,
        detailType: t.detailType,
        totalHours: t.totalHours,
      },
    });
  }

  // 3) 각 row 처리
  for (const r of rows) {
    if (!r.instructorName) {
      result.skippedNoInstructor += 1;
      continue;
    }
    const instructorId = canonical.get(r.instructorName)?.id ?? null;
    if (!instructorId) {
      result.skippedNoInstructor += 1;
      continue;
    }
    if (!r.startDate && !r.endDate) {
      result.skippedNoDate += 1;
      continue;
    }

    const key = tsKey(r.spreadsheetId, r.tabTitle, r.rowNumber);
    const existingRec = existingByKey.get(key);

    const data = {
      instructorDbId: instructorId,
      companyName: r.companyName,
      courseName: r.courseName,
      startDate: r.startDate,
      endDate: r.endDate ?? r.startDate,
      dateLabel: r.dateLabel,
      detailType: r.detailType,
      totalHours: r.totalHours,
      sourceType: FULLTIME_CALENDAR_SOURCE_TYPE,
      sourceRef: {
        spreadsheet_id: r.spreadsheetId,
        tab_title: r.tabTitle,
        row_number: r.rowNumber,
        month_label: r.monthLabel,
        origin: "fulltime_calendar",
      } as Prisma.InputJsonObject,
    };

    try {
      if (!existingRec) {
        await prisma.teachingHistory.create({ data });
        result.appended += 1;
        result.instructorIdsAffected.add(instructorId);
      } else {
        // 변경 detection
        const changed =
          existingRec.data.companyName !== r.companyName ||
          existingRec.data.courseName !== r.courseName ||
          !dateEqual(existingRec.data.startDate, r.startDate) ||
          !dateEqual(existingRec.data.endDate, r.endDate ?? r.startDate) ||
          existingRec.data.dateLabel !== r.dateLabel ||
          existingRec.data.detailType !== r.detailType ||
          !decimalEqual(existingRec.data.totalHours, r.totalHours);
        if (changed) {
          await prisma.teachingHistory.update({
            where: { id: existingRec.id },
            data,
          });
          result.updated += 1;
          result.instructorIdsAffected.add(instructorId);
        } else {
          result.deduped += 1;
        }
      }
    } catch (err) {
      result.errors.push({
        row: r.rowNumber,
        tab: r.tabTitle,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

/**
 * 영향 instructor의 total_courses / recent_courses_6mo 집계 갱신.
 * teaching_histories 변경 후 호출.
 */
export async function recomputeAggregatesForFulltimeInstructors(
  instructorIds: Set<string>
): Promise<{ updated: number }> {
  if (instructorIds.size === 0) return { updated: 0 };
  const ids = Array.from(instructorIds);
  const idSqlList = Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`));
  const cutoff = new Date();
  cutoff.setUTCMonth(cutoff.getUTCMonth() - 6);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  await prisma.$executeRaw`
    WITH agg AS (
      SELECT
        instructor_db_id,
        COUNT(*)::int AS total_courses,
        COUNT(*) FILTER (
          WHERE COALESCE(end_date, start_date) >= ${cutoffStr}::date
        )::int AS recent_courses_6mo
      FROM teaching_histories
      WHERE instructor_db_id IN (${idSqlList})
      GROUP BY instructor_db_id
    )
    UPDATE instructors AS i
    SET
      total_courses = agg.total_courses,
      recent_courses_6mo = agg.recent_courses_6mo
    FROM agg
    WHERE i.id = agg.instructor_db_id
  `;
  return { updated: ids.length };
}
