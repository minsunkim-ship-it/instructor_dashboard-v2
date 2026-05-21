/**
 * GET /api/backoffice/instructor-gaps?min_gap=5&limit=40
 *
 * NextAuth session 또는 CRON_SECRET 인증. th_record_gap 큰 강사 list.
 * 운영자가 매칭 누락 가능성 큰 강사 검토.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth, isAuthDisabled } from "@/auth";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const headerSecret = request.headers.get(CRON_SECRET_HEADER);
  let isAuthed = false;
  if (isValidCronSecret(headerSecret)) {
    isAuthed = true;
  } else if (isAuthDisabled()) {
    isAuthed = true;
  } else {
    const session = await auth();
    if (session?.user) isAuthed = true;
  }
  if (!isAuthed) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const minGap = parseInt(request.nextUrl.searchParams.get("min_gap") ?? "5", 10);
  const limit = parseInt(request.nextUrl.searchParams.get("limit") ?? "40", 10);

  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

  // satisfactionCount > 0 인 instructor만 — sparse 강사 중심
  const instructors = await prisma.instructor.findMany({
    where: {
      satisfactionCount: { gt: 0 },
    },
    select: {
      id: true,
      name: true,
      satisfactionAvg: true,
      satisfactionCount: true,
    },
    orderBy: { satisfactionCount: "desc" },
    take: 200,
  });

  const results: Array<{
    instructor_id: string;
    instructor_name: string;
    record_count: number;
    avg_score: number | null;
    th_count_recent: number;
    gap: number;
    th_companies: string[];
    record_companies: string[];
    missing_companies: string[];
  }> = [];

  for (const i of instructors) {
    const ths = await prisma.teachingHistory.findMany({
      where: {
        instructorDbId: i.id,
        startDate: { gte: sixMonthsAgo },
        companyName: { not: null },
      },
      select: { companyName: true },
    });
    const recs = await prisma.satisfactionRecord.findMany({
      where: {
        instructorDbId: i.id,
        responseDate: { gte: sixMonthsAgo },
      },
      select: { companyName: true },
    });
    const thCompanies = Array.from(
      new Set(ths.map((t) => (t.companyName ?? "").trim()).filter(Boolean))
    );
    const recCompanies = Array.from(
      new Set(recs.map((r) => (r.companyName ?? "").trim()).filter(Boolean))
    );
    const gap = ths.length - recs.length;
    if (gap < minGap) continue;
    const recCompanyNormSet = new Set(recCompanies.map((c) => c.replace(/\s+/g, "").toLowerCase()));
    const missing = thCompanies.filter(
      (c) => !recCompanyNormSet.has(c.replace(/\s+/g, "").toLowerCase())
    );
    results.push({
      instructor_id: i.id,
      instructor_name: i.name,
      record_count: recs.length,
      avg_score: i.satisfactionAvg !== null ? Number(i.satisfactionAvg) : null,
      th_count_recent: ths.length,
      gap,
      th_companies: thCompanies.slice(0, 10),
      record_companies: recCompanies.slice(0, 10),
      missing_companies: missing.slice(0, 10),
    });
  }

  results.sort((a, b) => b.gap - a.gap);
  return NextResponse.json({
    ok: true,
    total: results.length,
    instructors: results.slice(0, limit),
  });
}
