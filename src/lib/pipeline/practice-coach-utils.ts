export const PRACTICE_COACH_KEYWORDS = [
  "보조강사",
  "코치",
  "실습코치",
  "멘토",
  "문항개발",
] as const;

export interface PracticeCoachHistoryLike {
  contractType?: string | null;
  detailType?: string | null;
  specialNotes?: string | null;
}

export function containsPracticeCoachKeyword(
  value: string | null | undefined
): boolean {
  if (!value) return false;
  return PRACTICE_COACH_KEYWORDS.some((keyword) => value.includes(keyword));
}

export function isPracticeCoachHistory(
  history: PracticeCoachHistoryLike
): boolean {
  return (
    containsPracticeCoachKeyword(history.contractType) ||
    containsPracticeCoachKeyword(history.detailType) ||
    containsPracticeCoachKeyword(history.specialNotes)
  );
}

export function isPracticeCoachCandidate(
  histories: PracticeCoachHistoryLike[]
): boolean {
  if (histories.length === 0) return false;

  const coachCount = histories.filter(isPracticeCoachHistory).length;
  const regularCount = histories.length - coachCount;

  return coachCount > regularCount;
}
