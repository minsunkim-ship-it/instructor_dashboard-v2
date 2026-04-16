/**
 * POST /api/pipeline/fulltime
 *
 * 전임강사 JSON 파이프라인 — 04_data_pipeline.md 4-7절, 5-7절, 5-7-1절, 10절, 21-2절
 *
 * 수행:
 *   1. prisma/fulltime_instructors.json 로딩
 *   2. active=true 항목에 대해 instructors.is_fulltime = true (exact name match)
 *   3. pipeline_runs + source_sync_logs 기록
 */

import { NextResponse } from "next/server";
import { loadFulltimeJson } from "@/lib/pipeline/fulltime-loader";
import { applyFulltime } from "@/lib/pipeline/config-applier";

export async function POST() {
  const requestId = `req_${crypto.randomUUID()}`;

  try {
    const loaded = loadFulltimeJson();
    const result = await applyFulltime(loaded, "api:/api/pipeline/fulltime");

    return NextResponse.json({
      status: "success",
      meta: {
        request_id: requestId,
        pipeline: "fulltime_pilot",
      },
      data: {
        run_id: result.runId,
        run_status: result.runStatus,
        source_file: loaded.sourcePath,
        json_version: loaded.version,
        json_updated_at: loaded.updatedAt,
        total_entries: loaded.totalEntries,
        active_count: loaded.activeCount,
        updated_count: result.sync.updatedCount,
        unmatched_count: (result.sync.extra.unmatched_count as number) ?? 0,
        unmatched_names: (result.sync.extra.unmatched_names as string[]) ?? [],
      },
    });
  } catch (err) {
    return NextResponse.json(
      {
        status: "error",
        meta: {
          request_id: requestId,
          pipeline: "fulltime_pilot",
        },
        errors: [
          {
            code: "PIPELINE_FAILED",
            message:
              err instanceof Error
                ? err.message
                : "전임강사 파이프라인 실행 실패",
          },
        ],
      },
      { status: 500 }
    );
  }
}
