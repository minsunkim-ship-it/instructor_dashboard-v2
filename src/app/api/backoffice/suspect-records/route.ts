/**
 * GET /api/backoffice/suspect-records?score_lte=2.5&n_lte=2&limit=50
 *
 * NextAuth session 인증. 신뢰도 낮은 SatisfactionRecord (score≤score_lte + n≤n_lte) list.
 * 매칭 오류 의심 운영자 검토 큐. 각 record에 가까운 강사 후보 cross-check 포함.
 *
 * Backoffice UI에서 /admin/review 보조 섹션으로 호출.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth, isAuthDisabled } from "@/auth";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

function normalize(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/[\s()[\]{}.,:;'"`~!?+\-_/\\|]+/g, "");
}

export async function GET(request: NextRequest) {
  // 인증: NextAuth 세션 또는 CRON_SECRET
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

  const scoreLte = parseFloat(request.nextUrl.searchParams.get("score_lte") ?? "2.5");
  const nLte = parseInt(request.nextUrl.searchParams.get("n_lte") ?? "2", 10);
  const limit = parseInt(request.nextUrl.searchParams.get("limit") ?? "50", 10);

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
      instructor: { select: { name: true } },
    },
  });

  const respDates = records.map((r) => r.responseDate).filter((d): d is Date => !!d);
  let candidateTHs: Awaited<ReturnType<typeof prisma.teachingHistory.findMany>> = [];
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
        instructor: { select: { id: true, name: true } },
      },
    });
  }

  const items = records.map((r) => {
    const recCompany = normalize(r.companyName);
    const respMs = r.responseDate?.getTime() ?? null;
    const candidates: Array<{
      instructor_id: string;
      instructor_name: string;
      company: string | null;
      course: string | null;
      start: string | null;
      end: string | null;
      days_from_response: number | null;
    }> = [];
    if (respMs !== null && recCompany.length >= 2) {
      const THIRTY = 30 * 24 * 60 * 60 * 1000;
      for (const t of candidateTHs) {
        if (!t.companyName || !t.instructor) continue;
        const tn = normalize(t.companyName);
        if (!(tn === recCompany || tn.includes(recCompany) || recCompany.includes(tn))) continue;
        const start = t.startDate?.getTime() ?? null;
        const end = t.endDate?.getTime() ?? start;
        if (start === null) continue;
        const closest =
          respMs >= start && respMs <= (end ?? start)
            ? 0
            : Math.min(Math.abs(respMs - start), Math.abs(respMs - (end ?? start)));
        if (closest <= THIRTY) {
          candidates.push({
            instructor_id: t.instructor.id,
            instructor_name: t.instructor.name,
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
    const seen = new Set<string>();
    const uniqueCands = candidates.filter((c) => {
      if (seen.has(c.instructor_id)) return false;
      seen.add(c.instructor_id);
      return true;
    });
    const matched_instructor = r.instructor?.name ?? null;
    const instructor_in_candidates = uniqueCands.some(
      (c) => c.instructor_name === matched_instructor
    );
    return {
      record_id: r.id,
      matched_instructor,
      matched_instructor_id: r.instructorDbId,
      score: Number(r.score),
      respondent_count: r.respondentCount,
      company: r.companyName,
      course: r.courseName,
      response_date: r.responseDate?.toISOString().slice(0, 10) ?? null,
      source_type: r.sourceType,
      source_ref: r.sourceRef,
      th_candidates: uniqueCands.slice(0, 5),
      instructor_in_candidates,
      suggested_alternative:
        !instructor_in_candidates && uniqueCands.length > 0
          ? {
              instructor_id: uniqueCands[0].instructor_id,
              instructor_name: uniqueCands[0].instructor_name,
            }
          : null,
    };
  });

  return NextResponse.json({
    ok: true,
    total: items.length,
    records: items,
  });
}
