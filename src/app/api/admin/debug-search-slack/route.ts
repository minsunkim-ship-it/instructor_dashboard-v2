/**
 * GET /api/admin/debug-search-slack?q=풍산
 * activityImportItem rawPayload.text에서 keyword 검색.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const q = request.nextUrl.searchParams.get("q");
  if (!q) return NextResponse.json({ ok: false, error: "q required" }, { status: 400 });
  const items = await prisma.activityImportItem.findMany({
    where: {
      sourceType: "slack",
      rawPayload: { path: ["text"], string_contains: q },
    },
    select: { rawPayload: true, sourceRef: true, activityAt: true },
    take: 20,
    orderBy: { activityAt: "desc" },
  });
  const hits = items.map((it) => {
    const raw = it.rawPayload as Record<string, unknown>;
    const ref = it.sourceRef as Record<string, unknown>;
    return {
      channel: (raw.channel_id ?? raw.channel ?? ref.channel_id ?? ref.channel) as string | undefined,
      activityAt: it.activityAt,
      text: typeof raw.text === "string" ? raw.text.slice(0, 200) : null,
    };
  });
  return NextResponse.json({ ok: true, count: hits.length, hits });
}
