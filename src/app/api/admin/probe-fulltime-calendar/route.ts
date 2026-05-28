/**
 * GET /api/admin/probe-fulltime-calendar?tab=전임소진(공지연)&limit=5
 *
 * fulltime-calendar collector debug. 특정 tab의 raw 행 + normalize 결과를 dump.
 * 인증: CRON_SECRET
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";
import { collectFromFulltimeCalendars } from "@/lib/pipeline/fulltime-calendar-collector";
import { normalizeFulltimeRow } from "@/lib/pipeline/fulltime-calendar-normalizer";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const tabFilter = request.nextUrl.searchParams.get("tab");
  const limit = parseInt(request.nextUrl.searchParams.get("limit") ?? "5", 10);
  const collected = await collectFromFulltimeCalendars();

  const result = collected.tabs.map((t) => {
    if (tabFilter && !t.tabTitle.includes(tabFilter)) {
      return {
        tabTitle: t.tabTitle,
        fetched: t.fetchedCount,
        skipped_filter: true,
      };
    }
    const samples = t.rows.slice(0, limit).map((r) => {
      const norm = normalizeFulltimeRow(r);
      return {
        row_number: r.rowNumber,
        values: r.values,
        normalized: norm,
      };
    });
    return {
      tabTitle: t.tabTitle,
      kind: t.kind,
      fetched: t.fetchedCount,
      error: t.error ?? null,
      samples,
    };
  });

  return NextResponse.json({ ok: true, tabs: result });
}
