/**
 * Score Recalculator — 01_core_policy.md 9절, 05_api_spec.md 7-6절
 *
 * 만족도 저장 성공 시 전체 강사의 score, score_breakdown, score_calculated_at, rank를 재계산한다.
 * - 만족도 컴포넌트만 최신 집계 기준으로 다시 계산
 * - 비만족도 컴포넌트는 저장된 canonical 값(score_breakdown) 재사용
 * - 실습코치는 0점 처리
 * - 정규화: 전체 강사 중 최대값 대비 비율
 * - 만족도 결측: 전체 수집 강사의 중앙값으로 대체
 */

import { prisma } from "@/lib/prisma";

const SATISFACTION_WEIGHT = 15;

interface ScoreBreakdown {
  courses: number;
  satisfaction: number;
  slack: number;
  recency: number;
  salesmap: number;
  email: number;
  ops_channel: number;
}

function parseBreakdown(raw: unknown): ScoreBreakdown {
  const defaults: ScoreBreakdown = {
    courses: 0,
    satisfaction: 0,
    slack: 0,
    recency: 0,
    salesmap: 0,
    email: 0,
    ops_channel: 0,
  };
  if (!raw || typeof raw !== "object") return defaults;
  const obj = raw as Record<string, unknown>;
  return {
    courses: Number(obj.courses) || 0,
    satisfaction: Number(obj.satisfaction) || 0,
    slack: Number(obj.slack) || 0,
    recency: Number(obj.recency) || 0,
    salesmap: Number(obj.salesmap) || 0,
    email: Number(obj.email) || 0,
    ops_channel: Number(obj.ops_channel) || 0,
  };
}

/**
 * 중앙값 계산
 */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * 전체 강사의 score, score_breakdown, score_calculated_at, rank를 재계산한다.
 *
 * 05_api_spec 7-6절:
 * - 만족도 컴포넌트만 최신 집계 기준으로 재계산
 * - 비만족도 컴포넌트는 현재 저장된 canonical 값 재사용
 */
export async function recalculateAllScores(): Promise<void> {
  const now = new Date();

  // 04_data_pipeline 15-3: 적용 버전은 instructors.score_policy_version
  const activePolicy = await prisma.scorePolicyVersion.findFirst({
    where: { active: true },
  });
  const policyVersion = activePolicy?.version ?? null;

  const allInstructors = await prisma.instructor.findMany({
    select: {
      id: true,
      satisfactionAvg: true,
      satisfactionCount: true,
      isPracticeCoach: true,
      scoreBreakdown: true,
    },
  });

  // 01_core_policy 9절: 만족도 결측치 → 전체 수집 강사의 중앙값
  const satisfactionValues = allInstructors
    .filter((i) => i.satisfactionAvg !== null && i.satisfactionCount > 0)
    .map((i) => Number(i.satisfactionAvg));
  const medianSatisfaction = median(satisfactionValues);

  // 각 강사의 effective satisfaction_avg 결정
  const instructorData = allInstructors.map((inst) => {
    const hasSatisfaction =
      inst.satisfactionAvg !== null && inst.satisfactionCount > 0;
    const effectiveSatisfaction = hasSatisfaction
      ? Number(inst.satisfactionAvg)
      : medianSatisfaction;
    const isImputed = !hasSatisfaction;

    return {
      id: inst.id,
      effectiveSatisfaction,
      isImputed,
      isPracticeCoach: inst.isPracticeCoach,
      breakdown: parseBreakdown(inst.scoreBreakdown),
    };
  });

  // 01_core_policy 9절: 정규화 — 전체 강사 중 최대값 대비 비율
  const maxSatisfaction = Math.max(
    ...instructorData.map((i) => i.effectiveSatisfaction),
    0.01 // 0 division 방지
  );

  // 각 강사의 점수 계산
  const scored = instructorData.map((inst) => {
    // 01_core_policy 9절: 실습코치는 0점 처리
    if (inst.isPracticeCoach) {
      return {
        id: inst.id,
        isImputed: inst.isImputed,
        score: 0,
        breakdown: {
          courses: 0,
          satisfaction: 0,
          slack: 0,
          recency: 0,
          salesmap: 0,
          email: 0,
          ops_channel: 0,
        },
      };
    }

    // 만족도 컴포넌트만 재계산, 나머지는 canonical 값 재사용
    const satisfactionScore =
      (inst.effectiveSatisfaction / maxSatisfaction) * SATISFACTION_WEIGHT;

    const breakdown: ScoreBreakdown = {
      courses: inst.breakdown.courses,
      satisfaction: Math.round(satisfactionScore * 10) / 10,
      slack: inst.breakdown.slack,
      recency: inst.breakdown.recency,
      salesmap: inst.breakdown.salesmap,
      email: inst.breakdown.email,
      ops_channel: inst.breakdown.ops_channel,
    };

    const totalScore = Object.values(breakdown).reduce((a, b) => a + b, 0);

    return {
      id: inst.id,
      isImputed: inst.isImputed,
      score: Math.round(totalScore * 10) / 10,
      breakdown,
    };
  });

  // 순위 계산: score 내림차순
  scored.sort((a, b) => b.score - a.score);

  // DB 일괄 업데이트 — raw SQL로 배치 처리 (개별 update는 원격 DB에서 타임아웃)
  const BATCH_SIZE = 100;
  for (let i = 0; i < scored.length; i += BATCH_SIZE) {
    const batch = scored.slice(i, i + BATCH_SIZE);
    const values = batch
      .map((inst, batchIdx) => {
        const rank = i + batchIdx + 1;
        const breakdownJson = JSON.stringify(inst.breakdown).replace(/'/g, "''");
        const pv = policyVersion ? `'${policyVersion}'` : "NULL";
        return `('${inst.id}'::uuid, ${inst.score}, '${breakdownJson}'::jsonb, '${now.toISOString()}'::timestamptz, ${rank}, ${inst.isImputed}, ${pv})`;
      })
      .join(",\n");

    await prisma.$executeRawUnsafe(`
      UPDATE instructors AS t SET
        score = v.score,
        score_breakdown = v.breakdown,
        score_calculated_at = v.calculated_at,
        rank = v.rank,
        satisfaction_is_imputed = v.is_imputed,
        score_policy_version = v.policy_version
      FROM (VALUES ${values})
        AS v(id, score, breakdown, calculated_at, rank, is_imputed, policy_version)
      WHERE t.id = v.id
    `);
  }
}
