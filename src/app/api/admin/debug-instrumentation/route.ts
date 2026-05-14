import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const marker = (process as unknown as { __TLS_DISPATCHER_SET__?: number }).__TLS_DISPATCHER_SET__;
  return NextResponse.json({
    ok: true,
    tls_dispatcher_set: marker !== undefined,
    trusted_count: marker ?? null,
  });
}
