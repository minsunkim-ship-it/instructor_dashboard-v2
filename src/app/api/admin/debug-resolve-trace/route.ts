/**
 * GET /api/admin/debug-resolve-trace?registry_key=xxx
 *
 * 특정 pending row가 왜 매칭 안됐는지 trace.
 * - 회사 매칭 ops 메시지 list (narrow + wide)
 * - 각 ops 메시지의 강사 후보
 * - 각 강사의 TH 강의 기간
 * - TH cross-check 결과
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";
import { normalizeCompanyWithAlias } from "@/lib/company-aliases";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const OPS_REPORT_CHANNEL_ID = "C015YD84VGS";
const GENERAL_CHANNEL_ID = "C79GDLS3A";
const ALLOWED = new Set([OPS_REPORT_CHANNEL_ID, GENERAL_CHANNEL_ID]);
const INSTRUCTOR_REGEX = /([가-힣]{2,4}[A-Z]?)\s*(?:강사|대표|교수|선생)님/g;
const COMPANY_REGEX = /\(B2B\)\s*([^_\n]+?)[\s_]/;

type RawRecord = { [key: string]: unknown };
function pickString(obj: RawRecord | undefined | null, ...keys: string[]): string | null {
  if (!obj) return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return null;
}

function companyMatches(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const na = normalizeCompanyWithAlias(a);
  const nb = normalizeCompanyWithAlias(b);
  if (na.length < 2 || nb.length < 2) return false;
  return na.includes(nb) || nb.includes(na);
}

export async function GET(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const registryKey = request.nextUrl.searchParams.get("registry_key");
  const companyOverride = request.nextUrl.searchParams.get("company");
  const dateOverride = request.nextUrl.searchParams.get("response_date");

  let effectiveCompany: string;
  let responseDate: Date;

  if (registryKey) {
    const reg = await prisma.satisfactionReviewRegistry.findUnique({ where: { registryKey } });
    if (!reg) return NextResponse.json({ ok: false, error: "registry_not_found" }, { status: 404 });
    effectiveCompany = reg.companyName ?? "";
    const refs = Array.isArray(reg.sourceRefs) ? (reg.sourceRefs as RawRecord[]) : [];
    const firstRef = refs[0];
    const inner = firstRef?.source_ref as RawRecord | undefined;
    const dateStr =
      pickString(firstRef, "response_date") ??
      pickString(inner, "created_time") ??
      pickString(firstRef, "created_time");
    if (!dateStr) return NextResponse.json({ ok: false, error: "no_date" }, { status: 422 });
    responseDate = new Date(dateStr);
  } else if (companyOverride && dateOverride) {
    effectiveCompany = companyOverride;
    responseDate = new Date(dateOverride);
  } else {
    return NextResponse.json({ ok: false, error: "missing params" }, { status: 400 });
  }

  // ops 메시지 fetch
  const slack = await prisma.activityImportItem.findMany({
    where: { sourceType: "slack" },
    select: { rawPayload: true, sourceRef: true, activityAt: true },
    take: 10000,
  });
  interface Op {
    channel: string;
    activityAt: Date;
    company: string | null;
    instructors: string[];
    text_head: string;
    distance_days: number;
  }
  const ops: Op[] = [];
  for (const it of slack) {
    const raw = (it.rawPayload as RawRecord | null) ?? {};
    const ref = (it.sourceRef as RawRecord | null) ?? {};
    const cid = pickString(raw, "channel_id", "channel") ?? pickString(ref, "channel_id", "channel");
    if (!cid || !ALLOWED.has(cid)) continue;
    const text = pickString(raw, "text", "message", "body") ?? "";
    if (!text || !it.activityAt) continue;
    const cm = text.match(COMPANY_REGEX);
    const company = cm ? cm[1].trim() : null;
    if (!company || !companyMatches(company, effectiveCompany)) continue;
    const instructors = Array.from(new Set(Array.from(text.matchAll(INSTRUCTOR_REGEX)).map((m) => m[1])));
    const distDays = Math.abs(it.activityAt.getTime() - responseDate.getTime()) / (1000 * 60 * 60 * 24);
    ops.push({
      channel: cid,
      activityAt: it.activityAt,
      company,
      instructors,
      text_head: text.slice(0, 150),
      distance_days: Math.round(distDays * 10) / 10,
    });
  }
  ops.sort((a, b) => a.distance_days - b.distance_days);

  // 각 ops의 강사 후보 TH 검증
  const allInstructors = await prisma.instructor.findMany({
    select: { id: true, name: true },
  });
  const instByName = new Map<string, { id: string; name: string }>();
  for (const i of allInstructors) {
    instByName.set(i.name, i);
    instByName.set(i.name.normalize("NFC"), i);
    instByName.set(i.name.normalize("NFD"), i);
  }
  const instructorIds = new Set<string>();
  for (const o of ops) {
    for (const n of o.instructors) {
      const i = instByName.get(n) ?? instByName.get(n.normalize("NFC")) ?? instByName.get(n.normalize("NFD"));
      if (i) instructorIds.add(i.id);
    }
  }
  const ths = await prisma.teachingHistory.findMany({
    where: { instructorDbId: { in: Array.from(instructorIds) } },
    select: { instructorDbId: true, companyName: true, courseName: true, startDate: true, endDate: true },
  });

  // narrow window candidates (within 14d)
  const narrowOps = ops.filter((o) => o.distance_days <= 14);
  const narrowCandidates = new Set<string>();
  for (const o of narrowOps) for (const n of o.instructors) narrowCandidates.add(n);

  // TH cross-check: 응답일자가 강사 TH 기간 안에 있는 강사
  const FOURTEEN = 14 * 86400 * 1000;
  const verifiedNames: string[] = [];
  for (const n of narrowCandidates) {
    const i = instByName.get(n) ?? instByName.get(n.normalize("NFC")) ?? instByName.get(n.normalize("NFD"));
    if (!i) continue;
    const myTh = ths.filter(
      (t) => t.instructorDbId === i.id && t.companyName && companyMatches(t.companyName, effectiveCompany) && t.startDate
    );
    for (const t of myTh) {
      const start = t.startDate!.getTime();
      const end = t.endDate?.getTime() ?? start;
      const respMs = responseDate.getTime();
      if (respMs >= start - FOURTEEN && respMs <= end + FOURTEEN) {
        verifiedNames.push(n);
        break;
      }
    }
  }

  return NextResponse.json({
    ok: true,
    effective_company: effectiveCompany,
    response_date: responseDate.toISOString(),
    ops_count: ops.length,
    ops_within_14d: ops.filter((o) => o.distance_days <= 14).length,
    ops_within_60d: ops.filter((o) => o.distance_days <= 60).length,
    narrow_candidates: Array.from(narrowCandidates),
    th_verified_candidates: verifiedNames,
    ops_top10: ops.slice(0, 10),
    th_for_candidates: ths.map((t) => {
      const inst = allInstructors.find((i) => i.id === t.instructorDbId);
      return {
        instructor: inst?.name ?? "?",
        company: t.companyName,
        course: t.courseName?.slice(0, 60),
        start: t.startDate?.toISOString().slice(0, 10) ?? null,
        end: t.endDate?.toISOString().slice(0, 10) ?? null,
        covers_response:
          t.startDate && t.endDate
            ? responseDate.getTime() >= t.startDate.getTime() - 14 * 86400 * 1000 &&
              responseDate.getTime() <= t.endDate.getTime() + 14 * 86400 * 1000
            : null,
      };
    }),
  });
}
