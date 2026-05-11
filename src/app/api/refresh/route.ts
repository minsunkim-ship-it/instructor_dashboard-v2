/**
 * POST /api/refresh — 05_api_spec.md 9절
 *
 * 전체 데이터 새로고침: 모든 파이프라인 소스를 순차 실행한 뒤 점수를 재계산한다.
 * 한 소스가 실패해도 나머지 소스는 계속 실행한다 (resilient).
 */

import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { cleanupStalePipelineRuns } from "@/lib/pipeline/pipeline-run-helpers";
import { REFRESH_TRIGGER_HEADER } from "@/lib/cron-auth";

// --- Notion ---
import {
  collectFromNotionWithProgress,
  resolveNotionCollectorConfig,
} from "@/lib/pipeline/notion-collector";
import { normalizeNotionData } from "@/lib/pipeline/normalizer";
import { storeInstructors } from "@/lib/pipeline/store";

// --- Contract Sheet ---
import { collectFromContractSheets } from "@/lib/pipeline/contract-sheet-collector";
import { normalizeContractRows } from "@/lib/pipeline/contract-sheet-normalizer";
import {
  storeContractRows,
  recomputeAggregatesForInstructors,
} from "@/lib/pipeline/contract-sheet-store";
import {
  collectInstructorDispatchSheets,
  INSTRUCTOR_DISPATCH_SHEET_DEFINITIONS,
} from "@/lib/pipeline/instructor-dispatch-sheet-collector";
import { normalizeInstructorDispatchRow } from "@/lib/pipeline/instructor-dispatch-sheet-normalizer";
import { storeInstructorDispatchRows } from "@/lib/pipeline/instructor-dispatch-sheet-store";

// --- Salesmap ---
import { collectFromSalesmapSnapshot } from "@/lib/pipeline/salesmap-collector";
import { normalizeSalesmapDeals } from "@/lib/pipeline/salesmap-normalizer";
import { applySalesmapRows } from "@/lib/pipeline/salesmap-applier";

// --- Slack ---
import {
  collectFromSlack,
  type SlackChannelCheckpoint,
} from "@/lib/pipeline/slack-activity-collector";
import { normalizeSlackCollect } from "@/lib/pipeline/slack-activity-normalizer";
import { applyActivities } from "@/lib/pipeline/activity-applier";

// --- Gmail ---
import {
  collectFromGmail,
  GMAIL_ACTIVITY_MAILBOX_QUERY,
  type GmailMailboxCheckpoint,
} from "@/lib/pipeline/gmail-activity-collector";
import { normalizeGmailCollect } from "@/lib/pipeline/gmail-activity-normalizer";

// --- Satisfaction ---
import { collectSatisfactionSheets } from "@/lib/pipeline/satisfaction-sheets-collector";
import { normalizeSatisfactionSheetResults } from "@/lib/pipeline/satisfaction-sheets-normalizer";
import {
  collectSatisfactionFromGmail,
  type SatisfactionGmailCheckpoint,
} from "@/lib/pipeline/satisfaction-gmail-collector";
import { normalizeSatisfactionGmailResults } from "@/lib/pipeline/satisfaction-gmail-normalizer";
import { applySatisfactionImports } from "@/lib/pipeline/satisfaction-applier";

// --- Fulltime ---
import { loadFulltimeJson } from "@/lib/pipeline/fulltime-loader";
import { applyFulltime, applyOpsNotes } from "@/lib/pipeline/config-applier";

// --- Ops Notes ---
import { loadOpsNotesJson } from "@/lib/pipeline/ops-notes-loader";

// --- Practice Coach Detection (T6) ---
import { detectPracticeCoaches } from "@/lib/pipeline/practice-coach-detector";

// --- Fee Resolution (T7) ---
import { resolveFees } from "@/lib/pipeline/fee-resolver";

// --- Fee History Store (T8) ---
import { storeFeeHistories } from "@/lib/pipeline/fee-history-store";

// --- Score Recalculator ---
import { recalculateAllScores } from "@/lib/score-recalculator";
import {
  buildStoredFallbackSnapshot,
  writeStoredFallbackSnapshot,
} from "@/lib/fallback-snapshot";
import { generateOperationalIntelligence } from "@/lib/operational-intelligence";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
const POST_STAGE_TIMEOUT_MS = 90_000;
const OPERATIONAL_INTELLIGENCE_TIMEOUT_MS = 180_000;
const MIN_SOURCE_START_BUDGET_MS = 45_000;
const MIN_POST_STAGE_START_BUDGET_MS = 20_000;
const TIMEOUT_ERROR_FRAGMENT = "timeout after";

interface SourceResult {
  sourceType: string;
  status: "success" | "partial" | "failed";
  fetchedCount: number;
  updatedCount: number;
  errorMessage: string | null;
  durationMs: number;
  affectedInstructorIds?: string[];
}

interface SourceRunOutput {
  fetched: number;
  updated: number;
  status?: "success" | "partial";
  message?: string | null;
  affectedInstructorIds?: string[];
}

interface SourceRunContext {
  markProgress: (
    stage: string,
    detail?: Record<string, unknown>
  ) => Promise<void>;
}

interface SourceDefinition {
  name: string;
  fn: (context: SourceRunContext) => Promise<SourceRunOutput>;
  timeoutMs?: number;
}

function toSummaryObject(
  value: Prisma.JsonValue | Prisma.InputJsonObject | null | undefined
): Prisma.InputJsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Prisma.InputJsonObject;
}

async function withTimeout<T>(
  task: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;

  try {
    return await Promise.race([
      task,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`${label} timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function getRemainingRouteBudgetMs(routeStartedAtMs: number): number {
  return maxDuration * 1_000 - (Date.now() - routeStartedAtMs);
}

function buildBudgetWarningMessage(args: {
  label: string;
  remainingBudgetMs: number;
  minBudgetMs: number;
}): string {
  return [
    `${args.label} skipped because the refresh request is near the ${maxDuration}s runtime cap.`,
    `remaining_budget_ms=${Math.max(0, args.remainingBudgetMs)}`,
    `required_budget_ms>=${args.minBudgetMs}`,
  ].join(" ");
}

async function writeSkippedSourceSyncLog(
  runId: string,
  sourceName: string,
  errorMessage: string
): Promise<SourceResult> {
  const now = new Date();

  await prisma.sourceSyncLog.create({
    data: {
      runId,
      sourceType: sourceName,
      status: "partial",
      startedAt: now,
      finishedAt: now,
      fetchedCount: 0,
      updatedCount: 0,
      errorMessage,
    },
  });

  return {
    sourceType: sourceName,
    status: "partial",
    fetchedCount: 0,
    updatedCount: 0,
    errorMessage,
    durationMs: 0,
  };
}

async function runSourceWithSyncLog(
  runId: string,
  baseSummary: Prisma.InputJsonObject,
  stageIndex: number,
  totalStages: number,
  source: SourceDefinition
): Promise<SourceResult> {
  const startedAt = new Date();
  const syncLog = await prisma.sourceSyncLog.create({
    data: {
      runId,
      sourceType: source.name,
      status: "running",
      startedAt,
    },
  });
  let latestStage = "queued";
  let latestDetail: Record<string, unknown> | null = null;
  let timedOut = false;

  const markProgress = async (
    stage: string,
    detail?: Record<string, unknown>
  ): Promise<void> => {
    if (timedOut) return;
    latestStage = stage;
    latestDetail = detail ?? null;
    const detailText =
      detail && Object.keys(detail).length > 0
        ? ` ${Object.entries(detail)
            .filter(([, value]) => value !== undefined && value !== null)
            .map(([key, value]) => `${key}=${String(value)}`)
            .join(" ")}`
        : "";

    await prisma.sourceSyncLog.update({
      where: { id: syncLog.id },
      data: {
        errorMessage: `stage=${stage}${detailText}`,
      },
    });

    await prisma.pipelineRun.update({
      where: { id: runId },
      data: {
        summary: {
          ...baseSummary,
          stage: `source:${source.name}:${stage}`,
          stage_started_at: new Date().toISOString(),
          stage_progress: {
            processed: stageIndex,
            total: totalStages,
          },
        },
      },
    });
  };

  try {
    const result = await withTimeout(
      source.fn({ markProgress }),
      source.timeoutMs ?? 60_000,
      `${source.name} source`
    );
    const sourceResult: SourceResult = {
      sourceType: source.name,
      status: result.status ?? "success",
      fetchedCount: result.fetched,
      updatedCount: result.updated,
      errorMessage: result.message ?? null,
      durationMs: Date.now() - startedAt.getTime(),
      affectedInstructorIds: result.affectedInstructorIds,
    };

    await prisma.sourceSyncLog.update({
      where: { id: syncLog.id },
      data: {
        status: sourceResult.status,
        fetchedCount: sourceResult.fetchedCount,
        updatedCount: sourceResult.updatedCount,
        errorMessage: sourceResult.errorMessage,
        finishedAt: new Date(),
      },
    });

    return sourceResult;
  } catch (err) {
    timedOut = true;
    const sourceResult: SourceResult = {
      sourceType: source.name,
      status: "failed",
      fetchedCount: 0,
      updatedCount: 0,
      errorMessage:
        err instanceof Error
          ? `${err.message} (last_stage=${latestStage}${
              latestDetail
                ? ` ${Object.entries(latestDetail)
                    .filter(([, value]) => value !== undefined && value !== null)
                    .map(([key, value]) => `${key}=${String(value)}`)
                    .join(" ")}`
                : ""
            })`
          : String(err),
      durationMs: Date.now() - startedAt.getTime(),
    };

    await prisma.sourceSyncLog.update({
      where: { id: syncLog.id },
      data: {
        status: sourceResult.status,
        fetchedCount: 0,
        updatedCount: 0,
        errorMessage: sourceResult.errorMessage,
        finishedAt: new Date(),
      },
    });

    return sourceResult;
  }
}

function summarizeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function buildRunSummary(
  sourceResults: SourceResult[],
  extra: {
    sourceCount: number;
    sourceCheckedCount: number;
    scoreRecalcError: string | null;
    scoreRecalcUpdated: number | null;
    practiceCoachMs: number | null;
    feeResolverMs: number | null;
    feeHistoryMs: number | null;
    scoreRecalcMs: number | null;
    operationalIntelligenceMs: number | null;
    fallbackSnapshotMs: number | null;
    operationalIntelligenceError: string | null;
    practiceCoachError: string | null;
    feeResolverError: string | null;
    feeHistoryError: string | null;
    fallbackSnapshotError: string | null;
    staleRunsCleaned: number;
    shortCircuitReason: string | null;
  }
): Prisma.InputJsonObject {
  const successCount = sourceResults.filter((r) => r.status === "success").length;
  const partialCount = sourceResults.filter((r) => r.status === "partial").length;
  const failedCount = sourceResults.filter((r) => r.status === "failed").length;
  const totalRecordsUpdated = sourceResults.reduce(
    (sum, r) => sum + r.updatedCount,
    0
  );

  return {
    sources_checked: extra.sourceCheckedCount,
    sources_planned: extra.sourceCount,
    sources_updated: successCount,
    sources_partial: partialCount,
    sources_failed: failedCount,
    records_updated: totalRecordsUpdated,
    stale_runs_cleaned: extra.staleRunsCleaned,
    short_circuit_reason: extra.shortCircuitReason,
    practice_coach_error: extra.practiceCoachError,
    fee_resolver_error: extra.feeResolverError,
    fee_history_error: extra.feeHistoryError,
    practice_coach_ms: extra.practiceCoachMs,
    fee_resolver_ms: extra.feeResolverMs,
    fee_history_ms: extra.feeHistoryMs,
    score_recalc_error: extra.scoreRecalcError,
    score_recalc_updated: extra.scoreRecalcUpdated,
    score_recalc_ms: extra.scoreRecalcMs,
    operational_intelligence_error: extra.operationalIntelligenceError,
    operational_intelligence_ms: extra.operationalIntelligenceMs,
    fallback_snapshot_error: extra.fallbackSnapshotError,
    fallback_snapshot_ms: extra.fallbackSnapshotMs,
    source_details: sourceResults as unknown as Prisma.InputJsonArray,
  };
}

async function markRunFailed(
  runId: string,
  summary: Prisma.InputJsonObject
): Promise<void> {
  await prisma.sourceSyncLog.updateMany({
    where: {
      runId,
      status: "running",
    },
    data: {
      status: "failed",
      errorMessage: "Refresh request aborted before source completion.",
      finishedAt: new Date(),
    },
  });

  await prisma.pipelineRun.update({
    where: { id: runId },
    data: {
      status: "failed",
      finishedAt: new Date(),
      summary,
    },
  });
}

async function updateRunningStage(
  runId: string,
  baseSummary: Prisma.InputJsonObject,
  stage: string,
  processed: number,
  total: number
): Promise<void> {
  await prisma.pipelineRun.update({
    where: { id: runId },
    data: {
      summary: {
        ...baseSummary,
        stage,
        stage_started_at: new Date().toISOString(),
        stage_progress: {
          processed,
          total,
        },
      },
    },
  });
}

async function findBlockingRun(): Promise<{ id: string } | null> {
  return prisma.pipelineRun.findFirst({
    where: { status: "running" },
    orderBy: { startedAt: "asc" },
    select: { id: true },
  });
}

async function loadSatisfactionGmailCheckpoint(): Promise<SatisfactionGmailCheckpoint | null> {
  const row = await prisma.sourceCheckpoint.findUnique({
    where: {
      sourceType_scopeKey: {
        sourceType: "gmail_satisfaction",
        scopeKey: "mailbox",
      },
    },
  });
  if (!row) return null;

  const json = row.checkpointJson as Record<string, unknown>;
  return {
    lastInternalDateMs:
      typeof json.last_internal_date_ms === "string"
        ? json.last_internal_date_ms
        : null,
  };
}

/**
 * At-least-once semantics: caller MUST invoke this AFTER applySatisfactionImports
 * has committed. If apply fails, the checkpoint is not advanced and the next
 * refresh re-fetches the same threads (duplicate work, but safe because
 * apply is idempotent on sourceRefKey). Never move this call before apply.
 * Structurally enforced by scripts/unit-test-satisfaction-checkpoint-ordering.ts.
 */
async function saveSatisfactionGmailCheckpoint(
  threads: Array<{ threadId: string; sentAt: string | null }>
): Promise<void> {
  let latestSentAtMs: string | null = null;
  for (const thread of threads) {
    if (!thread.sentAt) continue;
    const ms = new Date(thread.sentAt).getTime();
    if (!Number.isFinite(ms)) continue;
    const msString = String(ms);
    if (!latestSentAtMs || msString > latestSentAtMs) {
      latestSentAtMs = msString;
    }
  }
  if (!latestSentAtMs) return;

  await prisma.sourceCheckpoint.upsert({
    where: {
      sourceType_scopeKey: {
        sourceType: "gmail_satisfaction",
        scopeKey: "mailbox",
      },
    },
    create: {
      sourceType: "gmail_satisfaction",
      scopeKey: "mailbox",
      checkpointJson: { last_internal_date_ms: latestSentAtMs },
      lastSyncedAt: new Date(),
    },
    update: {
      checkpointJson: { last_internal_date_ms: latestSentAtMs },
      lastSyncedAt: new Date(),
    },
  });
}

async function loadSlackCheckpoints(): Promise<SlackChannelCheckpoint[]> {
  const rows = await prisma.sourceCheckpoint.findMany({
    where: { sourceType: "slack" },
    select: {
      scopeKey: true,
      checkpointJson: true,
    },
  });

  return rows
    .filter((row) => row.scopeKey.startsWith("slack:channel:"))
    .map((row) => {
      const json = row.checkpointJson as Record<string, unknown>;
      return {
        channelId: row.scopeKey.replace(/^slack:channel:/, ""),
        lastSeenTs:
          typeof json.last_seen_ts === "string" ? json.last_seen_ts : null,
      };
    });
}

/**
 * At-least-once semantics: caller MUST invoke this AFTER applyActivities has
 * committed. If apply fails, checkpoints are not advanced and the next refresh
 * re-fetches the same messages. Duplicates are prevented by sourceRefKey
 * upsert in activity-applier. Never move this call before apply.
 */
async function saveSlackCheckpoints(
  channelMessages: Array<{ channelId: string; messages: Array<{ ts: string }> }>
): Promise<void> {
  for (const channel of channelMessages) {
    if (channel.messages.length === 0) continue;

    let maxTs = "0";
    for (const message of channel.messages) {
      if (message.ts > maxTs) {
        maxTs = message.ts;
      }
    }

    const scopeKey = `slack:channel:${channel.channelId}`;
    await prisma.sourceCheckpoint.upsert({
      where: {
        sourceType_scopeKey: {
          sourceType: "slack",
          scopeKey,
        },
      },
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

  return null;
}

/**
 * At-least-once semantics: caller MUST invoke this AFTER applyActivities has
 * committed. If apply fails, checkpoints are not advanced and the next refresh
 * re-fetches the same threads. Duplicates are prevented by sourceRefKey upsert
 * in activity-applier. Never move this call before apply.
 */
async function saveGmailCheckpoints(
  threads: Array<{
    lastInternalDateMs: string | null;
  }>
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

// ─── Source runners ───────────────────────────────────────────────────────────

async function runNotion({
  markProgress,
}: SourceRunContext): Promise<{ fetched: number; updated: number; message?: string | null }> {
  const notionConfig = resolveNotionCollectorConfig();
  const collectStartedAt = Date.now();
  await markProgress("collect_start", {
    page_size: 100,
    database_id: notionConfig.databaseId,
  });
  const rawData = await collectFromNotionWithProgress({
    onProgress: async (event) => {
      await markProgress(`collect:${event.stage}`, {
        page: event.page,
        fetched_pages: event.fetchedPages,
        fetched_rows: event.fetchedRows,
      });
    },
  });
  const collectMs = Date.now() - collectStartedAt;
  const normalizeStoreStartedAt = Date.now();
  await markProgress("normalize_store", {
    rows: rawData.length,
  });
  const normalized = normalizeNotionData(rawData);
  const storeResult = await storeInstructors(normalized);
  const normalizeStoreMs = Date.now() - normalizeStoreStartedAt;
  return {
    fetched: rawData.length,
    updated: storeResult.created + storeResult.updated,
    message: `database_id=${notionConfig.databaseId}; collect_ms=${collectMs}; normalize_store_ms=${normalizeStoreMs}; pages=${Math.ceil(
      rawData.length / 100
    )}`,
  };
}

async function runContractSheet({
  markProgress,
}: SourceRunContext): Promise<{
  fetched: number;
  updated: number;
  status?: "success" | "partial";
  message?: string | null;
}> {
  const collectStartedAt = Date.now();
  await markProgress("collect", { worksheets: 2 });
  const collected = await collectFromContractSheets();
  const collectMs = Date.now() - collectStartedAt;
  let totalFetched = 0;
  let totalUpdated = 0;
  const allAffectedIds = new Set<string>();
  const worksheetErrors = collected.worksheets
    .filter((ws) => ws.error)
    .map((ws) => `gid=${ws.gid}: ${ws.error}`);
  let normalizeStoreMs = 0;

  if (
    collected.worksheets.length > 0 &&
    worksheetErrors.length === collected.worksheets.length
  ) {
    throw new Error(`계약시트를 읽지 못했습니다. ${worksheetErrors.join("; ")}`);
  }

  for (const ws of collected.worksheets) {
    if (ws.error) continue;
    const worksheetStartedAt = Date.now();
    await markProgress("normalize_store", {
      gid: ws.gid,
      rows: ws.rows.length,
    });
    totalFetched += ws.fetchedCount;
    const normalized = normalizeContractRows(ws.rows);
    const result = await storeContractRows(normalized, {
      onProgress: async (progress) => {
        await markProgress("normalize_store", {
          gid: ws.gid,
          store_stage: progress.stage,
          processed: progress.processed,
          total: progress.total,
          appended: progress.appended,
          updated: progress.updated,
          skipped: progress.skipped,
          deduped: progress.deduped,
          errors: progress.errors,
          instructors_created: progress.instructorsCreated,
        });
      },
    });
    normalizeStoreMs += Date.now() - worksheetStartedAt;
    totalUpdated += result.appended + result.updated;
    result.instructorIdsAffected.forEach((id) => allAffectedIds.add(id));
  }

  const aggregateStartedAt = Date.now();
  await markProgress("aggregate", {
    instructors: allAffectedIds.size,
  });
  await recomputeAggregatesForInstructors(allAffectedIds);
  const aggregateMs = Date.now() - aggregateStartedAt;

  const timingNote = [
    `collect_ms=${collectMs}`,
    `normalize_store_ms=${normalizeStoreMs}`,
    `aggregate_ms=${aggregateMs}`,
    `worksheets=${collected.worksheets.length}`,
  ].join("; ");
  return {
    fetched: totalFetched,
    updated: totalUpdated,
    status: worksheetErrors.length > 0 ? "partial" : "success",
    message:
      worksheetErrors.length > 0
        ? `${worksheetErrors.join("; ")}; ${timingNote}`
        : timingNote,
  };
}

async function runInstructorDispatchSheet({
  markProgress,
}: SourceRunContext): Promise<{
  fetched: number;
  updated: number;
  status?: "success" | "partial";
  message?: string | null;
}> {
  const collectStartedAt = Date.now();
  await markProgress("collect", {
    sheets: INSTRUCTOR_DISPATCH_SHEET_DEFINITIONS.length,
  });
  const collected = await collectInstructorDispatchSheets();
  const collectMs = Date.now() - collectStartedAt;
  let totalFetched = 0;
  let totalUpdated = 0;
  const allAffectedIds = new Set<string>();
  const sheetErrors = collected
    .filter((sheet) => sheet.error)
    .map(
      (sheet) =>
        `${sheet.definition.instructorName}:${sheet.definition.worksheetGid}: ${sheet.error}`
    );
  let normalizeStoreMs = 0;

  if (collected.length > 0 && sheetErrors.length === collected.length) {
    throw new Error(
      `강사별 출강시트를 읽지 못했습니다. ${sheetErrors.join("; ")}`
    );
  }

  for (const sheet of collected) {
    if (sheet.error) continue;
    const sheetStartedAt = Date.now();
    await markProgress("normalize_store", {
      source_key: sheet.definition.key,
      rows: sheet.rows.length,
    });

    totalFetched += sheet.fetchedCount;
    const normalized = sheet.rows.map(normalizeInstructorDispatchRow);
    const result = await storeInstructorDispatchRows(normalized, {
      onProgress: async (progress) => {
        await markProgress("normalize_store", {
          source_key: sheet.definition.key,
          store_stage: progress.stage,
          processed: progress.processed,
          total: progress.total,
          appended: progress.appended,
          updated: progress.updated,
          skipped: progress.skipped,
          deduped: progress.deduped,
          errors: progress.errors,
          instructors_created: progress.instructorsCreated,
        });
      },
    });
    normalizeStoreMs += Date.now() - sheetStartedAt;
    totalUpdated += result.appended + result.updated;
    result.instructorIdsAffected.forEach((id) => allAffectedIds.add(id));
  }

  const aggregateStartedAt = Date.now();
  await markProgress("aggregate", {
    instructors: allAffectedIds.size,
  });
  await recomputeAggregatesForInstructors(allAffectedIds);
  const aggregateMs = Date.now() - aggregateStartedAt;

  const timingNote = [
    `collect_ms=${collectMs}`,
    `normalize_store_ms=${normalizeStoreMs}`,
    `aggregate_ms=${aggregateMs}`,
    `sheets=${collected.length}`,
  ].join("; ");

  return {
    fetched: totalFetched,
    updated: totalUpdated,
    status: sheetErrors.length > 0 ? "partial" : "success",
    message:
      sheetErrors.length > 0
        ? `${sheetErrors.join("; ")}; ${timingNote}`
        : timingNote,
  };
}

async function runSalesmap(): Promise<{ fetched: number; updated: number }> {
  const { deals } = collectFromSalesmapSnapshot();
  const normalized = normalizeSalesmapDeals(deals);
  const result = await applySalesmapRows(deals.length, normalized);
  return {
    fetched: result.dealsFetched,
    updated:
      result.lastActivityUpdated +
      result.teachingHistoriesCompanyFilled +
      result.teachingHistoriesCourseNameFilled,
  };
}

async function runSlack(
  runId: string,
  { markProgress }: SourceRunContext
): Promise<SourceRunOutput> {
  await markProgress("collect");
  const checkpoints = await loadSlackCheckpoints();
  const collect = await collectFromSlack({
    checkpoints,
    perPageLimit: 200,
    incrementalMaxPages: 5,
    fullBackfillMaxPages: 10,
    fullBackfillMinLookbackDays: 183,
    requestTimeoutMs: 10_000,
    channelTimeoutMs: 30_000,
    userLookupConcurrency: 8,
  });

  const totalMessages = collect.channels.reduce(
    (sum, c) => sum + c.messages.length,
    0
  );

  await markProgress("apply", {
    messages: totalMessages,
  });
  const normalized = normalizeSlackCollect(collect);
  const applyResult = await applyActivities(runId, normalized, [], {
    onProgress: async (stage, detail) => {
      await markProgress(`apply:${stage}`, detail);
    },
  });
  await saveSlackCheckpoints(
    collect.channels.map((channel) => ({
      channelId: channel.channelId,
      messages: channel.messages,
    }))
  );
  const failedChannels = collect.channels.filter((channel) => channel.error);
  const reflectionBlocked =
    totalMessages > 0 && applyResult.aggregateUpdates.length === 0;
  const notes: string[] = [];
  let status: SourceRunOutput["status"] = "success";

  if (failedChannels.length > 0) {
    status = "partial";
    notes.push(
      `failed_channels=${failedChannels
        .map((channel) => channel.channelId)
        .join(",")}`
    );
  }

  if (reflectionBlocked) {
    status = "partial";
    notes.push(
      `reflected_instructors=0 matched=${applyResult.items.matched} unmatched=${applyResult.items.unmatched} ambiguous=${applyResult.items.ambiguous} invalid=${applyResult.items.invalid}`
    );
  }

  // apply substage timing은 final state(source_sync_logs.errorMessage)에 항상 보존
  notes.push(
    `apply_load_existing_ms=${applyResult.timings.loadExistingMs}; ` +
      `apply_upsert_items_ms=${applyResult.timings.upsertItemsMs}; ` +
      `apply_registry_rebuild_ms=${applyResult.timings.registryRebuildMs}; ` +
      `apply_registry_upsert_ms=${applyResult.timings.registryUpsertMs}; ` +
      `apply_aggregate_update_ms=${applyResult.timings.aggregateUpdateMs}`
  );

  return {
    fetched: totalMessages,
    updated: applyResult.aggregateUpdates.length,
    status,
    message: notes.length > 0 ? notes.join("; ") : null,
  };
}

async function runGmail(
  runId: string,
  { markProgress }: SourceRunContext
): Promise<SourceRunOutput> {
  await markProgress("collect");
  const checkpoint = await loadGmailCheckpoint();
  const collect = await collectFromGmail({
    checkpoint,
    maxPages: 10,
    pageSize: 100,
    requestTimeoutMs: 10_000,
    mailboxTimeoutMs: 60_000,
    threadFetchConcurrency: 8,
  });

  await markProgress("apply", {
    threads: collect.threads.length,
  });
  const normalized = normalizeGmailCollect(collect);
  const applyResult = await applyActivities(runId, [], normalized);
  const checkpointAdvanced = collect.diagnostics.fetchComplete;
  if (checkpointAdvanced) {
    await saveGmailCheckpoints(collect.threads);
  }
  const filteredOnly =
    collect.threads.length > 0 &&
    applyResult.items.invalid === collect.threads.length &&
    applyResult.items.matched === 0 &&
    applyResult.items.unmatched === 0 &&
    applyResult.items.ambiguous === 0 &&
    applyResult.aggregateUpdates.length === 0;
  const reflectionBlocked =
    !filteredOnly &&
    collect.threads.length > 0 &&
    applyResult.aggregateUpdates.length === 0;
  const notes: string[] = [];
  let status: SourceRunOutput["status"] =
    collect.diagnostics.fetchComplete ? "success" : "partial";

  if (reflectionBlocked) {
    status = "partial";
    notes.push(
      `reflected_instructors=0 matched=${applyResult.items.matched} unmatched=${applyResult.items.unmatched} ambiguous=${applyResult.items.ambiguous} invalid=${applyResult.items.invalid}`
    );
  }

  if (filteredOnly) {
    notes.push(`filtered_invalid_items=${applyResult.items.invalid}`);
  }

  if (!collect.diagnostics.fetchComplete) {
    notes.push("incomplete_fetch");
  }

  notes.push(`checkpoint_advanced=${checkpointAdvanced}`);
  notes.push(`threads_listed=${collect.diagnostics.threadsListed}`);
  notes.push(`threads_loaded=${collect.diagnostics.threadsLoaded}`);
  notes.push(
    `threads_dropped_before_apply=${collect.diagnostics.threadsDroppedBeforeApply}`
  );
  notes.push(`detail_fetch_failures=${collect.diagnostics.detailFetchFailures}`);
  notes.push(`detail_empty_threads=${collect.diagnostics.detailEmptyThreads}`);
  notes.push(`list_pages_fetched=${collect.diagnostics.listPagesFetched}`);
  notes.push(`page_cap_hit=${collect.diagnostics.pageCapHit}`);
  notes.push(
    `next_page_token_remaining=${collect.diagnostics.nextPageTokenRemaining}`
  );

  notes.push(`mailbox_query=${collect.mailboxQuery}`);

  return {
    fetched: collect.threads.length,
    updated: applyResult.aggregateUpdates.length,
    status,
    message: notes.length > 0 ? notes.join("; ") : null,
  };
}

async function runSatisfaction(
  runId: string,
  { markProgress }: SourceRunContext
): Promise<SourceRunOutput> {
  const sheetCollectStartedAt = Date.now();
  await markProgress("sheet_collect");
  const collected = await collectSatisfactionSheets();
  const sheetCollectMs = Date.now() - sheetCollectStartedAt;
  const sheetNormalizeStartedAt = Date.now();
  await markProgress("sheet_normalize", {
    sources: collected.length,
  });
  const normalizedSheets = await normalizeSatisfactionSheetResults(collected);
  const sheetNormalizeMs = Date.now() - sheetNormalizeStartedAt;
  const allItems = [...normalizedSheets.items];
  let gmailCollectMs = 0;
  let gmailNormalizeMs = 0;
  let gmailIncremental: boolean | null = null;
  let gmailNote: string | null = null;
  let gmailCheckpointThreads: Array<{ threadId: string; sentAt: string | null }> = [];

  // Gmail satisfaction -- 실패해도 시트 결과만으로 계속 진행
  try {
    const gmailCheckpoint = await loadSatisfactionGmailCheckpoint();
    const gmailCollectStartedAt = Date.now();
    await markProgress("gmail_collect");
    const gmailCollected = await collectSatisfactionFromGmail({
      checkpoint: gmailCheckpoint,
      maxPages: gmailCheckpoint?.lastInternalDateMs ? 2 : 5,
      pageSize: 50,
      detailConcurrency: 6,
      listRequestTimeoutMs: 10_000,
      detailRequestTimeoutMs: 15_000,
    });
    gmailIncremental = gmailCollected.incremental;
    gmailCollectMs = Date.now() - gmailCollectStartedAt;
    const gmailNormalizeStartedAt = Date.now();
    await markProgress("gmail_normalize", {
      threads: gmailCollected.threads.length,
      incremental: gmailCollected.incremental,
    });
    const gmailNormalized =
      await normalizeSatisfactionGmailResults(gmailCollected);
    gmailNormalizeMs = Date.now() - gmailNormalizeStartedAt;
    allItems.push(...gmailNormalized.items);
    if (gmailNormalized.skippedSamples.length > 0) {
      const sampleSummary = gmailNormalized.skippedSamples
        .slice(0, 3)
        .map(
          (sample) =>
            `${sample.reason} | ${sample.subject ?? "(no subject)"}`
        )
        .join(" || ");
      gmailNote = `gmail_skipped_samples=${sampleSummary}`;
    }
    gmailCheckpointThreads = gmailCollected.threads.map((thread) => ({
      threadId: thread.threadId,
      sentAt: thread.sentAt,
    }));
  } catch (err) {
    // Gmail satisfaction 실패 시 시트 결과만 사용
    gmailNote = `gmail_satisfaction_error=${
      err instanceof Error ? err.message : String(err)
    }`;
  }

  const applyStartedAt = Date.now();
  await markProgress("apply", {
    items: allItems.length,
  });
  const applyResult = await applySatisfactionImports({
    runId,
    items: allItems,
    recalculateScores: false, // 최종 recalculate에서 일괄 처리
    onProgress: async (stage, detail) => {
      await markProgress(`apply:${stage}`, detail);
    },
  });
  const applyMs = Date.now() - applyStartedAt;

  if (gmailCheckpointThreads.length > 0) {
    await saveSatisfactionGmailCheckpoint(gmailCheckpointThreads);
  }

  const timingParts = [
    `sheet_collect_ms=${sheetCollectMs}`,
    `sheet_normalize_ms=${sheetNormalizeMs}`,
    `gmail_collect_ms=${gmailCollectMs}`,
    `gmail_normalize_ms=${gmailNormalizeMs}`,
    `apply_ms=${applyMs}`,
  ];
  if (gmailIncremental !== null) {
    timingParts.push(`gmail_mode=${gmailIncremental ? "incremental" : "full"}`);
  }
  if (gmailNote) timingParts.push(gmailNote);

  return {
    fetched: normalizedSheets.sourceSummaries.reduce(
      (sum, s) => sum + s.fetchedRows,
      0
    ),
    updated: applyResult.canonicalRecordsUpserted,
    message: timingParts.join("; "),
    affectedInstructorIds: applyResult.affectedInstructorIds,
  };
}

async function runFulltime(): Promise<{ fetched: number; updated: number }> {
  const loaded = loadFulltimeJson();
  const result = await applyFulltime(loaded, "refresh");
  return {
    fetched: loaded.activeCount,
    updated: result.sync.updatedCount,
  };
}

async function runOpsNotes(): Promise<{ fetched: number; updated: number }> {
  const loaded = loadOpsNotesJson();
  const result = await applyOpsNotes(loaded, "refresh");
  return {
    fetched: loaded.acceptedCount,
    updated: result.sync.updatedCount,
  };
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  const requestId = `req_${crypto.randomUUID()}`;
  let runId: string | null = null;
  const routeStartedAtMs = Date.now();

  try {
    const url = new URL(request.url);
    const scope = url.searchParams.get("scope");
    const refreshTriggerOverride = request.headers.get(REFRESH_TRIGGER_HEADER);
    const isTeachingHistoryOnly =
      scope === "contract_sheet" || scope === "teaching_history";
    const isSatisfactionOnly = scope === "satisfaction";
    const isPostprocessOnly = scope === "postprocess";
    const isSnapshotOnly = scope === "snapshot_only";
    // Expert P0-6: 기본 refresh에 contract_sheet/instructor_dispatch_sheet/postprocess 포함.
    // 정확성 우선 — 강의 이력이 stale인 채로 만족도 매칭이 일어나지 않게.
    // scope=lightweight 명시 시만 제외 (운영자 빠른 새로고침용).
    const isLightweightOnly = scope === "lightweight";
    const isFullDefault = scope === null || scope === "all";
    const defaultTriggeredBy = isSnapshotOnly
      ? "api:/api/refresh?scope=snapshot_only"
      : isSatisfactionOnly
      ? "api:/api/refresh?scope=satisfaction"
      : isPostprocessOnly
      ? "api:/api/refresh?scope=postprocess"
      : isTeachingHistoryOnly
      ? "api:/api/refresh?scope=teaching_history"
      : isLightweightOnly
      ? "api:/api/refresh?scope=lightweight"
      : "api:/api/refresh";
    const triggeredBy = refreshTriggerOverride || defaultTriggeredBy;

    const staleCleanup = await cleanupStalePipelineRuns();

    // 1. 동시 실행 방지: running 상태 PipelineRun 확인
    const existingRunning = await findBlockingRun();

    if (existingRunning) {
      return NextResponse.json(
        {
          status: "error",
          meta: {
            request_id: requestId,
            data_mode: "live",
            is_fallback: false,
            last_updated_at: null,
          },
          errors: [
            {
              code: "REFRESH_IN_PROGRESS",
              message: "새로고침이 이미 진행 중입니다.",
            },
          ],
        },
        { status: 409 }
      );
    }

    // 2. PipelineRun 생성
    const run = await prisma.pipelineRun.create({
      data: {
        runType: isSnapshotOnly
          ? "manual_refresh_snapshot"
          : isSatisfactionOnly
          ? "manual_refresh_satisfaction"
          : isPostprocessOnly
          ? "manual_refresh_postprocess"
          : isTeachingHistoryOnly
          ? "manual_refresh_teaching_history"
          : isLightweightOnly
            ? "manual_refresh_lightweight"
            : "manual_refresh",
        status: "running",
        triggeredBy,
        summary: {},
      },
    });
    runId = run.id;
    const runningSummaryBase = toSummaryObject({
      request_id: requestId,
      stale_runs_cleaned: staleCleanup.cleanedRunIds.length,
      refresh_scope: isSnapshotOnly
        ? "snapshot_only"
        : isSatisfactionOnly
          ? "satisfaction"
        : isPostprocessOnly
          ? "postprocess"
        : isTeachingHistoryOnly
          ? "teaching_history"
          : isLightweightOnly
            ? "lightweight"
            : "all",
    });
    await prisma.pipelineRun.update({
      where: { id: run.id },
      data: { summary: runningSummaryBase },
    });

    if (isSnapshotOnly) {
      let fallbackSnapshotError: string | null = null;

      try {
        await updateRunningStage(
          run.id,
          runningSummaryBase,
          "snapshot:write",
          1,
          1
        );
        const snapshot = await buildStoredFallbackSnapshot();
        await writeStoredFallbackSnapshot(snapshot);
      } catch (err) {
        fallbackSnapshotError = summarizeError(err);
      }

      const runStatus: "success" | "failed" = fallbackSnapshotError
        ? "failed"
        : "success";

      await prisma.pipelineRun.update({
        where: { id: run.id },
        data: {
          status: runStatus,
          finishedAt: new Date(),
          summary: {
            ...runningSummaryBase,
            refresh_scope: "snapshot_only",
            fallback_snapshot_error: fallbackSnapshotError,
            snapshot_written: fallbackSnapshotError === null,
          },
        },
      });

      if (runStatus === "failed") {
        return NextResponse.json(
          {
            status: "error",
            meta: {
              request_id: requestId,
              data_mode: "live",
              is_fallback: false,
              last_updated_at: null,
            },
            errors: [
              {
                code: "SNAPSHOT_WRITE_FAILED",
                message: fallbackSnapshotError ?? "스냅샷 저장에 실패했습니다.",
              },
            ],
          },
          { status: 500 }
        );
      }

      return NextResponse.json({
        status: "success",
        meta: {
          request_id: requestId,
          data_mode: "live",
          is_fallback: false,
          last_updated_at: new Date().toISOString(),
        },
        data: {
          refresh_status: "success",
          updated: true,
          run_id: run.id,
          summary: {
            sources_checked: 0,
            sources_updated: 0,
            records_updated: 0,
          },
        },
      });
    }

    // 3. 소스별 순차 실행 (resilient: 한 소스가 실패해도 나머지 계속)
    const sourceResults: SourceResult[] = [];
    let shortCircuitReason: string | null = null;

    const sources: SourceDefinition[] = isPostprocessOnly
      ? []
      : isTeachingHistoryOnly
      ? [
          { name: "contract_sheet", fn: runContractSheet, timeoutMs: 150_000 },
          {
            name: "instructor_dispatch_sheet",
            fn: runInstructorDispatchSheet,
            timeoutMs: 150_000,
          },
        ]
      : isSatisfactionOnly
      ? [{ name: "satisfaction", fn: (ctx) => runSatisfaction(run.id, ctx), timeoutMs: 180_000 }]
      : isFullDefault
      ? [
          // Expert P0-6: 기본 refresh = 강의 이력 + 만족도 + postprocess 모두 포함.
          { name: "notion", fn: runNotion, timeoutMs: 180_000 },
          { name: "fulltime", fn: async () => runFulltime(), timeoutMs: 15_000 },
          { name: "ops_notes", fn: async () => runOpsNotes(), timeoutMs: 15_000 },
          { name: "salesmap", fn: async () => runSalesmap(), timeoutMs: 20_000 },
          { name: "contract_sheet", fn: runContractSheet, timeoutMs: 150_000 },
          {
            name: "instructor_dispatch_sheet",
            fn: runInstructorDispatchSheet,
            timeoutMs: 150_000,
          },
          { name: "slack", fn: (ctx) => runSlack(run.id, ctx), timeoutMs: 150_000 },
          { name: "gmail", fn: (ctx) => runGmail(run.id, ctx), timeoutMs: 150_000 },
          { name: "satisfaction", fn: (ctx) => runSatisfaction(run.id, ctx), timeoutMs: 180_000 },
        ]
      : [
          // scope=lightweight: 빠른 새로고침. 강의 이력 stale 가능성 있음 (운영자 명시 선택).
          { name: "notion", fn: runNotion, timeoutMs: 180_000 },
          { name: "fulltime", fn: async () => runFulltime(), timeoutMs: 15_000 },
          { name: "ops_notes", fn: async () => runOpsNotes(), timeoutMs: 15_000 },
          { name: "salesmap", fn: async () => runSalesmap(), timeoutMs: 20_000 },
          { name: "slack", fn: (ctx) => runSlack(run.id, ctx), timeoutMs: 150_000 },
          { name: "gmail", fn: (ctx) => runGmail(run.id, ctx), timeoutMs: 150_000 },
          { name: "satisfaction", fn: (ctx) => runSatisfaction(run.id, ctx), timeoutMs: 180_000 },
        ];
    // Expert P0-6: 기본/teaching_history/satisfaction 모두에서 postprocess 자동 실행.
    const shouldRunPostStages = isPostprocessOnly || isFullDefault;
    const totalStages = sources.length + (shouldRunPostStages ? 5 : 0);

    for (const [index, source] of sources.entries()) {
      const remainingBudgetMs = getRemainingRouteBudgetMs(routeStartedAtMs);
      if (remainingBudgetMs < MIN_SOURCE_START_BUDGET_MS) {
        shortCircuitReason = buildBudgetWarningMessage({
          label: source.name,
          remainingBudgetMs,
          minBudgetMs: MIN_SOURCE_START_BUDGET_MS,
        });
        sourceResults.push(
          await writeSkippedSourceSyncLog(run.id, source.name, shortCircuitReason)
        );
        break;
      }

      await updateRunningStage(
        run.id,
        runningSummaryBase,
        `source:${source.name}`,
        index + 1,
        totalStages
      );
      const result = await runSourceWithSyncLog(
        run.id,
        runningSummaryBase,
        index + 1,
        totalStages,
        source
      );
      sourceResults.push(result);

      if (
        result.status === "failed" &&
        result.errorMessage?.includes(TIMEOUT_ERROR_FRAGMENT)
      ) {
        shortCircuitReason = `${source.name} timed out; stopping remaining stages so the refresh can finish cleanly before the ${maxDuration}s route cap leaves a stale run.`;
        break;
      }
    }

    let practiceCoachError: string | null = null;
    let practiceCoachMs: number | null = null;
    if (!shortCircuitReason && shouldRunPostStages) {
      if (getRemainingRouteBudgetMs(routeStartedAtMs) < MIN_POST_STAGE_START_BUDGET_MS) {
        shortCircuitReason = buildBudgetWarningMessage({
          label: "post:practice_coach",
          remainingBudgetMs: getRemainingRouteBudgetMs(routeStartedAtMs),
          minBudgetMs: MIN_POST_STAGE_START_BUDGET_MS,
        });
      }
    }
    if (!shortCircuitReason && shouldRunPostStages) {
      try {
        await updateRunningStage(
          run.id,
          runningSummaryBase,
          "post:practice_coach",
          sources.length + 1,
          totalStages
        );
        const practiceCoachStartedAt = Date.now();
        await withTimeout(
          detectPracticeCoaches(),
          POST_STAGE_TIMEOUT_MS,
          "practice_coach"
        );
        practiceCoachMs = Date.now() - practiceCoachStartedAt;
      } catch (err) {
        practiceCoachError = summarizeError(err);
      }
    }

    let feeResolverError: string | null = null;
    let feeResolverMs: number | null = null;
    if (!shortCircuitReason && shouldRunPostStages) {
      if (getRemainingRouteBudgetMs(routeStartedAtMs) < MIN_POST_STAGE_START_BUDGET_MS) {
        shortCircuitReason = buildBudgetWarningMessage({
          label: "post:fee_resolver",
          remainingBudgetMs: getRemainingRouteBudgetMs(routeStartedAtMs),
          minBudgetMs: MIN_POST_STAGE_START_BUDGET_MS,
        });
      }
    }
    if (!shortCircuitReason && shouldRunPostStages) {
      try {
        await updateRunningStage(
          run.id,
          runningSummaryBase,
          "post:fee_resolver",
          sources.length + 2,
          totalStages
        );
        const feeResolverStartedAt = Date.now();
        await withTimeout(
          resolveFees(),
          POST_STAGE_TIMEOUT_MS,
          "fee_resolver"
        );
        feeResolverMs = Date.now() - feeResolverStartedAt;
      } catch (err) {
        feeResolverError = summarizeError(err);
      }
    }

    let feeHistoryError: string | null = null;
    let feeHistoryMs: number | null = null;
    if (!shortCircuitReason && shouldRunPostStages) {
      if (getRemainingRouteBudgetMs(routeStartedAtMs) < MIN_POST_STAGE_START_BUDGET_MS) {
        shortCircuitReason = buildBudgetWarningMessage({
          label: "post:fee_history",
          remainingBudgetMs: getRemainingRouteBudgetMs(routeStartedAtMs),
          minBudgetMs: MIN_POST_STAGE_START_BUDGET_MS,
        });
      }
    }
    if (!shortCircuitReason && shouldRunPostStages) {
      try {
        await updateRunningStage(
          run.id,
          runningSummaryBase,
          "post:fee_history",
          sources.length + 3,
          totalStages
        );
        const feeHistoryStartedAt = Date.now();
        await withTimeout(
          storeFeeHistories(),
          POST_STAGE_TIMEOUT_MS,
          "fee_history"
        );
        feeHistoryMs = Date.now() - feeHistoryStartedAt;
      } catch (err) {
        feeHistoryError = summarizeError(err);
      }
    }

    let scoreRecalcError: string | null = null;
    let scoreRecalcUpdated: number | null = null;
    let scoreRecalcMs: number | null = null;
    let scoreRecalcDetail: Prisma.InputJsonObject | null = null;
    if (!shortCircuitReason && shouldRunPostStages) {
      if (getRemainingRouteBudgetMs(routeStartedAtMs) < MIN_POST_STAGE_START_BUDGET_MS) {
        shortCircuitReason = buildBudgetWarningMessage({
          label: "post:score_recalc",
          remainingBudgetMs: getRemainingRouteBudgetMs(routeStartedAtMs),
          minBudgetMs: MIN_POST_STAGE_START_BUDGET_MS,
        });
      }
    }
    if (!shortCircuitReason && shouldRunPostStages) {
      try {
        await updateRunningStage(
          run.id,
          runningSummaryBase,
          "post:score_recalc",
          sources.length + 4,
          totalStages
        );
        const scoreRecalcStartedAt = Date.now();
        const scoreRecalcResult = await withTimeout(
          recalculateAllScores({
            runId: run.id,
            validateIssues: true,
          }),
          POST_STAGE_TIMEOUT_MS,
          "score_recalc"
        );
        scoreRecalcUpdated = scoreRecalcResult.updatedInstructors;
        scoreRecalcMs = Date.now() - scoreRecalcStartedAt;
        scoreRecalcDetail = {
          load_instructors_ms: scoreRecalcResult.timings.loadInstructorsMs,
          load_activity_stats_ms: scoreRecalcResult.timings.loadActivityStatsMs,
          load_teaching_history_counts_ms:
            scoreRecalcResult.timings.loadTeachingHistoryCountsMs,
          scoring_ms: scoreRecalcResult.timings.scoringMs,
          write_scores_ms: scoreRecalcResult.timings.writeScoresMs,
          validation_ms: scoreRecalcResult.timings.validationMs,
        };
      } catch (err) {
        scoreRecalcError = summarizeError(err);
      }
    }

    let operationalIntelligenceError: string | null = null;
    let operationalIntelligenceMs: number | null = null;
    if (!shortCircuitReason && shouldRunPostStages) {
      if (getRemainingRouteBudgetMs(routeStartedAtMs) < MIN_POST_STAGE_START_BUDGET_MS) {
        shortCircuitReason = buildBudgetWarningMessage({
          label: "post:operational_intelligence",
          remainingBudgetMs: getRemainingRouteBudgetMs(routeStartedAtMs),
          minBudgetMs: MIN_POST_STAGE_START_BUDGET_MS,
        });
      }
    }
    if (!shortCircuitReason && shouldRunPostStages) {
      try {
        await updateRunningStage(
          run.id,
          runningSummaryBase,
          "post:operational_intelligence",
          sources.length + 5,
          totalStages
        );
        const operationalIntelligenceStartedAt = Date.now();
        await withTimeout(
          generateOperationalIntelligence({}),
          OPERATIONAL_INTELLIGENCE_TIMEOUT_MS,
          "operational_intelligence"
        );
        operationalIntelligenceMs =
          Date.now() - operationalIntelligenceStartedAt;
      } catch (err) {
        operationalIntelligenceError = summarizeError(err);
      }
    }

    // 9. 실행 결과 집계
    const successCount = sourceResults.filter((r) => r.status === "success").length;
    const partialCount = sourceResults.filter((r) => r.status === "partial").length;
    const failedCount = sourceResults.filter((r) => r.status === "failed").length;
    const totalRecordsUpdated = sourceResults.reduce(
      (sum, r) => sum + r.updatedCount,
      0
    );

    // 10. 마지막 정상 스냅샷 저장
    let fallbackSnapshotError: string | null = null;
    let fallbackSnapshotMs: number | null = null;
    if (
      shouldRunPostStages &&
      !shortCircuitReason &&
      failedCount === 0 &&
      partialCount === 0 &&
      !practiceCoachError &&
      !feeResolverError &&
      !feeHistoryError &&
      !scoreRecalcError &&
      !operationalIntelligenceError
    ) {
      try {
        await updateRunningStage(
          run.id,
          runningSummaryBase,
          "post:fallback_snapshot",
          totalStages,
          totalStages
        );
        const fallbackSnapshotStartedAt = Date.now();
        const snapshot = await buildStoredFallbackSnapshot();
        await writeStoredFallbackSnapshot(snapshot);
        fallbackSnapshotMs = Date.now() - fallbackSnapshotStartedAt;
      } catch (err) {
        fallbackSnapshotError = summarizeError(err);
      }
    }

    const pipelineStepError =
      shortCircuitReason ||
      practiceCoachError ||
      feeResolverError ||
      feeHistoryError ||
      scoreRecalcError ||
      operationalIntelligenceError ||
      fallbackSnapshotError;
    const runStatus: "success" | "partial" | "failed" =
      sourceResults.length > 0 && failedCount === sourceResults.length
        ? "failed"
        : failedCount > 0 || partialCount > 0 || pipelineStepError
          ? "partial"
          : "success";

    // 6. PipelineRun 종료
    await prisma.pipelineRun.update({
      where: { id: run.id },
      data: {
        status: runStatus,
        finishedAt: new Date(),
        summary: buildRunSummary(sourceResults, {
          sourceCount: sources.length,
          sourceCheckedCount: sourceResults.length,
          scoreRecalcError,
          scoreRecalcUpdated,
          practiceCoachMs,
          feeResolverMs,
          feeHistoryMs,
          scoreRecalcMs,
          operationalIntelligenceMs,
          fallbackSnapshotMs,
          operationalIntelligenceError,
          practiceCoachError,
          feeResolverError,
          feeHistoryError,
          fallbackSnapshotError,
          staleRunsCleaned: staleCleanup.cleanedRunIds.length,
          shortCircuitReason,
        }),
      },
    });

    const lastUpdatedAt = new Date().toISOString();

    if (runStatus === "failed") {
      return NextResponse.json(
        {
          status: "error",
          meta: {
            request_id: requestId,
            data_mode: "live",
            is_fallback: false,
            last_updated_at: lastUpdatedAt,
          },
          errors: [
            {
              code: "REFRESH_FAILED",
              message: "새로고침에 실패했습니다.",
            },
          ],
        },
        { status: 500 }
      );
    }

    const responseBody: Record<string, unknown> = {
      status: runStatus === "partial" ? "partial" : "success",
      meta: {
        request_id: requestId,
        data_mode: "live",
        is_fallback: false,
        last_updated_at: lastUpdatedAt,
      },
      data: {
        refresh_status: runStatus,
        updated: true,
        run_id: run.id,
        summary: {
          sources_checked: sourceResults.length,
          sources_updated: successCount,
          sources_partial: partialCount,
          sources_failed: failedCount,
          records_updated: totalRecordsUpdated,
          score_recalc_updated: scoreRecalcUpdated,
          score_recalc_detail: scoreRecalcDetail,
        },
      },
    };

    if (runStatus === "partial") {
      responseBody.errors = [
        {
          code: "PARTIAL_DATA",
          message: "일부 소스에서 데이터를 가져오지 못했습니다.",
        },
      ];
    }

    return NextResponse.json(responseBody);
  } catch (err) {
    if (runId) {
      await markRunFailed(runId, {
        request_id: requestId,
        error: summarizeError(err),
      }).catch(() => undefined);
    }

    return NextResponse.json(
      {
        status: "error",
        meta: {
          request_id: requestId,
          data_mode: "live",
          is_fallback: false,
          last_updated_at: null,
        },
        errors: [
          {
            code: "REFRESH_FAILED",
            message: summarizeError(err),
          },
        ],
      },
      { status: 500 }
    );
  }
}
