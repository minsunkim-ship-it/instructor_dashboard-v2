/**
 * Salesmap Applier — Pilot 4-3
 *
 * 04_data_pipeline.md 4-3절, 5-3절, 5-3-1절, 7-1절, 9절, 12절
 *
 * 파일럿 적용 규칙 (사용자 지시 + 문서 계약):
 * - 세일즈맵 단독으로 새 강사를 생성하지 않는다. `instructors.name` exact match 되는 기존 강사만 보강한다.
 * - `base_fee_hourly` 는 오염시키지 않는다. 세일즈맵 강사료는 hourly-interpretable 후보 건수만 집계한다.
 * - `teaching_histories` 는 새로 생성하지 않는다. 기존 행 중 `(instructor_db_id, course_id)` 가 매칭되고
 *   `company_name` 또는 `course_name` 이 NULL 인 행만 보강한다.
 * - `instructors.last_activity_at` 은 세일즈맵 강사별 최신 활동일이 기존 값보다 더 최근일 때만 갱신한다.
 */

import { prisma } from "@/lib/prisma";
import type { NormalizedSalesmapRow } from "./salesmap-normalizer";

const DB_WRITE_CONCURRENCY = 16;

export interface SalesmapApplyResult {
  dealsFetched: number;
  slotRowsNormalized: number;

  /** 세일즈맵 강사명 → 기존 instructors 매칭 (distinct 강사 수) */
  instructorsMatched: number;
  /** 매칭 실패한 고유 강사명 개수 (새 강사 생성하지 않고 skip) */
  instructorsUnmatched: number;

  /** last_activity_at 이 실제로 갱신된 강사 수 */
  lastActivityUpdated: number;

  /** teaching_histories 중 company_name 을 보강한 행 수 */
  teachingHistoriesCompanyFilled: number;
  /** teaching_histories 중 course_name 을 보강한 행 수 */
  teachingHistoriesCourseNameFilled: number;
  /** teaching_histories 보강 대상이었으나 (instructor, course_id) 매칭 실패로 건너뛴 세일즈맵 slot 수 */
  teachingHistoriesUnmatched: number;

  /** 시간당 단가로 해석 가능한 강사료 후보 slot 수 (DB 에 반영하지 않고 집계만) */
  hourlyFeeCandidates: number;
  /** 강사료가 있었으나 hourly 로 해석되지 않은 slot 수 (총액/특수 금액 가드 적중) */
  nonHourlyFeeValues: number;

  unmatchedInstructorSamples: string[];
}

async function mapWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;
  const safeConcurrency = Math.max(1, Math.min(concurrency, items.length));
  let index = 0;

  async function runWorker() {
    while (true) {
      const current = index;
      index += 1;
      if (current >= items.length) break;
      await worker(items[current]);
    }
  }

  await Promise.all(
    Array.from({ length: safeConcurrency }, () => runWorker())
  );
}

/**
 * 세일즈맵 정규화 rows 를 현재 DB 에 적용한다.
 */
export async function applySalesmapRows(
  dealsFetched: number,
  rows: NormalizedSalesmapRow[]
): Promise<SalesmapApplyResult> {
  const result: SalesmapApplyResult = {
    dealsFetched,
    slotRowsNormalized: rows.length,
    instructorsMatched: 0,
    instructorsUnmatched: 0,
    lastActivityUpdated: 0,
    teachingHistoriesCompanyFilled: 0,
    teachingHistoriesCourseNameFilled: 0,
    teachingHistoriesUnmatched: 0,
    hourlyFeeCandidates: 0,
    nonHourlyFeeValues: 0,
    unmatchedInstructorSamples: [],
  };

  // 1) instructors name → id 맵 (exact match). 01_core_policy 4절.
  const allInstructors = await prisma.instructor.findMany({
    select: { id: true, name: true, lastActivityAt: true },
  });
  const nameToInstructor = new Map<
    string,
    { id: string; lastActivityAt: Date | null }
  >();
  for (const inst of allInstructors) {
    nameToInstructor.set(inst.name, {
      id: inst.id,
      lastActivityAt: inst.lastActivityAt,
    });
  }

  // 2) 강사별로 row 그룹화 + 매칭/미매칭 집계
  //    동시에 fee 후보, last_activity_at max 계산
  interface PerInstructorAgg {
    instructorId: string;
    currentLastActivity: Date | null;
    maxSalesmapActivity: Date | null;
    // teaching_histories 보강 후보: (course_id) 별 세일즈맵 값
    courseFills: Map<
      string,
      { companyName: string | null; courseName: string | null }
    >;
  }
  const perInstructor = new Map<string, PerInstructorAgg>();
  const unmatchedNames = new Set<string>();
  // teaching_histories 매칭 대상이었으나 course_id 가 없거나 instructor 가 매칭 안 된 slot 수 집계
  let thUnmatchedSlots = 0;

  for (const row of rows) {
    if (row.feeRaw) {
      if (row.hourlyFeeCandidate !== null) {
        result.hourlyFeeCandidates += 1;
      } else {
        result.nonHourlyFeeValues += 1;
      }
    }

    const name = row.instructorName;
    if (!name) continue;

    const matched = nameToInstructor.get(name);
    if (!matched) {
      unmatchedNames.add(name);
      // course_id 있어도 instructor 매칭 실패면 teaching_histories 보강 불가
      if (row.courseId) thUnmatchedSlots += 1;
      continue;
    }

    let agg = perInstructor.get(matched.id);
    if (!agg) {
      agg = {
        instructorId: matched.id,
        currentLastActivity: matched.lastActivityAt,
        maxSalesmapActivity: null,
        courseFills: new Map(),
      };
      perInstructor.set(matched.id, agg);
    }

    if (row.lastActivityAt) {
      if (
        !agg.maxSalesmapActivity ||
        row.lastActivityAt > agg.maxSalesmapActivity
      ) {
        agg.maxSalesmapActivity = row.lastActivityAt;
      }
    }

    if (row.courseId) {
      const key = row.courseId;
      const existing = agg.courseFills.get(key);
      if (!existing) {
        agg.courseFills.set(key, {
          companyName: row.companyName,
          courseName: row.courseName,
        });
      } else {
        // 동일 course_id 가 여러 deal 에서 등장하면 먼저 채워진 값을 유지하되
        // null 이던 필드는 새 값으로 보완 (세일즈맵 내부 분산 가드)
        if (!existing.companyName && row.companyName) {
          existing.companyName = row.companyName;
        }
        if (!existing.courseName && row.courseName) {
          existing.courseName = row.courseName;
        }
      }
    }
  }

  result.instructorsMatched = perInstructor.size;
  result.instructorsUnmatched = unmatchedNames.size;
  result.unmatchedInstructorSamples = Array.from(unmatchedNames).slice(0, 10);

  // 3) instructors.last_activity_at 갱신 — 기존값이 없거나 세일즈맵이 더 최근일 때만
  const instructorUpdates = Array.from(perInstructor.values()).filter((agg) => {
    if (!agg.maxSalesmapActivity) return false;
    return (
      !agg.currentLastActivity ||
      agg.maxSalesmapActivity > agg.currentLastActivity
    );
  });

  await mapWithConcurrency(
    instructorUpdates,
    DB_WRITE_CONCURRENCY,
    async (agg) => {
      await prisma.instructor.update({
        where: { id: agg.instructorId },
        data: { lastActivityAt: agg.maxSalesmapActivity },
      });
      result.lastActivityUpdated += 1;
    }
  );

  // 4) teaching_histories 보강 — 필요한 후보를 먼저 전부 읽고, 업데이트만 제한 병렬로 수행
  const instructorIdsWithCourseFills = Array.from(perInstructor.values())
    .filter((agg) => agg.courseFills.size > 0)
    .map((agg) => agg.instructorId);
  const targetCourseIds = Array.from(
    new Set(
      Array.from(perInstructor.values()).flatMap((agg) =>
        Array.from(agg.courseFills.keys())
      )
    )
  );

  const existingHistories =
    instructorIdsWithCourseFills.length === 0 || targetCourseIds.length === 0
      ? []
      : await prisma.teachingHistory.findMany({
          where: {
            instructorDbId: { in: instructorIdsWithCourseFills },
            courseId: { in: targetCourseIds },
          },
          select: {
            id: true,
            instructorDbId: true,
            courseId: true,
            companyName: true,
            courseName: true,
          },
        });

  const historiesByPair = new Map<
    string,
    Array<{
      id: string;
      companyName: string | null;
      courseName: string | null;
    }>
  >();
  for (const history of existingHistories) {
    const key = `${history.instructorDbId}::${history.courseId}`;
    const arr = historiesByPair.get(key);
    const entry = {
      id: history.id,
      companyName: history.companyName,
      courseName: history.courseName,
    };
    if (arr) {
      arr.push(entry);
    } else {
      historiesByPair.set(key, [entry]);
    }
  }

  type HistoryUpdateTask = {
    historyId: string;
    data: { companyName?: string; courseName?: string };
  };
  const historyUpdateTasks: HistoryUpdateTask[] = [];

  for (const agg of perInstructor.values()) {
    if (agg.courseFills.size === 0) continue;
    for (const [courseId, fill] of agg.courseFills) {
      const key = `${agg.instructorId}::${courseId}`;
      const targets = historiesByPair.get(key);

      if (!targets || targets.length === 0) {
        thUnmatchedSlots += 1;
        continue;
      }

      for (const target of targets) {
        const data: { companyName?: string; courseName?: string } = {};
        if (fill.companyName && !target.companyName) {
          data.companyName = fill.companyName;
        }
        if (fill.courseName && !target.courseName) {
          data.courseName = fill.courseName;
        }
        if (Object.keys(data).length === 0) continue;

        historyUpdateTasks.push({
          historyId: target.id,
          data,
        });
      }
    }
  }

  await mapWithConcurrency(
    historyUpdateTasks,
    DB_WRITE_CONCURRENCY,
    async (task) => {
      await prisma.teachingHistory.update({
        where: { id: task.historyId },
        data: task.data,
      });
      if (task.data.companyName) result.teachingHistoriesCompanyFilled += 1;
      if (task.data.courseName) result.teachingHistoriesCourseNameFilled += 1;
    }
  );

  result.teachingHistoriesUnmatched = thUnmatchedSlots;

  return result;
}
