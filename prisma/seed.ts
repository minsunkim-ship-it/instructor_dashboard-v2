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
 * score_policy_versions v1 초기 데이터 — 03_data_model.md 5-4절
 *
 * - version: "v1"
 * - weights: 01_core_policy.md 9절 기준
 * - missing_satisfaction_policy: "median" (01_core_policy 9절: 전체 수집 강사의 중앙값으로 대체)
 * - recency_decay_days: 180 (03_data_model.md 5-4 기본값)
 * - active: true
 *
 * 중복 생성 방지: version="v1" row가 이미 있으면 skip.
 */
async function seedScorePolicy() {
  const existing = await prisma.scorePolicyVersion.findFirst({
    where: { version: "v1" },
  });

  if (existing) {
    console.log(`score_policy_versions v1 already exists (id: ${existing.id}), skipping`);
    return;
  }

  await prisma.scorePolicyVersion.create({
    data: {
      version: "v1",
      weights: {
        courses: 35,
        satisfaction: 15,
        slack: 15,
        recency: 15,
        salesmap: 10,
        email: 5,
        ops_channel: 5,
      },
      missingSatisfactionPolicy: "median",
      recencyDecayDays: 180,
      active: true,
    },
  });

  console.log("Seeded score_policy_versions v1");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
