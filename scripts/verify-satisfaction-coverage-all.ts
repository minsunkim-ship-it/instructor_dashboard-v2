/**
 * verify-satisfaction-coverage-all.ts — Phase D-4 전체 정규 강사 100% 검증
 *
 * 분류:
 *   L0: 강의 0건 (분모 제외)
 *   L1: catalog 시트 부재 (운영팀 인계, 분모 제외)
 *   L2: 시트 매칭 있으나 ImportItem 0건 (Phase B 회귀 fail)
 *   L3: ImportItem 있으나 SatisfactionRecord 0건 (Phase C 회귀 fail)
 *   L4: 정상
 *
 * 100% 정의: L4 / (L2 + L3 + L4) === 100%
 *
 * 산출:
 *   - reports/satisfaction-coverage-all.{md,json}
 *   - 콘솔 PASS/FAIL
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";

interface CatalogEntry {
  key: string;
  title: string;
  companyName?: string | null;
  courseName?: string | null;
  instructorHint?: string | null;
}

type CoverageLevel = "L0" | "L1" | "L2" | "L3" | "L4";

function normalize(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .toLowerCase()
    .replace(/[\s()[\]{}.,:;'"`~!?+\-_/\\|]+/g, "")
    .trim();
}

async function loadCatalog(): Promise<CatalogEntry[]> {
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
    } catch {}
  }
  const codeEntries: CatalogEntry[] = [
    { key: "kt_ai_campus", title: "KT AI Campus 만족도조사 결과", companyName: "KT AI Campus" },
    { key: "hyundai_mobis_llm", title: "현대모비스 LLM 만족도 종합", companyName: "현대모비스", courseName: "LLM을 활용한 현업 프로젝트" },
    { key: "hyundai_mobis_llm_2", title: "현대모비스 LLM 2차수", companyName: "현대모비스", courseName: "LLM을 활용한 현업 프로젝트" },
    { key: "hyundai_mobis_llm_3", title: "현대모비스 LLM 3차수 응답", companyName: "현대모비스", courseName: "LLM을 활용한 현업 프로젝트" },
    { key: "hyundai_mobis_llm_4", title: "현대모비스 LLM 4차수", companyName: "현대모비스", courseName: "LLM을 활용한 현업 프로젝트" },
    { key: "woori_ax_forms", title: "우리은행 AX 전문가 양성과정", companyName: "우리은행", courseName: "AX 기획자 과정" },
  ];
  return [...codeEntries, ...fileEntries];
}

function strictMatch(thNorm: string, refNorm: string): boolean {
  if (thNorm.length < 6 || refNorm.length < 6) return false;
  return thNorm.includes(refNorm) || refNorm.includes(thNorm);
}

function matchCatalog(
  catalog: CatalogEntry[],
  ths: Array<{ companyName: string | null; courseName: string | null }>
): string[] {
  const matched = new Set<string>();
  for (const c of catalog) {
    const title = normalize(c.title);
    const cCompany = normalize(c.companyName ?? "");
    const cCourse = normalize(c.courseName ?? "");

    let companyHit = false;
    let courseHit = false;
    for (const th of ths) {
      const thCompany = normalize(th.companyName);
      const thCourse = normalize(th.courseName);
      if (strictMatch(thCompany, cCompany) || strictMatch(thCompany, title)) companyHit = true;
      if (strictMatch(thCourse, cCourse) || strictMatch(thCourse, title)) courseHit = true;
      if (companyHit && courseHit) break;
    }
    if (companyHit && courseHit) matched.add(c.key);
  }
  return Array.from(matched);
}

async function main() {
  const catalog = await loadCatalog();
  const instructors = await prisma.instructor.findMany({
    where: { isPracticeCoach: false, isFulltime: false },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  const allThs = await prisma.teachingHistory.findMany({
    select: { instructorDbId: true, companyName: true, courseName: true, courseId: true },
  });
  const thsByInst = new Map<string, Array<{ companyName: string | null; courseName: string | null; courseId: string | null }>>();
  for (const t of allThs) {
    const list = thsByInst.get(t.instructorDbId) ?? [];
    list.push({ companyName: t.companyName, courseName: t.courseName, courseId: t.courseId });
    thsByInst.set(t.instructorDbId, list);
  }
  const recordCounts = await prisma.satisfactionRecord.groupBy({
    by: ["instructorDbId"],
    _count: { _all: true },
  });
  const recordById = new Map<string, number>(
    recordCounts.map((r) => [r.instructorDbId, r._count._all])
  );
  const importItems = await prisma.satisfactionImportItem.findMany({
    select: {
      candidateName: true,
      candidateCompanyName: true,
      candidateCourseName: true,
    },
  });

  const counts: Record<CoverageLevel, number> = { L0: 0, L1: 0, L2: 0, L3: 0, L4: 0 };
  const examples: Record<CoverageLevel, Array<{ name: string; reason: string }>> = {
    L0: [],
    L1: [],
    L2: [],
    L3: [],
    L4: [],
  };

  for (const inst of instructors) {
    const ths = thsByInst.get(inst.id) ?? [];
    const recordCount = recordById.get(inst.id) ?? 0;
    const matchedSheetKeys = matchCatalog(catalog, ths);

    const companyNamesForInst = new Set(
      ths.map((t) => t.companyName).filter((v): v is string => Boolean(v))
    );
    const courseNamesForInst = new Set(
      ths.map((t) => t.courseName).filter((v): v is string => Boolean(v))
    );
    const importItemCount = importItems.filter(
      (it) =>
        it.candidateName === inst.name ||
        (it.candidateCompanyName && companyNamesForInst.has(it.candidateCompanyName)) ||
        (it.candidateCourseName && courseNamesForInst.has(it.candidateCourseName))
    ).length;

    let level: CoverageLevel;
    let reason: string;
    if (ths.length === 0) {
      level = "L0";
      reason = "강의 0건";
    } else if (recordCount > 0) {
      level = "L4";
      reason = `Record ${recordCount}건`;
    } else if (matchedSheetKeys.length === 0) {
      level = "L1";
      reason = `시트 부재 — 회사 [${Array.from(companyNamesForInst).slice(0, 2).join(",")}] catalog 매칭 없음`;
    } else if (importItemCount === 0) {
      level = "L2";
      reason = `시트 ${matchedSheetKeys.length}건 매칭, ImportItem 0건 — Phase B 회귀 fail`;
    } else {
      level = "L3";
      reason = `ImportItem ${importItemCount}건, Record 0건 — Phase C 회귀 fail`;
    }

    counts[level]++;
    if (examples[level].length < 5) examples[level].push({ name: inst.name, reason });
  }

  const denominator = counts.L2 + counts.L3 + counts.L4;
  const successRate = denominator > 0 ? (counts.L4 / denominator) * 100 : 0;
  const pass = counts.L2 === 0 && counts.L3 === 0;

  const md: string[] = [];
  md.push("# 전체 정규 강사 만족도 100% 회귀 검증 (Phase D-4)");
  md.push(`Generated at: ${new Date().toISOString()}`);
  md.push(`정규 강사 ${instructors.length}명 검사`);
  md.push("");
  md.push("## 분류 결과");
  md.push(`- L0 (강의 0건): ${counts.L0}명 — 분모 제외`);
  md.push(`- L1 (시트 부재): ${counts.L1}명 — 카탈로그 등록 인계 (분모 제외)`);
  md.push(`- L2 (Phase B 회귀): ${counts.L2}명`);
  md.push(`- L3 (Phase C 회귀): ${counts.L3}명`);
  md.push(`- L4 (정상): ${counts.L4}명`);
  md.push("");
  md.push(`### 100% 정의: L4 / (L2 + L3 + L4) = ${successRate.toFixed(2)}%`);
  md.push(`### 종합: **${pass ? "✅ PASS" : "❌ FAIL"}** ${pass ? "(L2=0, L3=0)" : `(L2=${counts.L2}, L3=${counts.L3})`}`);
  md.push("");

  for (const lvl of ["L1", "L2", "L3"] as CoverageLevel[]) {
    if (examples[lvl].length === 0) continue;
    md.push(`## ${lvl} 샘플`);
    for (const e of examples[lvl]) md.push(`- ${e.name} — ${e.reason}`);
    md.push("");
  }

  const reportDir = path.resolve(process.cwd(), "reports");
  await mkdir(reportDir, { recursive: true });
  const mdPath = path.join(reportDir, "satisfaction-coverage-all.md");
  const jsonPath = path.join(reportDir, "satisfaction-coverage-all.json");
  await writeFile(mdPath, md.join("\n"), "utf-8");
  await writeFile(
    jsonPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        regularInstructorTotal: instructors.length,
        counts,
        successRate,
        pass,
      },
      null,
      2
    ),
    "utf-8"
  );

  console.log(
    `정규 ${instructors.length}명 — L0=${counts.L0} L1=${counts.L1} L2=${counts.L2} L3=${counts.L3} L4=${counts.L4} | success=${successRate.toFixed(2)}%`
  );
  console.log(`종합: ${pass ? "PASS" : "FAIL"}`);
  console.log(`Saved: ${mdPath}`);
  if (!pass) process.exit(1);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
