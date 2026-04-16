/**
 * POST /api/pipeline/gmail — Pilot 4-5 v2
 *
 * 04_data_pipeline.md 5-5절, 5-5-1절, 5-5-2절, 7-1절, 17절, 18-1절, 21-2절
 * 03_data_model.md 4-8절 pipeline_runs, 4-9절 source_sync_logs, 4-10절 activity_import_items
 *
 * 흐름:
 *   1. pipeline_runs 1건 생성 (running)
 *   2. source_checkpoints에서 target address별 checkpoint 로드
 *   3. Gmail direct API로 incremental 수집 (checkpoint 없으면 full backfill) → 정규화 → upsert
 *   4. activity_review_registries 자동 취합 + auto_accepted/approved registry만 영향받은 강사 aggregate 재계산
 *   5. source_checkpoints 갱신 (target별 last_internal_date_ms)
 *   6. source_sync_logs 1건 기록
 *   7. pipeline_runs 종료
 *
 * query param:
 *   ?mode=reconcile → checkpoint 무시, full backfill 강제 실행
 */

import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  collectFromGmail,
  type GmailTargetCheckpoint,
} from "@/lib/pipeline/gmail-activity-collector";
import { normalizeGmailCollect } from "@/lib/pipeline/gmail-activity-normalizer";
import { applyActivities } from "@/lib/pipeline/activity-applier";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function parsePositiveInt(
  value: string | null,
  fallback: number,
  max?: number
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return typeof max === "number" ? Math.min(parsed, max) : parsed;
}

/**
 * target address별 checkpoint를 source_checkpoints 테이블에서 로드한다.
 * scope_key = `gmail:target:{targetAddress}`
 */
async function loadGmailCheckpoints(
  targetAddresses: string[]
): Promise<GmailTargetCheckpoint[]> {
  const checkpoints: GmailTargetCheckpoint[] = [];

  for (const addr of targetAddresses) {
    const scopeKey = `gmail:target:${addr}`;
    const row = await prisma.sourceCheckpoint.findUnique({
      where: { sourceType_scopeKey: { sourceType: "gmail", scopeKey } },
    });

    if (row) {
      const json = row.checkpointJson as Record<string, unknown>;
      checkpoints.push({
        targetAddress: addr,
        lastInternalDateMs:
          typeof json.last_internal_date_ms === "string"
            ? json.last_internal_date_ms
            : null,
      });
    }
  }

  return checkpoints;
}

/**
 * 수집 결과에서 target address별 max internalDate를 계산하고 checkpoint를 갱신한다.
 */
async function saveGmailCheckpoints(
  threads: Array<{
    matchedTargetAddresses: string[];
    lastInternalDateMs: string | null;
  }>
): Promise<void> {
  // target address별 max internalDateMs 계산
  const maxByTarget = new Map<string, string>();

  for (const t of threads) {
    if (!t.lastInternalDateMs) continue;
    for (const addr of t.matchedTargetAddresses) {
      const current = maxByTarget.get(addr);
      if (!current || t.lastInternalDateMs > current) {
        maxByTarget.set(addr, t.lastInternalDateMs);
      }
    }
  }

  for (const [addr, maxMs] of maxByTarget.entries()) {
    const scopeKey = `gmail:target:${addr}`;
    await prisma.sourceCheckpoint.upsert({
      where: { sourceType_scopeKey: { sourceType: "gmail", scopeKey } },
      create: {
        sourceType: "gmail",
        scopeKey,
        checkpointJson: { last_internal_date_ms: maxMs },
        lastSyncedAt: new Date(),
      },
      update: {
        checkpointJson: { last_internal_date_ms: maxMs },
        lastSyncedAt: new Date(),
      },
    });
  }
}

export async function POST(request: NextRequest) {
  const requestId = `req_${crypto.randomUUID()}`;
  const isReconcile = request.nextUrl.searchParams.get("mode") === "reconcile";
  const query = request.nextUrl.searchParams.get("query")?.trim() || undefined;
  const maxPages = parsePositiveInt(
    request.nextUrl.searchParams.get("maxPages"),
    5
  );
  const pageSize = parsePositiveInt(
    request.nextUrl.searchParams.get("pageSize"),
    100,
    500
  );

  const run = await prisma.pipelineRun.create({
    data: {
      runType: isReconcile ? "pilot_4_5_gmail_reconcile" : "pilot_4_5_gmail",
      status: "running",
      triggeredBy: "api:/api/pipeline/gmail",
    },
  });

  const syncStartedAt = new Date();

  try {
    // Step 1: target addresses (env에서 읽음)
    const targetAddresses = (process.env.GMAIL_TARGET_ADDRESSES ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);

    // Step 2: checkpoint 로드 (reconcile 모드면 빈 배열 → full backfill)
    const checkpoints = isReconcile ? [] : await loadGmailCheckpoints(targetAddresses);

    // Step 3: Gmail direct API 수집
    const collect = await collectFromGmail({
      checkpoints,
      query,
      maxPages,
      pageSize,
    });

    // Step 4: 정규화
    const normalized = normalizeGmailCollect(collect);

    // Step 5: upsert + registry 취합 + aggregate 재계산 (영향받은 강사만)
    const applyResult = await applyActivities(run.id, [], normalized);

    // Step 6: checkpoint 갱신
    await saveGmailCheckpoints(collect.threads);

    // Step 7: source_sync_logs
    const syncStatus: "success" | "partial" =
      applyResult.items.invalid > 0 || collect.targetAddressErrors.length > 0
        ? "partial"
        : "success";

    await prisma.sourceSyncLog.create({
      data: {
        runId: run.id,
        sourceType: "gmail",
        status: syncStatus,
        fetchedCount: collect.threads.length,
        updatedCount: applyResult.aggregateUpdates.length,
        errorMessage:
          collect.targetAddressErrors.length > 0
            ? `target_address_errors:${collect.targetAddressErrors
                .map((entry) => entry.targetAddress)
                .join(",")}`
            : applyResult.items.invalid > 0
              ? `invalid_items:${applyResult.items.invalid}`
              : null,
        startedAt: syncStartedAt,
        finishedAt: new Date(),
      },
    });

    // Step 8: pipeline_runs 종료
    const runSummary: Prisma.InputJsonObject = {
      pipeline: isReconcile ? "pilot_4_5_gmail_reconcile" : "pilot_4_5_gmail",
      mode: isReconcile ? "reconcile" : (collect.incremental ? "incremental" : "full_backfill"),
      account_email: collect.accountEmail,
      query: query ?? "in:anywhere",
      max_pages: maxPages,
      page_size: pageSize,
      target_addresses: collect.targetAddresses as unknown as Prisma.InputJsonArray,
      target_address_errors:
        collect.targetAddressErrors as unknown as Prisma.InputJsonArray,
      threads_fetched: collect.threads.length,
      activity_items_inserted: applyResult.items.inserted,
      activity_items_updated: applyResult.items.updated,
      matched_count: applyResult.items.matched,
      unmatched_count: applyResult.items.unmatched,
      ambiguous_count: applyResult.items.ambiguous,
      invalid_count: applyResult.items.invalid,
      registry_auto_accepted_count: applyResult.registries.autoAccepted,
      registry_pending_count: applyResult.registries.pending,
      registry_approved_count: applyResult.registries.approved,
      registry_rejected_count: applyResult.registries.rejected,
      registry_invalid_count: applyResult.registries.invalid,
      affected_instructors: applyResult.affectedInstructorIds.length,
      unmatched_samples:
        applyResult.unmatchedSamples as unknown as Prisma.InputJsonArray,
      ambiguous_samples:
        applyResult.ambiguousSamples as unknown as Prisma.InputJsonArray,
    };

    await prisma.pipelineRun.update({
      where: { id: run.id },
      data: {
        status: syncStatus,
        finishedAt: new Date(),
        summary: runSummary,
      },
    });

    return NextResponse.json({
      status: "success",
      meta: {
        request_id: requestId,
        pipeline: "pilot_4_5_gmail",
        run_id: run.id,
        run_status: syncStatus,
        mode: isReconcile ? "reconcile" : (collect.incremental ? "incremental" : "full_backfill"),
      },
      data: runSummary,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    await prisma.sourceSyncLog.create({
      data: {
        runId: run.id,
        sourceType: "gmail",
        status: "failed",
        fetchedCount: 0,
        updatedCount: 0,
        errorMessage: message,
        startedAt: syncStartedAt,
        finishedAt: new Date(),
      },
    });

    await prisma.pipelineRun.update({
      where: { id: run.id },
      data: {
        status: "failed",
        finishedAt: new Date(),
        summary: { error: message },
      },
    });

    return NextResponse.json(
      {
        status: "error",
        meta: {
          request_id: requestId,
          pipeline: "pilot_4_5_gmail",
          run_id: run.id,
        },
        errors: [{ code: "PIPELINE_FAILED", message }],
      },
      { status: 500 }
    );
  }
}
