/**
 * GET /api/backoffice/suggest-candidates?registry_key=xxx
 *
 * NextAuth/CRON_SECRET 인증. registry 1건의 narrow_candidates 반환.
 * resolver가 ambiguous (2명+ 강사 후보)으로 보류한 case에 사용.
 * 운영자가 후보 중 1명 1-click 선택 가능.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth, isAuthDisabled } from "@/auth";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";
import { normalizeCompanyWithAlias } from "@/lib/company-aliases";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const OPS_REPORT_CHANNEL_ID = "C015YD84VGS";
const GENERAL_CHANNEL_ID = "C79GDLS3A";
const ALLOWED_CHANNELS = new Set([OPS_REPORT_CHANNEL_ID, GENERAL_CHANNEL_ID]);
const INSTRUCTOR_REGEX = /([가-힣]{2,4}[A-Z]?)\s*(?:강사|대표|교수|선생)님/g;

function extractInstructors(text: string): string[] {
  const names = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = INSTRUCTOR_REGEX.exec(text)) !== null) names.add(m[1]);
  return Array.from(names);
}

export async function GET(request: NextRequest) {
  const headerSecret = request.headers.get(CRON_SECRET_HEADER);
  let isAuthed = false;
  if (isValidCronSecret(headerSecret)) {
    isAuthed = true;
  } else if (isAuthDisabled()) {
    isAuthed = true;
  } else {
    const session = await auth();
    if (session?.user) isAuthed = true;
  }
  if (!isAuthed) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const registryKey = request.nextUrl.searchParams.get("registry_key");
  if (!registryKey) {
    return NextResponse.json({ ok: false, error: "registry_key required" }, { status: 400 });
  }

  type RawRecord = { [key: string]: unknown };
  function pickString(o: RawRecord | undefined | null, ...keys: string[]): string | null {
    if (!o) return null;
    for (const k of keys) {
      const v = o[k];
      if (typeof v === "string" && v.trim().length > 0) return v;
    }
    return null;
  }

  const reg = await prisma.satisfactionReviewRegistry.findUnique({
    where: { registryKey },
    select: { companyName: true, courseName: true, sourceRefs: true },
  });
  if (!reg) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  const effectiveCompany = normalizeCompanyWithAlias(reg.companyName ?? "");
  const refs = Array.isArray(reg.sourceRefs) ? (reg.sourceRefs as RawRecord[]) : [];
  const firstRef = refs[0];
  const inner = firstRef?.source_ref as RawRecord | undefined;
  const dateStr =
    pickString(firstRef, "response_date") ??
    pickString(inner, "created_time") ??
    pickString(firstRef, "created_time");

  if (!dateStr || effectiveCompany.length < 2) {
    return NextResponse.json({
      ok: true,
      candidates: [],
      reason: "no_company_or_date",
    });
  }
  const responseDate = new Date(dateStr);

  // ops_report messages within ±14d of responseDate (slack via activityImportItem)
  const lo = new Date(responseDate);
  lo.setUTCDate(lo.getUTCDate() - 14);
  const hi = new Date(responseDate);
  hi.setUTCDate(hi.getUTCDate() + 14);

  const slackItems = await prisma.activityImportItem.findMany({
    where: {
      sourceType: "slack",
      activityAt: { gte: lo, lte: hi },
    },
    select: { rawPayload: true, sourceRef: true, activityAt: true },
    take: 5000,
  });

  // 회사 매칭 + 강사 추출
  const candidateCounts = new Map<string, { count: number; samples: string[] }>();
  for (const it of slackItems) {
    const raw = (it.rawPayload as RawRecord | null) ?? {};
    const ref = (it.sourceRef as RawRecord | null) ?? {};
    const cid = pickString(raw, "channel_id", "channel") ?? pickString(ref, "channel_id", "channel");
    if (!cid || !ALLOWED_CHANNELS.has(cid)) continue;
    const text = pickString(raw, "text", "message", "body") ?? "";
    if (!text) continue;
    const normText = normalizeCompanyWithAlias(text);
    if (!normText.includes(effectiveCompany)) continue;
    const names = extractInstructors(text);
    for (const n of names) {
      const existing = candidateCounts.get(n) ?? { count: 0, samples: [] };
      existing.count += 1;
      if (existing.samples.length < 2) existing.samples.push(text.slice(0, 140));
      candidateCounts.set(n, existing);
    }
  }

  // 강사 존재 확인 + TH cross-check
  const candidates: Array<{
    instructor_id: string;
    instructor_name: string;
    ops_count: number;
    th_in_window: boolean;
    sample_messages: string[];
  }> = [];
  for (const [name, info] of candidateCounts.entries()) {
    const inst = await prisma.instructor.findFirst({
      where: { name },
      select: { id: true, name: true },
    });
    if (!inst) continue;
    const thWindow = await prisma.teachingHistory.findFirst({
      where: {
        instructorDbId: inst.id,
        OR: [
          {
            AND: [
              { startDate: { lte: hi } },
              { endDate: { gte: lo } },
            ],
          },
          { startDate: { gte: lo, lte: hi } },
        ],
      },
      select: { id: true },
    });
    candidates.push({
      instructor_id: inst.id,
      instructor_name: inst.name,
      ops_count: info.count,
      th_in_window: thWindow !== null,
      sample_messages: info.samples,
    });
  }
  candidates.sort((a, b) => b.ops_count - a.ops_count);

  return NextResponse.json({
    ok: true,
    registry_key: registryKey,
    effective_company: effectiveCompany,
    response_date: responseDate.toISOString().slice(0, 10),
    candidates,
  });
}
