/**
 * Score Recalculator — 01_core_policy.md 9절, 05_api_spec.md 7-6절
 *
 * 만족도 저장 성공 시 전체 강사의 score, score_breakdown, score_calculated_at, rank를 재계산한다.
 * - 만족도 컴포넌트는 최신 만족도 집계 기준으로 다시 계산
 * - courses/slack/recency/email/ops_channel 은 현재 canonical 필드 기준으로 다시 계산
 * - salesmap 은 raw canonical 입력값이 없어 저장된 breakdown 값을 재사용
 * - 실습코치는 0점 처리
 * - 정규화: 전체 강사 중 최대값 대비 비율
 * - 만족도 결측: 전체 수집 강사의 중앙값으로 대체
 */

import { prisma } from "@/lib/prisma";

const DEFAULT_WEIGHTS = {
  courses: 35,
  satisfaction: 15,
  slack: 15,
  recency: 15,
  salesmap: 10,
  email: 5,
  ops_channel: 5,
} as const;
const DEFAULT_RECENCY_DECAY_DAYS = 180;
const DEFAULT_MISSING_SATISFACTION_POLICY = "median";

interface ScoreBreakdown {
  courses: number;
  satisfaction: number;
  slack: number;
  recency: number;
  salesmap: number;
  email: number;
  ops_channel: number;
}

interface ScorePolicyConfig {
  version: string | null;
  weights: ScoreBreakdown;
  recencyDecayDays: number;
  missingSatisfactionPolicy: string;
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

function safeDiv(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || numerator <= 0) return 0;
  if (!Number.isFinite(denominator) || denominator <= 0) return 0;
  return Math.min(numerator / denominator, 1);
}

function parsePolicy(
  raw:
    | {
        version: string;
        weights: unknown;
        recencyDecayDays: number;
        missingSatisfactionPolicy: string;
      }
    | null
    | undefined
): ScorePolicyConfig {
  const rawWeights =
    raw && raw.weights && typeof raw.weights === "object"
      ? (raw.weights as Record<string, unknown>)
      : {};

  return {
    version: raw?.version ?? null,
    weights: {
      courses: Number(rawWeights.courses) || DEFAULT_WEIGHTS.courses,
      satisfaction:
        Number(rawWeights.satisfaction) || DEFAULT_WEIGHTS.satisfaction,
      slack: Number(rawWeights.slack) || DEFAULT_WEIGHTS.slack,
      recency: Number(rawWeights.recency) || DEFAULT_WEIGHTS.recency,
      salesmap: Number(rawWeights.salesmap) || DEFAULT_WEIGHTS.salesmap,
      email: Number(rawWeights.email) || DEFAULT_WEIGHTS.email,
      ops_channel:
        Number(rawWeights.ops_channel) || DEFAULT_WEIGHTS.ops_channel,
    },
    recencyDecayDays:
      raw?.recencyDecayDays && raw.recencyDecayDays > 0
        ? raw.recencyDecayDays
        : DEFAULT_RECENCY_DECAY_DAYS,
    missingSatisfactionPolicy:
      raw?.missingSatisfactionPolicy || DEFAULT_MISSING_SATISFACTION_POLICY,
  };
}

function recencyDecay(
  lastActivityAt: Date | null,
  recencyDecayDays: number
): number {
  if (!lastActivityAt) return 0;
  const daysAgo =
    (Date.now() - new Date(lastActivityAt).getTime()) / (1000 * 60 * 60 * 24);
  if (!Number.isFinite(daysAgo) || daysAgo < 0) return 0;
  return Math.exp(-daysAgo / recencyDecayDays);
}

/**
 * 전체 강사의 score, score_breakdown, score_calculated_at, rank를 재계산한다.
 *
 * 05_api_spec 7-6절:
 * - 만족도 컴포넌트는 최신 만족도 집계를 기준으로 다시 계산
 * - 비만족도 컴포넌트는 현재 저장된 canonical 값으로 재계산한다.
 * - salesmap 은 현재 저장된 breakdown 값을 재사용한다.
 */
export async function recalculateAllScores(): Promise<void> {
  const now = new Date();

  const activePolicy = await prisma.scorePolicyVersion.findFirst({
    where: { active: true },
  });
  const policy = parsePolicy(activePolicy);

  const allInstructors = await prisma.instructor.findMany({
    select: {
      id: true,
      satisfactionAvg: true,
      satisfactionCount: true,
      totalCourses: true,
      recentCourses6mo: true,
      slackActivityCount: true,
      emailActivityCount: true,
      opsReportActivityCount: true,
      dispatchRequestActivityCount: true,
      lastActivityAt: true,
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
    const effectiveSatisfaction =
      hasSatisfaction ||
      policy.missingSatisfactionPolicy !== DEFAULT_MISSING_SATISFACTION_POLICY
        ? Number(inst.satisfactionAvg ?? 0)
        : medianSatisfaction;
    const isImputed = !hasSatisfaction;

    return {
      id: inst.id,
      effectiveSatisfaction,
      isImputed,
      totalCourses: inst.totalCourses ?? 0,
      recentCourses6mo: inst.recentCourses6mo ?? 0,
      slackActivityCount: inst.slackActivityCount ?? 0,
      emailActivityCount: inst.emailActivityCount ?? 0,
      opsActivityCount:
        (inst.opsReportActivityCount ?? 0) + (inst.dispatchRequestActivityCount ?? 0),
      lastActivityAt: inst.lastActivityAt,
      isPracticeCoach: inst.isPracticeCoach,
      breakdown: parseBreakdown(inst.scoreBreakdown),
    };
  });

  // 01_core_policy 9절: 정규화 — 전체 강사 중 최대값 대비 비율
  const maxSatisfaction = Math.max(
    ...instructorData.map((i) => i.effectiveSatisfaction),
    0.01 // 0 division 방지
  );
  const maxCourses = Math.max(...instructorData.map((i) => i.totalCourses), 1);
  const maxSlack = Math.max(...instructorData.map((i) => i.slackActivityCount), 1);
  const maxEmail = Math.max(...instructorData.map((i) => i.emailActivityCount), 1);
  const maxOps = Math.max(...instructorData.map((i) => i.opsActivityCount), 1);

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

    const coursesScore =
      safeDiv(inst.totalCourses, maxCourses) * policy.weights.courses;
    const satisfactionScore =
      (inst.effectiveSatisfaction / maxSatisfaction) *
      policy.weights.satisfaction;
    const slackScore =
      safeDiv(inst.slackActivityCount, maxSlack) * policy.weights.slack;
    const recencyScore =
      recencyDecay(inst.lastActivityAt, policy.recencyDecayDays) *
      policy.weights.recency;
    const emailScore =
      safeDiv(inst.emailActivityCount, maxEmail) * policy.weights.email;
    const opsScore =
      safeDiv(inst.opsActivityCount, maxOps) * policy.weights.ops_channel;

    const breakdown: ScoreBreakdown = {
      courses: Math.round(coursesScore * 10) / 10,
      satisfaction: Math.round(satisfactionScore * 10) / 10,
      slack: Math.round(slackScore * 10) / 10,
      recency: Math.round(recencyScore * 10) / 10,
      salesmap: inst.breakdown.salesmap,
      email: Math.round(emailScore * 10) / 10,
      ops_channel: Math.round(opsScore * 10) / 10,
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
        const pv = policy.version ? `'${policy.version}'` : "NULL";
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
