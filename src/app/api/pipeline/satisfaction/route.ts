import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  ACCESSIBLE_SATISFACTION_SHEET_SOURCES,
  collectSatisfactionSheets,
} from "@/lib/pipeline/satisfaction-sheets-collector";
import {
  GMAIL_SATISFACTION_SOURCE_KEY,
  collectSatisfactionFromGmail,
  type SatisfactionGmailTargetCheckpoint,
} from "@/lib/pipeline/satisfaction-gmail-collector";
import { normalizeSatisfactionGmailResults } from "@/lib/pipeline/satisfaction-gmail-normalizer";
import {
  normalizeSatisfactionSheetResults,
  type SatisfactionSourceSummary,
} from "@/lib/pipeline/satisfaction-sheets-normalizer";
import { applySatisfactionImports } from "@/lib/pipeline/satisfaction-applier";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function loadSatisfactionGmailCheckpoints(
  targetAddresses: string[]
): Promise<SatisfactionGmailTargetCheckpoint[]> {
  const checkpoints: SatisfactionGmailTargetCheckpoint[] = [];
  for (const addr of targetAddresses) {
    const scopeKey = `gmail_satisfaction:target:${addr}`;
    const row = await prisma.sourceCheckpoint.findUnique({
      where: { sourceType_scopeKey: { sourceType: "gmail_satisfaction", scopeKey } },
    });
    if (!row) continue;
    const json = row.checkpointJson as Record<string, unknown>;
    checkpoints.push({
      targetAddress: addr,
      lastInternalDateMs:
        typeof json.last_internal_date_ms === "string" ? json.last_internal_date_ms : null,
    });
  }
  return checkpoints;
}

async function saveSatisfactionGmailCheckpoints(
  targetAddresses: string[],
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

  for (const addr of targetAddresses) {
    const scopeKey = `gmail_satisfaction:target:${addr}`;
    await prisma.sourceCheckpoint.upsert({
      where: { sourceType_scopeKey: { sourceType: "gmail_satisfaction", scopeKey } },
      create: {
        sourceType: "gmail_satisfaction",
        scopeKey,
        checkpointJson: { last_internal_date_ms: latestSentAtMs },
        lastSyncedAt: new Date(),
      },
      update: {
        checkpointJson: { last_internal_date_ms: latestSentAtMs },
        lastSyncedAt: new Date(),
      },
    });
  }
}

const SATISFACTION_PIPELINE_SOURCE_KEYS = [
  ...ACCESSIBLE_SATISFACTION_SHEET_SOURCES.map((source) => source.key),
  GMAIL_SATISFACTION_SOURCE_KEY,
] as const;

type SatisfactionPipelineSourceKey =
  (typeof SATISFACTION_PIPELINE_SOURCE_KEYS)[number];

function parseIncludeKeys(raw: string | null): SatisfactionPipelineSourceKey[] | undefined {
  if (!raw) return undefined;
  const allowed = new Set<string>(SATISFACTION_PIPELINE_SOURCE_KEYS);
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value): value is SatisfactionPipelineSourceKey => allowed.has(value));
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
  const includeKeys = parseIncludeKeys(request.nextUrl.searchParams.get("include"));
  const includeGmail =
    !includeKeys || includeKeys.includes(GMAIL_SATISFACTION_SOURCE_KEY);
  const sheetIncludeKeys =
    includeKeys?.filter(
      (key): key is (typeof ACCESSIBLE_SATISFACTION_SHEET_SOURCES)[number]["key"] =>
        key !== GMAIL_SATISFACTION_SOURCE_KEY
    ) ?? undefined;
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

    if (includeGmail) {
      const targetAddresses = (process.env.GMAIL_TARGET_ADDRESSES ?? "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
      const gmailCheckpoints =
        gmailReconcile || gmailStartDate || gmailEndDate
          ? []
          : await loadSatisfactionGmailCheckpoints(targetAddresses);
      const gmailCollected = await collectSatisfactionFromGmail({
        query: gmailQuery,
        maxPages: gmailMaxPages,
        pageSize: gmailPageSize,
        detailConcurrency: gmailDetailConcurrency,
        checkpoints: gmailCheckpoints,
        startDate: gmailStartDate,
        endDate: gmailEndDate,
      });
      await saveSatisfactionGmailCheckpoints(
        gmailCollected.targetAddresses,
        gmailCollected.threads.map((thread) => ({
          threadId: thread.threadId,
          sentAt: thread.sentAt,
        }))
      );
      const gmailNormalized = await normalizeSatisfactionGmailResults(gmailCollected);
      allItems.push(...gmailNormalized.items);
      allSourceSummaries.push(gmailNormalized.sourceSummary);
    }

    const applyResult = await applySatisfactionImports({
      runId: run.id,
      items: allItems,
      recalculateScores: true,
    });

    for (const summary of allSourceSummaries) {
      await prisma.sourceSyncLog.create({
        data: {
          runId: run.id,
          sourceType: `satisfaction_sheet:${summary.sourceKey}`,
          status:
            summary.status === "success"
              ? "success"
              : summary.status === "partial"
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

    const runSummary: Prisma.InputJsonObject = {
      pipeline: "pilot_4_4_satisfaction_sheets",
      included_source_keys:
        (includeKeys ??
          [...SATISFACTION_PIPELINE_SOURCE_KEYS]) as unknown as Prisma.InputJsonArray,
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
