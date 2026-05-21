/**
 * GET /api/admin/audit-ambiguous-registries
 *
 * pending registry 전체 중 ops_report cross-check 시 2+명 candidate인 ambiguous case 카운트.
 * 운영자가 1-click 선택 필요한 케이스 양 측정.
 *
 * 인증: CRON_SECRET
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";
import { normalizeCompanyWithAlias } from "@/lib/company-aliases";

export const maxDuration = 120;
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
const OPS_REPORT_CHANNEL_ID = "C015YD84VGS";
const GENERAL_CHANNEL_ID = "C79GDLS3A";
const ALLOWED = new Set([OPS_REPORT_CHANNEL_ID, GENERAL_CHANNEL_ID]);
const INSTRUCTOR_REGEX = /([가-힣]{2,4}[A-Z]?)\s*(?:강사|대표|교수|선생)님/g;

export async function GET(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const limit = parseInt(request.nextUrl.searchParams.get("limit") ?? "200", 10);
  const startedAt = Date.now();

  const pending = await prisma.satisfactionReviewRegistry.findMany({
    where: { matchStatus: "pending" },
    select: { registryKey: true, companyName: true, courseName: true, sourceRefs: true, sourceType: true },
    take: limit,
  });

  // slack items 전체 한 번에 (channel filter)
  const slackItems = await prisma.activityImportItem.findMany({
    where: { sourceType: "slack" },
    select: { rawPayload: true, sourceRef: true, activityAt: true },
    take: 50000,
  });
  const opsByChan: Array<{ cid: string; text: string; ts: Date | null }> = [];
  for (const it of slackItems) {
    const raw = (it.rawPayload as RawRecord | null) ?? {};
    const ref = (it.sourceRef as RawRecord | null) ?? {};
    const cid = pickString(raw, "channel_id", "channel") ?? pickString(ref, "channel_id", "channel");
    if (!cid || !ALLOWED.has(cid)) continue;
    const text = pickString(raw, "text", "message", "body") ?? "";
    if (!text) continue;
    opsByChan.push({ cid, text, ts: it.activityAt });
  }

  const allInstructors = await prisma.instructor.findMany({ select: { name: true } });
  const instructorNameSet = new Set(allInstructors.map((i) => i.name));

  const buckets = {
    single_candidate: 0,
    ambiguous_2: 0,
    ambiguous_3plus: 0,
    no_candidate: 0,
    no_date: 0,
  };
  const samples: Array<{
    company: string | null;
    course: string | null;
    candidates: string[];
    bucket: string;
  }> = [];

  for (const reg of pending) {
    const refs = Array.isArray(reg.sourceRefs) ? (reg.sourceRefs as RawRecord[]) : [];
    const firstRef = refs[0];
    const inner = firstRef?.source_ref as RawRecord | undefined;
    const dateStr =
      pickString(firstRef, "response_date") ??
      pickString(inner, "created_time") ??
      pickString(firstRef, "created_time");
    const effectiveCompany = normalizeCompanyWithAlias(reg.companyName ?? "");
    if (!dateStr || effectiveCompany.length < 2) {
      buckets.no_date += 1;
      continue;
    }
    const responseDate = new Date(dateStr).getTime();
    const window = 14 * 86400 * 1000;
    const names = new Set<string>();
    for (const m of opsByChan) {
      if (!m.ts) continue;
      if (Math.abs(m.ts.getTime() - responseDate) > window) continue;
      const normText = normalizeCompanyWithAlias(m.text);
      if (!normText.includes(effectiveCompany)) continue;
      const matches = Array.from(m.text.matchAll(INSTRUCTOR_REGEX)).map((mm) => mm[1]);
      for (const n of matches) {
        if (instructorNameSet.has(n)) names.add(n);
      }
    }
    let bucket = "no_candidate";
    if (names.size === 1) {
      buckets.single_candidate += 1;
      bucket = "single_candidate";
    } else if (names.size === 2) {
      buckets.ambiguous_2 += 1;
      bucket = "ambiguous_2";
    } else if (names.size >= 3) {
      buckets.ambiguous_3plus += 1;
      bucket = "ambiguous_3plus";
    } else {
      buckets.no_candidate += 1;
    }
    if (samples.length < 30 && names.size > 0) {
      samples.push({
        company: reg.companyName,
        course: reg.courseName?.slice(0, 60) ?? null,
        candidates: Array.from(names),
        bucket,
      });
    }
  }

  return NextResponse.json({
    ok: true,
    durationMs: Date.now() - startedAt,
    pending_audited: pending.length,
    slack_messages: opsByChan.length,
    buckets,
    samples,
  });
}
