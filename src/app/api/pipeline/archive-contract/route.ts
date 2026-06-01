/**
 * POST /api/pipeline/archive-contract
 *
 * 사용자가 2026-05-26에 알려준 archive 계약시트 (xlsx)
 *   "★조교 계약 작성 요청_B2B교육사업본부_DT기업교육팀.xlsx"
 *   ID: 1hl6VxXYN1kJoQlRCpbpyWV2PFsu3LhFQ
 *   2024-08 이전 강사 강의 이력
 *
 * 흐름: Drive binary download → xlsx 파싱 → 헤더 매핑 → TeachingHistory upsert.
 * 인증: CRON_SECRET
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";
import { collectArchiveContract } from "@/lib/pipeline/archive-contract-collector";
import { normalizeArchiveRows } from "@/lib/pipeline/archive-contract-normalizer";
import {
  storeArchiveRows,
  recomputeAggregatesForArchiveInstructors,
} from "@/lib/pipeline/archive-contract-store";

export const maxDuration = 180;
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const startedAt = Date.now();
  try {
    const collected = await collectArchiveContract();
    let totalNormalized = 0;
    const perSheet = collected.sheets.map((s) => {
      const normalized = normalizeArchiveRows(s.rows);
      totalNormalized += normalized.length;
      return { sheet: s, normalized };
    });
    const allNormalized = perSheet.flatMap((x) => x.normalized);
    const storeResult = await storeArchiveRows(allNormalized);
    const aggResult = await recomputeAggregatesForArchiveInstructors(
      storeResult.instructorIdsAffected
    );

    return NextResponse.json({
      ok: true,
      durationMs: Date.now() - startedAt,
      sheets: perSheet.map((x) => ({
        name: x.sheet.sheetName,
        fetched: x.sheet.fetchedCount,
        normalized: x.normalized.length,
        error: x.sheet.error ?? null,
      })),
      total_normalized: totalNormalized,
      store: {
        fetched: storeResult.fetched,
        appended: storeResult.appended,
        updated: storeResult.updated,
        deduped: storeResult.deduped,
        skipped_no_instructor: storeResult.skippedNoInstructor,
        errors: storeResult.errors.slice(0, 10),
        affected_instructors: storeResult.instructorIdsAffected.size,
      },
      aggregates_updated: aggResult.updated,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        durationMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}
