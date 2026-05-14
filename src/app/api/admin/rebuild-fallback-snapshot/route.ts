/**
 * POST /api/admin/rebuild-fallback-snapshot
 *
 * last-good-snapshot.json 재생성. /api/instructors가 catch 블록 타고 stored snapshot
 * 반환 중일 때 (`data_mode:"stored", is_fallback:true`) 화면이 outdated되는 문제 해결.
 *
 * 인증: CRON_SECRET
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";
import {
  buildStoredFallbackSnapshot,
  writeStoredFallbackSnapshot,
} from "@/lib/fallback-snapshot";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

function authorize(request: NextRequest): boolean {
  const headerSecret = request.headers.get(CRON_SECRET_HEADER);
  if (isValidCronSecret(headerSecret)) return true;
  const querySecret = request.nextUrl.searchParams.get("secret");
  if (isValidCronSecret(querySecret)) return true;
  return false;
}

export async function POST(request: NextRequest) {
  if (!authorize(request)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const startedAt = Date.now();
  try {
    const snapshot = await buildStoredFallbackSnapshot();
    await writeStoredFallbackSnapshot(snapshot);
    return NextResponse.json({
      ok: true,
      durationMs: Date.now() - startedAt,
      generated_at: snapshot.generated_at,
      list_items_count: snapshot.list_items?.length ?? 0,
      detail_items_count: snapshot.detail_items
        ? Object.keys(snapshot.detail_items).length
        : 0,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}
