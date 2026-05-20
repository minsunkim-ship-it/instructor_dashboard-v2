/**
 * POST /api/admin/sync-top100-oi
 *   body: { dryRun?: boolean }
 *
 * 강사 list endpoint top 100 (실습코치 제외, score desc) 중에서
 * InstructorIntelligence.promptVersion이 현재 PROMPT_VERSION과 다른 강사만
 * generateOperationalIntelligence로 재생성.
 *
 * 활용: 매일 cron 호출하면 score 변동으로 top 100에 새로 진입한 강사 +
 * prompt 업그레이드 직후 자동 동기화.
 *
 * 만족도 가드레일: satisfactionImportItem read-only input. 변경 없음.
 *
 * 인증: CRON_SECRET
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";
import {
  generateOperationalIntelligence,
  CURRENT_OPERATIONAL_INTELLIGENCE_PROMPT_VERSION,
} from "@/lib/operational-intelligence";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: {
    dryRun?: boolean;
    top?: number;
    batchSize?: number;
  } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {}

  const top = typeof body.top === "number" && body.top > 0 ? body.top : 100;
  const dryRun = body.dryRun === true;
  const batchSize =
    typeof body.batchSize === "number" && body.batchSize > 0
      ? body.batchSize
      : undefined;

  // 강사 list endpoint와 동일: 실습코치 제외, score desc.
  const visibleFilter: import("@prisma/client").Prisma.InstructorWhereInput = {
    AND: [
      { OR: [{ flag: null }, { flag: { not: "실습코치" } }] },
      { isPracticeCoach: false },
    ],
  };
  const topInst = await prisma.instructor.findMany({
    where: visibleFilter,
    orderBy: [{ score: "desc" }, { name: "asc" }],
    take: top,
    select: { id: true, name: true },
  });
  const topIds = topInst.map((r) => r.id);

  const existingOI = await prisma.instructorIntelligence.findMany({
    where: { instructorDbId: { in: topIds } },
    select: {
      instructorDbId: true,
      promptVersion: true,
      generatedAt: true,
    },
  });
  const oiByInstructor = new Map(
    existingOI.map((row) => [row.instructorDbId, row])
  );

  const staleIds: string[] = [];
  const upToDateIds: string[] = [];
  const newEntryIds: string[] = [];
  for (const inst of topInst) {
    const oi = oiByInstructor.get(inst.id);
    if (!oi) {
      newEntryIds.push(inst.id);
      staleIds.push(inst.id);
      continue;
    }
    if (oi.promptVersion !== CURRENT_OPERATIONAL_INTELLIGENCE_PROMPT_VERSION) {
      staleIds.push(inst.id);
    } else {
      upToDateIds.push(inst.id);
    }
  }

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      mode: "dry-run",
      current_prompt_version: CURRENT_OPERATIONAL_INTELLIGENCE_PROMPT_VERSION,
      top_count: topIds.length,
      stale_count: staleIds.length,
      up_to_date_count: upToDateIds.length,
      new_entry_count: newEntryIds.length,
      new_entry_names: topInst
        .filter((i) => newEntryIds.includes(i.id))
        .map((i) => i.name),
      stale_ids: staleIds,
    });
  }

  if (staleIds.length === 0) {
    return NextResponse.json({
      ok: true,
      message: "all up to date",
      current_prompt_version: CURRENT_OPERATIONAL_INTELLIGENCE_PROMPT_VERSION,
      top_count: topIds.length,
      up_to_date_count: upToDateIds.length,
    });
  }

  // batchSize 지정 시 첫 batchSize명만 처리 — Cloudflare 100s timeout 회피.
  const toProcess = batchSize ? staleIds.slice(0, batchSize) : staleIds;
  const remaining = batchSize ? staleIds.slice(batchSize) : [];

  const startedAt = Date.now();
  const result = await generateOperationalIntelligence({
    instructorIds: toProcess,
  });
  const elapsedMs = Date.now() - startedAt;

  return NextResponse.json({
    ok: true,
    mode: "apply",
    generated_at: new Date().toISOString(),
    elapsed_ms: elapsedMs,
    current_prompt_version: CURRENT_OPERATIONAL_INTELLIGENCE_PROMPT_VERSION,
    top_count: topIds.length,
    regenerated_count: toProcess.length,
    remaining_count: remaining.length,
    new_entry_count: newEntryIds.length,
    up_to_date_count: upToDateIds.length,
    updated: result.updatedCount,
    source_counts: result.sourceCounts,
  });
}
