import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/**
 * Mock 강사 시드 — 파일럿 1 UI 검증용.
 * 실데이터 파일럿에서는 실행하지 않는다.
 * 실행: node --experimental-strip-types prisma/seed.mock.ts
 */
async function main() {
  const instructors = [
    {
      name: "홍길동",
      displayName: "홍길동",
      affiliation: "데이원",
      categories: ["생성형AI"],
      specialties: ["ChatGPT", "업무자동화"],
      rank: 1,
      score: 91.5,
      scoreBreakdown: { courses: 31.2, satisfaction: 13.8, slack: 14.0, recency: 12.9, salesmap: 8.0, email: 4.1, ops_channel: 4.5 },
      totalCourses: 28,
      recentCourses6mo: 6,
      baseFeeHourly: 180000,
      isFulltime: false,
      isPracticeCoach: false,
      satisfactionAvg: 4.6,
      satisfactionCount: 12,
    },
    {
      name: "김영희",
      displayName: "김영희",
      affiliation: "프리랜서",
      categories: ["데이터분석"],
      specialties: ["Python", "데이터시각화", "통계분석"],
      rank: 2,
      score: 85.3,
      scoreBreakdown: { courses: 28.0, satisfaction: 12.5, slack: 12.0, recency: 14.0, salesmap: 9.0, email: 4.8, ops_channel: 5.0 },
      totalCourses: 22,
      recentCourses6mo: 4,
      baseFeeHourly: 200000,
      isFulltime: false,
      isPracticeCoach: false,
      satisfactionAvg: 4.3,
      satisfactionCount: 8,
    },
    {
      name: "이철수",
      displayName: "이철수",
      affiliation: "데이원",
      categories: ["리더십"],
      specialties: ["조직문화", "코칭"],
      rank: 3,
      score: 78.2,
      scoreBreakdown: { courses: 25.0, satisfaction: 11.0, slack: 10.0, recency: 13.0, salesmap: 7.0, email: 3.2, ops_channel: 4.0 },
      totalCourses: 18,
      recentCourses6mo: 3,
      baseFeeHourly: null,
      isFulltime: true,
      isPracticeCoach: false,
      satisfactionAvg: 4.8,
      satisfactionCount: 15,
    },
    {
      name: "박지민",
      displayName: "박지민",
      affiliation: null,
      categories: ["DX"],
      specialties: ["디지털전환"],
      rank: 4,
      score: 65.0,
      scoreBreakdown: { courses: 20.0, satisfaction: 10.0, slack: 8.0, recency: 10.0, salesmap: 6.0, email: 3.0, ops_channel: 3.0 },
      totalCourses: 12,
      recentCourses6mo: 2,
      baseFeeHourly: 150000,
      isFulltime: false,
      isPracticeCoach: false,
      satisfactionAvg: 4.1,
      satisfactionCount: 5,
    },
    {
      name: "최수진",
      displayName: "최수진",
      affiliation: "데이원",
      categories: [],
      specialties: [],
      rank: 5,
      score: 42.1,
      scoreBreakdown: { courses: 12.0, satisfaction: 7.0, slack: 5.0, recency: 8.0, salesmap: 4.0, email: 2.1, ops_channel: 2.0 },
      totalCourses: 7,
      recentCourses6mo: 1,
      baseFeeHourly: 120000,
      isFulltime: false,
      isPracticeCoach: false,
      satisfactionAvg: 3.9,
      satisfactionCount: 3,
    },
  ];

  for (const data of instructors) {
    await prisma.instructor.create({ data });
  }

  console.log(`Seeded ${instructors.length} mock instructors`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
