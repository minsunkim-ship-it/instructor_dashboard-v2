/**
 * diagnose-pre-migration-state.ts — Phase C0 사전 점검 (read-only)
 *
 * 마이그레이션 전 Railway DB의 강사/만족도/Review 큐 카운트를 스냅샷한다.
 * KNOWN_ALIASES 적용 시 영향받을 강사 후보를 식별한다 (실제 merge는 안 함).
 *
 * 사용:
 *   npm run diagnose:pre-migration
 *
 * 산출:
 *   reports/pre-migration-snapshot.json
 *
 * 안전성:
 *   - DB 읽기만 수행. 어떤 INSERT/UPDATE/DELETE도 실행하지 않음.
 *   - DATABASE_URL이 Railway일 때 안전하게 실행 가능.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { KNOWN_ALIASES, getAllAliases } from "@/lib/instructor-aliases";

async function main() {
  console.log("Phase C0 — Pre-migration DB diagnosis (read-only)");
  console.log("");

  const startedAt = new Date().toISOString();

  // 1. 핵심 테이블 카운트
  const counts = {
    Instructor: await prisma.instructor.count(),
    TeachingHistory: await prisma.teachingHistory.count(),
    SatisfactionRecord: await prisma.satisfactionRecord.count(),
    SatisfactionImportItem: await prisma.satisfactionImportItem.count(),
    SatisfactionReviewRegistry_pending: await prisma.satisfactionReviewRegistry.count({
      where: { matchStatus: "pending" },
    }),
    SatisfactionReviewRegistry_total: await prisma.satisfactionReviewRegistry.count(),
    ActivityImportItem: await prisma.activityImportItem.count(),
    ActivityReviewRegistry_pending: await prisma.activityReviewRegistry.count({
      where: { matchStatus: "pending" },
    }),
    SourceLink: await prisma.sourceLink.count(),
    ValidationIssue_auto_fixed: await prisma.validationIssue.count({
      where: { autoFixed: true },
    }),
    ValidationIssue_total: await prisma.validationIssue.count(),
  };

  console.log("DB 카운트:");
  for (const [k, v] of Object.entries(counts)) {
    console.log(`  ${k.padEnd(40)} ${v}`);
  }

  // 2. KNOWN_ALIASES 영향 분석 — 별칭 그룹별로 강사가 몇 명 등록되어 있는지
  const aliasGroups = new Map<string, string[]>();
  for (const [name, group] of Object.entries(KNOWN_ALIASES)) {
    const canonical = group[0];
    if (!aliasGroups.has(canonical)) {
      aliasGroups.set(canonical, getAllAliases(canonical));
    }
  }

  const aliasImpact: Array<{
    canonical: string;
    aliases: string[];
    foundInstructors: { id: string; name: string; createdAt: Date }[];
    risk: "no_match" | "single_match" | "alias_resolved" | "duplicate_split";
  }> = [];

  for (const [canonical, aliases] of aliasGroups) {
    const found = await prisma.instructor.findMany({
      where: { name: { in: aliases } },
      select: { id: true, name: true, createdAt: true },
    });
    let risk: typeof aliasImpact[0]["risk"];
    if (found.length === 0) risk = "no_match";
    else if (found.length === 1) risk = "single_match";
    else if (found.length === aliases.length) risk = "duplicate_split"; // 모든 별칭이 별개 row
    else risk = "alias_resolved"; // 일부 별칭만 등록
    aliasImpact.push({ canonical, aliases, foundInstructors: found, risk });
  }

  console.log("");
  console.log("KNOWN_ALIASES 영향 분석:");
  for (const item of aliasImpact) {
    const names = item.foundInstructors.map((i) => i.name).join(", ") || "(없음)";
    console.log(
      `  ${item.canonical.padEnd(20)} aliases=[${item.aliases.join(", ")}]`
    );
    console.log(
      `    found ${item.foundInstructors.length}: ${names}  → risk: ${item.risk}`
    );
  }

  // 3. 위험 요약
  const risks = {
    duplicate_split: aliasImpact.filter((i) => i.risk === "duplicate_split"),
    alias_resolved: aliasImpact.filter((i) => i.risk === "alias_resolved"),
    single_match: aliasImpact.filter((i) => i.risk === "single_match"),
    no_match: aliasImpact.filter((i) => i.risk === "no_match"),
  };

  console.log("");
  console.log("위험 요약:");
  console.log(
    `  duplicate_split: ${risks.duplicate_split.length}건 — Phase C2에서 retroactive merge 필요`
  );
  console.log(
    `  alias_resolved: ${risks.alias_resolved.length}건 — 일부 별칭만 등록, 별칭 lookup으로 자동 해결됨`
  );
  console.log(
    `  single_match: ${risks.single_match.length}건 — 별칭 1개만 등록, 추가 source 수집 시 신규 강사 가능성`
  );
  console.log(`  no_match: ${risks.no_match.length}건 — DB에 없는 강사 (수집 후 등장 가능)`);

  // 4. 보고서 저장
  const reportDir = path.resolve(process.cwd(), "reports");
  await mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, "pre-migration-snapshot.json");
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        generated_at: startedAt,
        counts,
        alias_impact: aliasImpact,
        risk_summary: {
          duplicate_split: risks.duplicate_split.length,
          alias_resolved: risks.alias_resolved.length,
          single_match: risks.single_match.length,
          no_match: risks.no_match.length,
        },
      },
      null,
      2
    ),
    "utf-8"
  );
  console.log(`\nSaved: ${reportPath}`);
}

main()
  .catch((err) => {
    console.error("Diagnosis error:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
