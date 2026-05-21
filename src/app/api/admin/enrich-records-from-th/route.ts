/**
 * POST /api/admin/enrich-records-from-th?mode=dry_run|apply
 *
 * SatisfactionRecord 중 companyName 비어있는 row에 대해 instructor의 TH 중
 * responseDate ±N일 단일 회사면 record.companyName 채움.
 *
 * 적용 대상: drive_satisfaction 중 "X 강사님_만족도" 패턴 sheet 등 회사 정보 누락 케이스
 * 안전장치: 단일 TH 회사만 enrich (여러 회사 있으면 skip)
 *
 * 인증: CRON_SECRET
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const mode = request.nextUrl.searchParams.get("mode") ?? "dry_run";
  const windowDays = parseInt(request.nextUrl.searchParams.get("window_days") ?? "60", 10);
  const instructorName = request.nextUrl.searchParams.get("instructor_name");
  const startedAt = Date.now();

  const records = await prisma.satisfactionRecord.findMany({
    where: {
      OR: [{ companyName: null }, { companyName: "" }],
      responseDate: { not: null },
      ...(instructorName
        ? { instructor: { name: instructorName } }
        : {}),
    },
    select: {
      id: true,
      instructorDbId: true,
      responseDate: true,
      sourceType: true,
      companyName: true,
      instructor: { select: { name: true } },
    },
    take: 500,
  });

  interface Plan {
    record_id: string;
    instructor: string;
    response_date: string;
    matched_company: string;
    th_count: number;
  }
  const plans: Plan[] = [];
  const skipped: { record_id: string; instructor: string; reason: string; companies: string[] }[] = [];

  for (const r of records) {
    if (!r.responseDate) continue;
    const lo = new Date(r.responseDate);
    lo.setUTCDate(lo.getUTCDate() - windowDays);
    const hi = new Date(r.responseDate);
    hi.setUTCDate(hi.getUTCDate() + windowDays);

    // 우선 1순위: responseDate가 TH startDate~endDate 사이에 들어가는 TH (정확 매칭)
    const exactTHs = await prisma.teachingHistory.findMany({
      where: {
        instructorDbId: r.instructorDbId,
        companyName: { not: null },
        startDate: { lte: r.responseDate },
        endDate: { gte: r.responseDate },
      },
      select: { companyName: true, startDate: true, endDate: true },
    });
    const exactCompanies = Array.from(new Set(exactTHs.map((t) => (t.companyName ?? "").trim()).filter(Boolean)));

    let companies: string[];
    if (exactCompanies.length > 0) {
      companies = exactCompanies;
    } else {
      // 2순위: ±N일 window 내 TH (응답 지연 또는 sheet 생성 지연)
      const windowTHs = await prisma.teachingHistory.findMany({
        where: {
          instructorDbId: r.instructorDbId,
          companyName: { not: null },
          OR: [
            { startDate: { gte: lo, lte: hi } },
            { endDate: { gte: lo, lte: hi } },
          ],
        },
        select: { companyName: true },
      });
      companies = Array.from(new Set(windowTHs.map((t) => (t.companyName ?? "").trim()).filter(Boolean)));
    }
    const ths = exactTHs;
    if (companies.length === 1) {
      plans.push({
        record_id: r.id,
        instructor: r.instructor?.name ?? "?",
        response_date: r.responseDate.toISOString().slice(0, 10),
        matched_company: companies[0],
        th_count: ths.length,
      });
    } else {
      skipped.push({
        record_id: r.id,
        instructor: r.instructor?.name ?? "?",
        reason: companies.length === 0 ? "no_th_in_window" : "multiple_th_companies",
        companies,
      });
    }
  }

  if (mode === "dry_run") {
    return NextResponse.json({
      ok: true,
      mode,
      durationMs: Date.now() - startedAt,
      total_null_company: records.length,
      to_update: plans.length,
      skipped_count: skipped.length,
      plans: plans.slice(0, 50),
      skipped_samples: skipped.slice(0, 20),
    });
  }

  let updated = 0;
  for (const p of plans) {
    await prisma.satisfactionRecord.update({
      where: { id: p.record_id },
      data: { companyName: p.matched_company },
    });
    updated += 1;
  }
  return NextResponse.json({
    ok: true,
    mode,
    durationMs: Date.now() - startedAt,
    updated,
    skipped_count: skipped.length,
  });
}
