import { NextResponse } from "next/server";
import { POST as runRefresh } from "@/app/api/refresh/route";
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

  return runRefresh(
    new Request(refreshUrl, {
      method: "POST",
      headers,
    })
  );
}
