/**
 * audit-satisfaction-coverage.ts — read-only 진단 (Phase A-2)
 *
 * 목적: 만족도 0건 강사를 L1~L4로 분류해 어디서 막혔는지 보이게 한다.
 *
 *  L0 — 강의 0건 (분모 제외)
 *  L1 — 시트 부재    : teaching_history 회사/과정 ↔ catalog 매칭 시도, 매칭 없음
 *  L2 — raw 부재     : 시트 매칭 있는데 SatisfactionImportItem 0건 (파서 미탑재 또는 read 실패)
 *  L3 — 매칭 실패    : ImportItem ≥ 1건, 그러나 resolved registry 0건 (Phase C 매칭 알고리즘 회복 대상)
 *  L4 — 정상         : SatisfactionRecord ≥ 1건
 *
 * 산출:
 *  - reports/satisfaction-coverage.json
 *  - reports/satisfaction-coverage.md
 *
 * 자기검수: 박상훈 강사가 L1/L2/L3 중 어디로 들어가는지 확인 (예상: L2 — 시트는 있으나 파서 미탑재).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";

interface CatalogEntry {
  key: string;
  sourceType: string;
  spreadsheetId: string;
  title: string;
  companyName?: string | null;
  courseName?: string | null;
  instructorHint?: string | null;
  note?: string | null;
}

interface ThSummary {
  companyName: string | null;
  courseName: string | null;
  courseId: string | null;
}

type CoverageLevel = "L0" | "L1" | "L2" | "L3" | "L4";

interface InstructorCoverage {
  instructorId: string;
  instructorName: string;
  isPracticeCoach: boolean;
  isFulltime: boolean;
  thRowCount: number;
  satisfactionRecordCount: number;
  matchedSheetKeys: string[];
  importItemCount: number;
  resolvedRegistryCount: number;
  level: CoverageLevel;
  reason: string;
  topCompanies: string[];
  topCourses: string[];
}

function normalize(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .toLowerCase()
    .replace(/[\s()[\]{}.,:;'"`~!?+\-_/\\|]+/g, "")
    .trim();
}

async function loadCatalog(): Promise<CatalogEntry[]> {
  // 1. data/satisfaction-sheet-catalog.json
  const catalogPath = path.resolve(process.cwd(), "data/satisfaction-sheet-catalog.json");
  const raw = await readFile(catalogPath, "utf-8").catch(() => null);
  const fileEntries: CatalogEntry[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { sources?: CatalogEntry[] };
      if (Array.isArray(parsed.sources)) {
        for (const s of parsed.sources) {
          if (s && typeof s.key === "string" && typeof s.title === "string") {
            fileEntries.push(s);
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // 2. 코드 내 ACCESSIBLE_SATISFACTION_SHEET_SOURCES 상수 — collector에서 import 시도
  // 환경 분리를 위해 dynamic import 회피, 코드 SOURCES도 catalog로 취급한다 (loadCatalogFromFile + 코드 정의 통합)
  // 코드 SOURCES는 기존에 알려진 KT/현대모비스/우리은행이라 hardcode
  const codeEntries: CatalogEntry[] = [
    { key: "kt_ai_campus", sourceType: "sheet_summary", spreadsheetId: "1nXK", title: "KT AI Campus 만족도조사 결과", companyName: "KT AI Campus" },
    { key: "hyundai_mobis_llm", sourceType: "sheet_summary", spreadsheetId: "1hyT", title: "현대모비스 LLM 만족도 종합", companyName: "현대모비스", courseName: "LLM을 활용한 현업 프로젝트" },
    { key: "hyundai_mobis_llm_2", sourceType: "google_forms", spreadsheetId: "1lBc", title: "현대모비스 LLM 2차수", companyName: "현대모비스", courseName: "LLM을 활용한 현업 프로젝트" },
    { key: "hyundai_mobis_llm_3", sourceType: "google_forms", spreadsheetId: "1KNg", title: "현대모비스 LLM 3차수 응답", companyName: "현대모비스", courseName: "LLM을 활용한 현업 프로젝트" },
    { key: "hyundai_mobis_llm_4", sourceType: "google_forms", spreadsheetId: "170_", title: "현대모비스 LLM 4차수", companyName: "현대모비스", courseName: "LLM을 활용한 현업 프로젝트" },
    { key: "woori_ax_forms", sourceType: "google_forms", spreadsheetId: "19v7", title: "우리은행 AX 전문가 양성과정", companyName: "우리은행", courseName: "AX 기획자 과정" },
  ];

  return [...codeEntries, ...fileEntries];
}

/**
 * Strict 보정: 회사+과정 둘 다 catalog의 회사/과정과 일치해야 매칭.
 * length≥6 토큰 매칭 + 양방향 substring (한 쪽이 다른 쪽 포함).
 * Catalog의 companyName/courseName은 catalog entry에 명시된 정규 데이터 우선.
 * Title 자체로 폴백 (catalog metadata 없을 때).
 */
function strictMatch(thNorm: string, refNorm: string): boolean {
  if (thNorm.length < 6 || refNorm.length < 6) return false;
  return thNorm.includes(refNorm) || refNorm.includes(thNorm);
}

function matchCatalogToTeachingHistories(
  catalog: CatalogEntry[],
  teachingHistories: ThSummary[]
): string[] {
  const matched = new Set<string>();
  for (const c of catalog) {
    const title = normalize(c.title);
    const cCompany = normalize(c.companyName ?? "");
    const cCourse = normalize(c.courseName ?? "");

    let companyHit = false;
    let courseHit = false;
    for (const th of teachingHistories) {
      const thCompany = normalize(th.companyName);
      const thCourse = normalize(th.courseName);

      // 회사 매칭: catalog companyName 또는 title 양쪽 시도
      if (
        strictMatch(thCompany, cCompany) ||
        strictMatch(thCompany, title)
      ) {
        companyHit = true;
      }
      // 과정 매칭: catalog courseName 또는 title 양쪽 시도
      if (
        strictMatch(thCourse, cCourse) ||
        strictMatch(thCourse, title)
      ) {
        courseHit = true;
      }
      if (companyHit && courseHit) break;
    }

    if (companyHit && courseHit) matched.add(c.key);
  }
  return Array.from(matched);
}

async function main() {
  const catalog = await loadCatalog();
  const instructors = await prisma.instructor.findMany({
    select: {
      id: true,
      name: true,
      isPracticeCoach: true,
      isFulltime: true,
    },
    orderBy: { name: "asc" },
  });

  // 한 번에 모든 teaching_histories / records / registries / import items 로드
  console.log(`[1/5] 강사 ${instructors.length}명 / catalog ${catalog.length}건 — bulk load 시작`);
  const allThs = (await prisma.teachingHistory.findMany({
    select: {
      instructorDbId: true,
      companyName: true,
      courseName: true,
      courseId: true,
    },
  })) as Array<ThSummary & { instructorDbId: string }>;
  console.log(`[2/5] teaching_histories ${allThs.length}건 로드`);

  const recordCounts = await prisma.satisfactionRecord.groupBy({
    by: ["instructorDbId"],
    _count: { _all: true },
  });
  const recordCountById = new Map<string, number>(
    recordCounts.map((r) => [r.instructorDbId, r._count._all])
  );
  console.log(`[3/5] satisfaction_records groupBy ${recordCounts.length}건 로드`);

  const registryCounts = await prisma.satisfactionReviewRegistry.groupBy({
    by: ["resolvedInstructorId"],
    where: { matchStatus: { in: ["auto_accepted", "approved"] } },
    _count: { _all: true },
  });
  const registryCountById = new Map<string, number>(
    registryCounts
      .filter((r) => r.resolvedInstructorId)
      .map((r) => [r.resolvedInstructorId!, r._count._all])
  );
  console.log(`[4/5] satisfaction_review_registries groupBy ${registryCounts.length}건 로드`);

  // ImportItem candidate_company/course/name 별 count는 회사/과정 패턴이 다양해 in-memory 매칭
  const importItems = await prisma.satisfactionImportItem.findMany({
    select: {
      candidateName: true,
      candidateCompanyName: true,
      candidateCourseName: true,
    },
  });
  console.log(`[5/5] satisfaction_import_items ${importItems.length}건 로드 — 분류 시작`);

  const thsByInstructor = new Map<string, ThSummary[]>();
  for (const t of allThs) {
    const list = thsByInstructor.get(t.instructorDbId) ?? [];
    list.push({ companyName: t.companyName, courseName: t.courseName, courseId: t.courseId });
    thsByInstructor.set(t.instructorDbId, list);
  }

  const reports: InstructorCoverage[] = [];

  for (const inst of instructors) {
    const ths = thsByInstructor.get(inst.id) ?? [];
    const recordCount = recordCountById.get(inst.id) ?? 0;
    const resolvedRegistryCount = registryCountById.get(inst.id) ?? 0;

    const matchedSheetKeys = matchCatalogToTeachingHistories(catalog, ths);

    const candidateCompanyNames = new Set(
      ths.map((t) => t.companyName).filter((v): v is string => Boolean(v))
    );
    const candidateCourseNames = new Set(
      ths.map((t) => t.courseName).filter((v): v is string => Boolean(v))
    );

    const importItemCount = importItems.filter(
      (it) =>
        it.candidateName === inst.name ||
        (it.candidateCompanyName && candidateCompanyNames.has(it.candidateCompanyName)) ||
        (it.candidateCourseName && candidateCourseNames.has(it.candidateCourseName))
    ).length;

    let level: CoverageLevel;
    let reason: string;
    if (ths.length === 0) {
      level = "L0";
      reason = "강의 이력 0건 — 분모 제외";
    } else if (recordCount > 0) {
      level = "L4";
      reason = `정상 — SatisfactionRecord ${recordCount}건`;
    } else if (matchedSheetKeys.length === 0) {
      level = "L1";
      reason = "회사/과정 매칭되는 catalog 시트 없음 — 카탈로그 등록 정정 필요";
    } else if (importItemCount === 0) {
      level = "L2";
      reason = `시트 ${matchedSheetKeys.length}건 매칭됨, ImportItem 0건 — 파서 미탑재 또는 read 실패`;
    } else {
      level = "L3";
      reason = `ImportItem ${importItemCount}건, resolvedRegistry ${resolvedRegistryCount}건, Record 0건 — 매칭 알고리즘 실패`;
    }

    const topCompanies = Array.from(candidateCompanyNames).slice(0, 3);
    const topCourses = Array.from(candidateCourseNames).slice(0, 3).map((c) => c.slice(0, 30));

    reports.push({
      instructorId: inst.id,
      instructorName: inst.name,
      isPracticeCoach: inst.isPracticeCoach,
      isFulltime: inst.isFulltime,
      thRowCount: ths.length,
      satisfactionRecordCount: recordCount,
      matchedSheetKeys,
      importItemCount,
      resolvedRegistryCount,
      level,
      reason,
      topCompanies,
      topCourses,
    });
  }

  // 정규 강사만 분류 통계
  const regularReports = reports.filter((r) => !r.isPracticeCoach && !r.isFulltime);
  const counts: Record<CoverageLevel, number> = { L0: 0, L1: 0, L2: 0, L3: 0, L4: 0 };
  for (const r of regularReports) counts[r.level]++;
  const denominator = counts.L2 + counts.L3 + counts.L4;
  const successRate = denominator > 0 ? ((counts.L4 / denominator) * 100).toFixed(2) : "—";

  // 박상훈 분류 자기검수
  const parkSanghoon = reports.find((r) => r.instructorName === "박상훈");

  const md: string[] = [];
  md.push("# Satisfaction Coverage Audit (read-only)");
  md.push(`Generated at: ${new Date().toISOString()}`);
  md.push(`강사 ${reports.length}명 / 정규 ${regularReports.length}명`);
  md.push("");
  md.push("## 정규 강사 분류 (이 plan의 분모)");
  md.push(`- L0 (강의 0건): ${counts.L0}명`);
  md.push(`- L1 (시트 부재): **${counts.L1}명** — 카탈로그 등록 정정 인계`);
  md.push(`- L2 (raw 부재): **${counts.L2}명** — Phase B 일반 파서 회복 대상`);
  md.push(`- L3 (매칭 실패): **${counts.L3}명** — Phase C 매칭 알고리즘 회복 대상`);
  md.push(`- L4 (정상): **${counts.L4}명**`);
  md.push("");
  md.push(`### Plan-D 100% 정의: L4/(L2+L3+L4) = **${successRate}%**`);
  md.push(`(L1은 카탈로그 측 작업으로 분리되어 분모 제외)`);
  md.push("");

  if (parkSanghoon) {
    md.push("### 박상훈 자기검수 (Phase D-1 대표 케이스)");
    md.push(`- level = ${parkSanghoon.level}`);
    md.push(`- reason: ${parkSanghoon.reason}`);
    md.push(`- thRows=${parkSanghoon.thRowCount}, ImportItem=${parkSanghoon.importItemCount}, Record=${parkSanghoon.satisfactionRecordCount}`);
    md.push(`- matched sheets: ${parkSanghoon.matchedSheetKeys.join(", ") || "(none)"}`);
    md.push("");
  }

  // L1~L3 강사 목록
  for (const lvl of ["L1", "L2", "L3"] as CoverageLevel[]) {
    const lvlList = regularReports.filter((r) => r.level === lvl);
    if (lvlList.length === 0) continue;
    md.push(`## ${lvl} 강사 (${lvlList.length}명)`);
    md.push("| 강사 | 강의수 | ImportItem | 매칭시트 | 회사/과정 샘플 | 사유 |");
    md.push("|---|---|---|---|---|---|");
    for (const r of lvlList) {
      md.push(
        `| ${r.instructorName} | ${r.thRowCount} | ${r.importItemCount} | ${r.matchedSheetKeys.join(",") || "—"} | ${r.topCompanies.join("/") || "—"} : ${r.topCourses.join("/") || "—"} | ${r.reason} |`
      );
    }
    md.push("");
  }

  const reportDir = path.resolve(process.cwd(), "reports");
  await mkdir(reportDir, { recursive: true });
  const mdPath = path.join(reportDir, "satisfaction-coverage.md");
  const jsonPath = path.join(reportDir, "satisfaction-coverage.json");
  await writeFile(mdPath, md.join("\n"), "utf-8");
  await writeFile(
    jsonPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        regularCounts: counts,
        successRateL4Over234: successRate,
        parkSanghoon: parkSanghoon ?? null,
        reports,
      },
      null,
      2
    ),
    "utf-8"
  );

  console.log(
    `정규 강사 분류 — L0=${counts.L0} L1=${counts.L1} L2=${counts.L2} L3=${counts.L3} L4=${counts.L4} | success=${successRate}%`
  );
  if (parkSanghoon) {
    console.log(`박상훈: ${parkSanghoon.level} — ${parkSanghoon.reason}`);
  }
  console.log(`Saved: ${mdPath}`);
  console.log(`Saved: ${jsonPath}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
