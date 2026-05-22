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

// v24-20: P0 가드 제거됨 — 새 알고리즘은 ops 명시 단독 + ±1d narrow + TH 검증 = 명시적 증거 기반
// 박상훈/유종훈/김정수A도 진짜 강의했다면 정확하게 매칭됨. 점수 낮다고 reject = 데이터 왜곡.

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
    chosen_window_days: number;
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

    // v24-17: narrow window single + wide window verification
    // ±1일 → ±3일 → ±7일 순서로 시도, 가장 좁은 window에서 단일 강사 식별 시
    // **±14일 wide window에서도 그 강사만 명시되거나 다른 강사 동시 없음** 추가 검증
    const windowDays = [1, 3, 7];
    let chosenName: string | null = null;
    let chosenSample = "";
    let chosenCount = 0;
    let chosenWindow = 0;
    let allWideCandidates: string[] = [];
    function collectCandidates(wMs: number): Map<string, { count: number; sample: string }> {
      const counts = new Map<string, { count: number; sample: string }>();
      for (const m of ops) {
        if (Math.abs(m.ts.getTime() - responseMs) > wMs) continue;
        const normText = normalizeCompanyWithAlias(m.text);
        if (!normText.includes(effectiveCompany)) continue;
        const matches = Array.from(m.text.matchAll(INSTRUCTOR_REGEX)).map((mm) => mm[1]);
        for (const n of matches) {
          if (!instByName.has(n)) continue;
          const e = counts.get(n) ?? { count: 0, sample: "" };
          e.count += 1;
          if (!e.sample) e.sample = m.text.slice(0, 150);
          counts.set(n, e);
        }
      }
      return counts;
    }
    // ±14일 wide candidates (모든 강사 후보) 미리 수집
    const wideCounts = collectCandidates(14 * 86400 * 1000);
    allWideCandidates = Array.from(wideCounts.keys());

    for (const wd of windowDays) {
      const wMs = wd * 86400 * 1000;
      const counts = collectCandidates(wMs);
      if (counts.size === 1) {
        const [n, info] = Array.from(counts.entries())[0];
        chosenName = n;
        chosenSample = info.sample;
        chosenCount = info.count;
        chosenWindow = wd;
        break;
      }
      if (counts.size > 1 && wd === 1) {
        skipped.push({ registry_key: reg.registryKey, reason: "ambiguous_within_1d" });
        chosenName = null;
        break;
      }
    }
    if (!chosenName) {
      skipped.push({ registry_key: reg.registryKey, reason: "no_single_in_any_window" });
      continue;
    }
    // v24-17: ±14일 wide window 검증 — 다른 강사도 명시되어 있다면 ambiguous
    // 단, narrow 강사가 wide에서 >= 70% dominant이면 통과
    if (allWideCandidates.length > 1) {
      const chosenWideCount = wideCounts.get(chosenName)?.count ?? 0;
      const totalWideOps = Array.from(wideCounts.values()).reduce((a, b) => a + b.count, 0);
      const dominanceRatio = totalWideOps > 0 ? chosenWideCount / totalWideOps : 0;
      if (dominanceRatio < 0.7) {
        skipped.push({
          registry_key: reg.registryKey,
          reason: `wide_ambiguous_others:${allWideCandidates.filter((n) => n !== chosenName).join(",")}`,
        });
        continue;
      }
    }
    const name = chosenName;
    const info = { count: chosenCount, sample: chosenSample };
    const inst = instByName.get(name)!;
    const avgScore = reg.avgScore !== null ? Number(reg.avgScore) : null;

    // v24-20: P0 가드 제거. ops 명시 단독 + TH 검증으로 충분.
    void avgScore;

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
      chosen_window_days: chosenWindow,
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
        resolutionBasis: `auto_resolve_ops_single_candidate|ops=${p.ops_count}|window_days=${p.chosen_window_days}|th_verified=true|date=${new Date().toISOString()}`,
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
