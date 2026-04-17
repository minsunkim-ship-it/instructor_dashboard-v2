import { prisma } from "@/lib/prisma";

const PRACTICE_COACH_KEYWORDS = ["보조강사", "코치", "실습코치", "멘토", "문항개발"];

export interface PracticeCoachResult {
  detected: number;
  protectedByFee: number;
  protectedByFulltime: number;
  updated: number;
}

function matchesKeyword(value: string | null): boolean {
  if (!value) return false;
  return PRACTICE_COACH_KEYWORDS.some((kw) => value.includes(kw));
}

export async function detectPracticeCoaches(): Promise<PracticeCoachResult> {
  const instructors = await prisma.instructor.findMany({
    select: {
      id: true,
      isFulltime: true,
      baseFeeHourly: true,
      categories: true,
      specialties: true,
      teachingHistories: {
        select: {
          contractType: true,
          detailType: true,
        },
      },
    },
  });

  const result: PracticeCoachResult = {
    detected: 0,
    protectedByFee: 0,
    protectedByFulltime: 0,
    updated: 0,
  };

  const practiceCoachIds: string[] = [];
  const nonPracticeCoachIds: string[] = [];

  for (const inst of instructors) {
    const histories = inst.teachingHistories;

    // L1: Candidate Detection
    if (histories.length === 0) {
      nonPracticeCoachIds.push(inst.id);
      continue;
    }

    // L1: docs/01 §10 — keyword 건수 vs 정규강사 건수 단순 수치 비교.
    // clarify-result: "보조 2, 정규 3 → 후보 아님" 예시에 맞춰 동률은 후보 아님.
    const matchCount = histories.filter(
      (h) => matchesKeyword(h.contractType) || matchesKeyword(h.detailType)
    ).length;
    const regularCount = histories.length - matchCount;

    if (matchCount <= regularCount) {
      nonPracticeCoachIds.push(inst.id);
      continue;
    }

    result.detected++;

    // L3: Fulltime Protection (unconditional)
    if (inst.isFulltime) {
      result.protectedByFulltime++;
      nonPracticeCoachIds.push(inst.id);
      continue;
    }

    // L2: Regular Instructor Protection
    if (
      inst.baseFeeHourly !== null &&
      inst.baseFeeHourly >= 100000 &&
      inst.categories.length > 0 &&
      inst.specialties.length > 0
    ) {
      result.protectedByFee++;
      nonPracticeCoachIds.push(inst.id);
      continue;
    }

    practiceCoachIds.push(inst.id);
  }

  const BATCH_SIZE = 500;

  await prisma.$transaction(async (tx) => {
    for (let i = 0; i < practiceCoachIds.length; i += BATCH_SIZE) {
      const batch = practiceCoachIds.slice(i, i + BATCH_SIZE);
      await tx.instructor.updateMany({
        where: { id: { in: batch } },
        data: { isPracticeCoach: true },
      });
    }

    for (let i = 0; i < nonPracticeCoachIds.length; i += BATCH_SIZE) {
      const batch = nonPracticeCoachIds.slice(i, i + BATCH_SIZE);
      await tx.instructor.updateMany({
        where: { id: { in: batch } },
        data: { isPracticeCoach: false },
      });
    }
  });

  result.updated = practiceCoachIds.length + nonPracticeCoachIds.length;

  return result;
}
