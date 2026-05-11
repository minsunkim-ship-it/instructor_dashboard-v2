import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  collectSatisfactionSheets,
  getAllSatisfactionSheetSources,
} from "@/lib/pipeline/satisfaction-sheets-collector";
import {
  GMAIL_SATISFACTION_SOURCE_KEY,
  collectSatisfactionFromGmail,
  type SatisfactionGmailCheckpoint,
} from "@/lib/pipeline/satisfaction-gmail-collector";
import { normalizeSatisfactionGmailResults } from "@/lib/pipeline/satisfaction-gmail-normalizer";
import {
  normalizeSatisfactionSheetResults,
  type SatisfactionSourceSummary,
} from "@/lib/pipeline/satisfaction-sheets-normalizer";
import { applySatisfactionImports } from "@/lib/pipeline/satisfaction-applier";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

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

async function saveSatisfactionGmailCheckpoints(
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

type SatisfactionPipelineSourceKey = string;

/**
 * 코드 SOURCES + catalog JSON에 등록된 모든 키 + gmail = 허용 키 전체.
 * include 파라미터로 catalog JSON에 등록된 시트도 대상이 되어야 한다.
 */
async function getAllowedSourceKeys(): Promise<Set<string>> {
  const allSheetSources = await getAllSatisfactionSheetSources();
  const allowed = new Set<string>([
    ...allSheetSources.map((s) => s.key),
    GMAIL_SATISFACTION_SOURCE_KEY,
  ]);
  return allowed;
}

async function parseIncludeKeys(
  raw: string | null
): Promise<SatisfactionPipelineSourceKey[] | undefined> {
  if (!raw) return undefined;
  const allowed = await getAllowedSourceKeys();
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => allowed.has(value));
  return values.length > 0 ? values : undefined;
}

function parsePositiveInt(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function toSourceSummaryJson(summary: SatisfactionSourceSummary): Prisma.InputJsonObject {
  return {
    source_key: summary.sourceKey,
    source_type: summary.sourceType,
    fetched_rows: summary.fetchedRows,
    imported_items: summary.importedItems,
    skipped_rows: summary.skippedRows,
    auto_accepted_candidates: summary.autoAcceptedCandidates,
    pending_candidates: summary.pendingCandidates,
    status: summary.status,
    note: summary.note ?? null,
  };
}

export async function POST(request: NextRequest) {
  const requestId = `req_${crypto.randomUUID()}`;
  const includeKeys = await parseIncludeKeys(
    request.nextUrl.searchParams.get("include")
  );
  const includeGmail =
    !includeKeys || includeKeys.includes(GMAIL_SATISFACTION_SOURCE_KEY);
  const sheetIncludeKeys =
    includeKeys?.filter((key) => key !== GMAIL_SATISFACTION_SOURCE_KEY) ?? undefined;
  const gmailMaxPages = parsePositiveInt(request.nextUrl.searchParams.get("gmailMaxPages"));
  const gmailPageSize = parsePositiveInt(request.nextUrl.searchParams.get("gmailPageSize"));
  const gmailDetailConcurrency = parsePositiveInt(
    request.nextUrl.searchParams.get("gmailDetailConcurrency")
  );
  const gmailQuery = request.nextUrl.searchParams.get("gmailQuery")?.trim() || undefined;
  const gmailStartDate = request.nextUrl.searchParams.get("gmailStartDate")?.trim() || undefined;
  const gmailEndDate = request.nextUrl.searchParams.get("gmailEndDate")?.trim() || undefined;
  const gmailReconcile = request.nextUrl.searchParams.get("gmailMode") === "reconcile";

  const run = await prisma.pipelineRun.create({
    data: {
      runType: "pilot_4_4_satisfaction_sheets",
      status: "running",
      triggeredBy: "api:/api/pipeline/satisfaction",
    },
  });

  const syncStartedAt = new Date();

  try {
    const shouldSkipSheets = includeKeys !== undefined && (sheetIncludeKeys?.length ?? 0) === 0;
    const collected =
      shouldSkipSheets
        ? []
        : await collectSatisfactionSheets({ includeKeys: sheetIncludeKeys });
    const normalizedSheets = await normalizeSatisfactionSheetResults(collected);
    const allItems = [...normalizedSheets.items];
    const allSourceSummaries = [...normalizedSheets.sourceSummaries];
    let gmailSkippedSamples: Prisma.InputJsonArray = [];
    let gmailThreadsForCheckpoint: Array<{
      threadId: string;
      sentAt: string | null;
    }> = [];

    if (includeGmail) {
      const gmailCheckpoint =
        gmailReconcile || gmailStartDate || gmailEndDate
          ? null
          : await loadSatisfactionGmailCheckpoint();
      const gmailCollected = await collectSatisfactionFromGmail({
        query: gmailQuery,
        maxPages: gmailMaxPages,
        pageSize: gmailPageSize,
        detailConcurrency: gmailDetailConcurrency,
        checkpoint: gmailCheckpoint,
        startDate: gmailStartDate,
        endDate: gmailEndDate,
      });
      gmailThreadsForCheckpoint = gmailCollected.threads.map((thread) => ({
        threadId: thread.threadId,
        sentAt: thread.sentAt,
      }));
      const gmailNormalized = await normalizeSatisfactionGmailResults(gmailCollected);
      allItems.push(...gmailNormalized.items);
      allSourceSummaries.push(gmailNormalized.sourceSummary);
      gmailSkippedSamples =
        gmailNormalized.skippedSamples as unknown as Prisma.InputJsonArray;
    }

    const applyResult = await applySatisfactionImports({
      runId: run.id,
      items: allItems,
      recalculateScores: true,
    });
    if (includeGmail && gmailThreadsForCheckpoint.length > 0) {
      await saveSatisfactionGmailCheckpoints(
        gmailThreadsForCheckpoint.map((thread) => ({
          threadId: thread.threadId,
          sentAt: thread.sentAt,
        }))
      );
    }

    for (const summary of allSourceSummaries) {
      await prisma.sourceSyncLog.create({
        data: {
          runId: run.id,
          sourceType: `satisfaction_sheet:${summary.sourceKey}`,
          status:
            summary.status === "success"
              ? "success"
              : summary.status === "partial" || summary.status === "skipped"
                ? "partial"
                : "failed",
          fetchedCount: summary.fetchedRows,
          updatedCount: summary.importedItems,
          errorMessage: summary.note ?? null,
          startedAt: syncStartedAt,
          finishedAt: new Date(),
        },
      });
    }

    const hasSkippedSource = allSourceSummaries.some(
      (summary) => summary.status !== "success"
    );
    const runStatus: "success" | "partial" =
      hasSkippedSource || applyResult.registries.invalidCount > 0 ? "partial" : "success";

    const allowedKeysList = Array.from(await getAllowedSourceKeys());
    const runSummary: Prisma.InputJsonObject = {
      pipeline: "pilot_4_4_satisfaction_sheets",
      included_source_keys: (includeKeys ??
        allowedKeysList) as unknown as Prisma.InputJsonArray,
      gmail_mode:
        gmailStartDate || gmailEndDate ? "date_window_backfill" : gmailReconcile ? "reconcile" : "incremental",
      gmail_start_date: gmailStartDate ?? null,
      gmail_end_date: gmailEndDate ?? null,
      gmail_detail_concurrency: gmailDetailConcurrency ?? null,
      raw_rows_fetched: allSourceSummaries.reduce(
        (sum, summary) => sum + summary.fetchedRows,
        0
      ),
      import_items_stored: applyResult.importItemsStored,
      registry_auto_accepted_count: applyResult.registries.autoAcceptedCount,
      registry_pending_count: applyResult.registries.pendingCount,
      registry_approved_count: applyResult.registries.approvedCount,
      registry_rejected_count: applyResult.registries.rejectedCount,
      registry_invalid_count: applyResult.registries.invalidCount,
      affected_instructors: applyResult.affectedInstructors,
      canonical_records_upserted: applyResult.canonicalRecordsUpserted,
      gmail_skipped_samples: gmailSkippedSamples,
      source_summaries:
        allSourceSummaries.map(toSourceSummaryJson) as unknown as Prisma.InputJsonArray,
    };

    await prisma.pipelineRun.update({
      where: { id: run.id },
      data: {
        status: runStatus,
        finishedAt: new Date(),
        summary: runSummary,
      },
    });

    return NextResponse.json({
      status: "success",
      meta: {
        request_id: requestId,
        pipeline: "pilot_4_4_satisfaction_sheets",
        run_id: run.id,
        run_status: runStatus,
      },
      data: runSummary,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await prisma.sourceSyncLog.create({
      data: {
        runId: run.id,
        sourceType: "satisfaction_sheet:route",
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
          pipeline: "pilot_4_4_satisfaction_sheets",
          run_id: run.id,
        },
        errors: [{ code: "PIPELINE_FAILED", message }],
      },
      { status: 500 }
    );
  }
}
