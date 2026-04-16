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

// --- Notion ---
import { collectFromNotion } from "@/lib/pipeline/notion-collector";
import { normalizeNotionData } from "@/lib/pipeline/normalizer";
import { storeInstructors } from "@/lib/pipeline/store";

// --- Contract Sheet ---
import { collectFromContractSheets } from "@/lib/pipeline/contract-sheet-collector";
import { normalizeContractRow } from "@/lib/pipeline/contract-sheet-normalizer";
import {
  storeContractRows,
  recomputeAggregatesForInstructors,
} from "@/lib/pipeline/contract-sheet-store";

// --- Salesmap ---
import { collectFromSalesmapSnapshot } from "@/lib/pipeline/salesmap-collector";
import { normalizeSalesmapDeals } from "@/lib/pipeline/salesmap-normalizer";
import { applySalesmapRows } from "@/lib/pipeline/salesmap-applier";

// --- Slack ---
import { collectFromSlack } from "@/lib/pipeline/slack-activity-collector";
import { normalizeSlackCollect } from "@/lib/pipeline/slack-activity-normalizer";
import { applyActivities } from "@/lib/pipeline/activity-applier";

// --- Gmail ---
import { collectFromGmail } from "@/lib/pipeline/gmail-activity-collector";
import { normalizeGmailCollect } from "@/lib/pipeline/gmail-activity-normalizer";

// --- Satisfaction ---
import { collectSatisfactionSheets } from "@/lib/pipeline/satisfaction-sheets-collector";
import { normalizeSatisfactionSheetResults } from "@/lib/pipeline/satisfaction-sheets-normalizer";
import { collectSatisfactionFromGmail } from "@/lib/pipeline/satisfaction-gmail-collector";
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

export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface SourceResult {
  sourceType: string;
  status: "success" | "failed";
  fetchedCount: number;
  updatedCount: number;
  errorMessage: string | null;
  durationMs: number;
}

interface SourceDefinition {
  name: string;
  fn: () => Promise<{ fetched: number; updated: number }>;
}

async function runSourceWithSyncLog(
  runId: string,
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

  try {
    const result = await source.fn();
    const sourceResult: SourceResult = {
      sourceType: source.name,
      status: "success",
      fetchedCount: result.fetched,
      updatedCount: result.updated,
      errorMessage: null,
      durationMs: Date.now() - startedAt.getTime(),
    };

    await prisma.sourceSyncLog.update({
      where: { id: syncLog.id },
      data: {
        status: sourceResult.status,
        fetchedCount: sourceResult.fetchedCount,
        updatedCount: sourceResult.updatedCount,
        errorMessage: null,
        finishedAt: new Date(),
      },
    });

    return sourceResult;
  } catch (err) {
    const sourceResult: SourceResult = {
      sourceType: source.name,
      status: "failed",
      fetchedCount: 0,
      updatedCount: 0,
      errorMessage: err instanceof Error ? err.message : String(err),
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
    scoreRecalcError: string | null;
    practiceCoachError: string | null;
    feeResolverError: string | null;
    feeHistoryError: string | null;
    staleRunsCleaned: number;
  }
): Prisma.InputJsonObject {
  const successCount = sourceResults.filter((r) => r.status === "success").length;
  const failedCount = sourceResults.filter((r) => r.status === "failed").length;
  const totalRecordsUpdated = sourceResults.reduce(
    (sum, r) => sum + r.updatedCount,
    0
  );

  return {
    sources_checked: extra.sourceCount,
    sources_updated: successCount,
    sources_failed: failedCount,
    records_updated: totalRecordsUpdated,
    stale_runs_cleaned: extra.staleRunsCleaned,
    practice_coach_error: extra.practiceCoachError,
    fee_resolver_error: extra.feeResolverError,
    fee_history_error: extra.feeHistoryError,
    score_recalc_error: extra.scoreRecalcError,
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

async function findBlockingRun(): Promise<{ id: string } | null> {
  return prisma.pipelineRun.findFirst({
    where: { status: "running" },
    orderBy: { startedAt: "asc" },
    select: { id: true },
  });
}

// ─── Source runners ───────────────────────────────────────────────────────────

async function runNotion(): Promise<{ fetched: number; updated: number }> {
  const rawData = await collectFromNotion();
  const normalized = normalizeNotionData(rawData);
  const storeResult = await storeInstructors(normalized);
  return {
    fetched: rawData.length,
    updated: storeResult.created + storeResult.updated,
  };
}

async function runContractSheet(): Promise<{
  fetched: number;
  updated: number;
}> {
  const collected = await collectFromContractSheets();
  let totalFetched = 0;
  let totalUpdated = 0;
  const allAffectedIds = new Set<string>();

  for (const ws of collected.worksheets) {
    if (ws.error) continue;
    totalFetched += ws.fetchedCount;
    const normalized = ws.rows.map(normalizeContractRow);
    const result = await storeContractRows(normalized);
    totalUpdated += result.appended;
    result.instructorIdsAffected.forEach((id) => allAffectedIds.add(id));
  }

  await recomputeAggregatesForInstructors(allAffectedIds);
  return { fetched: totalFetched, updated: totalUpdated };
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
  runId: string
): Promise<{ fetched: number; updated: number }> {
  const collect = await collectFromSlack({
    checkpoints: [],
    perPageLimit: 200,
    incrementalMaxPages: 5,
    fullBackfillMaxPages: 10,
  });

  const totalMessages = collect.channels.reduce(
    (sum, c) => sum + c.messages.length,
    0
  );

  const normalized = normalizeSlackCollect(collect);
  const applyResult = await applyActivities(runId, normalized, []);

  return {
    fetched: totalMessages,
    updated: applyResult.aggregateUpdates.length,
  };
}

async function runGmail(
  runId: string
): Promise<{ fetched: number; updated: number }> {
  const collect = await collectFromGmail({
    checkpoints: [],
    maxPages: 5,
    pageSize: 100,
  });

  const normalized = normalizeGmailCollect(collect);
  const applyResult = await applyActivities(runId, [], normalized);

  return {
    fetched: collect.threads.length,
    updated: applyResult.aggregateUpdates.length,
  };
}

async function runSatisfaction(
  runId: string
): Promise<{ fetched: number; updated: number }> {
  const collected = await collectSatisfactionSheets();
  const normalizedSheets = await normalizeSatisfactionSheetResults(collected);
  const allItems = [...normalizedSheets.items];

  // Gmail satisfaction -- 실패해도 시트 결과만으로 계속 진행
  try {
    const gmailCollected = await collectSatisfactionFromGmail({
      checkpoints: [],
    });
    const gmailNormalized =
      await normalizeSatisfactionGmailResults(gmailCollected);
    allItems.push(...gmailNormalized.items);
  } catch {
    // Gmail satisfaction 실패 시 시트 결과만 사용
  }

  const applyResult = await applySatisfactionImports({
    runId,
    items: allItems,
    recalculateScores: false, // 최종 recalculate에서 일괄 처리
  });

  return {
    fetched: normalizedSheets.sourceSummaries.reduce(
      (sum, s) => sum + s.fetchedRows,
      0
    ),
    updated: applyResult.canonicalRecordsUpserted,
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

export async function POST() {
  const requestId = `req_${crypto.randomUUID()}`;
  let runId: string | null = null;

  try {
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
        runType: "manual_refresh",
        status: "running",
        triggeredBy: "api:/api/refresh",
        summary: {
          request_id: requestId,
          stale_runs_cleaned: staleCleanup.cleanedRunIds.length,
        },
      },
    });
    runId = run.id;

    // 3. 소스별 순차 실행 (resilient: 한 소스가 실패해도 나머지 계속)
    const sourceResults: SourceResult[] = [];

    const sources: SourceDefinition[] = [
      { name: "notion", fn: runNotion },
      { name: "contract_sheet", fn: runContractSheet },
      { name: "salesmap", fn: runSalesmap },
      { name: "slack", fn: () => runSlack(run.id) },
      { name: "gmail", fn: () => runGmail(run.id) },
      { name: "satisfaction", fn: () => runSatisfaction(run.id) },
      { name: "fulltime", fn: runFulltime },
      { name: "ops_notes", fn: runOpsNotes },
    ];

    for (const source of sources) {
      const result = await runSourceWithSyncLog(run.id, source);
      sourceResults.push(result);
    }

    // 4. 실습코치 판정 (T6)
    let practiceCoachError: string | null = null;
    try {
      await detectPracticeCoaches();
    } catch (err) {
      practiceCoachError = summarizeError(err);
    }

    // 5. Fee 우선순위 체인 (T7)
    let feeResolverError: string | null = null;
    try {
      await resolveFees();
    } catch (err) {
      feeResolverError = summarizeError(err);
    }

    // 6. Fee 이력 적재 (T8)
    let feeHistoryError: string | null = null;
    try {
      await storeFeeHistories();
    } catch (err) {
      feeHistoryError = summarizeError(err);
    }

    // 7. 점수 재계산
    let scoreRecalcError: string | null = null;
    try {
      await recalculateAllScores();
    } catch (err) {
      scoreRecalcError = summarizeError(err);
    }

    // 5. 실행 결과 집계
    const successCount = sourceResults.filter(
      (r) => r.status === "success"
    ).length;
    const failedCount = sourceResults.filter(
      (r) => r.status === "failed"
    ).length;
    const totalRecordsUpdated = sourceResults.reduce(
      (sum, r) => sum + r.updatedCount,
      0
    );

    const pipelineStepError = practiceCoachError || feeResolverError || feeHistoryError || scoreRecalcError;
    const runStatus: "success" | "partial" | "failed" =
      failedCount === sources.length
        ? "failed"
        : failedCount > 0 || pipelineStepError
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
          scoreRecalcError,
          practiceCoachError,
          feeResolverError,
          feeHistoryError,
          staleRunsCleaned: staleCleanup.cleanedRunIds.length,
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
          sources_checked: sources.length,
          sources_updated: successCount,
          records_updated: totalRecordsUpdated,
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
