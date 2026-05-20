import { NextResponse } from "next/server";
import { POST as runRefresh } from "@/app/api/refresh/route";
import { POST as runSyncTop100OI } from "@/app/api/admin/sync-top100-oi/route";
import type { NextRequest } from "next/server";
import {
  isAuthorizedCronRequest,
  REFRESH_TRIGGER_HEADER,
} from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json(
      {
        status: "error",
        meta: {
          request_id: `req_${crypto.randomUUID()}`,
          data_mode: "live",
          is_fallback: false,
          last_updated_at: null,
        },
        errors: [
          {
            code: "CRON_UNAUTHORIZED",
            message: "유효한 cron secret이 없습니다.",
          },
        ],
      },
      { status: 401 }
    );
  }

  const refreshUrl = new URL(request.url);
  refreshUrl.pathname = "/api/refresh";

  const headers = new Headers(request.headers);
  headers.set(
    REFRESH_TRIGGER_HEADER,
    `api:/api/refresh/cron${refreshUrl.search}`
  );

  const refreshResponse = await runRefresh(
    new Request(refreshUrl, {
      method: "POST",
      headers,
    })
  );

  // 운영 인텔 자동 동기화 — top 100 score desc 중 promptVersion mismatch + 신규 진입자.
  // 실패해도 refresh 응답을 막지 않음. 결과는 X-OI-Sync 헤더에 요약.
  let oiSyncSummary = "skipped";
  try {
    const syncUrl = new URL(request.url);
    syncUrl.pathname = "/api/admin/sync-top100-oi";
    const syncRes = await runSyncTop100OI(
      new Request(syncUrl, {
        method: "POST",
        headers: new Headers({
          "x-cron-secret": request.headers.get("x-cron-secret") ?? "",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ batchSize: 20 }),
      }) as unknown as NextRequest
    );
    const syncData = (await syncRes.json()) as Record<string, unknown>;
    oiSyncSummary = JSON.stringify({
      regenerated: syncData.regenerated_count ?? 0,
      remaining: syncData.remaining_count ?? 0,
      up_to_date: syncData.up_to_date_count ?? 0,
    });
  } catch (error) {
    oiSyncSummary = `error: ${error instanceof Error ? error.message : String(error)}`;
  }

  const headersOut = new Headers(refreshResponse.headers);
  headersOut.set("X-OI-Sync", oiSyncSummary);
  return new NextResponse(refreshResponse.body, {
    status: refreshResponse.status,
    headers: headersOut,
  });
}
