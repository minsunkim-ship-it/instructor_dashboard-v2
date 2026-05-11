/**
 * Score Recalculator — demo intent aligned
 *
 * instructor_db_demo의 후기 구현에서 생긴 slack/ops 중복을 줄이고,
 * 초기 build_data.py 시기의 의도에 맞춰 Slack 15점과 운영채널 5점을 분리한다.
 * - 출강횟수: contract_sheet_rows 우선, 없으면 total_courses
 *   (`contract_sheet_rows` = 계약시트 + 강사별 출강시트 기반 이력 수)
 * - 만족도: avg_score / 5.0, 결측 시 중앙값, 전체 만족도 데이터가 없으면 4.0
 * - 슬랙 평판: slack_activity_count 전체 최대값 대비 정규화
 * - 최근성: max(slack_last_activity, salesmap_last_deal_at, gmail_last_activity) 기준 exp(-days/180)
 * - SM 딜: salesmap_deal_count 전체 최대값 대비 정규화
 * - 이메일: gmail thread 수 전체 최대값 대비 정규화
 * - 운영채널: ops_report_activity_count 전체 최대값 대비 정규화
 * - dispatch_request_activity_count는 수요 보조 신호로 저장만 하고 점수에는 직접 반영하지 않는다.
 * - 실습코치(flag / boolean)는 0점 처리
 * - tie rank는 기존 강사 생성 순서를 보존하는 stable sort로 처리한다.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { countGroupedTeachingHistories } from "@/lib/teaching-history-display";
import { COURSE_COUNT_SOURCE_TYPES } from "@/lib/pipeline/teaching-history-sources";

const SCORE_VERSION = "v3_demo_intent";
const RECENCY_DECAY_DAYS = 180;
const DEFAULT_MISSING_SATISFACTION = 4.0;
const ACCEPTED_ACTIVITY_STATUSES = ["auto_accepted", "approved"] as const;

const VALIDATION_RULES = {
  satisfactionOutOfRange: "SATISFACTION_OUT_OF_RANGE",
  practiceCoachScoreMismatch: "PRACTICE_COACH_SCORE_MISMATCH",
  contractHistoryCountMismatch: "CONTRACT_HISTORY_COUNT_MISMATCH",
  highActivityLowScore: "HIGH_ACTIVITY_LOW_SCORE",
} as const;

interface ScoreBreakdown {
  courses: number;
  satisfaction: number;
  slack: number;
  recency: number;
  salesmap: number;
  email: number;
  ops_channel: number;
}

interface ActivityStats {
  slackMentions: number;
  slackLastActivityAt: Date | null;
  gmailThreads: number;
  gmailLastActivityAt: Date | null;
  opsReportCount: number;
}

interface ValidationCandidate {
  id: string;
  name: string;
  flag: string | null;
  isPracticeCoach: boolean;
  satisfactionAvg: number | null;
  contractSheetRows: number;
  contractHistoryCount: number;
  totalHistoryCount: number;
  totalCourses: number;
  preCoachScore: number;
  score: number;
}

interface ScoreRecalcTimings {
  loadActivityStatsMs: number;
  loadTeachingHistoryCountsMs: number;
  loadInstructorsMs: number;
  scoringMs: number;
  writeScoresMs: number;
  validationMs: number;
}

function breakdownEquals(
  current: Prisma.JsonValue,
  next: ScoreBreakdown
): boolean {
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    return false;
  }

  const record = current as Record<string, unknown>;
  const keys: Array<keyof ScoreBreakdown> = [
    "courses",
    "satisfaction",
    "slack",
    "recency",
    "salesmap",
    "email",
    "ops_channel",
  ];

  return keys.every((key) => {
    const value = record[key];
    return typeof value === "number" && value === next[key];
  });
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function safeDiv(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || numerator <= 0) return 0;
  if (!Number.isFinite(denominator) || denominator <= 0) return 0;
  return Math.min(numerator / denominator, 1);
}

function demoMedian(values: number[]): number {
  if (values.length === 0) return DEFAULT_MISSING_SATISFACTION;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function maxDate(dates: Array<Date | null | undefined>): Date | null {
  let result: Date | null = null;
  for (const date of dates) {
    if (!date) continue;
    if (!result || date > result) {
      result = date;
    }
  }
  return result;
}

function localDayDiff(mostRecent: Date | null): number | null {
  if (!mostRecent) return null;
  const today = new Date();
  const todayStart = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate()
  );
  const targetStart = new Date(
    mostRecent.getFullYear(),
    mostRecent.getMonth(),
    mostRecent.getDate()
  );
  const diffMs = todayStart.getTime() - targetStart.getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return null;
  return Math.round(diffMs / (1000 * 60 * 60 * 24));
}

async function loadActivityStatsByInstructor(): Promise<Map<string, ActivityStats>> {
  const rows = await prisma.$queryRaw<
    Array<{
      instructorId: string;
      slackMentions: number | bigint | null;
      slackLastActivityAt: Date | null;
      gmailThreads: number | bigint | null;
      gmailLastActivityAt: Date | null;
      opsReportCount: number | bigint | null;
    }>
  >(Prisma.sql`
    SELECT
      resolved_instructor_id AS "instructorId",
      COALESCE(SUM(slack_activity_count), 0) AS "slackMentions",
      MAX(CASE WHEN source_type = 'slack' THEN last_activity_at END) AS "slackLastActivityAt",
      COALESCE(SUM(email_activity_count), 0) AS "gmailThreads",
      MAX(CASE WHEN source_type = 'gmail' THEN last_activity_at END) AS "gmailLastActivityAt",
      COALESCE(SUM(ops_report_activity_count), 0) AS "opsReportCount"
    FROM activity_review_registries
    WHERE match_status IN (${Prisma.join(
      ACCEPTED_ACTIVITY_STATUSES.map((status) => Prisma.sql`${status}`)
    )})
      AND resolved_instructor_id IS NOT NULL
    GROUP BY resolved_instructor_id
  `);

  const statsByInstructor = new Map<string, ActivityStats>();
  for (const row of rows) {
    if (!row.instructorId) continue;
    statsByInstructor.set(row.instructorId, {
      slackMentions: Number(row.slackMentions ?? 0),
      slackLastActivityAt: row.slackLastActivityAt,
      gmailThreads: Number(row.gmailThreads ?? 0),
      gmailLastActivityAt: row.gmailLastActivityAt,
      opsReportCount: Number(row.opsReportCount ?? 0),
    });
  }

  return statsByInstructor;
}

async function loadTeachingHistoryCounts(): Promise<{
  contractSheetCounts: Map<string, number>;
  totalCounts: Map<string, number>;
}> {
  const histories = await prisma.teachingHistory.findMany({
    select: {
      instructorDbId: true,
      sourceType: true,
      companyName: true,
      courseName: true,
      courseId: true,
      detailType: true,
      feeExtra: true,
      specialNotes: true,
      startDate: true,
      endDate: true,
      dateLabel: true,
      totalSessions: true,
      totalHours: true,
      // 박상훈 패치 작동을 위해 deal_fee_hourly/contract_type 포함
      dealFeeHourly: true,
      contractType: true,
    },
  });

  type CountableItem = {
    company_name: string | null;
    course_name: string | null;
    course_id: string | null;
    detail_type: string | null;
    fee_extra: string | null;
    special_notes: string | null;
    start_date: string | null;
    end_date: string | null;
    date_label: string | null;
    total_sessions: number | null;
    total_hours: number | null;
    // 박상훈 패치 작동을 위해 필수
    deal_fee_hourly: number | null;
    contract_type: string | null;
  };
  const allByInstructor = new Map<string, CountableItem[]>();
  const courseCountByInstructor = new Map<string, CountableItem[]>();

  for (const row of histories) {
    const item: CountableItem = {
      company_name: row.companyName,
      course_name: row.courseName,
      course_id: row.courseId,
      detail_type: row.detailType,
      fee_extra: row.feeExtra,
      special_notes: row.specialNotes,
      start_date: row.startDate?.toISOString().split("T")[0] ?? null,
      end_date: row.endDate?.toISOString().split("T")[0] ?? null,
      date_label: row.dateLabel,
      total_sessions: row.totalSessions,
      total_hours: row.totalHours !== null ? Number(row.totalHours) : null,
      deal_fee_hourly: row.dealFeeHourly,
      contract_type: row.contractType,
    };

    const allBucket = allByInstructor.get(row.instructorDbId) ?? [];
    allBucket.push(item);
    allByInstructor.set(row.instructorDbId, allBucket);

    if (COURSE_COUNT_SOURCE_TYPES.includes(row.sourceType as typeof COURSE_COUNT_SOURCE_TYPES[number])) {
      const courseBucket = courseCountByInstructor.get(row.instructorDbId) ?? [];
      courseBucket.push(item);
      courseCountByInstructor.set(row.instructorDbId, courseBucket);
    }
  }

  return {
    contractSheetCounts: new Map(
      Array.from(courseCountByInstructor.entries()).map(([instructorId, items]) => [
        instructorId,
        countGroupedTeachingHistories(items, {
          fromDate: "2025-01-01",
        }),
      ])
    ),
    totalCounts: new Map(
      Array.from(allByInstructor.entries()).map(([instructorId, items]) => [
        instructorId,
        countGroupedTeachingHistories(items, {
          fromDate: "2025-01-01",
        }),
      ])
    ),
  };
}

async function recordValidationIssues(
  candidates: ValidationCandidate[],
  runId?: string | null
): Promise<void> {
  const issues: Array<{
    instructorDbId: string;
    entityType: string;
    entityId: string;
    ruleCode: string;
    severity: string;
    message: string;
    beforeValue: Prisma.InputJsonValue;
    afterValue: Prisma.InputJsonValue;
    autoFixed: boolean;
    runId?: string | null;
  }> = [];

  for (const candidate of candidates) {
    if (
      candidate.satisfactionAvg !== null &&
      (candidate.satisfactionAvg < 1 || candidate.satisfactionAvg > 5)
    ) {
      issues.push({
        instructorDbId: candidate.id,
        entityType: "instructor",
        entityId: candidate.id,
        ruleCode: VALIDATION_RULES.satisfactionOutOfRange,
        severity: "warning",
        message: `${candidate.name}: 만족도 ${candidate.satisfactionAvg}가 demo parity 범위(1~5)를 벗어났습니다.`,
        beforeValue: { satisfaction_avg: candidate.satisfactionAvg },
        afterValue: {},
        autoFixed: false,
        runId,
      });
    }

    const coachFlag = candidate.flag === "실습코치";
    if ((coachFlag || candidate.isPracticeCoach) && candidate.preCoachScore > 0) {
      issues.push({
        instructorDbId: candidate.id,
        entityType: "instructor",
        entityId: candidate.id,
        ruleCode: VALIDATION_RULES.practiceCoachScoreMismatch,
        severity: "warning",
        message: `${candidate.name}: 실습코치는 0점이어야 해서 자동 보정했습니다.`,
        beforeValue: {
          flag: candidate.flag,
          is_practice_coach: candidate.isPracticeCoach,
          score: candidate.preCoachScore,
        },
        afterValue: {
          flag: "실습코치",
          is_practice_coach: true,
          score: 0,
        },
        autoFixed: true,
        runId,
      });
    }

    if (
      candidate.contractSheetRows > 0 &&
      candidate.contractHistoryCount === 0 &&
      candidate.totalHistoryCount > 0
    ) {
      issues.push({
        instructorDbId: candidate.id,
        entityType: "instructor",
        entityId: candidate.id,
        ruleCode: VALIDATION_RULES.contractHistoryCountMismatch,
        severity: "warning",
        message: `${candidate.name}: contract_sheet_rows가 있는데 canonical teaching_history(contract_sheet / instructor_dispatch_sheet)가 비어 있습니다.`,
        beforeValue: {
          contract_sheet_rows: candidate.contractSheetRows,
          contract_history_count: candidate.contractHistoryCount,
          total_history_count: candidate.totalHistoryCount,
        },
        afterValue: {},
        autoFixed: false,
        runId,
      });
    }

    const isCoach = candidate.flag === "실습코치" || candidate.isPracticeCoach;
    if (candidate.totalHistoryCount >= 30 && candidate.score < 20 && !isCoach) {
      issues.push({
        instructorDbId: candidate.id,
        entityType: "instructor",
        entityId: candidate.id,
        ruleCode: VALIDATION_RULES.highActivityLowScore,
        severity: "warning",
        message: `${candidate.name}: teaching_history ${candidate.totalHistoryCount}건인데 score가 ${candidate.score}점입니다.`,
        beforeValue: {
          teaching_history_count: candidate.totalHistoryCount,
          score: candidate.score,
        },
        afterValue: {},
        autoFixed: false,
        runId,
      });
    }
  }

  if (issues.length === 0) return;
  await prisma.validationIssue.createMany({ data: issues });
}

/**
 * 전체 강사의 score, score_breakdown, score_calculated_at, rank를 재계산한다.
 */
export async function recalculateAllScores(options?: {
  runId?: string | null;
  validateIssues?: boolean;
}): Promise<{
  updatedInstructors: number;
  totalInstructors: number;
  timings: ScoreRecalcTimings;
}> {
  const now = new Date();
  const validateIssues = options?.validateIssues ?? true;
  const timings: ScoreRecalcTimings = {
    loadActivityStatsMs: 0,
    loadTeachingHistoryCountsMs: 0,
    loadInstructorsMs: 0,
    scoringMs: 0,
    writeScoresMs: 0,
    validationMs: 0,
  };

  const instructorsPromise = (async () => {
    const startedAt = Date.now();
    const instructors = await prisma.instructor.findMany({
      select: {
        id: true,
        name: true,
        flag: true,
        createdAt: true,
        isPracticeCoach: true,
        satisfactionAvg: true,
        satisfactionCount: true,
        satisfactionIsImputed: true,
        contractSheetRows: true,
        totalCourses: true,
        score: true,
        scoreBreakdown: true,
        rank: true,
        scorePolicyVersion: true,
        salesmapDealCount: true,
        salesmapLastDealAt: true,
      },
    });
    timings.loadInstructorsMs = Date.now() - startedAt;
    return instructors;
  })();

  const activityStatsPromise = (async () => {
    const startedAt = Date.now();
    const stats = await loadActivityStatsByInstructor();
    timings.loadActivityStatsMs = Date.now() - startedAt;
    return stats;
  })();

  const teachingHistoryCountsPromise = (async () => {
    if (!validateIssues) {
      return {
        contractSheetCounts: new Map<string, number>(),
        totalCounts: new Map<string, number>(),
      };
    }
    const startedAt = Date.now();
    const counts = await loadTeachingHistoryCounts();
    timings.loadTeachingHistoryCountsMs = Date.now() - startedAt;
    return counts;
  })();

  const [
    allInstructors,
    activityStatsByInstructor,
    teachingHistoryCounts,
  ] = await Promise.all([
    instructorsPromise,
    activityStatsPromise,
    teachingHistoryCountsPromise,
  ]);

  allInstructors.sort((a, b) => {
    const byCreatedAt = a.createdAt.getTime() - b.createdAt.getTime();
    if (byCreatedAt !== 0) return byCreatedAt;
    const byName = a.name.localeCompare(b.name, "ko");
    if (byName !== 0) return byName;
    return a.id.localeCompare(b.id);
  });

  const satisfactionValues = allInstructors
    .filter((inst) => inst.satisfactionAvg !== null && Number(inst.satisfactionAvg) > 0)
    .map((inst) => Number(inst.satisfactionAvg))
    .filter((value) => Number.isFinite(value) && value > 0);
  const satisfactionMedian = demoMedian(satisfactionValues);

  const maxContracts = Math.max(
    ...allInstructors.map((inst) =>
      (inst.contractSheetRows ?? 0) > 0
        ? (inst.contractSheetRows ?? 0)
        : (inst.totalCourses ?? 0)
    ),
    1
  );
  const maxSlack = Math.max(
    ...allInstructors.map(
      (inst) => activityStatsByInstructor.get(inst.id)?.slackMentions ?? 0
    ),
    1
  );
  const maxDeals = Math.max(
    ...allInstructors.map((inst) => inst.salesmapDealCount ?? 0),
    1
  );
  const maxEmail = Math.max(
    ...allInstructors.map(
      (inst) => activityStatsByInstructor.get(inst.id)?.gmailThreads ?? 0
    ),
    1
  );
  const maxOps = Math.max(
    ...allInstructors.map(
      (inst) => activityStatsByInstructor.get(inst.id)?.opsReportCount ?? 0
    ),
    1
  );

  const validationCandidates: ValidationCandidate[] = [];
  const scoringStartedAt = Date.now();

  const scored = allInstructors.map((inst, index) => {
    const activityStats = activityStatsByInstructor.get(inst.id) ?? {
      slackMentions: 0,
      slackLastActivityAt: null,
      gmailThreads: 0,
      gmailLastActivityAt: null,
      opsReportCount: 0,
    };

    const contractCount =
      inst.contractSheetRows > 0 ? inst.contractSheetRows : inst.totalCourses;
    const hasSatisfaction =
      inst.satisfactionAvg !== null && Number(inst.satisfactionAvg) > 0;
    const satisfactionValue = hasSatisfaction
      ? Number(inst.satisfactionAvg)
      : satisfactionMedian;

    const mostRecentActivityAt = maxDate([
      activityStats.slackLastActivityAt,
      inst.salesmapLastDealAt,
      activityStats.gmailLastActivityAt,
    ]);
    const daysSinceRecent = localDayDiff(mostRecentActivityAt);

    const rawCoursesScore = safeDiv(contractCount, maxContracts) * 35;
    const rawSatisfactionScore = (satisfactionValue / 5.0) * 15;
    const rawSlackScore = safeDiv(activityStats.slackMentions, maxSlack) * 15;
    const rawRecencyScore =
      daysSinceRecent === null
        ? 0
        : Math.exp(-daysSinceRecent / RECENCY_DECAY_DAYS) * 15;
    const rawSalesmapScore = safeDiv(inst.salesmapDealCount, maxDeals) * 10;
    const rawEmailScore = safeDiv(activityStats.gmailThreads, maxEmail) * 5;
    const rawOpsScore = safeDiv(activityStats.opsReportCount, maxOps) * 5;

    const preCoachScore = round1(
      rawCoursesScore +
        rawSatisfactionScore +
        rawSlackScore +
        rawRecencyScore +
        rawSalesmapScore +
        rawEmailScore +
        rawOpsScore
    );

    const isCoach = inst.flag === "실습코치" || inst.isPracticeCoach;
    const score = isCoach ? 0 : preCoachScore;
    const breakdown: ScoreBreakdown = isCoach
      ? {
          courses: 0,
          satisfaction: 0,
          slack: 0,
          recency: 0,
          salesmap: 0,
          email: 0,
          ops_channel: 0,
        }
      : {
          courses: round1(rawCoursesScore),
          satisfaction: round1(rawSatisfactionScore),
          slack: round1(rawSlackScore),
          recency: round1(rawRecencyScore),
          salesmap: round1(rawSalesmapScore),
          email: round1(rawEmailScore),
          ops_channel: round1(rawOpsScore),
        };

    if (validateIssues) {
      validationCandidates.push({
        id: inst.id,
        name: inst.name,
        flag: inst.flag,
        isPracticeCoach: inst.isPracticeCoach,
        satisfactionAvg:
          inst.satisfactionAvg !== null ? Number(inst.satisfactionAvg) : null,
        contractSheetRows: inst.contractSheetRows,
        contractHistoryCount:
          teachingHistoryCounts.contractSheetCounts.get(inst.id) ?? 0,
        totalHistoryCount: teachingHistoryCounts.totalCounts.get(inst.id) ?? 0,
        totalCourses: inst.totalCourses,
        preCoachScore,
        score,
      });
    }

    return {
      id: inst.id,
      score,
      breakdown,
      isImputed: !hasSatisfaction,
      originalIndex: index,
      currentScore: inst.score !== null ? Number(inst.score) : null,
      currentBreakdown: inst.scoreBreakdown,
      currentRank: inst.rank,
      currentIsImputed: inst.satisfactionIsImputed,
      currentPolicyVersion: inst.scorePolicyVersion,
    };
  });
  timings.scoringMs = Date.now() - scoringStartedAt;

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.originalIndex - b.originalIndex;
  });

  const changedRows = scored
    .map((inst, index) => ({
      ...inst,
      nextRank: index + 1,
    }))
    .filter((inst) => {
      return (
        inst.currentScore !== inst.score ||
        !breakdownEquals(inst.currentBreakdown, inst.breakdown) ||
        inst.currentRank !== inst.nextRank ||
        inst.currentIsImputed !== inst.isImputed ||
        inst.currentPolicyVersion !== SCORE_VERSION
      );
    });

  const writeScoresStartedAt = Date.now();
  const BATCH_SIZE = 100;
  for (let i = 0; i < changedRows.length; i += BATCH_SIZE) {
    const batch = changedRows.slice(i, i + BATCH_SIZE);
    const values = batch
      .map((inst) => {
        const breakdownJson = JSON.stringify(inst.breakdown).replace(/'/g, "''");
        return `('${inst.id}'::uuid, ${inst.score}, '${breakdownJson}'::jsonb, '${now.toISOString()}'::timestamptz, ${inst.nextRank}, ${inst.isImputed}, '${SCORE_VERSION}')`;
      })
      .join(",\n");

    if (!values) continue;

    const rows = batch.map((inst) => {
      const breakdownJson = JSON.stringify(inst.breakdown);
      return Prisma.sql`(
        ${inst.id}::uuid,
        ${inst.score},
        ${breakdownJson}::jsonb,
        ${now.toISOString()}::timestamptz,
        ${inst.nextRank},
        ${inst.isImputed},
        ${SCORE_VERSION}
      )`;
    });

    await prisma.$executeRaw`
      UPDATE instructors AS t SET
        score = v.score,
        score_breakdown = v.breakdown,
        score_calculated_at = v.calculated_at,
        rank = v.rank,
        satisfaction_is_imputed = v.is_imputed,
        score_policy_version = v.policy_version
      FROM (VALUES ${Prisma.join(rows)})
        AS v(id, score, breakdown, calculated_at, rank, is_imputed, policy_version)
      WHERE t.id = v.id
    `;
  }
  timings.writeScoresMs = Date.now() - writeScoresStartedAt;

  if (validateIssues) {
    const validationStartedAt = Date.now();
    await recordValidationIssues(validationCandidates, options?.runId ?? null);
    timings.validationMs = Date.now() - validationStartedAt;
  }
  return {
    updatedInstructors: changedRows.length,
    totalInstructors: scored.length,
    timings,
  };
}
