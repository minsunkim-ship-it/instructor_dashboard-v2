import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/**
 * 기본 seed — 설정성 초기 데이터만 처리한다.
 * mock 강사 데이터는 포함하지 않는다.
 */
async function main() {
  await seedScorePolicy();
}

/**
 * score_policy_versions v3 초기 데이터 — demo parity 메타데이터
 *
 * - version: "v3"
 * - weights: instructor_db_demo Engagement Score v3 기준
 * - missing_satisfaction_policy: "median_or_4.0"
 * - recency_decay_days: 180
 * - active: true
 *
 * 주의: 실제 계산 로직은 demo parity를 코드로 직접 구현한다.
 * 이 row는 운영 메타데이터/표시용 기준점으로 유지한다.
 */
async function seedScorePolicy() {
  const existing = await prisma.scorePolicyVersion.findFirst({
    where: { version: "v3" },
  });

  if (existing) {
    console.log(
      `score_policy_versions v3 already exists (id: ${existing.id}), syncing active flag`
    );
    await prisma.scorePolicyVersion.updateMany({
      where: { version: "v3" },
      data: { active: true },
    });
    return;
  }

  await prisma.scorePolicyVersion.updateMany({
    data: { active: false },
  });

  await prisma.scorePolicyVersion.create({
    data: {
      version: "v3",
      weights: {
        courses: 35,
        satisfaction: 15,
        slack: 15,
        recency: 15,
        salesmap: 10,
        email: 5,
        ops_channel: 5,
      },
      missingSatisfactionPolicy: "median_or_4.0",
      recencyDecayDays: 180,
      active: true,
    },
  });

  console.log("Seeded score_policy_versions v3");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
