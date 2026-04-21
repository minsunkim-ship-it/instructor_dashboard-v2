export interface InstructorListVisibilityCandidate {
  flag?: string | null;
  isPracticeCoach?: boolean | null;
  is_practice_coach?: boolean | null;
}

export function shouldIncludeInInstructorList(
  candidate: InstructorListVisibilityCandidate
): boolean {
  const normalizedFlag = candidate.flag?.trim() ?? null;

  return (
    normalizedFlag !== "실습코치" &&
    candidate.isPracticeCoach !== true &&
    candidate.is_practice_coach !== true
  );
}
