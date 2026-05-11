/**
 * diagnose-alias-ground-truth.ts — KNOWN_ALIASES 별칭 페어의 ground truth 비교 (read-only)
 *
 * 각 별칭 페어의 두 Instructor row의 contact/teaching/satisfaction/source-link를 비교한다.
 * 운영자가 동일인 vs 동명이인 결정을 내릴 수 있도록 증거 수집.
 *
 * 실행:
 *   npm run diagnose:alias-ground-truth
 *
 * 산출:
 *   reports/alias-ground-truth.md (사람 읽기용)
 *   reports/alias-ground-truth.json (구조화)
 *
 * 안전성:
 *   - DB 읽기만. 어떤 INSERT/UPDATE/DELETE도 실행하지 않음.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { KNOWN_ALIASES } from "@/lib/instructor-aliases";

interface InstructorEvidence {
  id: string;
  name: string;
  displayName: string;
  contactEmail: string | null;
  contactPhone: string | null;
  affiliation: string | null;
  categories: string[];
  isFulltime: boolean;
  flag: string | null;
  baseFeeHourly: number | null;
  createdAt: Date;
  teachingHistoryCount: number;
  satisfactionRecordCount: number;
  sourceLinks: Array<{ sourceType: string; externalKey: string }>;
  recentTeachingCompanies: string[]; // 최근 5건의 고객사명 (중복 제거)
}

async function collectEvidence(name: string): Promise<InstructorEvidence | null> {
  const inst = await prisma.instructor.findUnique({
    where: { name },
    include: {
      sourceLinks: {
        select: { sourceType: true, externalKey: true },
      },
      teachingHistories: {
        select: { sourceRef: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 20,
      },
      _count: {
        select: { teachingHistories: true, satisfactionRecords: true },
      },
    },
  });
  if (!inst) return null;

  const recentCompanies = Array.from(
    new Set(
      inst.teachingHistories
        .map((th) => {
          const ref = th.sourceRef as { company?: string } | null;
          return ref?.company || null;
        })
        .filter((c): c is string => Boolean(c))
    )
  ).slice(0, 5);

  return {
    id: inst.id,
    name: inst.name,
    displayName: inst.displayName,
    contactEmail: inst.contactEmail,
    contactPhone: inst.contactPhone,
    affiliation: inst.affiliation,
    categories: inst.categories,
    isFulltime: inst.isFulltime,
    flag: inst.flag,
    baseFeeHourly: inst.baseFeeHourly,
    createdAt: inst.createdAt,
    teachingHistoryCount: inst._count.teachingHistories,
    satisfactionRecordCount: inst._count.satisfactionRecords,
    sourceLinks: inst.sourceLinks,
    recentTeachingCompanies: recentCompanies,
  };
}

interface PairAnalysis {
  canonical: string;
  pair: [string, string];
  evidence: [InstructorEvidence | null, InstructorEvidence | null];
  signals: {
    sameEmail: boolean | null;
    samePhone: boolean | null;
    sameAffiliation: boolean | null;
    overlappingCompanies: string[];
    notionPagesEqual: boolean | null;
    likelihood: "likely_same" | "likely_different" | "insufficient_data";
    reasoning: string;
  };
}

function analyzePair(
  canonical: string,
  pair: [string, string],
  evidence: [InstructorEvidence | null, InstructorEvidence | null]
): PairAnalysis {
  const [a, b] = evidence;
  const signals: PairAnalysis["signals"] = {
    sameEmail: null,
    samePhone: null,
    sameAffiliation: null,
    overlappingCompanies: [],
    notionPagesEqual: null,
    likelihood: "insufficient_data",
    reasoning: "",
  };

  if (!a || !b) {
    signals.reasoning = "한쪽이 DB에 없음";
    return { canonical, pair, evidence, signals };
  }

  // 이메일/전화 비교
  signals.sameEmail =
    Boolean(a.contactEmail) &&
    Boolean(b.contactEmail) &&
    a.contactEmail!.trim().toLowerCase() === b.contactEmail!.trim().toLowerCase();
  signals.samePhone =
    Boolean(a.contactPhone) &&
    Boolean(b.contactPhone) &&
    a.contactPhone!.replace(/[\s\-]/g, "") === b.contactPhone!.replace(/[\s\-]/g, "");
  signals.sameAffiliation =
    Boolean(a.affiliation) &&
    Boolean(b.affiliation) &&
    a.affiliation === b.affiliation;

  // 고객사 overlap
  const setA = new Set(a.recentTeachingCompanies);
  const setB = new Set(b.recentTeachingCompanies);
  signals.overlappingCompanies = [...setA].filter((c) => setB.has(c));

  // 노션 페이지 비교
  const notionA = a.sourceLinks.find((s) => s.sourceType === "notion")?.externalKey;
  const notionB = b.sourceLinks.find((s) => s.sourceType === "notion")?.externalKey;
  if (notionA && notionB) {
    signals.notionPagesEqual = notionA === notionB;
  }

  // 종합 판단
  const reasoning: string[] = [];
  let likelihoodScore = 0; // +면 same, -면 different
  if (signals.sameEmail === true) {
    likelihoodScore += 3;
    reasoning.push("이메일 일치 (+3)");
  } else if (signals.sameEmail === false) {
    likelihoodScore -= 2;
    reasoning.push("이메일 다름 (-2)");
  }
  if (signals.samePhone === true) {
    likelihoodScore += 3;
    reasoning.push("전화 일치 (+3)");
  } else if (signals.samePhone === false) {
    likelihoodScore -= 2;
    reasoning.push("전화 다름 (-2)");
  }
  if (signals.notionPagesEqual === true) {
    likelihoodScore += 2;
    reasoning.push("노션 페이지 동일 (+2)");
  } else if (signals.notionPagesEqual === false) {
    likelihoodScore -= 3;
    reasoning.push("노션 페이지 다름 (-3, 별개 강사 강한 신호)");
  }
  if (signals.sameAffiliation === true) {
    likelihoodScore += 1;
    reasoning.push("소속 일치 (+1)");
  }
  if (signals.overlappingCompanies.length > 0) {
    likelihoodScore += 1;
    reasoning.push(
      `고객사 overlap ${signals.overlappingCompanies.length}건: ${signals.overlappingCompanies.join(", ")}`
    );
  }

  if (likelihoodScore >= 3) signals.likelihood = "likely_same";
  else if (likelihoodScore <= -2) signals.likelihood = "likely_different";
  else signals.likelihood = "insufficient_data";
  signals.reasoning = reasoning.join("; ");

  return { canonical, pair, evidence, signals };
}

async function main() {
  console.log("Phase C2 dry-run — KNOWN_ALIASES ground truth 비교");
  console.log("");

  // 별칭 그룹 추출 (canonical 기준 dedup)
  const groups = new Map<string, [string, string]>();
  for (const [name, group] of Object.entries(KNOWN_ALIASES)) {
    const canonical = group[0];
    if (!groups.has(canonical) && group.length === 2) {
      groups.set(canonical, [group[0], group[1]]);
    }
  }

  console.log(`총 ${groups.size}쌍 검증`);
  console.log("");

  const analyses: PairAnalysis[] = [];
  for (const [canonical, pair] of groups) {
    const [a, b] = await Promise.all([
      collectEvidence(pair[0]),
      collectEvidence(pair[1]),
    ]);
    const analysis = analyzePair(canonical, pair, [a, b]);
    analyses.push(analysis);
  }

  // 보고서 생성
  const lines: string[] = [];
  lines.push(`# KNOWN_ALIASES Ground Truth 비교 (Phase C2 dry-run)\n`);
  lines.push(`Generated at: ${new Date().toISOString()}\n`);
  lines.push(`총 ${groups.size}쌍 분석.\n`);
  lines.push(`---\n`);

  for (const a of analyses) {
    lines.push(`## ${a.canonical} ↔ ${a.pair[1]}\n`);
    const [evA, evB] = a.evidence;
    if (!evA || !evB) {
      lines.push(`⚠️ 한쪽이 DB에 없음. ${evA ? a.pair[0] : a.pair[1]}만 등록됨.\n`);
      continue;
    }
    lines.push(`### 판단: **${a.signals.likelihood}**`);
    lines.push(`근거: ${a.signals.reasoning || "(신호 부족)"}`);
    lines.push(``);
    lines.push(`| 항목 | ${evA.name} | ${evB.name} |`);
    lines.push(`|------|------|------|`);
    lines.push(`| id | \`${evA.id.slice(0, 8)}\` | \`${evB.id.slice(0, 8)}\` |`);
    lines.push(
      `| email | ${evA.contactEmail ?? "—"} | ${evB.contactEmail ?? "—"} |`
    );
    lines.push(
      `| phone | ${evA.contactPhone ?? "—"} | ${evB.contactPhone ?? "—"} |`
    );
    lines.push(
      `| affiliation | ${evA.affiliation ?? "—"} | ${evB.affiliation ?? "—"} |`
    );
    lines.push(
      `| isFulltime | ${evA.isFulltime} | ${evB.isFulltime} |`
    );
    lines.push(`| flag | ${evA.flag ?? "—"} | ${evB.flag ?? "—"} |`);
    lines.push(
      `| baseFeeHourly | ${evA.baseFeeHourly ?? "—"} | ${evB.baseFeeHourly ?? "—"} |`
    );
    lines.push(`| createdAt | ${evA.createdAt.toISOString().slice(0, 10)} | ${evB.createdAt.toISOString().slice(0, 10)} |`);
    lines.push(
      `| teachingHistory | ${evA.teachingHistoryCount}건 | ${evB.teachingHistoryCount}건 |`
    );
    lines.push(
      `| satisfactionRecord | ${evA.satisfactionRecordCount}건 | ${evB.satisfactionRecordCount}건 |`
    );
    const notionA = evA.sourceLinks.find((s) => s.sourceType === "notion")?.externalKey ?? "—";
    const notionB = evB.sourceLinks.find((s) => s.sourceType === "notion")?.externalKey ?? "—";
    lines.push(`| notion page | ${notionA} | ${notionB} |`);
    lines.push(
      `| 최근 고객사 | ${evA.recentTeachingCompanies.join(", ") || "—"} | ${evB.recentTeachingCompanies.join(", ") || "—"} |`
    );
    if (a.signals.overlappingCompanies.length > 0) {
      lines.push(`\n**고객사 overlap**: ${a.signals.overlappingCompanies.join(", ")}\n`);
    }
    lines.push(`\n---\n`);
  }

  lines.push(`## 권장 조치\n`);
  lines.push(`각 페어를 다음 중 하나로 분류:\n`);
  lines.push(`1. **likely_same → confirmed**: 같은 강사. \`repair:duplicate-instructors --mode=alias-merge --pair=<canonical>\`로 merge.`);
  lines.push(`2. **likely_different → split**: 다른 강사. KNOWN_ALIASES에서 제거.`);
  lines.push(`3. **insufficient_data**: 추가 데이터 수집 후 재검토. 우선 분리 유지.\n`);
  lines.push(`각 페어의 결정을 \`KNOWN_ALIASES\`에 반영한 뒤 다시 \`npm run diagnose:alias-ground-truth\`를 실행해 검증.\n`);

  const reportDir = path.resolve(process.cwd(), "reports");
  await mkdir(reportDir, { recursive: true });
  const mdPath = path.join(reportDir, "alias-ground-truth.md");
  const jsonPath = path.join(reportDir, "alias-ground-truth.json");
  await writeFile(mdPath, lines.join("\n"), "utf-8");
  await writeFile(
    jsonPath,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        analyses,
      },
      null,
      2
    ),
    "utf-8"
  );

  console.log("판단 요약:");
  for (const a of analyses) {
    const sig = a.signals;
    console.log(`  ${a.canonical} ↔ ${a.pair[1]}: ${sig.likelihood}`);
    console.log(`    ${sig.reasoning || "(신호 부족)"}`);
  }
  console.log("");
  console.log(`Saved: ${mdPath}`);
  console.log(`Saved: ${jsonPath}`);
}

main()
  .catch((err) => {
    console.error("Diagnosis error:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
