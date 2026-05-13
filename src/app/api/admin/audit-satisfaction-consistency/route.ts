/**
 * GET /api/admin/audit-satisfaction-consistency
 *
 * Phase α Step 1 — 만족도 산식 3중 정합성 검증 (read-only).
 *
 * 검증 대상:
 *   A. `instructors.satisfaction_avg/count` (DB 컬럼, refreshSatisfactionAggregates SQL이 갱신)
 *   B. SQL 산식과 동일한 TS 재계산 (모든 sourceType, 6개월 cutoff, respondentCount 가중 평균)
 *   C. `/api/instructors/{id}` 라이브 응답 산식 (sourceType: 3개로 제한 — sheet_summary/google_forms/gmail_summary)
 *
 * 핵심 의문:
 *   - A vs B: refreshSatisfactionAggregates가 정상 작동했는가?
 *   - A vs C: sourceType filter 차이로 DB 컬럼과 라이브 응답이 불일치하는가?
 *   - history 빈 케이스: count > 0인데 3-sourceType filter 후 0건 = 라이브 화면에서 평균은 있지만 history 비는 케이스
 *
 * P0 회귀 방지 점검 (메모리 [만족도 P0 정공법 완료]):
 *   - 박상훈 avg=null/count=0
 *   - 최진영B avg=null/count=0
 *   - 유종훈 5.0/1~2 (gmail만)
 *   - 김정수A 5.0/1~2
 *   - 공지연 4.8/1 (KT만)
 *
 * 인증: CRON_SECRET (header `x-cron-secret` 또는 query `?secret=`)
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

function authorize(request: NextRequest): boolean {
  const headerSecret = request.headers.get(CRON_SECRET_HEADER);
  if (isValidCronSecret(headerSecret)) return true;
  const querySecret = request.nextUrl.searchParams.get("secret");
  if (isValidCronSecret(querySecret)) return true;
  return false;
}

// D1 fix (Phase α): drive_satisfaction 추가. route.ts와 동기화.
// manual은 운영자 수기 입력/test data 가능성으로 라이브 제외 유지.
const LIVE_RESPONSE_SOURCE_TYPES = new Set([
  "sheet_summary",
  "google_forms",
  "gmail_summary",
  "drive_satisfaction",
]);

const P0_CHECK_NAMES = [
  "박상훈",
  "최진영B",
  "유종훈",
  "김정수A",
  "공지연",
];

function getRecentSatisfactionCutoffDate(now = new Date()): string {
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - 6);
  return cutoff.toISOString().slice(0, 10);
}

function dateStringForRecord(
  responseDate: Date | null,
  createdAt: Date
): string {
  if (responseDate) return responseDate.toISOString().slice(0, 10);
  return createdAt.toISOString().slice(0, 10);
}

interface Aggregate {
  weightedSum: number;
  totalWeight: number;
  count: number;
}

function emptyAggregate(): Aggregate {
  return { weightedSum: 0, totalWeight: 0, count: 0 };
}

function applyRow(
  agg: Aggregate,
  score: number,
  respondentCount: number | null
): void {
  const w = respondentCount && respondentCount > 0 ? respondentCount : 1;
  agg.weightedSum += score * w;
  agg.totalWeight += w;
  agg.count += 1;
}

function finalizeAggregate(agg: Aggregate): {
  avg: number | null;
  count: number;
} {
  if (agg.totalWeight === 0 || agg.count === 0) {
    return { avg: null, count: 0 };
  }
  // SQL: ROUND(.., 2). Math.round(*100)/100 — 동일 결과
  const avg = Math.round((agg.weightedSum / agg.totalWeight) * 100) / 100;
  return { avg, count: agg.count };
}

function avgDiffers(a: number | null, b: number | null): boolean {
  if (a === null && b === null) return false;
  if (a === null || b === null) return true;
  // 둘 다 소수 둘째자리로 반올림된 값. 직접 비교
  return Math.abs(a - b) > 0.005;
}

export async function GET(request: NextRequest) {
  if (!authorize(request)) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 }
    );
  }

  const startedAt = Date.now();
  const cutoffDate = getRecentSatisfactionCutoffDate();

  // 진단 모드 — 기본은 consistency, 옵션으로 source/instructor detail
  const detailMode = request.nextUrl.searchParams.get("detail");
  const instructorNameQuery = request.nextUrl.searchParams.get("name");

  // detail=sourcetypes — sourceType별 sample 1건씩 dump (drive_satisfaction/manual 정체 파악)
  if (detailMode === "sourcetypes") {
    const allTypes = await prisma.satisfactionRecord.groupBy({
      by: ["sourceType"],
      _count: { _all: true },
    });
    const samples: Array<{
      sourceType: string;
      count: number;
      sample: {
        instructorName: string | null;
        score: number;
        respondentCount: number | null;
        companyName: string | null;
        courseName: string | null;
        responseDate: string | null;
        createdAt: string;
        sourceRef: unknown;
      } | null;
    }> = [];
    for (const t of allTypes) {
      const rec = await prisma.satisfactionRecord.findFirst({
        where: { sourceType: t.sourceType },
        select: {
          score: true,
          respondentCount: true,
          companyName: true,
          courseName: true,
          responseDate: true,
          createdAt: true,
          sourceRef: true,
          instructor: { select: { name: true } },
        },
        orderBy: { createdAt: "desc" },
      });
      samples.push({
        sourceType: t.sourceType,
        count: t._count._all,
        sample: rec
          ? {
              instructorName: rec.instructor.name,
              score: Number(rec.score),
              respondentCount: rec.respondentCount,
              companyName: rec.companyName,
              courseName: rec.courseName,
              responseDate: rec.responseDate?.toISOString().slice(0, 10) ?? null,
              createdAt: rec.createdAt.toISOString(),
              sourceRef: rec.sourceRef,
            }
          : null,
      });
    }
    return NextResponse.json({
      ok: true,
      mode: "sourcetypes",
      samples,
    });
  }

  // detail=instructor&name=공지연 — 특정 강사 record 전체 dump (P0 회귀 조사용)
  if (detailMode === "instructor" && instructorNameQuery) {
    // findFirst exact match가 한글 unicode normalization 차이로 실패하는 케이스 있음.
    // findMany + JS-side 비교 + 후보 list로 안전하게.
    const candidates = await prisma.instructor.findMany({
      where: { name: { contains: instructorNameQuery } },
      select: { id: true, name: true, satisfactionAvg: true, satisfactionCount: true },
    });
    if (candidates.length === 0) {
      return NextResponse.json({
        ok: false,
        error: "instructor not found",
        name: instructorNameQuery,
        name_codepoints: Array.from(instructorNameQuery).map((c) => c.codePointAt(0)),
      });
    }
    // 정확 매칭 우선, 없으면 contains 후보 모두 반환
    const inst = candidates.find((c) => c.name === instructorNameQuery) ?? candidates[0];
    const multipleCandidates = candidates.length > 1;
    const records = await prisma.satisfactionRecord.findMany({
      where: { instructorDbId: inst.id },
      orderBy: { createdAt: "desc" },
    });
    const registries = await prisma.satisfactionReviewRegistry.findMany({
      where: {
        OR: [
          { candidateName: instructorNameQuery },
          { resolvedInstructorId: inst.id },
        ],
      },
      take: 20,
      orderBy: { updatedAt: "desc" },
    });
    return NextResponse.json({
      ok: true,
      mode: "instructor",
      query_name: instructorNameQuery,
      query_codepoints: Array.from(instructorNameQuery).map((c) => c.codePointAt(0)),
      multiple_candidates: multipleCandidates,
      all_candidates: candidates.map((c) => ({
        id: c.id,
        name: c.name,
        codepoints: Array.from(c.name).map((ch) => ch.codePointAt(0)),
        satisfactionAvg: c.satisfactionAvg !== null ? Number(c.satisfactionAvg) : null,
        satisfactionCount: c.satisfactionCount,
      })),
      instructor: {
        id: inst.id,
        name: inst.name,
        satisfactionAvg: inst.satisfactionAvg !== null ? Number(inst.satisfactionAvg) : null,
        satisfactionCount: inst.satisfactionCount,
      },
      records: records.map((r) => ({
        id: r.id,
        score: Number(r.score),
        respondentCount: r.respondentCount,
        companyName: r.companyName,
        courseName: r.courseName,
        responseDate: r.responseDate?.toISOString().slice(0, 10) ?? null,
        createdAt: r.createdAt.toISOString(),
        sourceType: r.sourceType,
        sourceRef: r.sourceRef,
      })),
      registries: registries.map((reg) => ({
        registryKey: reg.registryKey,
        sourceType: reg.sourceType,
        candidateName: reg.candidateName,
        companyName: reg.companyName,
        courseName: reg.courseName,
        avgScore: reg.avgScore !== null ? Number(reg.avgScore) : null,
        responseCount: reg.responseCount,
        matchStatus: reg.matchStatus,
        suggestedInstructorId: reg.suggestedInstructorId,
        resolvedInstructorId: reg.resolvedInstructorId,
        resolutionBasis: reg.resolutionBasis,
        updatedAt: reg.updatedAt.toISOString(),
      })),
    });
  }

  // 모든 만족도 record (모든 sourceType, 모든 강사)
  const records = await prisma.satisfactionRecord.findMany({
    select: {
      instructorDbId: true,
      score: true,
      respondentCount: true,
      responseDate: true,
      createdAt: true,
      sourceType: true,
    },
  });

  // sourceType 분포
  const sourceTypeCounts = new Map<string, number>();
  for (const r of records) {
    sourceTypeCounts.set(
      r.sourceType,
      (sourceTypeCounts.get(r.sourceType) ?? 0) + 1
    );
  }
  const sourceTypeDistribution = Array.from(sourceTypeCounts.entries())
    .map(([sourceType, count]) => ({ sourceType, count }))
    .sort((a, b) => b.count - a.count);

  // B 산식 — SQL과 동일: 모든 sourceType, cutoff 적용, respondent 가중평균
  const aggB = new Map<string, Aggregate>();
  // C 산식 — 라이브 응답: 3개 sourceType만, cutoff 적용, 동일 가중평균
  const aggC = new Map<string, Aggregate>();

  for (const r of records) {
    const dateStr = dateStringForRecord(r.responseDate, r.createdAt);
    if (dateStr < cutoffDate) continue; // cutoff 안에 들어오는 record만

    const score = Number(r.score);
    if (!Number.isFinite(score)) continue;

    if (!aggB.has(r.instructorDbId)) aggB.set(r.instructorDbId, emptyAggregate());
    applyRow(aggB.get(r.instructorDbId)!, score, r.respondentCount);

    if (LIVE_RESPONSE_SOURCE_TYPES.has(r.sourceType)) {
      if (!aggC.has(r.instructorDbId)) aggC.set(r.instructorDbId, emptyAggregate());
      applyRow(aggC.get(r.instructorDbId)!, score, r.respondentCount);
    }
  }

  // A — DB 컬럼
  const instructors = await prisma.instructor.findMany({
    select: {
      id: true,
      name: true,
      satisfactionAvg: true,
      satisfactionCount: true,
      satisfactionIsImputed: true,
    },
  });

  // 비교 통계
  type DiffSample = {
    name: string;
    a_avg: number | null;
    a_count: number;
    b_avg: number | null;
    b_count: number;
    c_avg: number | null;
    c_count: number;
  };

  let dbVsRecomputed_match = 0;
  let dbVsRecomputed_mismatch = 0;
  const dbVsRecomputed_samples: DiffSample[] = [];

  let dbVsLive_match = 0;
  let dbVsLive_mismatch = 0;
  const dbVsLive_samples: DiffSample[] = [];

  let historyEmptyWithSummary = 0;
  const historyEmptySamples: DiffSample[] = [];

  // P0 체크
  const p0Checks: Record<
    string,
    { name: string; a_avg: number | null; a_count: number; c_avg: number | null; c_count: number; status: string } | null
  > = {};
  for (const name of P0_CHECK_NAMES) p0Checks[name] = null;

  for (const inst of instructors) {
    const aAvg = inst.satisfactionAvg !== null ? Number(inst.satisfactionAvg) : null;
    const aCount = inst.satisfactionCount;
    const aggB_finalized = finalizeAggregate(aggB.get(inst.id) ?? emptyAggregate());
    const aggC_finalized = finalizeAggregate(aggC.get(inst.id) ?? emptyAggregate());

    // 만족도가 있는 강사만 (A 또는 B 또는 C 중 하나라도)
    const anyHasSatisfaction =
      aCount > 0 || aggB_finalized.count > 0 || aggC_finalized.count > 0;
    if (!anyHasSatisfaction) continue;

    const sample: DiffSample = {
      name: inst.name,
      a_avg: aAvg,
      a_count: aCount,
      b_avg: aggB_finalized.avg,
      b_count: aggB_finalized.count,
      c_avg: aggC_finalized.avg,
      c_count: aggC_finalized.count,
    };

    // A vs B
    if (avgDiffers(aAvg, aggB_finalized.avg) || aCount !== aggB_finalized.count) {
      dbVsRecomputed_mismatch += 1;
      if (dbVsRecomputed_samples.length < 10) dbVsRecomputed_samples.push(sample);
    } else {
      dbVsRecomputed_match += 1;
    }

    // A vs C
    if (avgDiffers(aAvg, aggC_finalized.avg) || aCount !== aggC_finalized.count) {
      dbVsLive_mismatch += 1;
      if (dbVsLive_samples.length < 10) dbVsLive_samples.push(sample);
    } else {
      dbVsLive_match += 1;
    }

    // history 빈 케이스: DB count > 0 인데 C count(라이브 history) === 0
    if (aCount > 0 && aggC_finalized.count === 0) {
      historyEmptyWithSummary += 1;
      if (historyEmptySamples.length < 10) historyEmptySamples.push(sample);
    }

    // P0 체크
    if (P0_CHECK_NAMES.includes(inst.name)) {
      p0Checks[inst.name] = {
        name: inst.name,
        a_avg: aAvg,
        a_count: aCount,
        c_avg: aggC_finalized.avg,
        c_count: aggC_finalized.count,
        status: "captured",
      };
    }
  }

  // P0 기대값 평가
  function evaluateP0(
    name: string,
    actual: { a_avg: number | null; a_count: number } | null,
    expectations: { avg: number | null | "any"; count: number | "any" }
  ): { name: string; status: "PASS" | "FAIL"; expected: typeof expectations; actual: typeof actual } {
    // P0 정정으로 record가 0건이 된 케이스(박상훈/최진영B): pending_review로 빠져 SatisfactionRecord 없음 = 정책상 정상.
    // 즉 expectations.avg=null, expectations.count=0 일 때 actual=null도 PASS.
    if (expectations.avg === null && expectations.count === 0) {
      if (actual === null) return { name, status: "PASS", expected: expectations, actual: null };
      if (actual.a_avg === null && actual.a_count === 0) {
        return { name, status: "PASS", expected: expectations, actual };
      }
      return { name, status: "FAIL", expected: expectations, actual };
    }
    if (!actual) return { name, status: "FAIL", expected: expectations, actual: null };
    const avgOk =
      expectations.avg === "any" ||
      (expectations.avg === null ? actual.a_avg === null : avgDiffers(actual.a_avg, expectations.avg) === false);
    const countOk = expectations.count === "any" || actual.a_count === expectations.count;
    return {
      name,
      status: avgOk && countOk ? "PASS" : "FAIL",
      expected: expectations,
      actual,
    };
  }

  const p0Evaluation = [
    evaluateP0("박상훈", p0Checks["박상훈"], { avg: null, count: 0 }),
    evaluateP0("최진영B", p0Checks["최진영B"], { avg: null, count: 0 }),
    evaluateP0("유종훈", p0Checks["유종훈"], { avg: 5.0, count: "any" }),
    evaluateP0("김정수A", p0Checks["김정수A"], { avg: 5.0, count: "any" }),
    evaluateP0("공지연", p0Checks["공지연"], { avg: 4.8, count: 1 }),
  ];

  const p0PassCount = p0Evaluation.filter((c) => c.status === "PASS").length;

  return NextResponse.json({
    ok: true,
    durationMs: Date.now() - startedAt,
    cutoffDate,
    total_satisfaction_records: records.length,
    sourceType_distribution: sourceTypeDistribution,
    checks: {
      db_vs_recomputed: {
        match: dbVsRecomputed_match,
        mismatch: dbVsRecomputed_mismatch,
        samples: dbVsRecomputed_samples,
        note:
          "A(instructors.satisfaction_avg DB 컬럼) vs B(SQL 산식 TS 재계산: 모든 sourceType, 6개월 cutoff, 가중평균). " +
          "0이면 refreshSatisfactionAggregates 정상 작동.",
      },
      db_vs_live_response: {
        match: dbVsLive_match,
        mismatch: dbVsLive_mismatch,
        samples: dbVsLive_samples,
        note:
          "A(DB 컬럼) vs C(라이브 응답 산식: 3개 sourceType만, 6개월 cutoff, 가중평균). " +
          "0이 아니면 사용자가 보는 inst.satisfaction.avg와 recent_satisfaction_summary.avg가 다르다는 의미.",
      },
      history_empty_with_summary: {
        count: historyEmptyWithSummary,
        samples: historyEmptySamples,
        note:
          "DB count > 0인데 라이브 sourceType filter(3개) 후 history가 빈 강사. " +
          "전문가 보고서 3-6 결함과 동일 패턴. 0이면 P0-5 통일 완료.",
      },
    },
    p0_check: {
      pass_count: p0PassCount,
      total: p0Evaluation.length,
      details: p0Evaluation,
      note:
        "메모리 [만족도 P0 정공법 완료] 결과와 일치 여부. " +
        "박상훈/최진영B는 null/0 (강사별 평균 없음 — pending_review), 유종훈/김정수A는 gmail만 5.0, 공지연은 KT만 4.8/1.",
    },
    interpretation: {
      qg_alpha1: dbVsRecomputed_mismatch === 0 ? "PASS" : "FAIL",
      qg_alpha2: dbVsLive_mismatch === 0 && historyEmptyWithSummary === 0 ? "PASS" : "FAIL",
      qg_alpha5: p0PassCount === p0Evaluation.length ? "PASS" : "FAIL",
      next_action:
        dbVsRecomputed_mismatch > 0
          ? "A≠B: refreshSatisfactionAggregates 재실행 또는 SQL 산식 버그"
          : dbVsLive_mismatch > 0 || historyEmptyWithSummary > 0
            ? "A≠C: route.ts의 sourceType filter 영향. 정책 결정 필요 (모든 sourceType 또는 컬럼도 같은 filter 적용)"
            : p0PassCount < p0Evaluation.length
              ? "P0 회귀 감지. 변경 이력 점검"
              : "모든 QG PASS — Phase α Step 1 완료. snapshot 정합성으로 진행",
    },
  });
}
