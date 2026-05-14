/**
 * GET /api/admin/debug-slack-auth
 * Slack auth.test 호출로 token 검증.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    return NextResponse.json({ ok: false, error: "SLACK_BOT_TOKEN missing" });
  }
  const result: Record<string, unknown> = {
    token_prefix: token.slice(0, 5),
    token_length: token.length,
  };
  try {
    const res = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
        "User-Agent": "instructor-dashboard/1.0 (+coolify)",
        Accept: "application/json",
      },
    });
    result.http_status = res.status;
    const txt = await res.text();
    try {
      result.body = JSON.parse(txt);
    } catch {
      result.body_raw = txt.slice(0, 300);
    }
  } catch (e) {
    result.fetch_error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    // Inspect cause
    if (e instanceof Error && (e as Error & { cause?: unknown }).cause) {
      const cause = (e as Error & { cause?: unknown }).cause;
      result.fetch_cause =
        cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
    }
  }
  return NextResponse.json({ ok: true, ...result });
}
