/**
 * GET /api/admin/audit-gmail-instructor-mentions?limit=200
 *
 * gmail satisfaction registry / import_item 중 subject·snippet·body에
 * "X 강사" / "X 강사님께" / "X 강사님" 패턴이 있는 케이스를 list.
 *
 * 각 케이스에 대해:
 *  - matched_instructor (registry.resolvedInstructorId가 가리키는 강사명)
 *  - extracted_mentioned_name (regex로 추출)
 *  - matchStatus (pending/auto/approved 등)
 *  - registry company / course / responseCount / avgScore
 *  - suspicion:
 *      mention_vs_match_mismatch — mentioned ≠ matched
 *      mention_pending — mentioned 있는데 매칭 못함
 *      mention_unknown_instructor — mentioned 강사가 DB에 없음
 *
 * 인증: CRON_SECRET
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type RawRecord = { [key: string]: unknown };
function pickString(o: RawRecord | undefined | null, ...keys: string[]): string | null {
  if (!o) return null;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return null;
}

const MENTION_REGEX = /([가-힣]{2,4}[A-Z]?)\s*(?:강사|대표|교수|선생)/g;

function extractMentions(text: string): string[] {
  if (!text) return [];
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  MENTION_REGEX.lastIndex = 0;
  while ((m = MENTION_REGEX.exec(text)) !== null) {
    out.add(m[1]);
  }
  return Array.from(out);
}

export async function GET(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const limit = parseInt(request.nextUrl.searchParams.get("limit") ?? "200", 10);

  // gmail-derived registries
  const registries = await prisma.satisfactionReviewRegistry.findMany({
    where: { sourceType: { in: ["gmail_summary", "gmail_satisfaction"] } },
    orderBy: { updatedAt: "desc" },
    take: 1000,
    select: {
      id: true,
      registryKey: true,
      sourceType: true,
      sourceRefs: true,
      matchStatus: true,
      companyName: true,
      courseName: true,
      candidateName: true,
      responseCount: true,
      avgScore: true,
      resolvedInstructorId: true,
    },
  });

  // join ImportItem by thread_id for body text
  const threadIds = new Set<string>();
  for (const r of registries) {
    const refs = Array.isArray(r.sourceRefs) ? (r.sourceRefs as RawRecord[]) : [];
    const inner = refs[0]?.source_ref as RawRecord | undefined;
    const tid = pickString(inner, "thread_id");
    if (tid) threadIds.add(tid);
  }
  type ImportItemRow = {
    sourceRefKey: string | null;
    rawPayload: unknown;
    normalizedPayload: unknown;
  };
  const items: ImportItemRow[] = threadIds.size
    ? await prisma.satisfactionImportItem.findMany({
        where: {
          OR: Array.from(threadIds).flatMap((tid) => [
            { sourceRefKey: { startsWith: `gmail_satisfaction:${tid}:` } },
          ]),
        },
        select: { sourceRefKey: true, rawPayload: true, normalizedPayload: true },
      })
    : [];
  const itemsByThread = new Map<string, ImportItemRow[]>();
  for (const it of items) {
    if (!it.sourceRefKey) continue;
    const m = it.sourceRefKey.match(/^gmail_satisfaction:([^:]+):/);
    if (!m) continue;
    const tid = m[1];
    const arr = itemsByThread.get(tid) ?? ([] as ImportItemRow[]);
    arr.push(it);
    itemsByThread.set(tid, arr);
  }

  // resolved instructor names
  const resolvedIds = Array.from(
    new Set(
      registries
        .map((r) => r.resolvedInstructorId)
        .filter((id): id is string => !!id)
    )
  );
  const resolvedInstructors = resolvedIds.length
    ? await prisma.instructor.findMany({
        where: { id: { in: resolvedIds } },
        select: { id: true, name: true },
      })
    : [];
  const nameById = new Map(resolvedInstructors.map((i) => [i.id, i.name]));

  // all instructor names for mention-vs-DB existence check
  const allInstructors = await prisma.instructor.findMany({
    select: { name: true },
  });
  const knownNames = new Set(allInstructors.map((i) => i.name));

  const out: Array<{
    registry_key: string;
    source_type: string;
    matched_status: string;
    matched_instructor: string | null;
    extracted_mentions: string[];
    company: string | null;
    course: string | null;
    response_count: number;
    avg_score: number | null;
    suspicions: string[];
    sample_text: string;
  }> = [];

  for (const r of registries) {
    const refs = Array.isArray(r.sourceRefs) ? (r.sourceRefs as RawRecord[]) : [];
    const inner = refs[0]?.source_ref as RawRecord | undefined;
    const tid = pickString(inner, "thread_id") ?? "";
    const subj = pickString(inner, "subject") ?? pickString(refs[0], "subject") ?? "";
    const snip = pickString(inner, "snippet") ?? pickString(refs[0], "snippet") ?? "";
    const threadItems = tid ? itemsByThread.get(tid) ?? [] : [];
    let body = "";
    for (const it of threadItems) {
      const raw = it.rawPayload as RawRecord | null;
      if (typeof raw?.body === "string") {
        body += " " + (raw.body as string);
      }
    }
    const haystack = [r.courseName ?? "", subj, snip, body].filter(Boolean).join(" | ");
    const mentions = extractMentions(haystack);
    if (mentions.length === 0) continue;
    const matchedName = r.resolvedInstructorId ? nameById.get(r.resolvedInstructorId) ?? null : null;
    const suspicions: string[] = [];
    if (matchedName && !mentions.includes(matchedName)) {
      suspicions.push("mention_vs_match_mismatch");
    }
    if (r.matchStatus === "pending") {
      suspicions.push("mention_pending");
    }
    const knownMentions = mentions.filter((n) => knownNames.has(n));
    if (knownMentions.length === 0) {
      suspicions.push("mention_unknown_instructor");
    }
    if (suspicions.length === 0) continue; // 정상 매칭은 skip

    out.push({
      registry_key: r.registryKey,
      source_type: r.sourceType,
      matched_status: r.matchStatus,
      matched_instructor: matchedName,
      extracted_mentions: mentions,
      company: r.companyName,
      course: r.courseName,
      response_count: r.responseCount,
      avg_score: r.avgScore !== null ? Number(r.avgScore) : null,
      suspicions,
      sample_text: haystack.slice(0, 300),
    });
    if (out.length >= limit) break;
  }

  const summary = {
    total: out.length,
    mention_vs_match_mismatch: out.filter((o) => o.suspicions.includes("mention_vs_match_mismatch")).length,
    mention_pending: out.filter((o) => o.suspicions.includes("mention_pending")).length,
    mention_unknown_instructor: out.filter((o) => o.suspicions.includes("mention_unknown_instructor")).length,
  };

  return NextResponse.json({ ok: true, summary, mentions: out });
}
