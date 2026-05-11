/**
 * trigger-score-recalc.ts — 모든 강사의 score/totalCourses 캐시 갱신
 *
 * 박상훈 patch + Phase E NULL 보강이 dedupe count에 반영되도록 totalCourses 캐시 갱신.
 */
import { recalculateAllScores } from "@/lib/score-recalculator";

const result = await recalculateAllScores({
  runId: undefined,
  validateIssues: false,
});

console.log("Score recalc done:");
console.log(`  updated instructors: ${result.updatedInstructors}`);
console.log(`  totals: instructors=${result.totals.instructors}, regularInstructors=${result.totals.regularInstructors}`);
console.log(`  timings(ms): instructors=${result.timings.loadInstructorsMs} stats=${result.timings.loadActivityStatsMs} thCounts=${result.timings.loadTeachingHistoryCountsMs} score=${result.timings.scoringMs} write=${result.timings.writeScoresMs}`);
