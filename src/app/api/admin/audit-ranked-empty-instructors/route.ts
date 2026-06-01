/**
 * GET /api/admin/audit-ranked-empty-instructors
 *
 * "이은지류" 강사 전수 추출 (read-only):
 *  - satisfactionCount = 0
 *  - totalCourses = 0
 *  - contractSheetRows = 0
 *  - teachingHistories rowCount = 0 (TH=0)
 *  - rank IS NOT NULL OR score IS NOT NULL
 *
 * 즉, 근거 데이터(만족도/계약시트/teaching_history/totalCourses)가 전무한데
 * 점수/랭크가 부여된 강사 = list 노출 후보지만 evidence 없는 강사.
 *
 * 인증: CRON_SECRET (header 또는 query secret)
 *
 * Optional params:
 *   - include_practice_coach=1 → 실습코치 포함 (기본 제외, list-visibility 일치)
 *   - require_rank=1 → rank IS NOT NULL 강사만 (기본 score OR rank)
 *   - limit=N (기본 500)
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorize(request: NextRequest): boolean {
  const headerSecret = request.headers.get(CRON_SECRET_HEADER);
  if (isValidCronSecret(headerSecret)) return true;
  const querySecret = request.nextUrl.searchParams.get("secret");
  if (isValidCronSecret(querySecret)) return true;
  return false;
}

export async function GET(request: NextRequest) {
  if (!authorize(request)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const includePracticeCoach =
    request.nextUrl.searchParams.get("include_practice_coach") === "1";
  const requireRank = request.nextUrl.searchParams.get("require_rank") === "1";
  const limit = Math.min(
    parseInt(request.nextUrl.searchParams.get("limit") ?? "500", 10) || 500,
    2000
  );

  // 1차 필터: satisfactionCount/totalCourses/contractSheetRows 모두 0
  //   + rank 또는 score 부여
  //   + (옵션) 실습코치 제외
  const baseWhere: import("@prisma/client").Prisma.InstructorWhereInput = {
    satisfactionCount: 0,
    totalCourses: 0,
    contractSheetRows: 0,
    ...(requireRank
      ? { rank: { not: null } }
      : { OR: [{ rank: { not: null } }, { score: { not: null } }] }),
    ...(includePracticeCoach
      ? {}
      : {
          AND: [
            {
              OR: [{ flag: null }, { NOT: { flag: "실습코치" } }],
            },
            {
              isPracticeCoach: false,
            },
          ],
        }),
  };

  const candidates = await prisma.instructor.findMany({
    where: baseWhere,
    select: {
      id: true,
      name: true,
      affiliation: true,
      flag: true,
      isPracticeCoach: true,
      rank: true,
      score: true,
      satisfactionAvg: true,
      satisfactionCount: true,
      satisfactionIsImputed: true,
      totalCourses: true,
      contractSheetRows: true,
      salesmapDealCount: true,
      salesmapLastDealAt: true,
      scoreCalculatedAt: true,
    },
    orderBy: [{ rank: "asc" }, { name: "asc" }],
  });

  // 2차 필터: teachingHistories count = 0 (TH=0)
  // candidates 가 많지 않을 가능성이 높지만 chunked count 로 안전하게.
  const ids = candidates.map((c) => c.id);
  let thCounts = new Map<string, number>();
  if (ids.length > 0) {
    const grouped = await prisma.teachingHistory.groupBy({
      by: ["instructorDbId"],
      where: { instructorDbId: { in: ids } },
      _count: { instructorDbId: true },
    });
    thCounts = new Map(
      grouped.map((g) => [g.instructorDbId, g._count.instructorDbId])
    );
  }

  const filtered = candidates.filter((c) => (thCounts.get(c.id) ?? 0) === 0);

  const results = filtered.slice(0, limit).map((c) => ({
    id: c.id,
    name: c.name,
    affiliation: c.affiliation,
    flag: c.flag,
    is_practice_coach: c.isPracticeCoach,
    rank: c.rank,
    score: c.score !== null ? Number(c.score) : null,
    satisfaction_avg:
      c.satisfactionAvg !== null ? Number(c.satisfactionAvg) : null,
    satisfaction_count: c.satisfactionCount,
    satisfaction_is_imputed: c.satisfactionIsImputed,
    total_courses: c.totalCourses,
    contract_sheet_rows: c.contractSheetRows,
    teaching_history_count: thCounts.get(c.id) ?? 0,
    salesmap_deal_count: c.salesmapDealCount,
    salesmap_last_deal_at:
      c.salesmapLastDealAt?.toISOString().slice(0, 10) ?? null,
    score_calculated_at:
      c.scoreCalculatedAt?.toISOString().slice(0, 10) ?? null,
  }));

  return NextResponse.json({
    ok: true,
    generated_at: new Date().toISOString(),
    criteria: {
      satisfaction_count: 0,
      total_courses: 0,
      contract_sheet_rows: 0,
      teaching_history_count: 0,
      require_rank: requireRank,
      include_practice_coach: includePracticeCoach,
    },
    candidate_count_after_db_where: candidates.length,
    final_count: filtered.length,
    instructors: results,
  });
}
