/**
 * POST /api/admin/recompute-aggregates
 *
 * 외곡 #3 (P0-5 가중 평균) 적용 trigger.
 * SQL 산식 변경(satisfaction-applier.ts:refreshSatisfactionAggregates) 후 모든 강사의
 * instructors.satisfaction_avg 컬럼을 가중 평균으로 재계산.
 *
 * 인증: CRON_SECRET (header `x-cron-secret` 또는 query `?secret=`)
 *
 * 호출 예 (브라우저 콘솔 또는 curl):
 *   fetch('/api/admin/recompute-aggregates?secret=YOUR_CRON_SECRET', { method: 'POST' })
 *     .then(r => r.json()).then(console.log)
 *
 * 응답:
 *   { ok: true, durationMs, sampleInstructors: [{ id, name, before, after }] }
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { refreshSatisfactionAggregates } from "@/lib/pipeline/satisfaction-applier";
import {
  CRON_SECRET_HEADER,
  isValidCronSecret,
} from "@/lib/cron-auth";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

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

  // 변경 효과 확인용 sample (가중 평균 적용 후 변화 비교).
  const sampleBefore = await prisma.instructor.findMany({
    where: {
      satisfactionAvg: { not: null },
      satisfactionCount: { gt: 1 },
    },
    select: { id: true, name: true, satisfactionAvg: true, satisfactionCount: true },
    orderBy: { satisfactionCount: "desc" },
    take: 10,
  });

  await refreshSatisfactionAggregates();

  const sampleAfter = await prisma.instructor.findMany({
    where: { id: { in: sampleBefore.map((s) => s.id) } },
    select: { id: true, name: true, satisfactionAvg: true, satisfactionCount: true },
  });

  const afterById = new Map(sampleAfter.map((row) => [row.id, row]));

  const sample = sampleBefore.map((before) => {
    const after = afterById.get(before.id);
    return {
      id: before.id,
      name: before.name,
      count: before.satisfactionCount,
      before: before.satisfactionAvg !== null ? Number(before.satisfactionAvg) : null,
      after: after?.satisfactionAvg !== null && after?.satisfactionAvg !== undefined
        ? Number(after.satisfactionAvg)
        : null,
      delta:
        before.satisfactionAvg !== null && after?.satisfactionAvg !== null && after?.satisfactionAvg !== undefined
          ? Number((Number(after.satisfactionAvg) - Number(before.satisfactionAvg)).toFixed(2))
          : null,
    };
  });

  return NextResponse.json({
    ok: true,
    durationMs: Date.now() - startedAt,
    sampleInstructors: sample,
    note: "instructors.satisfaction_avg recomputed using weighted average (P0-5 correction). Sample shows top-10 instructors by satisfactionCount with before/after values.",
  });
}
