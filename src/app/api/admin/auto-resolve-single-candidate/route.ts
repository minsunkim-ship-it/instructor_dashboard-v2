/**
 * POST /api/admin/auto-resolve-single-candidate?mode=dry_run|apply
 *
 * pending registry 중 ops_report/general ±14일 cross-check 결과
 * **단일 강사**만 식별되고 그 강사가 같은 기간 TH 보유 시 자동 strong_single resolve.
 *
 * 사용자 룰 [no_guess_matching] 준수: 추측 X, ops 명시 + TH 확인 = 명시적 증거.
 * apply는 사용자 명시 승인 필요.
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
const OPS_REPORT = "C015YD84VGS";
const GENERAL = "C79GDLS3A";
const ALLOWED = new Set([OPS_REPORT, GENERAL]);
const INSTRUCTOR_REGEX = /([가-힣]{2,4}[A-Z]?)\s*(?:강사|대표|교수|선생)님/g;

// P0 보호 강사 — 자동 매칭 금지 (회귀 패턴)
const P0_NULL_PROTECTED = new Set(["박상훈"]);
const P0_HIGH_AVG_PROTECTED = new Set(["유종훈", "김정수A"]);

// 회사명이 강좌/주제명인 경우 부정확 매칭 위험 → 자동 매칭 차단
const GENERIC_COMPANY_BLOCKLIST = new Set([
  "원데이", "GenAI 활용과정", "디자인씽킹", "파이썬", "엑셀",
  "AI", "생성형 AI", "프롬프트 엔지니어링", "데이터 분석",
  "프로그래밍", "코딩", "마케팅", "기획", "보고서",
  "공개형 교육", "공개교육", "특강", "워크숍",
]);
function isGenericCompany(name: string | null | undefined): boolean {
  if (!name) return true;
  const trimmed = name.trim();
  if (GENERIC_COMPANY_BLOCKLIST.has(trimmed)) return true;
  // 한글 회사명 2자 미만, generic 키워드만 포함
  if (trimmed.length < 3) return true;
  return false;
}

export async function POST(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const mode = request.nextUrl.searchParams.get("mode") ?? "dry_run";
  const startedAt = Date.now();

  const pending = await prisma.satisfactionReviewRegistry.findMany({
    where: { matchStatus: "pending" },
    select: { id: true, registryKey: true, companyName: true, courseName: true, sourceRefs: true, avgScore: true },
    take: 500,
  });

  const slackItems = await prisma.activityImportItem.findMany({
    where: { sourceType: "slack" },
    select: { rawPayload: true, sourceRef: true, activityAt: true },
    take: 50000,
  });
  const ops: Array<{ cid: string; text: string; ts: Date }> = [];
  for (const it of slackItems) {
    const raw = (it.rawPayload as RawRecord | null) ?? {};
    const ref = (it.sourceRef as RawRecord | null) ?? {};
    const cid = pickString(raw, "channel_id", "channel") ?? pickString(ref, "channel_id", "channel");
    if (!cid || !ALLOWED.has(cid)) continue;
    const text = pickString(raw, "text", "message", "body") ?? "";
    if (!text || !it.activityAt) continue;
    ops.push({ cid, text, ts: it.activityAt });
  }

  const allInstructors = await prisma.instructor.findMany({ select: { id: true, name: true } });
  const instByName = new Map(allInstructors.map((i) => [i.name, i]));

  interface Plan {
    registry_id: string;
    registry_key: string;
    company: string | null;
    course: string | null;
    instructor_id: string;
    instructor_name: string;
    ops_count: number;
    th_verified: boolean;
    avg_score: number | null;
    sample_message: string;
  }
  const plans: Plan[] = [];
  const skipped: Array<{ registry_key: string; reason: string }> = [];

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
      skipped.push({ registry_key: reg.registryKey, reason: "no_date_or_company" });
      continue;
    }
    // generic 회사명 차단 (원데이/디자인씽킹/파이썬 등)
    if (isGenericCompany(reg.companyName)) {
      skipped.push({ registry_key: reg.registryKey, reason: "generic_company" });
      continue;
    }
    const responseDate = new Date(dateStr);
    const responseMs = responseDate.getTime();
    const window = 14 * 86400 * 1000;

    // 회사 매칭 ops 메시지에서 강사 추출
    const candidateCounts = new Map<string, { count: number; sample: string }>();
    for (const m of ops) {
      if (Math.abs(m.ts.getTime() - responseMs) > window) continue;
      const normText = normalizeCompanyWithAlias(m.text);
      if (!normText.includes(effectiveCompany)) continue;
      const matches = Array.from(m.text.matchAll(INSTRUCTOR_REGEX)).map((mm) => mm[1]);
      for (const n of matches) {
        if (!instByName.has(n)) continue;
        const e = candidateCounts.get(n) ?? { count: 0, sample: "" };
        e.count += 1;
        if (!e.sample) e.sample = m.text.slice(0, 150);
        candidateCounts.set(n, e);
      }
    }
    if (candidateCounts.size === 0) {
      skipped.push({ registry_key: reg.registryKey, reason: "no_candidate_in_ops" });
      continue;
    }
    if (candidateCounts.size > 1) {
      skipped.push({ registry_key: reg.registryKey, reason: "ambiguous_multi" });
      continue;
    }
    // 단일 강사
    const [name, info] = Array.from(candidateCounts.entries())[0];
    const inst = instByName.get(name)!;
    const avgScore = reg.avgScore !== null ? Number(reg.avgScore) : null;

    // P0 보호: 박상훈 자동 매칭 금지
    if (P0_NULL_PROTECTED.has(name)) {
      skipped.push({ registry_key: reg.registryKey, reason: `p0_protected_null:${name}` });
      continue;
    }
    // P0 high_avg 보호: 유종훈/김정수A는 score<5 reject
    if (P0_HIGH_AVG_PROTECTED.has(name) && avgScore !== null && avgScore < 5) {
      skipped.push({ registry_key: reg.registryKey, reason: `p0_protected_high_avg:${name}:score=${avgScore}` });
      continue;
    }

    // TH window 검증
    const lo = new Date(responseDate);
    lo.setUTCDate(lo.getUTCDate() - 14);
    const hi = new Date(responseDate);
    hi.setUTCDate(hi.getUTCDate() + 14);
    const thWindow = await prisma.teachingHistory.findFirst({
      where: {
        instructorDbId: inst.id,
        OR: [
          { AND: [{ startDate: { lte: hi } }, { endDate: { gte: lo } }] },
          { startDate: { gte: lo, lte: hi } },
        ],
      },
      select: { id: true },
    });
    if (!thWindow) {
      skipped.push({ registry_key: reg.registryKey, reason: `no_th_in_window:${name}` });
      continue;
    }

    plans.push({
      registry_id: reg.id,
      registry_key: reg.registryKey,
      company: reg.companyName,
      course: reg.courseName?.slice(0, 60) ?? null,
      instructor_id: inst.id,
      instructor_name: name,
      ops_count: info.count,
      th_verified: true,
      avg_score: avgScore,
      sample_message: info.sample,
    });
  }

  if (mode === "dry_run") {
    return NextResponse.json({
      ok: true,
      mode,
      durationMs: Date.now() - startedAt,
      pending_audited: pending.length,
      to_resolve: plans.length,
      skipped_count: skipped.length,
      plans: plans.slice(0, 50),
      skipped_buckets: skipped.reduce((acc: Record<string, number>, s) => {
        const key = s.reason.split(":")[0];
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {}),
    });
  }

  // apply mode: pending → resolved
  let resolved = 0;
  for (const p of plans) {
    await prisma.satisfactionReviewRegistry.update({
      where: { id: p.registry_id },
      data: {
        matchStatus: "auto_accepted",
        resolvedInstructorId: p.instructor_id,
        resolutionBasis: `auto_resolve_ops_single_candidate|ops=${p.ops_count}|th_verified=true|date=${new Date().toISOString()}`,
      },
    });
    resolved += 1;
  }
  return NextResponse.json({
    ok: true,
    mode,
    durationMs: Date.now() - startedAt,
    pending_audited: pending.length,
    resolved,
    skipped_count: skipped.length,
  });
}
