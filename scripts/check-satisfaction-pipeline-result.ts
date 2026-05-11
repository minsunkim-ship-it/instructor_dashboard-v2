/**
 * check-satisfaction-pipeline-result.ts — 파이프라인 실행 결과 즉시 검증 (read-only)
 *
 * 박상훈/공지연/최진영B 강사의 satisfaction 상태 + 동국제강 ImportItem/Record 카운트
 */
import { prisma } from "@/lib/prisma";

async function main() {
  const targets = ["박상훈", "공지연", "최진영B", "최진영"];
  const records = await prisma.instructor.findMany({
    where: { name: { in: targets } },
    select: {
      id: true,
      name: true,
      satisfactionAvg: true,
      satisfactionCount: true,
    },
  });

  console.log("=== 강사별 만족도 ===");
  for (const r of records) {
    console.log(`${r.name}: avg=${r.satisfactionAvg ?? "—"}, count=${r.satisfactionCount}`);
  }

  // 동국 ImportItem
  const dongkukImports = await prisma.satisfactionImportItem.count({
    where: {
      OR: [
        { candidateCompanyName: { contains: "동국" } },
        { candidateCourseName: { contains: "DK AI" } },
      ],
    },
  });
  console.log(`\n동국 SatisfactionImportItem: ${dongkukImports}건`);

  // 동국 ReviewRegistry
  const dongkukRegistries = await prisma.satisfactionReviewRegistry.findMany({
    where: {
      OR: [
        { companyName: { contains: "동국" } },
        { courseName: { contains: "DK AI" } },
      ],
    },
    select: {
      id: true,
      candidateName: true,
      companyName: true,
      courseName: true,
      matchStatus: true,
      avgScore: true,
      responseCount: true,
      resolvedInstructorId: true,
      resolutionBasis: true,
    },
  });
  console.log(`동국 SatisfactionReviewRegistry: ${dongkukRegistries.length}건`);
  for (const r of dongkukRegistries.slice(0, 10)) {
    console.log(
      `  - ${r.candidateName ?? "—"} / ${r.companyName ?? "—"} / ${(r.courseName ?? "—").slice(0, 30)} / status=${r.matchStatus} / avg=${r.avgScore ?? "—"} / count=${r.responseCount} / basis=${r.resolutionBasis ?? "—"}`
    );
  }

  // 동국 SatisfactionRecord
  const dongkukRecords = await prisma.satisfactionRecord.findMany({
    where: {
      OR: [
        { companyName: { contains: "동국" } },
        { courseName: { contains: "DK AI" } },
      ],
    },
    select: {
      id: true,
      score: true,
      companyName: true,
      courseName: true,
      responseDate: true,
      respondentCount: true,
      instructor: { select: { name: true } },
    },
  });
  console.log(`\n동국 SatisfactionRecord: ${dongkukRecords.length}건`);
  const byInstructor = new Map<string, number>();
  for (const r of dongkukRecords) {
    const n = r.instructor.name;
    byInstructor.set(n, (byInstructor.get(n) ?? 0) + 1);
  }
  for (const [name, count] of byInstructor) {
    console.log(`  - ${name}: ${count}건`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
