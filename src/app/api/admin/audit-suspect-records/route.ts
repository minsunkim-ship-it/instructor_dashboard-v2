/**
 * GET /api/admin/audit-suspect-records?score_lte=2.5&n_lte=2&limit=200
 *
 * 의심 record bulk list: score≤score_lte + respondentCount≤n_lte.
 * 각 record에 대해 가까운 강사 후보 (같은 회사·responseDate ±30일 TH 보유) 제시.
 *
 * 인증: CRON_SECRET
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";
import {
  normalizeCompanyWithAlias,
  companyMatchesWithAlias,
} from "@/lib/company-aliases";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// alias-aware normalize. KB금융그룹 ↔ 케이비국민은행 / 웰컴저축은행 ↔ 웰컴금융그룹
// 같은 그룹사 매칭 통합 (group SET 적용).
function normalize(value: string | null | undefined): string {
  return normalizeCompanyWithAlias(value);
}

export async function GET(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const scoreLte = parseFloat(request.nextUrl.searchParams.get("score_lte") ?? "2.5");
  const nLte = parseInt(request.nextUrl.searchParams.get("n_lte") ?? "2", 10);
  const limit = parseInt(request.nextUrl.searchParams.get("limit") ?? "200", 10);

  const records = await prisma.satisfactionRecord.findMany({
    where: {
      score: { lte: scoreLte },
      respondentCount: { lte: nLte },
    },
    orderBy: { score: "asc" },
    take: limit,
    select: {
      id: true,
      instructorDbId: true,
      score: true,
      respondentCount: true,
      companyName: true,
      courseName: true,
      responseDate: true,
      sourceType: true,
      sourceRef: true,
      instructor: { select: { id: true, name: true } },
    },
  });

  // TH for cross-check — fetch within ±60d of any record responseDate to keep query small
  const respDates = records.map((r) => r.responseDate).filter((d): d is Date => !!d);
  type THCandidate = {
    instructorDbId: string;
    companyName: string | null;
    courseName: string | null;
    startDate: Date | null;
    endDate: Date | null;
    instructor: { name: string } | null;
  };
  let candidateTHs: THCandidate[] = [];
  if (respDates.length > 0) {
    const minDate = new Date(Math.min(...respDates.map((d) => d.getTime())));
    const maxDate = new Date(Math.max(...respDates.map((d) => d.getTime())));
    minDate.setDate(minDate.getDate() - 60);
    maxDate.setDate(maxDate.getDate() + 30);
    candidateTHs = await prisma.teachingHistory.findMany({
      where: {
        OR: [
          { startDate: { gte: minDate, lte: maxDate } },
          { endDate: { gte: minDate, lte: maxDate } },
        ],
      },
      select: {
        instructorDbId: true,
        companyName: true,
        courseName: true,
        startDate: true,
        endDate: true,
        instructor: { select: { name: true } },
      },
    });
  }

  // 본인 회사 TH any-date 매칭용 별도 fetch (window 결함 회피)
  const recordInstructorIds = Array.from(new Set(records.map((r) => r.instructorDbId)));
  const selfAllTHs = await prisma.teachingHistory.findMany({
    where: {
      instructorDbId: { in: recordInstructorIds },
      companyName: { not: null },
    },
    select: { instructorDbId: true, companyName: true },
  });
  const selfTHByInst = new Map<string, string[]>();
  for (const t of selfAllTHs) {
    if (!t.companyName) continue;
    const arr = selfTHByInst.get(t.instructorDbId) ?? [];
    arr.push(t.companyName);
    selfTHByInst.set(t.instructorDbId, arr);
  }

  const items = records.map((r) => {
    const recCompany = normalize(r.companyName);
    const respMs = r.responseDate?.getTime() ?? null;
    const candidates: Array<{
      instructor: string;
      company: string | null;
      course: string | null;
      start: string | null;
      end: string | null;
      days_from_response: number | null;
    }> = [];
    if (respMs !== null && recCompany.length >= 2) {
      const THIRTY = 30 * 24 * 60 * 60 * 1000;
      for (const t of candidateTHs) {
        if (!t.companyName) continue;
        // alias + group SET 적용된 매칭
        if (!companyMatchesWithAlias(t.companyName, r.companyName)) {
          continue;
        }
        const start = t.startDate?.getTime() ?? null;
        const end = t.endDate?.getTime() ?? start;
        if (start === null) continue;
        const closest =
          respMs >= start && respMs <= (end ?? start)
            ? 0
            : Math.min(Math.abs(respMs - start), Math.abs(respMs - (end ?? start)));
        if (closest <= THIRTY) {
          candidates.push({
            instructor: t.instructor?.name ?? "(unknown)",
            company: t.companyName,
            course: t.courseName?.slice(0, 80) ?? null,
            start: t.startDate?.toISOString().slice(0, 10) ?? null,
            end: t.endDate?.toISOString().slice(0, 10) ?? null,
            days_from_response: Math.round(closest / (24 * 60 * 60 * 1000)),
          });
        }
      }
    }
    candidates.sort((a, b) => (a.days_from_response ?? 999) - (b.days_from_response ?? 999));
    // dedupe by instructor name keeping closest
    const seen = new Set<string>();
    const uniqueCands = candidates.filter((c) => {
      if (seen.has(c.instructor)) return false;
      seen.add(c.instructor);
      return true;
    });

    const matched_instructor = r.instructor.name;

    // 진짜 audit 의도: 본인이 같은 회사 TH가 있으면 (날짜 ±30일 무관) 정상 매칭.
    // selfTHByInst는 instructor 본인의 ALL TH 회사명 (date filter 없음).
    let self_has_company_th_any_date = false;
    if (recCompany.length >= 2) {
      const selfTHCompanies = selfTHByInst.get(r.instructorDbId) ?? [];
      for (const co of selfTHCompanies) {
        if (companyMatchesWithAlias(co, r.companyName)) {
          self_has_company_th_any_date = true;
          break;
        }
      }
    }
    const instructor_in_candidates =
      self_has_company_th_any_date ||
      uniqueCands.some((c) => c.instructor === matched_instructor);
    const suggested_alternative =
      !instructor_in_candidates && uniqueCands.length > 0 ? uniqueCands[0].instructor : null;

    return {
      record_id: r.id,
      matched_instructor,
      matched_instructor_id: r.instructorDbId,
      score: Number(r.score),
      n: r.respondentCount,
      company: r.companyName,
      course: r.courseName?.slice(0, 80) ?? null,
      response_date: r.responseDate?.toISOString().slice(0, 10) ?? null,
      source_type: r.sourceType,
      source_ref: r.sourceRef,
      th_candidates: uniqueCands.slice(0, 5),
      instructor_in_candidates,
      suggested_alternative,
    };
  });

  const summary = {
    total: items.length,
    instructor_mismatch_count: items.filter((i) => !i.instructor_in_candidates).length,
    suggested_alternative_count: items.filter((i) => i.suggested_alternative !== null).length,
  };

  return NextResponse.json({ ok: true, summary, records: items });
}
