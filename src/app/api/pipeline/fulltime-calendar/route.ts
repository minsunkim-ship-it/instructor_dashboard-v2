/**
 * POST /api/pipeline/fulltime-calendar
 *
 * 전임관리 캘린더 + 정백 출강목록 시트에서 TeachingHistory로 sync.
 * 회기적: 일반 contract-sheet에 없는 전임강사 강의 일정을 일반 TH로 가져온다.
 *
 * 인증: CRON_SECRET
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";
import { collectFromFulltimeCalendars } from "@/lib/pipeline/fulltime-calendar-collector";
import { normalizeFulltimeRows } from "@/lib/pipeline/fulltime-calendar-normalizer";
import {
  storeFulltimeRows,
  recomputeAggregatesForFulltimeInstructors,
} from "@/lib/pipeline/fulltime-calendar-store";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const startedAt = Date.now();
  try {
    const collected = await collectFromFulltimeCalendars();
    let totalNormalized = 0;
    const perTab = collected.tabs.map((t) => {
      const normalized = normalizeFulltimeRows(t.rows);
      totalNormalized += normalized.length;
      return { tab: t, normalized };
    });

    const allNormalized = perTab.flatMap((x) => x.normalized);
    const storeResult = await storeFulltimeRows(allNormalized);
    const aggResult = await recomputeAggregatesForFulltimeInstructors(
      storeResult.instructorIdsAffected
    );

    return NextResponse.json({
      ok: true,
      durationMs: Date.now() - startedAt,
      tabs: perTab.map((x) => ({
        spreadsheetId: x.tab.spreadsheetId,
        tabTitle: x.tab.tabTitle,
        kind: x.tab.kind,
        fetched: x.tab.fetchedCount,
        normalized: x.normalized.length,
        error: x.tab.error ?? null,
      })),
      total_normalized: totalNormalized,
      store: {
        fetched: storeResult.fetched,
        appended: storeResult.appended,
        updated: storeResult.updated,
        deduped: storeResult.deduped,
        skipped_no_instructor: storeResult.skippedNoInstructor,
        skipped_no_date: storeResult.skippedNoDate,
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
