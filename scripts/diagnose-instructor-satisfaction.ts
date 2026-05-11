/**
 * diagnose-instructor-satisfaction.ts — 특정 강사의 만족도 데이터 흐름 진단 (read-only)
 *
 * 사용: node ... ./scripts/diagnose-instructor-satisfaction.ts <name1> <name2> ...
 *
 * 출력 (강사별):
 *   - Instructor 캐시 (satisfactionCount/Avg, totalCourses)
 *   - 강의 회사/과정 목록 (어떤 시트와 매칭되어야 하는지 추정)
 *   - SatisfactionRecord (실제 매칭된 점수)
 *   - SatisfactionImportItem (raw item 후보 — candidateName 또는 companyName/courseName 매칭)
 *   - SatisfactionReviewRegistry (auto_accepted vs pending vs invalid)
 */
import { prisma } from "@/lib/prisma";

const names = process.argv.slice(2).filter(Boolean);
if (names.length === 0) {
  console.error("Usage: <name1> <name2> ...");
  process.exit(1);
}

for (const name of names) {
  console.log(`\n========================================`);
  console.log(`강사: ${name}`);
  console.log(`========================================`);

  const inst = await prisma.instructor.findUnique({
    where: { name },
    select: {
      id: true,
      name: true,
      isPracticeCoach: true,
      isFulltime: true,
      satisfactionAvg: true,
      satisfactionCount: true,
      totalCourses: true,
      contractSheetRows: true,
    },
  });
  if (!inst) {
    console.log(`❌ Instructor 미존재 (이름 표기 차이?)`);
    continue;
  }
  const role = inst.isPracticeCoach ? "실습코치" : inst.isFulltime ? "전임" : "정규";
  console.log(
    `  meta: ${role} | totalCourses=${inst.totalCourses} | satisfactionAvg=${inst.satisfactionAvg ?? "—"} | satisfactionCount=${inst.satisfactionCount}`
  );

  // 강의 회사/과정 목록
  const ths = await prisma.teachingHistory.findMany({
    where: { instructorDbId: inst.id },
    select: {
      companyName: true,
      courseName: true,
      courseId: true,
      startDate: true,
      endDate: true,
    },
    orderBy: { startDate: "desc" },
  });
  console.log(`\n  [TeachingHistory] ${ths.length}건 (최근 5건)`);
  const companies = new Set<string>();
  for (const t of ths.slice(0, 5)) {
    if (t.companyName) companies.add(t.companyName);
    console.log(
      `    - ${t.companyName ?? "—"} / ${(t.courseName ?? "—").slice(0, 35)} / ${t.startDate?.toISOString().slice(0, 10) ?? "—"}~${t.endDate?.toISOString().slice(0, 10) ?? "—"}`
    );
  }
  for (const t of ths) {
    if (t.companyName) companies.add(t.companyName);
  }
  console.log(`  진행 회사 unique: [${Array.from(companies).slice(0, 5).join(", ")}]${companies.size > 5 ? ` 외 ${companies.size - 5}` : ""}`);

  // SatisfactionRecord
  const records = await prisma.satisfactionRecord.findMany({
    where: { instructorDbId: inst.id },
    select: {
      score: true,
      companyName: true,
      courseName: true,
      responseDate: true,
      respondentCount: true,
      sourceType: true,
      sourceRef: true,
    },
    orderBy: { responseDate: "desc" },
  });
  console.log(`\n  [SatisfactionRecord] ${records.length}건`);
  for (const r of records) {
    const sourceRef = r.sourceRef as Record<string, unknown> | null;
    const refKey = (sourceRef?.registry_key as string | undefined)?.slice(0, 30) ?? "—";
    console.log(
      `    - ${r.score} | ${r.companyName ?? "—"} | ${(r.courseName ?? "—").slice(0, 30)} | ${r.responseDate?.toISOString().slice(0, 10) ?? "—"} | n=${r.respondentCount ?? "—"} | ${r.sourceType} | ${refKey}`
    );
  }

  // SatisfactionImportItem 후보 (candidateName 또는 강사 진행 회사 일치)
  const candidateCompanies = Array.from(companies);
  const importItems = await prisma.satisfactionImportItem.findMany({
    where: {
      OR: [
        { candidateName: name },
        ...(candidateCompanies.length > 0 ? [{ candidateCompanyName: { in: candidateCompanies } }] : []),
      ],
    },
    select: {
      candidateName: true,
      candidateCompanyName: true,
      candidateCourseName: true,
      scoreNormalized: true,
      responseDate: true,
      sourceType: true,
      sourceRef: true,
      normalizedPayload: true,
    },
  });
  console.log(`\n  [SatisfactionImportItem 후보] ${importItems.length}건 (candidateName=${name} OR companyName in 강의회사)`);
  // candidateName 매칭만 분리
  const byName = importItems.filter((i) => i.candidateName === name);
  const byCompany = importItems.filter((i) => i.candidateName !== name);
  console.log(`    candidateName=${name}: ${byName.length}건`);
  console.log(`    회사만 일치: ${byCompany.length}건`);
  for (const it of byName.slice(0, 5)) {
    console.log(
      `    [N] ${it.scoreNormalized ?? "—"} | ${it.candidateCompanyName ?? "—"} | ${(it.candidateCourseName ?? "—").slice(0, 25)} | ${it.responseDate?.toISOString().slice(0, 10) ?? "—"} | ${it.sourceType}`
    );
  }
  for (const it of byCompany.slice(0, 5)) {
    console.log(
      `    [C] candidate=${it.candidateName ?? "—"} | ${it.candidateCompanyName ?? "—"} | ${(it.candidateCourseName ?? "—").slice(0, 25)} | ${it.scoreNormalized ?? "—"} | ${it.responseDate?.toISOString().slice(0, 10) ?? "—"}`
    );
  }

  // SatisfactionReviewRegistry: 매칭 status
  const registries = await prisma.satisfactionReviewRegistry.findMany({
    where: {
      OR: [
        { resolvedInstructorId: inst.id },
        { suggestedInstructorId: inst.id },
        { candidateName: name },
      ],
    },
    select: {
      candidateName: true,
      companyName: true,
      courseName: true,
      avgScore: true,
      responseCount: true,
      matchStatus: true,
      resolvedInstructorId: true,
      resolutionBasis: true,
    },
  });
  console.log(`\n  [SatisfactionReviewRegistry] ${registries.length}건`);
  const byStatus: Record<string, number> = {};
  for (const r of registries) {
    byStatus[r.matchStatus] = (byStatus[r.matchStatus] ?? 0) + 1;
  }
  console.log(`    by status: ${JSON.stringify(byStatus)}`);
  for (const r of registries.slice(0, 8)) {
    console.log(
      `    - ${r.matchStatus} | ${r.candidateName ?? "—"} | ${r.companyName ?? "—"} | ${(r.courseName ?? "—").slice(0, 30)} | avg=${r.avgScore ?? "—"} count=${r.responseCount} basis=${r.resolutionBasis ?? "—"}`
    );
  }
}

await prisma.$disconnect();
