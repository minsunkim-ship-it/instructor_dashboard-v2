/**
 * GET /api/admin/debug-slack-fetch
 * Slack collector를 직접 trigger하고 channel-level result/error 그대로 반환.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";
import { collectFromSlack, type RawSlackChannelCollect } from "@/lib/pipeline/slack-activity-collector";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  try {
    const start = Date.now();

    const out = await collectFromSlack({ requestTimeoutMs: 8000, channelTimeoutMs: 20000 });
    return NextResponse.json({
      ok: true,
      durationMs: Date.now() - start,
      channels: out.channels.map((c: RawSlackChannelCollect) => ({
        channelId: c.channelId,
        kind: c.kind,
        message_count: c.messages.length,
        users_count: Object.keys(c.users).length,
        error: c.error ?? null,
      })),
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
