/**
 * GET /api/admin/debug-env-presence
 * 환경변수 존재 여부만 (값 노출 X).
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";

const KEYS = [
  "SLACK_BOT_TOKEN",
  "SLACK_WORKSPACE_ID",
  "SLACK_USER_TOKEN",
  "GOOGLE_CONTRACTS_SPREADSHEET_ID",
  "GOOGLE_USER_REFRESH_TOKEN",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "DATABASE_URL",
  "CRON_SECRET",
];

export async function GET(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const presence = KEYS.map((k) => {
    const v = process.env[k];
    return {
      key: k,
      present: typeof v === "string" && v.length > 0,
      length: typeof v === "string" ? v.length : 0,
    };
  });
  return NextResponse.json({ ok: true, presence });
}
