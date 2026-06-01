export interface InstructorListVisibilityCandidate {
  flag?: string | null;
  isPracticeCoach?: boolean | null;
  is_practice_coach?: boolean | null;
  isDataInsufficient?: boolean | null;
  is_data_insufficient?: boolean | null;
}

export function shouldIncludeInInstructorList(
  candidate: InstructorListVisibilityCandidate
): boolean {
  const normalizedFlag = candidate.flag?.trim() ?? null;

  if (normalizedFlag === "실습코치") return false;
  if (candidate.isPracticeCoach === true) return false;
  if (candidate.is_practice_coach === true) return false;

  // 데이터 부족 강사 hide (이은지 13위 root cause).
  // score-recalculator가 contractCount=0 + satisfactionCount=0 + totalCourses=0인 강사에
  // isDataInsufficient=true 를 write. list에서 제외하여 evidence 없는 강사가
  // satisfaction median imputation 같은 약한 신호로 rank 부여받는 결함 방지.
  // 단일 게이트(live + fallback 공통)이므로 두 경로 모두 자동 hide.
  if (candidate.isDataInsufficient === true) return false;
  if (candidate.is_data_insufficient === true) return false;

  return true;
}
