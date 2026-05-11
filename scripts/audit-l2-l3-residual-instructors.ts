/**
 * audit-l2-l3-residual-instructors.ts — L2/L3 잔여 강사 false positive 검수 (read-only)
 *
 * 목적: audit:satisfaction-coverage가 L2/L3로 분류한 강사 15명 각각에 대해
 *  - 강사의 teaching_history (실제 진행 강의)
 *  - 매칭된 catalog 시트의 회사/과정명
 * 비교해서 진짜 매칭(true positive)인지 false positive인지 분류.
 *
 * 분류 결과:
 *   TP (true positive)  — catalog에 expectedInstructors 추가하면 회복 가능
 *   FP (false positive) — audit가 잘못 매칭. L1으로 재분류
 *   AMBIGUOUS — 사용자 결정 필요
 *
 * 산출:
 *   - reports/l2-l3-residual-audit.md
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";

interface CatalogEntry {
  key: string;
  title: string;
  companyName?: string | null;
  courseName?: string | null;
}

const L2_INSTRUCTORS = ["신승진", "이중학(주식회사 그로스링크)", "김성재A"];
const L3_INSTRUCTORS = [
  "김건우",
  "김유신",
  "김태헌",
  "박노성",
  "박효경",
  "신주혜",
  "유연휘",
  "황만수",
  "박효경(소속강사)",
  "김준범, 이진원",
  "정민수A",
  "이찬우B",
];

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
    { key: "kt_ai_campus", title: "KT AI Campus 만족도조사 결과", companyName: "KT", courseName: "AI Campus" },
    { key: "hyundai_mobis_llm", title: "현대모비스 LLM 만족도 종합", companyName: "현대모비스", courseName: "LLM을 활용한 현업 프로젝트" },
    { key: "hyundai_mobis_llm_2", title: "현대모비스 LLM 2차수", companyName: "현대모비스", courseName: "LLM을 활용한 현업 프로젝트" },
    { key: "hyundai_mobis_llm_3", title: "현대모비스 LLM 3차수 응답", companyName: "현대모비스", courseName: "LLM을 활용한 현업 프로젝트" },
    { key: "hyundai_mobis_llm_4", title: "현대모비스 LLM 4차수", companyName: "현대모비스", courseName: "LLM을 활용한 현업 프로젝트" },
    { key: "woori_ax_forms", title: "우리은행 AX 전문가 양성과정", companyName: "우리은행", courseName: "AX 기획자 과정" },
  ];
  return [...codeEntries, ...fileEntries];
}

function normalize(value: string | null | undefined): string {
  if (!value) return "";
  return value.toLowerCase().replace(/[\s()[\]{}.,:;'"`~!?+\-_/\\|]+/g, "").trim();
}

function matchSheets(
  catalog: CatalogEntry[],
  ths: Array<{ companyName: string | null; courseName: string | null }>
): string[] {
  const matched = new Set<string>();
  for (const th of ths) {
    const company = normalize(th.companyName);
    const course = normalize(th.courseName);
    if (!company && !course) continue;
    for (const c of catalog) {
      const title = normalize(c.title);
      if (!title) continue;
      if (company.length >= 4 && title.includes(company)) {
        matched.add(c.key);
        continue;
      }
      if (course.length >= 4 && title.includes(course)) {
        matched.add(c.key);
        continue;
      }
      if (title.length >= 4 && (company.includes(title) || course.includes(title))) {
        matched.add(c.key);
      }
    }
  }
  return Array.from(matched);
}

interface Verdict {
  name: string;
  level: "L2" | "L3";
  thCount: number;
  importItemCount: number;
  matchedSheets: string[];
  thSamples: Array<{ company: string | null; course: string | null }>;
  catalogSamples: Array<{ key: string; title: string }>;
  classification: "TP" | "FP" | "AMBIGUOUS";
  reason: string;
  recommendation: string;
}

async function main() {
  const catalog = await loadCatalog();
  const allInstructors = [...L2_INSTRUCTORS, ...L3_INSTRUCTORS];

  const importItems = await prisma.satisfactionImportItem.findMany({
    select: {
      candidateName: true,
      candidateCompanyName: true,
      candidateCourseName: true,
    },
  });

  const verdicts: Verdict[] = [];

  for (const name of allInstructors) {
    const isL2 = L2_INSTRUCTORS.includes(name);
    const inst = await prisma.instructor.findUnique({
      where: { name },
      select: { id: true, name: true },
    });
    if (!inst) {
      verdicts.push({
        name,
        level: isL2 ? "L2" : "L3",
        thCount: 0,
        importItemCount: 0,
        matchedSheets: [],
        thSamples: [],
        catalogSamples: [],
        classification: "AMBIGUOUS",
        reason: "Instructor 미존재 (이름 표기 차이?)",
        recommendation: "audit 알고리즘에서 이름 정규화 필요",
      });
      continue;
    }

    const ths = await prisma.teachingHistory.findMany({
      where: { instructorDbId: inst.id },
      select: { companyName: true, courseName: true },
    });

    const matchedSheets = matchSheets(catalog, ths);
    const matchedSheetSamples = matchedSheets.slice(0, 3).map((key) => {
      const entry = catalog.find((c) => c.key === key);
      return { key, title: entry?.title ?? "(unknown)" };
    });

    const companies = Array.from(
      new Set(ths.map((t) => t.companyName).filter((v): v is string => Boolean(v)))
    );
    const courses = Array.from(
      new Set(ths.map((t) => t.courseName).filter((v): v is string => Boolean(v)))
    );

    const importItemCount = importItems.filter(
      (it) =>
        it.candidateName === name ||
        (it.candidateCompanyName && companies.includes(it.candidateCompanyName)) ||
        (it.candidateCourseName && courses.includes(it.candidateCourseName))
    ).length;

    // 분류 휴리스틱
    let classification: Verdict["classification"] = "AMBIGUOUS";
    let reason = "";
    let recommendation = "";

    if (matchedSheets.length === 0) {
      classification = "FP";
      reason = "matched sheets = 0 → audit 분류 오류";
      recommendation = "L1 (시트 부재)로 재분류";
    } else {
      // 강사의 teaching_history에 있는 회사명/과정명이 매칭된 시트의 회사/과정과 정확히 일치하는지 확인
      const sheetEntries = matchedSheets.map((k) => catalog.find((c) => c.key === k)).filter(Boolean) as CatalogEntry[];
      const sheetCompanies = sheetEntries
        .map((e) => normalize(e.companyName ?? ""))
        .filter((v) => v.length >= 4);
      const sheetCourses = sheetEntries
        .map((e) => normalize(e.courseName ?? ""))
        .filter((v) => v.length >= 4);

      const thCompaniesNorm = companies.map(normalize);
      const thCoursesNorm = courses.map(normalize);

      // 회사명 정확 일치 (substring 양방향)
      const companyHit = sheetCompanies.some((sc) =>
        thCompaniesNorm.some((tc) => tc.includes(sc) || sc.includes(tc))
      );
      // 과정명 정확 일치 (≥6 chars 토큰 매칭)
      const courseHit = sheetCourses.some((sc) =>
        thCoursesNorm.some((tc) => {
          if (sc.length < 6 || tc.length < 6) return false;
          return tc.includes(sc) || sc.includes(tc);
        })
      );

      if (companyHit && courseHit) {
        classification = "TP";
        reason = "회사+과정 모두 매칭 — 진짜 그 시트의 강사";
        recommendation = `catalog ${matchedSheets[0]} entry에 expectedInstructors=["${name}"] 추가 검토`;
      } else if (companyHit) {
        classification = "AMBIGUOUS";
        reason = "회사만 매칭, 과정명은 다름 — 같은 회사의 다른 강의일 수 있음";
        recommendation = "사용자 검수: 시트 응답이 이 강사 강의의 만족도인지 확인";
      } else {
        classification = "FP";
        reason = "회사명 일치 안 함 → audit 부분 매칭으로 인한 false positive";
        recommendation = "audit 매칭 알고리즘 strict 보정 (length≥6 + 회사명 양방향 정규화)";
      }
    }

    verdicts.push({
      name,
      level: isL2 ? "L2" : "L3",
      thCount: ths.length,
      importItemCount,
      matchedSheets,
      thSamples: ths.slice(0, 3).map((t) => ({ company: t.companyName, course: t.courseName })),
      catalogSamples: matchedSheetSamples,
      classification,
      reason,
      recommendation,
    });
  }

  // counts
  const tp = verdicts.filter((v) => v.classification === "TP");
  const fp = verdicts.filter((v) => v.classification === "FP");
  const ambig = verdicts.filter((v) => v.classification === "AMBIGUOUS");

  const md: string[] = [];
  md.push("# L2/L3 잔여 강사 false positive 검수");
  md.push(`Generated at: ${new Date().toISOString()}`);
  md.push(`L2 ${L2_INSTRUCTORS.length}명 + L3 ${L3_INSTRUCTORS.length}명 = ${verdicts.length}명 검수`);
  md.push("");
  md.push("## 분류 결과");
  md.push(`- TP (회복 가능, catalog 보강): **${tp.length}명**`);
  md.push(`- FP (audit 오류, L1 재분류): **${fp.length}명**`);
  md.push(`- AMBIGUOUS (사용자 결정 필요): **${ambig.length}명**`);
  md.push("");

  for (const group of [
    { label: "TP — Catalog 보강 시 회복 가능", verdicts: tp },
    { label: "AMBIGUOUS — 사용자 검수 필요", verdicts: ambig },
    { label: "FP — Audit 알고리즘 false positive", verdicts: fp },
  ]) {
    if (group.verdicts.length === 0) continue;
    md.push(`## ${group.label} (${group.verdicts.length}명)`);
    md.push("");
    for (const v of group.verdicts) {
      md.push(`### ${v.name} (${v.level}, th=${v.thCount}, importItems=${v.importItemCount})`);
      md.push(`- 분류: **${v.classification}** — ${v.reason}`);
      md.push(`- 권장: ${v.recommendation}`);
      md.push(`- 강사의 회사/과정 샘플:`);
      for (const s of v.thSamples) {
        md.push(`  - ${s.company ?? "—"} / ${(s.course ?? "—").slice(0, 40)}`);
      }
      md.push(`- 매칭된 catalog 시트:`);
      for (const c of v.catalogSamples) {
        md.push(`  - ${c.key}: ${c.title.slice(0, 50)}`);
      }
      md.push("");
    }
  }

  const reportDir = path.resolve(process.cwd(), "reports");
  await mkdir(reportDir, { recursive: true });
  const mdPath = path.join(reportDir, "l2-l3-residual-audit.md");
  await writeFile(mdPath, md.join("\n"), "utf-8");

  console.log(`L2/L3 잔여 ${verdicts.length}명: TP=${tp.length}, FP=${fp.length}, AMBIGUOUS=${ambig.length}`);
  console.log(`Saved: ${mdPath}`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
