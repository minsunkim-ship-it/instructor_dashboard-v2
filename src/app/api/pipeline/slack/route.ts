/**
 * POST /api/pipeline/slack — Pilot 4-5 v2
 *
 * 04_data_pipeline.md 5-4절, 5-4-1절, 7-1절, 17절, 18-1절, 21-2절
 * 03_data_model.md 4-8절 pipeline_runs, 4-9절 source_sync_logs, 4-10절 activity_import_items
 *
 * 흐름:
 *   1. pipeline_runs 1건 생성 (running)
 *   2. source_checkpoints에서 채널별 checkpoint 로드
 *   3. Slack direct API로 incremental 수집 (checkpoint 없으면 full backfill) → 정규화 → upsert
 *   4. activity_review_registries 자동 취합 + auto_accepted/approved registry만 영향받은 강사 aggregate 재계산
 *   5. source_checkpoints 갱신 (채널별 last_seen_ts)
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
  collectFromSlack,
  SLACK_PILOT_4_5_CHANNELS,
  type SlackChannelCheckpoint,
} from "@/lib/pipeline/slack-activity-collector";
import { normalizeSlackCollect } from "@/lib/pipeline/slack-activity-normalizer";
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
 * 채널별 checkpoint를 source_checkpoints 테이블에서 로드한다.
 * scope_key = `slack:channel:{channelId}`
 */
async function loadSlackCheckpoints(): Promise<SlackChannelCheckpoint[]> {
  const checkpoints: SlackChannelCheckpoint[] = [];

  for (const ch of SLACK_PILOT_4_5_CHANNELS) {
    const scopeKey = `slack:channel:${ch.channelId}`;
    const row = await prisma.sourceCheckpoint.findUnique({
      where: { sourceType_scopeKey: { sourceType: "slack", scopeKey } },
    });

    if (row) {
      const json = row.checkpointJson as Record<string, unknown>;
      checkpoints.push({
        channelId: ch.channelId,
        lastSeenTs: typeof json.last_seen_ts === "string" ? json.last_seen_ts : null,
      });
    }
  }

  return checkpoints;
}

/**
 * 수집 결과에서 채널별 max ts를 계산하고 checkpoint를 갱신한다.
 */
async function saveSlackCheckpoints(
  channelMessages: Array<{ channelId: string; messages: Array<{ ts: string }> }>
): Promise<void> {
  for (const ch of channelMessages) {
    if (ch.messages.length === 0) continue;

    // 채널 내 가장 큰 ts = 가장 최신 메시지
    let maxTs = "0";
    for (const m of ch.messages) {
      if (m.ts > maxTs) maxTs = m.ts;
    }

    const scopeKey = `slack:channel:${ch.channelId}`;
    await prisma.sourceCheckpoint.upsert({
      where: { sourceType_scopeKey: { sourceType: "slack", scopeKey } },
      create: {
        sourceType: "slack",
        scopeKey,
        checkpointJson: { last_seen_ts: maxTs },
        lastSyncedAt: new Date(),
      },
      update: {
        checkpointJson: { last_seen_ts: maxTs },
        lastSyncedAt: new Date(),
      },
    });
  }
}

export async function POST(request: NextRequest) {
  const requestId = `req_${crypto.randomUUID()}`;
  const isReconcile = request.nextUrl.searchParams.get("mode") === "reconcile";
  const perPageLimit = parsePositiveInt(
    request.nextUrl.searchParams.get("pageSize"),
    200,
    200
  );
  const incrementalMaxPages = parsePositiveInt(
    request.nextUrl.searchParams.get("incrementalMaxPages"),
    5
  );
  const fullBackfillMaxPages = parsePositiveInt(
    request.nextUrl.searchParams.get("maxPages"),
    10
  );

  const run = await prisma.pipelineRun.create({
    data: {
      runType: isReconcile ? "pilot_4_5_slack_reconcile" : "pilot_4_5_slack",
      status: "running",
      triggeredBy: "api:/api/pipeline/slack",
    },
  });

  const syncStartedAt = new Date();

  try {
    // Step 1: checkpoint 로드 (reconcile 모드면 빈 배열 → full backfill)
    const checkpoints = isReconcile ? [] : await loadSlackCheckpoints();

    // Step 2: Slack direct API 수집
    const collect = await collectFromSlack({
      checkpoints,
      perPageLimit,
      incrementalMaxPages,
      fullBackfillMaxPages,
    });

    const channelErrors = collect.channels
      .filter((c) => c.error)
      .map((c) => ({ channel_id: c.channelId, error: c.error }));

    const totalMessages = collect.channels.reduce(
      (sum, c) => sum + c.messages.length,
      0
    );

    // Step 3: 정규화
    const normalized = normalizeSlackCollect(collect);

    // Step 4: upsert + registry 취합 + aggregate 재계산 (영향받은 강사만)
    const applyResult = await applyActivities(run.id, normalized, []);

    // Step 5: checkpoint 갱신
    await saveSlackCheckpoints(
      collect.channels.map((c) => ({
        channelId: c.channelId,
        messages: c.messages,
      }))
    );

    // Step 6: source_sync_logs
    const hasError = channelErrors.length > 0;
    const syncStatus: "success" | "partial" | "failed" = hasError
      ? channelErrors.length === collect.channels.length
        ? "failed"
        : "partial"
      : "success";

    await prisma.sourceSyncLog.create({
      data: {
        runId: run.id,
        sourceType: "slack",
        status: syncStatus,
        fetchedCount: totalMessages,
        updatedCount: applyResult.aggregateUpdates.length,
        errorMessage: hasError
          ? `channel_errors:${channelErrors.length}`
          : null,
        startedAt: syncStartedAt,
        finishedAt: new Date(),
      },
    });

    // Step 7: pipeline_runs 종료
    const runSummary: Prisma.InputJsonObject = {
      pipeline: isReconcile ? "pilot_4_5_slack_reconcile" : "pilot_4_5_slack",
      mode: isReconcile ? "reconcile" : (collect.incremental ? "incremental" : "full_backfill"),
      workspace_id: collect.workspaceId,
      channels_scanned: collect.channels.length,
      page_size: perPageLimit,
      incremental_max_pages: incrementalMaxPages,
      full_backfill_max_pages: fullBackfillMaxPages,
      channel_errors: channelErrors as unknown as Prisma.InputJsonArray,
      total_messages_fetched: totalMessages,
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

    const runStatus: "success" | "partial" | "failed" =
      syncStatus === "failed"
        ? "failed"
        : hasError || applyResult.items.invalid > 0
          ? "partial"
          : "success";

    await prisma.pipelineRun.update({
      where: { id: run.id },
      data: {
        status: runStatus,
        finishedAt: new Date(),
        summary: runSummary,
      },
    });

    return NextResponse.json({
      status: runStatus === "failed" ? "error" : "success",
      meta: {
        request_id: requestId,
        pipeline: "pilot_4_5_slack",
        run_id: run.id,
        run_status: runStatus,
        mode: isReconcile ? "reconcile" : (collect.incremental ? "incremental" : "full_backfill"),
      },
      data: runSummary,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    await prisma.sourceSyncLog.create({
      data: {
        runId: run.id,
        sourceType: "slack",
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
          pipeline: "pilot_4_5_slack",
          run_id: run.id,
        },
        errors: [{ code: "PIPELINE_FAILED", message }],
      },
      { status: 500 }
    );
  }
}
