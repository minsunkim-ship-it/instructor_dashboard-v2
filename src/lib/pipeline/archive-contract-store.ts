/**
 * Archive Contract Store — Phase 1-5
 *
 * NormalizedArchiveRow를 TeachingHistory로 upsert.
 *   - source_type: "archive_contract"
 *   - source_ref: { file_id, sheet_name, row_number, origin: "archive_contract" }
 *   - dedup: source_ref 동일 row 재import 시 update
 *   - 강사 매칭: name exact match. 없으면 skip.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { NormalizedArchiveRow } from "./archive-contract-normalizer";
import { buildCanonicalInstructorByNameMap } from "@/lib/instructor-name-canonical";

export const ARCHIVE_CONTRACT_SOURCE_TYPE = "archive_contract";

export interface ArchiveStoreResult {
  fetched: number;
  appended: number;
  updated: number;
  deduped: number;
  skippedNoInstructor: number;
  errors: Array<{ row: number; sheet: string; message: string }>;
  instructorIdsAffected: Set<string>;
}

function tsKey(fileId: string, sheet: string, rowNumber: number): string {
  return `${fileId}::${sheet}::${rowNumber}`;
}

function dateEqual(a: Date | null, b: Date | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.getTime() === b.getTime();
}

export async function storeArchiveRows(
  rows: NormalizedArchiveRow[]
): Promise<ArchiveStoreResult> {
  const result: ArchiveStoreResult = {
    fetched: rows.length,
    appended: 0,
    updated: 0,
    deduped: 0,
    skippedNoInstructor: 0,
    errors: [],
    instructorIdsAffected: new Set<string>(),
  };
  if (rows.length === 0) return result;

  const allInstructors = await prisma.instructor.findMany({
    select: { id: true, name: true, flag: true, createdAt: true },
  });
  const canonical = buildCanonicalInstructorByNameMap(allInstructors);

  const existing = await prisma.teachingHistory.findMany({
    where: { sourceType: ARCHIVE_CONTRACT_SOURCE_TYPE },
    select: {
      id: true,
      sourceRef: true,
      companyName: true,
      startDate: true,
      endDate: true,
      dateLabel: true,
      totalHours: true,
    },
  });
  const existingByKey = new Map<string, {
    id: string;
    companyName: string | null;
    startDate: Date | null;
    endDate: Date | null;
    dateLabel: string | null;
    totalHours: Prisma.Decimal | null;
  }>();
  for (const t of existing) {
    const r = t.sourceRef as Record<string, unknown> | null;
    const fid = typeof r?.file_id === "string" ? r.file_id : "";
    const sh = typeof r?.sheet_name === "string" ? r.sheet_name : "";
    const rn = typeof r?.row_number === "number" ? r.row_number : -1;
    if (!fid || !sh || rn < 0) continue;
    existingByKey.set(tsKey(fid, sh, rn), {
      id: t.id,
      companyName: t.companyName,
      startDate: t.startDate,
      endDate: t.endDate,
      dateLabel: t.dateLabel,
      totalHours: t.totalHours,
    });
  }

  for (const r of rows) {
    const inst = canonical.get(r.instructorName ?? "");
    if (!inst) {
      result.skippedNoInstructor += 1;
      continue;
    }

    const data = {
      instructorDbId: inst.id,
      companyName: r.companyName,
      courseName: r.courseName,
      startDate: r.startDate,
      endDate: r.endDate,
      dateLabel: r.dateLabel,
      totalHours: r.totalHours,
      dealFeeHourly: r.dealFeeHourly,
      detailType: r.category,
      sourceType: ARCHIVE_CONTRACT_SOURCE_TYPE,
      sourceRef: {
        file_id: r.fileId,
        sheet_name: r.sheetName,
        row_number: r.rowNumber,
        course_link: r.courseLink,
        origin: "archive_contract",
      } as Prisma.InputJsonObject,
    };

    const key = tsKey(r.fileId, r.sheetName, r.rowNumber);
    const existingRec = existingByKey.get(key);

    try {
      if (!existingRec) {
        await prisma.teachingHistory.create({ data });
        result.appended += 1;
        result.instructorIdsAffected.add(inst.id);
      } else {
        const changed =
          existingRec.companyName !== r.companyName ||
          !dateEqual(existingRec.startDate, r.startDate) ||
          !dateEqual(existingRec.endDate, r.endDate) ||
          existingRec.dateLabel !== r.dateLabel;
        if (changed) {
          await prisma.teachingHistory.update({ where: { id: existingRec.id }, data });
          result.updated += 1;
          result.instructorIdsAffected.add(inst.id);
        } else {
          result.deduped += 1;
        }
      }
    } catch (err) {
      result.errors.push({
        row: r.rowNumber,
        sheet: r.sheetName,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

export async function recomputeAggregatesForArchiveInstructors(
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
        COUNT(*) FILTER (WHERE COALESCE(end_date, start_date) >= ${cutoffStr}::date)::int AS recent_courses_6mo
      FROM teaching_histories
      WHERE instructor_db_id IN (${idSqlList})
      GROUP BY instructor_db_id
    )
    UPDATE instructors AS i
    SET total_courses = agg.total_courses, recent_courses_6mo = agg.recent_courses_6mo
    FROM agg
    WHERE i.id = agg.instructor_db_id
  `;
  return { updated: ids.length };
}
