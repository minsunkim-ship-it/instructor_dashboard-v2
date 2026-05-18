/**
 * GET /api/admin/debug-no-company
 * 회사명이 null인 pending registry의 sourceRefs 본문/주제/from/to 등 모두 노출.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";

type RawRecord = { [key: string]: unknown };
function pickString(o: RawRecord | undefined | null, ...keys: string[]): string | null {
  if (!o) return null;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return null;
}

export async function GET(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const limit = parseInt(request.nextUrl.searchParams.get("limit") ?? "30", 10) || 30;

  const rows = await prisma.satisfactionReviewRegistry.findMany({
    where: {
      matchStatus: "pending",
      OR: [{ companyName: null }, { companyName: "" }],
    },
    orderBy: { responseCount: "desc" },
    take: limit,
  });

  // ImportItem join — gmail의 경우 raw_payload.subject/snippet/from/to
  const sourceRefKeys = new Set<string>();
  const registryKeys = new Set<string>();
  for (const r of rows) {
    registryKeys.add(r.registryKey);
    const refs = Array.isArray(r.sourceRefs) ? (r.sourceRefs as RawRecord[]) : [];
    for (const ref of refs) {
      const inner = ref?.source_ref as RawRecord | undefined;
      const key = pickString(inner, "source_ref_key", "source_key", "thread_id", "message_id", "file_id");
      if (key) sourceRefKeys.add(key);
    }
  }
  const items = await prisma.satisfactionImportItem.findMany({
    where: { sourceRefKey: { in: Array.from(sourceRefKeys) } },
    select: { sourceRefKey: true, sourceType: true, rawPayload: true, normalizedPayload: true },
    take: 500,
  });
  const itemByKey = new Map<string, typeof items[number]>();
  for (const it of items) itemByKey.set(it.sourceRefKey, it);

  const out = rows.map((r) => {
    const refs = Array.isArray(r.sourceRefs) ? (r.sourceRefs as RawRecord[]) : [];
    const firstRef = refs[0];
    const inner = firstRef?.source_ref as RawRecord | undefined;
    const srk = pickString(inner, "source_ref_key", "source_key", "thread_id", "message_id", "file_id") ?? "";
    const item = srk ? itemByKey.get(srk) : undefined;
    const raw = (item?.rawPayload as RawRecord | null) ?? null;
    return {
      registry_key: r.registryKey,
      source_type: r.sourceType,
      response_count: r.responseCount,
      avg_score: r.avgScore !== null ? Number(r.avgScore) : null,
      course_name: r.courseName,
      candidate_name: r.candidateName,
      source_ref_first: inner ?? {},
      gmail_subject: pickString(raw, "subject"),
      gmail_snippet: pickString(raw, "snippet")?.slice(0, 300) ?? null,
      gmail_from: pickString(raw, "from"),
      gmail_to: pickString(raw, "to"),
      gmail_body_head: typeof raw?.body === "string" ? (raw.body as string).slice(0, 500) : null,
    };
  });

  return NextResponse.json({ ok: true, count: out.length, rows: out });
}
