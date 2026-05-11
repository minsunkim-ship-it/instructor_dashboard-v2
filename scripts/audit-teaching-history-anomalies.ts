/**
 * audit-teaching-history-anomalies.ts — read-only 진단 (Phase A-1)
 *
 * 목적: 박상훈 동국홀딩스 dedupe 오판 같은 패턴이 다른 강사에도 있는지 자동 감지.
 *
 * 검출 패턴:
 *  - P1 (검증)   : 박상훈 패치 검증 — 복합 detailType + dealFee non-null 행이 dedupe에서 살아남는지
 *  - P2 (회복)   : dealFee null + courseId 있는 행 — 회복 후보. 같은 courseId의 다른 행에 단가 있으면 추적
 *  - P3 (중복)   : 같은 (courseId, startDate, endDate) 인데 sourceType 다름 — dedupe로 합쳐지지 않을 위험
 *  - P4 (NULL)   : courseId 있는데 companyName/courseName NULL — API route NULL 보강 우회 검증
 *  - P5 (차수)   : stripIterationSuffix 후 같은 시그니처지만 startDate 다름 — 다른 차수가 dedupe로 합쳐질 위험
 *
 * 산출:
 *  - reports/teaching-history-anomalies.json — 강사별 패턴별 카운트 + 샘플 raw row
 *  - reports/teaching-history-anomalies.md   — 사람이 읽는 요약
 *
 * 자기검수: 박상훈 강사가 P1 회복(detailType "강사비, 기획개발비, 출장비" 행이 dedupe 통과)이 보이면 패치 적용 확인.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import {
  isNonTeachingCompensationItem,
  type TeachingHistoryKindLike,
} from "@/lib/teaching-history-kind";

const SPECIAL_KEYWORDS = ["출장비", "건당", "별도"];

interface ThRow {
  id: string;
  instructorDbId: string;
  companyName: string | null;
  courseName: string | null;
  courseId: string | null;
  startDate: Date | null;
  endDate: Date | null;
  dealFeeHourly: number | null;
  contractType: string | null;
  detailType: string | null;
  feeExtra: string | null;
  specialNotes: string | null;
  sourceType: string;
}

interface AnomalySample {
  thId: string;
  courseId: string | null;
  companyName: string | null;
  courseName: string | null;
  startDate: string | null;
  endDate: string | null;
  detailType: string | null;
  dealFeeHourly: number | null;
  sourceType: string;
  note?: string;
}

interface InstructorAnomalyReport {
  instructorId: string;
  instructorName: string;
  isPracticeCoach: boolean;
  isFulltime: boolean;
  totalRows: number;
  passedDedupe: number;
  filteredAsNonTeaching: number;
  patterns: {
    p1_compoundDetailWithFee: { count: number; samples: AnomalySample[] };
    p2_nullFeeWithCourseId: { count: number; samples: AnomalySample[] };
    p3_duplicateCourseDateDifferentSource: {
      count: number;
      samples: AnomalySample[];
    };
    p4_courseIdNullCompanyOrCourse: { count: number; samples: AnomalySample[] };
    p5_iterationCohortMergeRisk: { count: number; samples: AnomalySample[] };
  };
}

function isoDate(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

function rowToSample(row: ThRow, note?: string): AnomalySample {
  return {
    thId: row.id,
    courseId: row.courseId,
    companyName: row.companyName,
    courseName: row.courseName,
    startDate: isoDate(row.startDate),
    endDate: isoDate(row.endDate),
    detailType: row.detailType,
    dealFeeHourly: row.dealFeeHourly,
    sourceType: row.sourceType,
    note,
  };
}

function rowToKindLike(row: ThRow): TeachingHistoryKindLike {
  return {
    courseId: row.courseId,
    courseName: row.courseName,
    dealFeeHourly: row.dealFeeHourly,
    feeExtra: row.feeExtra,
    detailType: row.detailType,
    specialNotes: row.specialNotes,
  };
}

function containsSpecialKeyword(value: string | null): boolean {
  if (!value) return false;
  return SPECIAL_KEYWORDS.some((kw) => value.includes(kw));
}

function isCompoundDetailType(value: string | null): boolean {
  if (!value) return false;
  if (!containsSpecialKeyword(value)) return false;
  // "강사비", "기획", "개발", "운영" 등 정규 항목이 같이 있으면 복합
  const regularKeywords = ["강사비", "강사료", "기획", "개발", "운영", "강의료"];
  return regularKeywords.some((rk) => value.includes(rk));
}

function stripIterationSuffix(value: string | null): string {
  if (!value) return "";
  return value
    .replace(/\s*[\(\[]\s*\d+\s*(회차|차수)\s*[\)\]]\s*$/u, "")
    .replace(/\s+\d+\s*(회차|차수)\s*$/u, "")
    .trim();
}

function detectPatterns(rows: ThRow[]): InstructorAnomalyReport["patterns"] {
  const p1Samples: AnomalySample[] = [];
  const p2Samples: AnomalySample[] = [];
  const p3Samples: AnomalySample[] = [];
  const p4Samples: AnomalySample[] = [];
  const p5Samples: AnomalySample[] = [];

  // courseId → company/course 채워진 행이 있는지 lookup 맵
  const courseIdLookup = new Map<
    string,
    { hasCompany: boolean; hasCourse: boolean; hasFee: boolean }
  >();
  for (const r of rows) {
    if (!r.courseId) continue;
    const ex = courseIdLookup.get(r.courseId) ?? {
      hasCompany: false,
      hasCourse: false,
      hasFee: false,
    };
    if (r.companyName) ex.hasCompany = true;
    if (r.courseName) ex.hasCourse = true;
    if (r.dealFeeHourly !== null) ex.hasFee = true;
    courseIdLookup.set(r.courseId, ex);
  }

  // P3: (courseId, startDate, endDate) 그룹별 sourceType 다양성
  const tripleGroups = new Map<string, ThRow[]>();
  for (const r of rows) {
    if (!r.courseId || !r.startDate || !r.endDate) continue;
    const key = `${r.courseId}||${isoDate(r.startDate)}||${isoDate(r.endDate)}`;
    const list = tripleGroups.get(key) ?? [];
    list.push(r);
    tripleGroups.set(key, list);
  }

  // P5: (stripped courseName, companyName) 그룹별 startDate 다양성
  const cohortGroups = new Map<string, ThRow[]>();
  for (const r of rows) {
    if (!r.courseName) continue;
    const stripped = stripIterationSuffix(r.courseName);
    const company = stripIterationSuffix(r.companyName);
    if (!stripped) continue;
    const key = `${stripped}||${company}`;
    const list = cohortGroups.get(key) ?? [];
    list.push(r);
    cohortGroups.set(key, list);
  }

  for (const r of rows) {
    // P1: 복합 detailType + dealFee non-null
    if (isCompoundDetailType(r.detailType) && r.dealFeeHourly !== null) {
      const isFiltered = isNonTeachingCompensationItem(rowToKindLike(r));
      if (!isFiltered) {
        // 패치가 작동해서 dedupe 통과 — 정상 회복
        if (p1Samples.length < 5) {
          p1Samples.push(
            rowToSample(r, "복합 detailType + dealFee 있음 → 패치로 dedupe 통과 (정상)")
          );
        }
      } else {
        // 필터됐다면 패치 미적용 — 회귀 위험
        if (p1Samples.length < 5) {
          p1Samples.push(
            rowToSample(r, "⚠️ 복합 detailType이 비-강의로 필터됨 — 패치 회귀 의심")
          );
        }
      }
    }

    // P2: dealFee null + courseId 있는 행 — 회복 후보 (같은 courseId에 단가 있으면)
    if (r.dealFeeHourly === null && r.courseId) {
      const lookup = courseIdLookup.get(r.courseId);
      if (lookup?.hasFee) {
        if (p2Samples.length < 5) {
          p2Samples.push(
            rowToSample(r, "단가 NULL인데 같은 courseId의 다른 행에 단가 있음")
          );
        }
      }
    }

    // P4: courseId 있는데 company/course NULL이면서 같은 courseId의 다른 행이 채워짐
    if (r.courseId && (!r.companyName || !r.courseName)) {
      const lookup = courseIdLookup.get(r.courseId);
      const otherHasCompany = lookup?.hasCompany && !r.companyName;
      const otherHasCourse = lookup?.hasCourse && !r.courseName;
      if (otherHasCompany || otherHasCourse) {
        if (p4Samples.length < 5) {
          const missing: string[] = [];
          if (otherHasCompany) missing.push("company");
          if (otherHasCourse) missing.push("course");
          p4Samples.push(
            rowToSample(r, `${missing.join("+")} NULL — 같은 courseId의 다른 행으로 보강 가능`)
          );
        }
      }
    }
  }

  // P3 카운트
  let p3Count = 0;
  for (const [key, list] of tripleGroups) {
    if (list.length < 2) continue;
    const sourceTypes = new Set(list.map((r) => r.sourceType));
    if (sourceTypes.size < 2) continue;
    p3Count += list.length;
    if (p3Samples.length < 5) {
      p3Samples.push(
        rowToSample(
          list[0],
          `같은 (courseId, start, end)에 sourceType ${Array.from(sourceTypes).join(",")} 중복 ${list.length}건`
        )
      );
    }
  }

  // P5 카운트 — 같은 stripped 시그니처에 startDate가 다른 행 ≥ 2
  let p5Count = 0;
  for (const [key, list] of cohortGroups) {
    if (list.length < 2) continue;
    const startDates = new Set(list.map((r) => isoDate(r.startDate)).filter(Boolean));
    if (startDates.size < 2) continue;
    p5Count += list.length;
    if (p5Samples.length < 5) {
      p5Samples.push(
        rowToSample(
          list[0],
          `차수 stripped 시그니처 같지만 startDate ${startDates.size}종 — cohort merge risk`
        )
      );
    }
  }

  return {
    p1_compoundDetailWithFee: { count: p1Samples.length, samples: p1Samples },
    p2_nullFeeWithCourseId: { count: p2Samples.length, samples: p2Samples },
    p3_duplicateCourseDateDifferentSource: { count: p3Count, samples: p3Samples },
    p4_courseIdNullCompanyOrCourse: { count: p4Samples.length, samples: p4Samples },
    p5_iterationCohortMergeRisk: { count: p5Count, samples: p5Samples },
  };
}

async function main() {
  const instructors = await prisma.instructor.findMany({
    select: {
      id: true,
      name: true,
      isPracticeCoach: true,
      isFulltime: true,
    },
    orderBy: { name: "asc" },
  });

  const reports: InstructorAnomalyReport[] = [];
  let processed = 0;

  for (const inst of instructors) {
    const rows = (await prisma.teachingHistory.findMany({
      where: { instructorDbId: inst.id },
      select: {
        id: true,
        instructorDbId: true,
        companyName: true,
        courseName: true,
        courseId: true,
        startDate: true,
        endDate: true,
        dealFeeHourly: true,
        contractType: true,
        detailType: true,
        feeExtra: true,
        specialNotes: true,
        sourceType: true,
      },
    })) as ThRow[];

    if (rows.length === 0) continue;

    const passedDedupe = rows.filter(
      (r) => !isNonTeachingCompensationItem(rowToKindLike(r))
    ).length;
    const filteredAsNonTeaching = rows.length - passedDedupe;

    const patterns = detectPatterns(rows);

    // 모든 패턴이 0건이면 skip (보고서 노이즈 줄이기)
    const totalAnomalies =
      patterns.p1_compoundDetailWithFee.count +
      patterns.p2_nullFeeWithCourseId.count +
      patterns.p3_duplicateCourseDateDifferentSource.count +
      patterns.p4_courseIdNullCompanyOrCourse.count +
      patterns.p5_iterationCohortMergeRisk.count;

    if (totalAnomalies === 0) {
      processed++;
      continue;
    }

    reports.push({
      instructorId: inst.id,
      instructorName: inst.name,
      isPracticeCoach: inst.isPracticeCoach,
      isFulltime: inst.isFulltime,
      totalRows: rows.length,
      passedDedupe,
      filteredAsNonTeaching,
      patterns,
    });
    processed++;
  }

  reports.sort((a, b) => {
    const aSum =
      a.patterns.p1_compoundDetailWithFee.count +
      a.patterns.p2_nullFeeWithCourseId.count +
      a.patterns.p3_duplicateCourseDateDifferentSource.count +
      a.patterns.p4_courseIdNullCompanyOrCourse.count +
      a.patterns.p5_iterationCohortMergeRisk.count;
    const bSum =
      b.patterns.p1_compoundDetailWithFee.count +
      b.patterns.p2_nullFeeWithCourseId.count +
      b.patterns.p3_duplicateCourseDateDifferentSource.count +
      b.patterns.p4_courseIdNullCompanyOrCourse.count +
      b.patterns.p5_iterationCohortMergeRisk.count;
    return bSum - aSum;
  });

  // 종합
  const totalP1 = reports.reduce((s, r) => s + r.patterns.p1_compoundDetailWithFee.count, 0);
  const totalP2 = reports.reduce((s, r) => s + r.patterns.p2_nullFeeWithCourseId.count, 0);
  const totalP3 = reports.reduce(
    (s, r) => s + r.patterns.p3_duplicateCourseDateDifferentSource.count,
    0
  );
  const totalP4 = reports.reduce((s, r) => s + r.patterns.p4_courseIdNullCompanyOrCourse.count, 0);
  const totalP5 = reports.reduce((s, r) => s + r.patterns.p5_iterationCohortMergeRisk.count, 0);

  // P1 회귀 의심 강사 (필터됨 = 패치 미적용 의심)
  const p1Regressions: string[] = [];
  for (const r of reports) {
    const regressionSamples = r.patterns.p1_compoundDetailWithFee.samples.filter((s) =>
      s.note?.startsWith("⚠️")
    );
    if (regressionSamples.length > 0) p1Regressions.push(r.instructorName);
  }

  const md: string[] = [];
  md.push("# Teaching History Anomalies Audit (read-only)");
  md.push(`Generated at: ${new Date().toISOString()}`);
  md.push(`강사 ${processed}명 검사 / 이상 패턴 강사 ${reports.length}명`);
  md.push("");
  md.push("## 종합");
  md.push(`- P1 (복합 detailType + dealFee 있음) 행: **${totalP1}**`);
  md.push(`- P2 (단가 NULL + courseId 있음 + 같은 courseId에 단가 있음) 행: **${totalP2}**`);
  md.push(`- P3 (같은 courseId+date에 sourceType 중복) 행: **${totalP3}**`);
  md.push(`- P4 (courseId 있는데 company/course NULL, 다른 행으로 보강 가능) 행: **${totalP4}**`);
  md.push(`- P5 (차수 stripped 같은데 startDate 다름) 행: **${totalP5}**`);
  md.push("");
  if (p1Regressions.length > 0) {
    md.push("### ⚠️ P1 회귀 의심 (박상훈 패치 미적용 가능)");
    md.push(p1Regressions.map((n) => `- ${n}`).join("\n"));
    md.push("");
  } else {
    md.push("### ✅ P1 회귀 없음 — 박상훈 패치 정상 적용 확인");
    md.push("");
  }

  md.push("## 강사별 이상 패턴");
  md.push("| 강사 | role | rows | dedupe통과 | 비-강의필터 | P1 | P2 | P3 | P4 | P5 |");
  md.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const r of reports) {
    const role = r.isPracticeCoach ? "실습코치" : r.isFulltime ? "전임" : "정규";
    md.push(
      `| ${r.instructorName} | ${role} | ${r.totalRows} | ${r.passedDedupe} | ${r.filteredAsNonTeaching} | ${r.patterns.p1_compoundDetailWithFee.count} | ${r.patterns.p2_nullFeeWithCourseId.count} | ${r.patterns.p3_duplicateCourseDateDifferentSource.count} | ${r.patterns.p4_courseIdNullCompanyOrCourse.count} | ${r.patterns.p5_iterationCohortMergeRisk.count} |`
    );
  }
  md.push("");

  // 상위 5명 샘플
  md.push("## 상위 5명 샘플");
  for (const r of reports.slice(0, 5)) {
    md.push(`### ${r.instructorName}`);
    const buckets: Array<{
      label: string;
      data: { count: number; samples: AnomalySample[] };
    }> = [
      { label: "P1 (복합 detailType+fee)", data: r.patterns.p1_compoundDetailWithFee },
      { label: "P2 (단가 NULL 회복후보)", data: r.patterns.p2_nullFeeWithCourseId },
      { label: "P3 (sourceType 중복)", data: r.patterns.p3_duplicateCourseDateDifferentSource },
      { label: "P4 (NULL 보강 후보)", data: r.patterns.p4_courseIdNullCompanyOrCourse },
      { label: "P5 (차수 merge risk)", data: r.patterns.p5_iterationCohortMergeRisk },
    ];
    for (const b of buckets) {
      if (b.data.count === 0) continue;
      md.push(`- **${b.label}**: ${b.data.count}건`);
      for (const s of b.data.samples.slice(0, 2)) {
        md.push(
          `  - ${s.companyName ?? "—"} / ${(s.courseName ?? "—").slice(0, 30)} / courseId=${s.courseId ?? "—"} / start=${s.startDate ?? "—"} / fee=${s.dealFeeHourly ?? "—"}${s.note ? ` // ${s.note}` : ""}`
        );
      }
    }
    md.push("");
  }

  const reportDir = path.resolve(process.cwd(), "reports");
  await mkdir(reportDir, { recursive: true });
  const mdPath = path.join(reportDir, "teaching-history-anomalies.md");
  const jsonPath = path.join(reportDir, "teaching-history-anomalies.json");
  await writeFile(mdPath, md.join("\n"), "utf-8");
  await writeFile(
    jsonPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        totals: { p1: totalP1, p2: totalP2, p3: totalP3, p4: totalP4, p5: totalP5 },
        p1Regressions,
        reports,
      },
      null,
      2
    ),
    "utf-8"
  );

  console.log(`강사 ${processed}명 검사 / 이상 ${reports.length}명`);
  console.log(`P1=${totalP1} P2=${totalP2} P3=${totalP3} P4=${totalP4} P5=${totalP5}`);
  console.log(`P1 회귀 의심: ${p1Regressions.length}명${p1Regressions.length > 0 ? ` — ${p1Regressions.join(", ")}` : ""}`);
  console.log(`Saved: ${mdPath}`);
  console.log(`Saved: ${jsonPath}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
