/**
 * POST /api/admin/apply-data-insufficient-hide
 *
 * 이은지류 hide 룰 적용 endpoint (one-shot):
 *  1) `is_data_insufficient` 컬럼이 없으면 추가 (idempotent ALTER TABLE).
 *  2) `recalculateAllScores({ validateIssues: false })` 호출.
 *     → 4중 zero 강사 (contractSheetRows=0 + satisfactionCount=0 + totalCourses=0)
 *       의 `is_data_insufficient = true` 로 갱신 + score=0 + breakdown=0.
 *  3) 결과 요약(updated count, 영향 강사 수) 반환.
 *
 * 단일 path 로 prod DB schema 확장 + 전체 재계산을 한 번에.
 *
 * 인증: CRON_SECRET (header 또는 query secret)
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";
import { recalculateAllScores } from "@/lib/score-recalculator";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorize(request: NextRequest): boolean {
  const headerSecret = request.headers.get(CRON_SECRET_HEADER);
  if (isValidCronSecret(headerSecret)) return true;
  const querySecret = request.nextUrl.searchParams.get("secret");
  if (isValidCronSecret(querySecret)) return true;
  return false;
}

export async function POST(request: NextRequest) {
  if (!authorize(request)) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 }
    );
  }

  const startedAt = Date.now();
  const steps: Record<string, unknown> = {};

  // Step 1: ensure column exists (idempotent)
  try {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "instructors" ADD COLUMN IF NOT EXISTS "is_data_insufficient" BOOLEAN NOT NULL DEFAULT false`
    );
    steps.alter_column = "ok";
  } catch (err) {
    steps.alter_column_error = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { ok: false, steps },
      { status: 500 }
    );
  }

  // Step 2: count "이은지류" 강사 (before)
  let beforeCount = 0;
  try {
    beforeCount = await prisma.instructor.count({
      where: {
        contractSheetRows: 0,
        satisfactionCount: 0,
        totalCourses: 0,
        isPracticeCoach: false,
        OR: [{ flag: null }, { NOT: { flag: "실습코치" } }],
      },
    });
    steps.before_count = beforeCount;
  } catch (err) {
    steps.before_count_error = err instanceof Error ? err.message : String(err);
  }

  // Step 3: recalc all scores → writes is_data_insufficient
  try {
    const result = await recalculateAllScores({ validateIssues: false });
    steps.recalc = {
      updatedInstructors: result.updatedInstructors,
      totalInstructors: result.totalInstructors,
      timings: result.timings,
    };
  } catch (err) {
    steps.recalc_error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, steps }, { status: 500 });
  }

  // Step 4: count is_data_insufficient=true (after)
  let afterFlaggedCount = 0;
  try {
    afterFlaggedCount = await prisma.instructor.count({
      where: { isDataInsufficient: true },
    });
    steps.after_flagged_count = afterFlaggedCount;
  } catch (err) {
    steps.after_flagged_count_error =
      err instanceof Error ? err.message : String(err);
  }

  return NextResponse.json({
    ok: true,
    elapsed_ms: Date.now() - startedAt,
    steps,
  });
}
