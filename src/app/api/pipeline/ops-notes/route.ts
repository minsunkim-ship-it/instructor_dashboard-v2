/**
 * POST /api/pipeline/ops-notes
 *
 * 운영 메모 hardcoded JSON 파이프라인 — 04_data_pipeline.md 4-8절, 5-8절, 5-8-1절, 5-8-2절, 6절, 21-2절
 *
 * 수행:
 *   1. data/ops-notes-hardcoded.json 로딩
 *   2. 5-8-1 / 6절 필터 규칙 적용 (10자 미만, 민감 키워드, 시작 패턴)
 *   3. exact name match 강사의 memo_raw 비파괴 병합 (기존 값 보존, 덮어쓰기 금지)
 *   4. pipeline_runs + source_sync_logs 기록
 */

import { NextResponse } from "next/server";
import { loadOpsNotesJson } from "@/lib/pipeline/ops-notes-loader";
import { applyOpsNotes } from "@/lib/pipeline/config-applier";

export async function POST() {
  const requestId = `req_${crypto.randomUUID()}`;

  try {
    const loaded = loadOpsNotesJson();
    const result = await applyOpsNotes(loaded, "api:/api/pipeline/ops-notes");

    return NextResponse.json({
      status: "success",
      meta: {
        request_id: requestId,
        pipeline: "ops_notes_pilot",
      },
      data: {
        run_id: result.runId,
        run_status: result.runStatus,
        source_file: loaded.sourcePath,
        json_version: loaded.version,
        json_updated_at: loaded.updatedAt,
        total_entries: loaded.totalEntries,
        accepted_count: loaded.acceptedCount,
        filtered_out_count: loaded.filteredOutCount,
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
          pipeline: "ops_notes_pilot",
        },
        errors: [
          {
            code: "PIPELINE_FAILED",
            message:
              err instanceof Error
                ? err.message
                : "운영 메모 파이프라인 실행 실패",
          },
        ],
      },
      { status: 500 }
    );
  }
}
