/**
 * analyze-p2-p4-recovery.ts — P2/P4 자동 회복 시뮬레이션 (read-only, dry-run)
 *
 * P2: 단가 NULL + 같은 courseId의 다른 행에 단가 있음 → 단가 보강 가능
 * P4: 회사/과정 NULL + 같은 courseId의 다른 행에 회사/과정 있음 → NULL 보강 가능
 *
 * 영향 분석:
 *   - 영향 강사 수 + 강의 수
 *   - 보강 가능 vs 보강 후 dedupe 변동
 *   - totalCourses 회복 예상치
 *
 * 산출:
 *   - reports/p2-p4-recovery-simulation.{md,json}
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import {
  countGroupedTeachingHistories,
  type TeachingHistoryDisplayItem,
} from "@/lib/teaching-history-display";
import { isNonTeachingCompensationItem } from "@/lib/teaching-history-kind";

interface ThRow {
  id: string;
  instructorDbId: string;
  companyName: string | null;
  courseName: string | null;
  courseId: string | null;
  startDate: Date | null;
  endDate: Date | null;
  dealFeeHourly: number | null;
  detailType: string | null;
  feeExtra: string | null;
  specialNotes: string | null;
  totalSessions: number | null;
  totalHours: { toString(): string } | null;
  contractType: string | null;
}

interface RecoveryCandidate {
  id: string;
  fix: "fee" | "company" | "course" | "fee+company" | "fee+course" | "all";
  before: { fee: number | null; company: string | null; course: string | null };
  after: { fee: number | null; company: string | null; course: string | null };
  courseId: string;
  donor: { id: string; fee: number | null; company: string | null; course: string | null };
}

async function main() {
  const allTh = (await prisma.teachingHistory.findMany({
    orderBy: { createdAt: "asc" },
  })) as ThRow[];
  console.log(`전체 teaching_histories: ${allTh.length}건`);

  // courseId 기준 lookup — 그룹별 fee/company/course donor 행 식별
  const byCourseId = new Map<string, ThRow[]>();
  for (const r of allTh) {
    if (!r.courseId) continue;
    const list = byCourseId.get(r.courseId) ?? [];
    list.push(r);
    byCourseId.set(r.courseId, list);
  }

  const candidates: RecoveryCandidate[] = [];
  const affectedInstructorIds = new Set<string>();

  for (const r of allTh) {
    if (!r.courseId) continue;
    const isNonTeach = isNonTeachingCompensationItem({
      courseId: r.courseId,
      courseName: r.courseName,
      dealFeeHourly: r.dealFeeHourly,
      feeExtra: r.feeExtra,
      detailType: r.detailType,
      specialNotes: r.specialNotes,
    });
    if (isNonTeach) continue; // 비-강의는 제외

    const needsFee = r.dealFeeHourly === null;
    const needsCompany = !r.companyName;
    const needsCourse = !r.courseName;
    if (!needsFee && !needsCompany && !needsCourse) continue;

    const peers = byCourseId.get(r.courseId) ?? [];
    let donorFee: { id: string; fee: number | null; company: string | null; course: string | null } | null = null;
    for (const p of peers) {
      if (p.id === r.id) continue;
      // 가장 풍부한 donor 우선 (fee + company + course 모두 있는 행)
      const score =
        (p.dealFeeHourly !== null ? 4 : 0) +
        (p.companyName ? 2 : 0) +
        (p.courseName ? 1 : 0);
      const currScore = donorFee
        ? (donorFee.fee !== null ? 4 : 0) +
          (donorFee.company ? 2 : 0) +
          (donorFee.course ? 1 : 0)
        : -1;
      if (score > currScore) {
        donorFee = {
          id: p.id,
          fee: p.dealFeeHourly,
          company: p.companyName,
          course: p.courseName,
        };
      }
    }
    if (!donorFee) continue;

    const fixes: string[] = [];
    const after = {
      fee: r.dealFeeHourly,
      company: r.companyName,
      course: r.courseName,
    };
    if (needsFee && donorFee.fee !== null) {
      after.fee = donorFee.fee;
      fixes.push("fee");
    }
    if (needsCompany && donorFee.company) {
      after.company = donorFee.company;
      fixes.push("company");
    }
    if (needsCourse && donorFee.course) {
      after.course = donorFee.course;
      fixes.push("course");
    }
    if (fixes.length === 0) continue;

    affectedInstructorIds.add(r.instructorDbId);
    candidates.push({
      id: r.id,
      fix: fixes.join("+") as RecoveryCandidate["fix"],
      before: { fee: r.dealFeeHourly, company: r.companyName, course: r.courseName },
      after,
      courseId: r.courseId,
      donor: donorFee,
    });
  }

  console.log(`회복 가능 행: ${candidates.length}건`);
  console.log(`영향 강사: ${affectedInstructorIds.size}명`);

  // fix 종류별 카운트
  const byFix: Record<string, number> = {};
  for (const c of candidates) {
    byFix[c.fix] = (byFix[c.fix] ?? 0) + 1;
  }

  // 강사별 dedupe 변화 시뮬레이션 (top 10 영향 강사)
  const byInstructor = new Map<string, RecoveryCandidate[]>();
  for (const c of candidates) {
    const targetRow = allTh.find((r) => r.id === c.id);
    if (!targetRow) continue;
    const list = byInstructor.get(targetRow.instructorDbId) ?? [];
    list.push(c);
    byInstructor.set(targetRow.instructorDbId, list);
  }

  const instructorImpacts: Array<{
    name: string;
    role: string;
    candidatesCount: number;
    beforeGroups: number;
    afterGroups: number;
    delta: number;
  }> = [];

  for (const [instructorDbId, instCandidates] of byInstructor) {
    const inst = await prisma.instructor.findUnique({
      where: { id: instructorDbId },
      select: { name: true, isPracticeCoach: true, isFulltime: true },
    });
    if (!inst) continue;

    const myRows = allTh.filter((r) => r.instructorDbId === instructorDbId);
    // before: 현재 데이터로 dedupe count
    const beforeItems: TeachingHistoryDisplayItem[] = myRows.map((r) => ({
      course_name: r.courseName,
      company_name: r.companyName,
      course_id: r.courseId,
      deal_fee_hourly: r.dealFeeHourly,
      contract_type: r.contractType,
      detail_type: r.detailType,
      fee_extra: r.feeExtra,
      special_notes: r.specialNotes,
      start_date: r.startDate?.toISOString() ?? null,
      end_date: r.endDate?.toISOString() ?? null,
      total_sessions: r.totalSessions,
      total_hours: r.totalHours ? Number(r.totalHours) : null,
    }));
    const beforeGroups = countGroupedTeachingHistories(beforeItems);

    // after: 회복 시뮬레이션 적용
    const candidateIds = new Map(instCandidates.map((c) => [c.id, c]));
    const afterItems: TeachingHistoryDisplayItem[] = myRows.map((r) => {
      const c = candidateIds.get(r.id);
      const fee = c?.after.fee ?? r.dealFeeHourly;
      const company = c?.after.company ?? r.companyName;
      const course = c?.after.course ?? r.courseName;
      return {
        course_name: course,
        company_name: company,
        course_id: r.courseId,
        deal_fee_hourly: fee,
        contract_type: r.contractType,
        detail_type: r.detailType,
        fee_extra: r.feeExtra,
        special_notes: r.specialNotes,
        start_date: r.startDate?.toISOString() ?? null,
        end_date: r.endDate?.toISOString() ?? null,
        total_sessions: r.totalSessions,
        total_hours: r.totalHours ? Number(r.totalHours) : null,
      };
    });
    const afterGroups = countGroupedTeachingHistories(afterItems);

    instructorImpacts.push({
      name: inst.name,
      role: inst.isPracticeCoach ? "실습코치" : inst.isFulltime ? "전임" : "정규",
      candidatesCount: instCandidates.length,
      beforeGroups,
      afterGroups,
      delta: afterGroups - beforeGroups,
    });
  }

  // 정렬: delta 큰 순
  instructorImpacts.sort((a, b) => b.delta - a.delta || b.candidatesCount - a.candidatesCount);

  const md: string[] = [];
  md.push("# P2/P4 자동 회복 시뮬레이션 (read-only)");
  md.push(`Generated at: ${new Date().toISOString()}`);
  md.push(`전체 teaching_histories: ${allTh.length}건`);
  md.push("");
  md.push("## 회복 가능 후보");
  md.push(`- 회복 가능 행: **${candidates.length}건**`);
  md.push(`- 영향 강사: **${affectedInstructorIds.size}명**`);
  md.push("");
  md.push("### Fix 종류별");
  for (const [fix, count] of Object.entries(byFix).sort((a, b) => b[1] - a[1])) {
    md.push(`- ${fix}: ${count}건`);
  }
  md.push("");

  md.push("## 강사별 dedupe 회복 영향 (top 20)");
  md.push("| 강사 | role | 회복후보 | before groups | after groups | Δ |");
  md.push("|---|---|---|---|---|---|");
  for (const i of instructorImpacts.slice(0, 20)) {
    md.push(
      `| ${i.name} | ${i.role} | ${i.candidatesCount} | ${i.beforeGroups} | ${i.afterGroups} | ${i.delta > 0 ? "**+" + i.delta + "**" : i.delta} |`
    );
  }
  md.push("");

  // delta > 0 강사들 (실제 회복 효과 있는 강사)
  const realRecoveries = instructorImpacts.filter((i) => i.delta > 0);
  md.push(`## 실제 dedupe 회복 강사: ${realRecoveries.length}명, 회복 강의 합: ${realRecoveries.reduce((s, i) => s + i.delta, 0)}건`);
  md.push("");

  // 샘플 후보 5건
  md.push("## 회복 후보 샘플 (top 10)");
  md.push("| candidateId | fix | courseId | before | after | donorId |");
  md.push("|---|---|---|---|---|---|");
  for (const c of candidates.slice(0, 10)) {
    const beforeStr = `fee=${c.before.fee ?? "—"} company=${c.before.company ?? "—"} course=${(c.before.course ?? "—").slice(0, 20)}`;
    const afterStr = `fee=${c.after.fee ?? "—"} company=${c.after.company ?? "—"} course=${(c.after.course ?? "—").slice(0, 20)}`;
    md.push(`| ${c.id.slice(0, 8)} | ${c.fix} | ${c.courseId} | ${beforeStr} | ${afterStr} | ${c.donor.id.slice(0, 8)} |`);
  }

  const reportDir = path.resolve(process.cwd(), "reports");
  await mkdir(reportDir, { recursive: true });
  const mdPath = path.join(reportDir, "p2-p4-recovery-simulation.md");
  const jsonPath = path.join(reportDir, "p2-p4-recovery-simulation.json");
  await writeFile(mdPath, md.join("\n"), "utf-8");
  await writeFile(
    jsonPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        candidatesCount: candidates.length,
        affectedInstructors: affectedInstructorIds.size,
        byFix,
        realRecoveries: realRecoveries.length,
        recoveryGroupsTotal: realRecoveries.reduce((s, i) => s + i.delta, 0),
        candidates: candidates.slice(0, 100), // top 100 only
      },
      null,
      2
    ),
    "utf-8"
  );

  console.log(`Saved: ${mdPath}`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
