/**
 * POST /api/pipeline/contract-sheet — Pilot 4-1
 *
 * 04_data_pipeline.md 21-2: 운영/관리용 파이프라인 트리거 API
 * 04_data_pipeline.md 4-1절, 5-1절, 5-1-1절, 6절, 7-2절, 18-1절, 21-1절
 *
 * 흐름:
 *   1. pipeline_runs 1건 생성 (running)
 *   2. worksheet 2개 각각 수집 → 정규화 → teaching_histories 저장
 *   3. worksheet별 source_sync_logs 1건씩 총 2건 기록
 *   4. 영향 instructor의 total_courses / recent_courses_6mo 집계 갱신
 *   5. pipeline_runs 종료 (success / partial / failed)
 */

import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  collectFromContractSheets,
  type WorksheetCollectResult,
} from "@/lib/pipeline/contract-sheet-collector";
import { normalizeContractRow } from "@/lib/pipeline/contract-sheet-normalizer";
import {
  storeContractRows,
  recomputeAggregatesForInstructors,
  type WorksheetStoreResult,
} from "@/lib/pipeline/contract-sheet-store";

interface WorksheetSummary {
  gid: number;
  fetched: number;
  appended: number;
  skipped_no_name: number;
  deduped: number;
  instructors_created: number;
  errors: number;
  status: "success" | "partial" | "failed";
  error_message: string | null;
}

export async function POST() {
  const requestId = `req_${crypto.randomUUID()}`;

  // 04_data_pipeline 21-1: Pilot에서도 pipeline_runs 1건 기록
  const run = await prisma.pipelineRun.create({
    data: {
      runType: "pilot_4_1_contract_sheet",
      status: "running",
      triggeredBy: "pilot_4_1",
    },
  });

  try {
    // Step 1: 두 worksheet 수집 (collector가 내부에서 worksheet별 error 분리)
    const collected = await collectFromContractSheets();

    // Step 2: worksheet별 정규화 + 저장 + source_sync_logs 1건씩 기록
    const worksheetSummaries: WorksheetSummary[] = [];
    const allAffectedInstructorIds = new Set<string>();

    for (const ws of collected.worksheets) {
      const syncLogStartedAt = new Date();

      const { summary, storeResult } = await processWorksheet(ws);

      // source_sync_logs 기록 — 04_data_pipeline 21-1, worksheet별 분리
      await prisma.sourceSyncLog.create({
        data: {
          runId: run.id,
          sourceType: "contract_sheet",
          status: summary.status,
          fetchedCount: summary.fetched,
          updatedCount: summary.appended,
          errorMessage: summary.error_message,
          startedAt: syncLogStartedAt,
          finishedAt: new Date(),
        },
      });

      worksheetSummaries.push(summary);

      if (storeResult) {
        storeResult.instructorIdsAffected.forEach((id) =>
          allAffectedInstructorIds.add(id)
        );
      }
    }

    // Step 3: 영향 instructor 집계 갱신 — 04_data_pipeline 18-1
    const aggregatesUpdated = await recomputeAggregatesForInstructors(
      allAffectedInstructorIds
    );

    // Step 4: pipeline_runs 종료
    const hasFailure = worksheetSummaries.some((s) => s.status === "failed");
    const hasPartial = worksheetSummaries.some((s) => s.status === "partial");
    const runStatus = hasFailure
      ? "partial"
      : hasPartial
        ? "partial"
        : "success";

    const totalAppended = worksheetSummaries.reduce(
      (s, x) => s + x.appended,
      0
    );
    const totalDeduped = worksheetSummaries.reduce(
      (s, x) => s + x.deduped,
      0
    );
    const totalSkipped = worksheetSummaries.reduce(
      (s, x) => s + x.skipped_no_name,
      0
    );
    const totalInstructorsCreated = worksheetSummaries.reduce(
      (s, x) => s + x.instructors_created,
      0
    );
    const totalErrors = worksheetSummaries.reduce((s, x) => s + x.errors, 0);

    const runSummary: Prisma.InputJsonObject = {
      spreadsheet_id: collected.spreadsheetId,
      worksheets: worksheetSummaries as unknown as Prisma.InputJsonArray,
      total_appended: totalAppended,
      total_deduped: totalDeduped,
      total_skipped_no_name: totalSkipped,
      total_instructors_created: totalInstructorsCreated,
      total_errors: totalErrors,
      aggregates_updated: aggregatesUpdated,
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
      status: runStatus === "success" ? "success" : "partial",
      meta: {
        request_id: requestId,
        pipeline: "pilot_4_1_contract_sheet",
        run_id: run.id,
      },
      data: {
        run_id: run.id,
        spreadsheet_id: collected.spreadsheetId,
        worksheets: worksheetSummaries,
        total_appended: totalAppended,
        total_deduped: totalDeduped,
        total_skipped_no_name: totalSkipped,
        total_instructors_created: totalInstructorsCreated,
        total_errors: totalErrors,
        aggregates_updated: aggregatesUpdated,
      },
    });
  } catch (err) {
    // pipeline_runs failed 처리 — 수집 자체가 실패한 경우
    await prisma.pipelineRun.update({
      where: { id: run.id },
      data: {
        status: "failed",
        finishedAt: new Date(),
        summary: {
          error: err instanceof Error ? err.message : String(err),
        },
      },
    });

    return NextResponse.json(
      {
        status: "error",
        meta: {
          request_id: requestId,
          pipeline: "pilot_4_1_contract_sheet",
          run_id: run.id,
        },
        errors: [
          {
            code: "PIPELINE_FAILED",
            message:
              err instanceof Error ? err.message : "파이프라인 실행 실패",
          },
        ],
      },
      { status: 500 }
    );
  }
}

/**
 * 단일 worksheet 처리: 수집 결과 → 정규화 → 저장 → summary.
 * worksheet 수집 단계에서 error가 있었다면 저장 단계를 건너뛴다.
 */
async function processWorksheet(
  ws: WorksheetCollectResult
): Promise<{
  summary: WorksheetSummary;
  storeResult: WorksheetStoreResult | null;
}> {
  if (ws.error) {
    return {
      summary: {
        gid: ws.gid,
        fetched: 0,
        appended: 0,
        skipped_no_name: 0,
        deduped: 0,
        instructors_created: 0,
        errors: 1,
        status: "failed",
        error_message: `gid=${ws.gid}: ${ws.error}`,
      },
      storeResult: null,
    };
  }

  const normalized = ws.rows.map(normalizeContractRow);
  const storeResult = await storeContractRows(normalized);

  const status: WorksheetSummary["status"] =
    storeResult.errors.length > 0 ? "partial" : "success";

  const errorMessage =
    storeResult.errors.length > 0
      ? `gid=${ws.gid}: ${storeResult.errors.length}건 행 실패 — ${JSON.stringify(
          storeResult.errors.slice(0, 3)
        )}`
      : null;

  return {
    summary: {
      gid: ws.gid,
      fetched: ws.fetchedCount,
      appended: storeResult.appended,
      skipped_no_name: storeResult.skipped,
      deduped: storeResult.deduped,
      instructors_created: storeResult.instructorsCreated,
      errors: storeResult.errors.length,
      status,
      error_message: errorMessage,
    },
    storeResult,
  };
}
