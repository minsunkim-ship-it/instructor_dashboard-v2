/**
 * verify-park-sanghoon-e2e.ts — Phase D-1 박상훈 대표 케이스 검증
 *
 * 박상훈은 동국홀딩스/동국제강 그룹 _ 2026 DK AI 역량강화 아카데미 다중 강사 과정의 일부 강사.
 * Phase B+C가 정상 작동하면:
 *   1. dongkuk_steel_dk_ai_2026_03_6 (Basic-6차수) → buildGenericGoogleFormsDraftItems
 *   2. resolveInstructorByCourseAndDate L1 매칭 → 박상훈 + 다른 강사들 모두에 분배
 *   3. SatisfactionRecord 생성 (instructorDbId = 박상훈 id, 다른 강사 id)
 *
 * 산출:
 *   - reports/park-sanghoon-e2e.md
 *   - 콘솔에 PASS/FAIL
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import {
  countGroupedTeachingHistories,
  type TeachingHistoryDisplayItem,
} from "@/lib/teaching-history-display";

async function main() {
  const inst = await prisma.instructor.findUnique({
    where: { name: "박상훈" },
    select: {
      id: true,
      name: true,
      isPracticeCoach: true,
      isFulltime: true,
      satisfactionAvg: true,
      satisfactionCount: true,
      totalCourses: true,
    },
  });
  if (!inst) {
    console.error("박상훈 강사 미존재");
    process.exit(1);
  }

  const ths = await prisma.teachingHistory.findMany({
    where: {
      instructorDbId: inst.id,
      OR: [
        { companyName: { contains: "동국" } },
        { courseName: { contains: "DK AI" } },
        { courseName: { contains: "AI 역량강화" } },
      ],
    },
    select: {
      id: true,
      companyName: true,
      courseName: true,
      courseId: true,
      startDate: true,
      endDate: true,
      detailType: true,
      dealFeeHourly: true,
    },
    orderBy: { startDate: "asc" },
  });

  const records = await prisma.satisfactionRecord.findMany({
    where: { instructorDbId: inst.id },
    select: {
      id: true,
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

  const dongkukRecords = records.filter(
    (r) =>
      (r.companyName ?? "").includes("동국") ||
      (r.courseName ?? "").includes("DK AI") ||
      (r.courseName ?? "").includes("AI 역량강화")
  );

  const importItems = await prisma.satisfactionImportItem.count({
    where: {
      OR: [
        { candidateCompanyName: { contains: "동국" } },
        { candidateCourseName: { contains: "DK AI" } },
        { candidateCourseName: { contains: "AI 역량강화" } },
      ],
    },
  });

  const passes: string[] = [];
  const fails: string[] = [];

  if (ths.length > 0) passes.push(`동국 관련 teaching_history ${ths.length}건`);
  else fails.push(`동국 관련 teaching_history 0건 — Phase G/박상훈 동국홀딩스 회복 회귀 의심`);

  if (importItems > 0) passes.push(`동국 SatisfactionImportItem ${importItems}건`);
  else fails.push(`동국 SatisfactionImportItem 0건 — Phase B 파서 미실행 또는 시트 read 실패`);

  if (dongkukRecords.length > 0)
    passes.push(`박상훈 동국 SatisfactionRecord ${dongkukRecords.length}건`);
  else
    fails.push(
      `박상훈 동국 SatisfactionRecord 0건 — Phase C 매칭 실패 또는 fan-out 미작동`
    );

  if (inst.satisfactionCount > 0)
    passes.push(`박상훈 satisfactionCount=${inst.satisfactionCount}`);
  else fails.push(`박상훈 satisfactionCount=0 — recalculate 미실행 의심`);

  // totalCourses 캐시 + 실제 dedupe 결과 둘 다 확인 (refresh 미반영 가능성)
  const allTh = await prisma.teachingHistory.findMany({
    where: { instructorDbId: inst.id },
  });
  const items: TeachingHistoryDisplayItem[] = allTh.map((t) => ({
    course_name: t.courseName,
    company_name: t.companyName,
    course_id: t.courseId,
    deal_fee_hourly: t.dealFeeHourly,
    contract_type: t.contractType,
    detail_type: t.detailType,
    fee_extra: t.feeExtra,
    special_notes: t.specialNotes,
    start_date: t.startDate?.toISOString() ?? null,
    end_date: t.endDate?.toISOString() ?? null,
    total_sessions: t.totalSessions,
    total_hours: t.totalHours ? Number(t.totalHours) : null,
  }));
  const liveCount = countGroupedTeachingHistories(items);
  if (liveCount >= 3)
    passes.push(`박상훈 dedupe 결과 ${liveCount}개 group (동국홀딩스 회복 패치 정상)`);
  else fails.push(`박상훈 dedupe 결과 ${liveCount}개 group — 회복 패치 회귀 의심`);

  if (inst.totalCourses < liveCount) {
    passes.push(
      `박상훈 totalCourses 캐시(${inst.totalCourses}) < live(${liveCount}) — refresh 필요`
    );
  }

  const md: string[] = [];
  md.push("# 박상훈 동국홀딩스 E2E 검증 (Phase D-1)");
  md.push(`Generated at: ${new Date().toISOString()}`);
  md.push("");
  md.push("## 강사 메타");
  md.push(`- name: ${inst.name}`);
  md.push(`- role: ${inst.isPracticeCoach ? "실습코치" : inst.isFulltime ? "전임" : "정규"}`);
  md.push(`- satisfactionAvg: ${inst.satisfactionAvg ?? "—"}`);
  md.push(`- satisfactionCount: ${inst.satisfactionCount}`);
  md.push(`- totalCourses: ${inst.totalCourses}`);
  md.push("");

  md.push("## 동국 관련 teaching_history");
  if (ths.length === 0) {
    md.push("(0건)");
  } else {
    md.push("| companyName | courseName | courseId | start | end | detail | fee |");
    md.push("|---|---|---|---|---|---|---|");
    for (const t of ths.slice(0, 10)) {
      md.push(
        `| ${t.companyName ?? "—"} | ${(t.courseName ?? "—").slice(0, 30)} | ${t.courseId ?? "—"} | ${t.startDate?.toISOString().slice(0, 10) ?? "—"} | ${t.endDate?.toISOString().slice(0, 10) ?? "—"} | ${(t.detailType ?? "—").slice(0, 20)} | ${t.dealFeeHourly ?? "—"} |`
      );
    }
  }
  md.push("");

  md.push("## 동국 SatisfactionRecord");
  if (dongkukRecords.length === 0) {
    md.push("(0건)");
  } else {
    md.push("| score | company | course | responseDate | respondents | sourceType |");
    md.push("|---|---|---|---|---|---|");
    for (const r of dongkukRecords.slice(0, 10)) {
      md.push(
        `| ${r.score} | ${r.companyName ?? "—"} | ${(r.courseName ?? "—").slice(0, 30)} | ${r.responseDate?.toISOString().slice(0, 10) ?? "—"} | ${r.respondentCount ?? "—"} | ${r.sourceType} |`
      );
    }
  }
  md.push("");

  md.push("## 검증 결과");
  md.push(`### ✅ PASS (${passes.length})`);
  for (const p of passes) md.push(`- ${p}`);
  md.push("");
  md.push(`### ❌ FAIL (${fails.length})`);
  for (const f of fails) md.push(`- ${f}`);
  md.push("");

  const overall = fails.length === 0 ? "PASS" : "FAIL";
  md.push(`## 종합: **${overall}**`);

  const reportDir = path.resolve(process.cwd(), "reports");
  await mkdir(reportDir, { recursive: true });
  const mdPath = path.join(reportDir, "park-sanghoon-e2e.md");
  await writeFile(mdPath, md.join("\n"), "utf-8");

  console.log(`종합: ${overall}`);
  console.log(`PASS: ${passes.length}, FAIL: ${fails.length}`);
  for (const f of fails) console.log(`  ❌ ${f}`);
  console.log(`Saved: ${mdPath}`);

  if (fails.length > 0) process.exit(1);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
