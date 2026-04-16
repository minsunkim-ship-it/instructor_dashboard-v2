/**
 * POST /api/pipeline/salesmap — Pilot 4-3
 *
 * 04_data_pipeline.md 4-3절, 5-3절, 5-3-1절, 21-2절
 * 03_data_model.md 4-8절 pipeline_runs, 4-9절 source_sync_logs
 *
 * 흐름:
 *   1. pipeline_runs 1건 생성 (running)
 *   2. 세일즈맵 스냅샷 수집 → unpivot 정규화
 *   3. DB 에 적용 (instructors.last_activity_at, teaching_histories.company_name/course_name)
 *   4. source_sync_logs 1건 기록 (source_type=salesmap)
 *   5. pipeline_runs 종료 (success / partial / failed)
 */

import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { collectFromSalesmapSnapshot } from "@/lib/pipeline/salesmap-collector";
import { normalizeSalesmapDeals } from "@/lib/pipeline/salesmap-normalizer";
import { applySalesmapRows } from "@/lib/pipeline/salesmap-applier";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST() {
  const requestId = `req_${crypto.randomUUID()}`;

  const run = await prisma.pipelineRun.create({
    data: {
      runType: "pilot_4_3_salesmap",
      status: "running",
      triggeredBy: "pilot_4_3",
    },
  });

  const syncStartedAt = new Date();

  try {
    // Step 1: snapshot 수집
    const { snapshotPath, deals } = collectFromSalesmapSnapshot();

    // Step 2: unpivot 정규화
    const normalized = normalizeSalesmapDeals(deals);

    // Step 3: DB 적용
    const applyResult = await applySalesmapRows(deals.length, normalized);

    // Step 4: source_sync_logs 1건 — 04_data_pipeline 21-1
    await prisma.sourceSyncLog.create({
      data: {
        runId: run.id,
        sourceType: "salesmap",
        status: "success",
        fetchedCount: applyResult.dealsFetched,
        updatedCount:
          applyResult.lastActivityUpdated +
          applyResult.teachingHistoriesCompanyFilled +
          applyResult.teachingHistoriesCourseNameFilled,
        errorMessage: null,
        startedAt: syncStartedAt,
        finishedAt: new Date(),
      },
    });

    // Step 5: pipeline_runs 종료
    const runSummary: Prisma.InputJsonObject = {
      snapshot_path: snapshotPath,
      deals_fetched: applyResult.dealsFetched,
      slot_rows_normalized: applyResult.slotRowsNormalized,
      instructors_matched: applyResult.instructorsMatched,
      instructors_unmatched: applyResult.instructorsUnmatched,
      last_activity_updated: applyResult.lastActivityUpdated,
      teaching_histories_company_filled:
        applyResult.teachingHistoriesCompanyFilled,
      teaching_histories_course_name_filled:
        applyResult.teachingHistoriesCourseNameFilled,
      teaching_histories_unmatched: applyResult.teachingHistoriesUnmatched,
      hourly_fee_candidates: applyResult.hourlyFeeCandidates,
      non_hourly_fee_values: applyResult.nonHourlyFeeValues,
      unmatched_instructor_samples:
        applyResult.unmatchedInstructorSamples as unknown as Prisma.InputJsonArray,
    };

    await prisma.pipelineRun.update({
      where: { id: run.id },
      data: {
        status: "success",
        finishedAt: new Date(),
        summary: runSummary,
      },
    });

    return NextResponse.json({
      status: "success",
      meta: {
        request_id: requestId,
        pipeline: "pilot_4_3_salesmap",
        run_id: run.id,
      },
      data: runSummary,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // source_sync_logs failed 1건
    await prisma.sourceSyncLog.create({
      data: {
        runId: run.id,
        sourceType: "salesmap",
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
          pipeline: "pilot_4_3_salesmap",
          run_id: run.id,
        },
        errors: [{ code: "PIPELINE_FAILED", message }],
      },
      { status: 500 }
    );
  }
}
