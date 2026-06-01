/**
 * GET /api/admin/probe-instructor-record-companies?names=신승진,오세규,민경주
 *
 * 강사별 satisfaction record의 회사명 분포 dump.
 * archive 시트에 강의가 없는 강사의 진짜 source가 어디인지 진단.
 *
 * 인증: CRON_SECRET
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const namesParam = request.nextUrl.searchParams.get("names");
  if (!namesParam) {
    return NextResponse.json({ ok: false, error: "names required" }, { status: 400 });
  }
  const names = namesParam.split(",").map((s) => s.trim()).filter(Boolean);

  const out: Array<{
    name: string;
    instructor_id: string | null;
    record_count: number;
    th_count: number;
    record_company_distribution: Array<{ company: string | null; count: number }>;
    record_source_type_distribution: Array<{ sourceType: string; count: number }>;
    record_year_distribution: Array<{ year: string; count: number }>;
    th_company_distribution: Array<{ company: string | null; count: number; sourceType: string | null }>;
  }> = [];

  for (const name of names) {
    const inst = await prisma.instructor.findFirst({ where: { name } });
    if (!inst) {
      out.push({
        name,
        instructor_id: null,
        record_count: 0,
        th_count: 0,
        record_company_distribution: [],
        record_source_type_distribution: [],
        record_year_distribution: [],
        th_company_distribution: [],
      });
      continue;
    }
    const records = await prisma.satisfactionRecord.findMany({
      where: { instructorDbId: inst.id },
      select: { companyName: true, sourceType: true, responseDate: true },
    });
    const ths = await prisma.teachingHistory.findMany({
      where: { instructorDbId: inst.id },
      select: { companyName: true, sourceType: true },
    });
    const cdist = new Map<string, number>();
    const sdist = new Map<string, number>();
    const ydist = new Map<string, number>();
    for (const r of records) {
      const c = r.companyName ?? "(null)";
      cdist.set(c, (cdist.get(c) ?? 0) + 1);
      sdist.set(r.sourceType, (sdist.get(r.sourceType) ?? 0) + 1);
      const y = r.responseDate?.toISOString().slice(0, 7) ?? "(null)";
      ydist.set(y, (ydist.get(y) ?? 0) + 1);
    }
    const tdist = new Map<string, { count: number; sourceType: string | null }>();
    for (const t of ths) {
      const c = t.companyName ?? "(null)";
      const cur = tdist.get(c) ?? { count: 0, sourceType: t.sourceType };
      cur.count += 1;
      tdist.set(c, cur);
    }
    out.push({
      name,
      instructor_id: inst.id,
      record_count: records.length,
      th_count: ths.length,
      record_company_distribution: Array.from(cdist.entries())
        .map(([c, n]) => ({ company: c, count: n }))
        .sort((a, b) => b.count - a.count),
      record_source_type_distribution: Array.from(sdist.entries())
        .map(([s, n]) => ({ sourceType: s, count: n })),
      record_year_distribution: Array.from(ydist.entries())
        .map(([y, n]) => ({ year: y, count: n }))
        .sort((a, b) => a.year.localeCompare(b.year)),
      th_company_distribution: Array.from(tdist.entries())
        .map(([c, v]) => ({ company: c, count: v.count, sourceType: v.sourceType }))
        .sort((a, b) => b.count - a.count),
    });
  }
  return NextResponse.json({ ok: true, instructors: out });
}
