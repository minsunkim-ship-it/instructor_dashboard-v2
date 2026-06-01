/**
 * GET /api/admin/probe-archive-contract
 *
 * 진단:
 *   - ?instructor=신승진 → archive에서 해당 강사명 매치되는 row dump (raw + normalize)
 *   - ?skipped=1 → archive normalize 후 강사 매칭 실패한 강사 이름 list (중복 제거)
 *   - 기본: 시트별 fetched / normalized 통계 + 회사 추출 성공률
 * 인증: CRON_SECRET
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";
import { collectArchiveContract } from "@/lib/pipeline/archive-contract-collector";
import {
  normalizeArchiveRow,
  normalizeArchiveRows,
} from "@/lib/pipeline/archive-contract-normalizer";
import { buildCanonicalInstructorByNameMap } from "@/lib/instructor-name-canonical";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

async function buildDynamicCompanyKeywords(): Promise<string[]> {
  const [recordCompanies, thCompanies] = await Promise.all([
    prisma.satisfactionRecord.findMany({
      where: { companyName: { not: null } },
      select: { companyName: true },
      distinct: ["companyName"],
    }),
    prisma.teachingHistory.findMany({
      where: { companyName: { not: null } },
      select: { companyName: true },
      distinct: ["companyName"],
    }),
  ]);
  const set = new Set<string>();
  for (const r of recordCompanies) {
    const c = r.companyName?.trim();
    if (c && c.length >= 2 && c.length <= 30) set.add(c);
  }
  for (const t of thCompanies) {
    const c = t.companyName?.trim();
    if (c && c.length >= 2 && c.length <= 30) set.add(c);
  }
  return Array.from(set);
}

export async function GET(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const targetInstructor = request.nextUrl.searchParams.get("instructor");
  const showSkipped = request.nextUrl.searchParams.get("skipped") === "1";
  const sheetFilter = request.nextUrl.searchParams.get("sheet");
  const sheetDump = request.nextUrl.searchParams.get("dump_raw") === "1";

  const collected = await collectArchiveContract();
  const keywords = await buildDynamicCompanyKeywords();

  // 모든 sheet 순회
  type Item = {
    sheet: string;
    row: number;
    values: Record<string, string>;
    normalized: ReturnType<typeof normalizeArchiveRow>;
  };
  const matchedTarget: Item[] = [];
  const allNormalized: NonNullable<ReturnType<typeof normalizeArchiveRow>>[] = [];

  const sheetSummaries: Array<{
    name: string;
    fetched: number;
    normalized: number;
    withCompany: number;
    error: string | null;
  }> = [];

  for (const sh of collected.sheets) {
    const norms = normalizeArchiveRows(sh.rows, keywords);
    sheetSummaries.push({
      name: sh.sheetName,
      fetched: sh.fetchedCount,
      normalized: norms.length,
      withCompany: norms.filter((n) => n.companyName).length,
      error: sh.error ?? null,
    });
    allNormalized.push(...norms);
    if (targetInstructor) {
      for (const raw of sh.rows) {
        const inst = (raw.values["강사명"] ?? "").trim();
        if (inst === targetInstructor || inst.includes(targetInstructor)) {
          const n = normalizeArchiveRow(raw, keywords);
          matchedTarget.push({
            sheet: sh.sheetName,
            row: raw.rowNumber,
            values: raw.values,
            normalized: n,
          });
        }
      }
    }
  }

  // skipped instructor list (DB에 없거나 alias 미적용)
  let skippedList: { name: string; count: number; matched?: boolean }[] = [];
  if (showSkipped) {
    const allInstructors = await prisma.instructor.findMany({
      select: { id: true, name: true, flag: true, createdAt: true },
    });
    const canonical = buildCanonicalInstructorByNameMap(allInstructors);
    const counts = new Map<string, number>();
    for (const n of allNormalized) {
      const name = n.instructorName ?? "";
      if (!name) continue;
      if (!canonical.get(name)) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
    skippedList = Array.from(counts.entries())
      .map(([name, count]) => ({ name, count, matched: false }))
      .sort((a, b) => b.count - a.count);
  }

  // Sheet raw dump (변경계약 등 normalize 실패 sheet 진단)
  let rawDump: Array<{
    sheet: string;
    row: number;
    headers: string[];
    values: Record<string, string>;
  }> | undefined;
  if (sheetFilter && sheetDump) {
    rawDump = [];
    for (const sh of collected.sheets) {
      if (!sh.sheetName.includes(sheetFilter)) continue;
      for (const r of sh.rows.slice(0, 5)) {
        rawDump.push({
          sheet: sh.sheetName,
          row: r.rowNumber,
          headers: Object.keys(r.values),
          values: r.values,
        });
      }
    }
  }

  return NextResponse.json({
    ok: true,
    sheet_summaries: sheetSummaries,
    dynamic_keywords_count: keywords.length,
    target_instructor: targetInstructor ?? null,
    target_matched_rows: targetInstructor ? matchedTarget.slice(0, 50) : undefined,
    target_matched_count: targetInstructor ? matchedTarget.length : undefined,
    skipped_instructor_list: showSkipped ? skippedList : undefined,
    skipped_unique_count: showSkipped ? skippedList.length : undefined,
    skipped_total_rows: showSkipped
      ? skippedList.reduce((s, x) => s + x.count, 0)
      : undefined,
    raw_dump: rawDump,
  });
}
