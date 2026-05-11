/**
 * check-dongkuk-candidates.ts — 박상훈/공지연/최진영B 정규 강사인지 확인 (read-only)
 */
import { prisma } from "@/lib/prisma";

async function main() {
  const names = ["박상훈", "공지연", "최진영B", "최진영"];
  const records = await prisma.instructor.findMany({
    where: { name: { in: names } },
    select: {
      id: true,
      name: true,
      isPracticeCoach: true,
      isFulltime: true,
      satisfactionCount: true,
      totalCourses: true,
    },
  });

  for (const r of records) {
    const role = r.isPracticeCoach ? "실습코치" : r.isFulltime ? "전임" : "정규";
    console.log(`${r.name}: ${role} | courses=${r.totalCourses} | satisfaction=${r.satisfactionCount}`);
  }

  const missing = names.filter((n) => !records.find((r) => r.name === n));
  if (missing.length > 0) {
    console.log(`\nMissing in DB: ${missing.join(", ")}`);
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
