/**
 * GET /api/admin/audit-th-window-analysis
 *
 * audit-suspect-records의 ±30일 window를 단계별로 확장해 false positive 비율 측정.
 *
 * 각 record에 대해:
 *   - tier1_30d: 회사 정확 매칭 + 본인 TH가 ±30일 안 (audit-suspect-records 기본)
 *   - tier2_90d: 회사 + 본인 TH가 ±90일 안 (window 확장으로 해결)
 *   - tier3_any:  회사 + 본인 TH 어디든 (TH는 있지만 날짜 차이 큰 경우)
 *   - tier4_company_no_th: 본인이 그 회사 TH가 전혀 없음 (진짜 gap)
 *   - tier5_null_company: record.companyName=null (분석 불가)
 *
 * 인증: CRON_SECRET
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";
import {
  normalizeCompanyWithAlias,
  companyMatchesWithAlias,
} from "@/lib/company-aliases";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

function normalize(s: string | null | undefined): string {
  return normalizeCompanyWithAlias(s);
}

function companyMatch(a: string, b: string): boolean {
  // alias-aware. raw 인풋이 이미 normalize 됐지만 group SET은 normalize 통과 후
  // 외형이 다른 그룹사도 매칭하려면 원문에 SET 매칭을 시도. 여기는 normalize된
  // string끼리 비교라 SET 매칭이 효과 없음 — companyMatchesWithAlias가 raw 원문
  // 받는 곳에서 적용해야. 이 함수는 fallback substring 매칭만.
  if (!a || !b || a.length < 2 || b.length < 2) return false;
  return a === b || a.includes(b) || b.includes(a);
}

// 원문 그대로 받아서 alias + group SET 매칭. 우선 사용.
function companyMatchRaw(a: string | null | undefined, b: string | null | undefined): boolean {
  return companyMatchesWithAlias(a, b);
}

export async function GET(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const startedAt = Date.now();

  const records = await prisma.satisfactionRecord.findMany({
    select: {
      id: true,
      instructorDbId: true,
      companyName: true,
      responseDate: true,
      sourceType: true,
      score: true,
      respondentCount: true,
      instructor: { select: { name: true } },
    },
  });

  const allTHs = await prisma.teachingHistory.findMany({
    select: {
      instructorDbId: true,
      companyName: true,
      startDate: true,
      endDate: true,
    },
  });

  // group TH by instructor — keep raw companyName for alias-aware matching
  const thByInst = new Map<string, Array<{ companyRaw: string; company: string; start: number; end: number }>>();
  for (const t of allTHs) {
    if (!t.companyName) continue;
    const start = t.startDate?.getTime();
    if (!start) continue;
    const end = t.endDate?.getTime() ?? start;
    const arr = thByInst.get(t.instructorDbId) ?? [];
    arr.push({
      companyRaw: t.companyName,
      company: normalize(t.companyName),
      start,
      end,
    });
    thByInst.set(t.instructorDbId, arr);
  }

  // self-consistency: 본인이 같은 회사로 record N건 이상이면 misattribute 아님
  const SELF_STRONG_THRESHOLD = 2;
  const selfRecordCompanyCount = new Map<string, Map<string, number>>();
  for (const r of records) {
    if (!r.companyName) continue;
    const bucket =
      selfRecordCompanyCount.get(r.instructorDbId) ?? new Map<string, number>();
    const key = normalize(r.companyName);
    bucket.set(key, (bucket.get(key) ?? 0) + 1);
    selfRecordCompanyCount.set(r.instructorDbId, bucket);
  }

  const D30 = 30 * 24 * 3600 * 1000;
  const D90 = 90 * 24 * 3600 * 1000;
  const D180 = 180 * 24 * 3600 * 1000;

  const tiers = {
    tier1_30d: 0,
    tier2_90d: 0,
    tier3_180d: 0,
    tier4_any_date: 0,
    tier5_company_no_th: 0,
    tier6_null_company: 0,
  };
  const byInstructorTier = new Map<string, { tier1_30d: number; tier2_90d: number; tier3_180d: number; tier4_any: number; tier5_no_th: number }>();

  for (const r of records) {
    if (!r.companyName) {
      tiers.tier6_null_company += 1;
      continue;
    }
    const recCo = normalize(r.companyName);
    if (recCo.length < 2) {
      tiers.tier6_null_company += 1;
      continue;
    }
    const respMs = r.responseDate?.getTime();
    const ths = thByInst.get(r.instructorDbId) ?? [];
    // alias-aware: raw companyRaw 로 group SET 매칭 + normalize 비교 fallback
    const sameCompanyTHs = ths.filter(
      (t) =>
        companyMatchRaw(t.companyRaw, r.companyName) ||
        companyMatch(t.company, recCo)
    );

    if (sameCompanyTHs.length === 0) {
      // self-strong: 본인 record가 같은 회사 N건 이상이면 tier1 인정
      const selfCnt =
        selfRecordCompanyCount.get(r.instructorDbId)?.get(recCo) ?? 0;
      if (selfCnt >= SELF_STRONG_THRESHOLD) {
        tiers.tier1_30d += 1;
        const bucket = byInstructorTier.get(r.instructor.name) ?? {
          tier1_30d: 0,
          tier2_90d: 0,
          tier3_180d: 0,
          tier4_any: 0,
          tier5_no_th: 0,
        };
        bucket.tier1_30d += 1;
        byInstructorTier.set(r.instructor.name, bucket);
        continue;
      }
      tiers.tier5_company_no_th += 1;
      const bucket = byInstructorTier.get(r.instructor.name) ?? {
        tier1_30d: 0,
        tier2_90d: 0,
        tier3_180d: 0,
        tier4_any: 0,
        tier5_no_th: 0,
      };
      bucket.tier5_no_th += 1;
      byInstructorTier.set(r.instructor.name, bucket);
      continue;
    }

    if (respMs === undefined) {
      // company TH 있는데 response_date 없음 → tier4 (any date)
      tiers.tier4_any_date += 1;
      continue;
    }

    let minDist = Infinity;
    for (const t of sameCompanyTHs) {
      const inRange = respMs >= t.start && respMs <= t.end;
      const dist = inRange ? 0 : Math.min(Math.abs(respMs - t.start), Math.abs(respMs - t.end));
      if (dist < minDist) minDist = dist;
    }

    let tier: keyof typeof tiers;
    if (minDist <= D30) tier = "tier1_30d";
    else if (minDist <= D90) tier = "tier2_90d";
    else if (minDist <= D180) tier = "tier3_180d";
    else tier = "tier4_any_date";

    tiers[tier] += 1;

    const bucket = byInstructorTier.get(r.instructor.name) ?? {
      tier1_30d: 0,
      tier2_90d: 0,
      tier3_180d: 0,
      tier4_any: 0,
      tier5_no_th: 0,
    };
    if (tier === "tier1_30d") bucket.tier1_30d += 1;
    else if (tier === "tier2_90d") bucket.tier2_90d += 1;
    else if (tier === "tier3_180d") bucket.tier3_180d += 1;
    else bucket.tier4_any += 1;
    byInstructorTier.set(r.instructor.name, bucket);
  }

  // top instructors with most tier5_no_th (real gap)
  const topGapInstructors = Array.from(byInstructorTier.entries())
    .map(([name, b]) => ({ name, ...b, total: b.tier1_30d + b.tier2_90d + b.tier3_180d + b.tier4_any + b.tier5_no_th }))
    .sort((a, b) => b.tier5_no_th - a.tier5_no_th)
    .slice(0, 20);

  return NextResponse.json({
    ok: true,
    durationMs: Date.now() - startedAt,
    total_records: records.length,
    tiers,
    interpretation: {
      audit_suspect_records_count: tiers.tier2_90d + tiers.tier3_180d + tiers.tier4_any_date + tiers.tier5_company_no_th + tiers.tier6_null_company,
      false_positive_if_window_widened_to_90d: tiers.tier2_90d,
      false_positive_if_window_widened_to_180d: tiers.tier2_90d + tiers.tier3_180d,
      real_company_gap: tiers.tier5_company_no_th,
    },
    top_real_gap_instructors: topGapInstructors,
  });
}
