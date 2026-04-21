/**
 * POST /api/pipeline/gmail — Pilot 4-5 v3
 *
 * 04_data_pipeline.md 5-5절, 5-5-1절, 5-5-2절, 7-1절, 17절, 18-1절, 21-2절
 * 03_data_model.md 4-8절 pipeline_runs, 4-9절 source_sync_logs, 4-10절 activity_import_items
 *
 * 흐름:
 *   1. pipeline_runs 1건 생성 (running)
 *   2. source_checkpoints에서 mailbox checkpoint 로드
 *   3. Gmail direct API로 mailbox-wide incremental 수집 (checkpoint 없으면 full backfill) → 정규화 → upsert
 *   4. activity_review_registries 자동 취합 + auto_accepted/approved registry만 영향받은 강사 aggregate 재계산
 *   5. source_checkpoints 갱신 (mailbox last_internal_date_ms)
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
  GMAIL_ACTIVITY_MAILBOX_QUERY,
  type GmailMailboxCheckpoint,
} from "@/lib/pipeline/gmail-activity-collector";
import { normalizeGmailCollect } from "@/lib/pipeline/gmail-activity-normalizer";
import { applyActivities } from "@/lib/pipeline/activity-applier";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function parseDateOnly(value: string | null): Date | null {
  if (!value) return null;
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return Number.isNaN(date.getTime()) ? null : date;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function formatGmailDate(date: Date): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yyyy}/${mm}/${dd}`;
}

function parsePositiveInt(
  value: string | null,
  fallback: number,
  max?: number
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return typeof max === "number" ? Math.min(parsed, max) : parsed;
}

async function loadGmailCheckpoint(): Promise<GmailMailboxCheckpoint | null> {
  const row = await prisma.sourceCheckpoint.findUnique({
    where: {
      sourceType_scopeKey: {
        sourceType: "gmail",
        scopeKey: "gmail:mailbox",
      },
    },
  });

  if (row) {
    const json = row.checkpointJson as Record<string, unknown>;
    return {
      lastInternalDateMs:
        typeof json.last_internal_date_ms === "string"
          ? json.last_internal_date_ms
          : null,
    };
  }

  const legacyRows = await prisma.sourceCheckpoint.findMany({
    where: {
      sourceType: "gmail",
      scopeKey: { startsWith: "gmail:target:" },
    },
    select: { checkpointJson: true },
  });

  let maxInternalDateMs: string | null = null;
  for (const legacyRow of legacyRows) {
    const json = legacyRow.checkpointJson as Record<string, unknown>;
    const value =
      typeof json.last_internal_date_ms === "string"
        ? json.last_internal_date_ms
        : null;
    if (value && (!maxInternalDateMs || value > maxInternalDateMs)) {
      maxInternalDateMs = value;
    }
  }

  return {
    lastInternalDateMs: maxInternalDateMs,
  };
}

async function saveGmailCheckpoint(
  threads: Array<{ lastInternalDateMs: string | null }>
): Promise<void> {
  let maxInternalDateMs: string | null = null;
  for (const thread of threads) {
    if (!thread.lastInternalDateMs) continue;
    if (!maxInternalDateMs || thread.lastInternalDateMs > maxInternalDateMs) {
      maxInternalDateMs = thread.lastInternalDateMs;
    }
  }

  if (!maxInternalDateMs) return;

  await prisma.sourceCheckpoint.upsert({
    where: {
      sourceType_scopeKey: {
        sourceType: "gmail",
        scopeKey: "gmail:mailbox",
      },
    },
    create: {
      sourceType: "gmail",
      scopeKey: "gmail:mailbox",
      checkpointJson: {
        last_internal_date_ms: maxInternalDateMs,
        mailbox_query: GMAIL_ACTIVITY_MAILBOX_QUERY,
      },
      lastSyncedAt: new Date(),
    },
    update: {
      checkpointJson: {
        last_internal_date_ms: maxInternalDateMs,
        mailbox_query: GMAIL_ACTIVITY_MAILBOX_QUERY,
      },
      lastSyncedAt: new Date(),
    },
  });
}

export async function POST(request: NextRequest) {
  const requestId = `req_${crypto.randomUUID()}`;
  const mode = request.nextUrl.searchParams.get("mode")?.trim() || "incremental";
  const isReconcile = mode === "reconcile";
  const isBackfill = mode === "backfill";
  const startDate = parseDateOnly(request.nextUrl.searchParams.get("startDate"));
  const endDate = parseDateOnly(request.nextUrl.searchParams.get("endDate"));
  const manualQuery = request.nextUrl.searchParams.get("query")?.trim() || null;
  const query =
    manualQuery ??
    (isBackfill && startDate && endDate
      ? `${GMAIL_ACTIVITY_MAILBOX_QUERY} after:${formatGmailDate(startDate)} before:${formatGmailDate(
          addDays(endDate, 1)
        )}`
      : GMAIL_ACTIVITY_MAILBOX_QUERY);
  const maxPages = parsePositiveInt(
    request.nextUrl.searchParams.get("maxPages"),
    10
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

  const syncLog = await prisma.sourceSyncLog.create({
    data: {
      runId: run.id,
      sourceType: "gmail",
      status: "running",
      startedAt: new Date(),
    },
  });

  try {
    const checkpoint = isReconcile || isBackfill ? null : await loadGmailCheckpoint();
    const collect = await collectFromGmail({
      checkpoint,
      query,
      maxPages,
      pageSize,
    });

    const normalized = normalizeGmailCollect(collect);
    const applyResult = await applyActivities(run.id, [], normalized);

    if (!isReconcile && !isBackfill) {
      await saveGmailCheckpoint(collect.threads);
    }

    const filteredOnly =
      collect.threads.length > 0 &&
      applyResult.items.invalid === collect.threads.length &&
      applyResult.items.matched === 0 &&
      applyResult.items.unmatched === 0 &&
      applyResult.items.ambiguous === 0 &&
      applyResult.aggregateUpdates.length === 0;

    const syncStatus: "success" | "partial" =
      applyResult.items.unmatched > 0 || applyResult.items.ambiguous > 0
        ? "partial"
        : "success";

    await prisma.sourceSyncLog.update({
      where: { id: syncLog.id },
      data: {
        status: syncStatus,
        fetchedCount: collect.threads.length,
        updatedCount: applyResult.aggregateUpdates.length,
        errorMessage:
          filteredOnly
            ? `filtered_invalid_items:${applyResult.items.invalid}`
            : applyResult.items.invalid > 0
              ? `invalid_items:${applyResult.items.invalid}`
            : null,
        finishedAt: new Date(),
      },
    });

    const runSummary: Prisma.InputJsonObject = {
      pipeline: isReconcile ? "pilot_4_5_gmail_reconcile" : "pilot_4_5_gmail",
      mode: isBackfill
        ? "backfill"
        : isReconcile
          ? "reconcile"
          : collect.incremental
          ? "incremental"
          : "full_backfill",
      account_email: collect.accountEmail,
      mailbox_query: collect.mailboxQuery,
      start_date: startDate ? startDate.toISOString().slice(0, 10) : null,
      end_date: endDate ? endDate.toISOString().slice(0, 10) : null,
      max_pages: maxPages,
      page_size: pageSize,
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
        mode: isBackfill
          ? "backfill"
          : isReconcile
            ? "reconcile"
            : collect.incremental
            ? "incremental"
            : "full_backfill",
      },
      data: runSummary,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    await prisma.sourceSyncLog.update({
      where: { id: syncLog.id },
      data: {
        status: "failed",
        fetchedCount: 0,
        updatedCount: 0,
        errorMessage: message,
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
