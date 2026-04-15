/**
 * POST /api/pipeline/notion
 *
 * 파일럿 파이프라인: Notion 소스 수집 → 정규화 → instructors 테이블 저장.
 * 04_data_pipeline.md 2절 전체 흐름 중 아래만 구현:
 *   2. 소스별 데이터 수집 (Notion만)
 *   3. 소스별 정규화
 *  11. Railway DB 저장 (instructors 테이블만)
 */

import { NextResponse } from "next/server";
import { collectFromNotion } from "@/lib/pipeline/notion-collector";
import { normalizeNotionData } from "@/lib/pipeline/normalizer";
import { storeInstructors } from "@/lib/pipeline/store";

export async function POST() {
  const requestId = `req_${crypto.randomUUID()}`;

  try {
    // Step 1: Notion 수집 — 04_data_pipeline 4-2절
    const rawData = await collectFromNotion();

    // Step 2: 정규화 — 04_data_pipeline 6절
    const normalized = normalizeNotionData(rawData);

    // Step 3: instructors 테이블 저장 — 03_data_model 4-1절
    const storeResult = await storeInstructors(normalized);

    return NextResponse.json({
      status: "success",
      meta: {
        request_id: requestId,
        pipeline: "notion_pilot",
      },
      data: {
        fetched: rawData.length,
        normalized: normalized.length,
        skipped_no_name: rawData.length - normalized.length,
        created: storeResult.created,
        updated: storeResult.updated,
        errors: storeResult.errors,
      },
    });
  } catch (err) {
    return NextResponse.json(
      {
        status: "error",
        meta: {
          request_id: requestId,
          pipeline: "notion_pilot",
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
