/**
 * GET /api/admin/debug-slack-channels
 * activityImportItem 중 채널별 메시지 수 집계.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";

type RawRecord = { [key: string]: unknown };
function pickString(obj: RawRecord | undefined | null, ...keys: string[]): string | null {
  if (!obj) return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return null;
}

export async function GET(request: NextRequest) {
  const h = request.headers.get(CRON_SECRET_HEADER);
  if (!isValidCronSecret(h)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const items = await prisma.activityImportItem.findMany({
    where: { sourceType: "slack" },
    select: { rawPayload: true, sourceRef: true },
    take: 20000,
  });
  const byChannel = new Map<string, number>();
  for (const it of items) {
    const raw = (it.rawPayload as RawRecord | null) ?? {};
    const ref = (it.sourceRef as RawRecord | null) ?? {};
    const cid = pickString(raw, "channel_id", "channel") ?? pickString(ref, "channel_id", "channel") ?? "(none)";
    byChannel.set(cid, (byChannel.get(cid) ?? 0) + 1);
  }
  return NextResponse.json({
    ok: true,
    total: items.length,
    by_channel: Array.from(byChannel.entries())
      .map(([id, count]) => ({ id, count }))
      .sort((a, b) => b.count - a.count),
  });
}
