/**
 * diagnose-fee-chip-asymmetry-v2.ts — 단가 칩 매칭 실패 진단 (read-only)
 *
 * v1과 차이:
 *   - v1: noteMatchesTimeline (amount + start_date 정확) 매칭 검증
 *   - v2: 진짜 칩 트리거인 findLatestFeeHistoryCardId (textmatch substring) 재현
 *
 * 매칭 키:
 *   teaching_history → [title, course_name, company_name] (normalize, 4자+)
 *   fee_history → context + notes (timeline) 또는 context + effective_label (reference)
 *
 * 매칭 = 정규화한 teaching key가 fee_history의 정규화된 텍스트에 substring 포함
 *
 * 산출:
 *   reports/fee-chip-asymmetry-v2.md
 *   reports/fee-chip-asymmetry-v2.json
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";

interface FeeRow {
  id: string;
  effectiveDate: Date | null;
  effectiveLabel: string | null;
  amount: number | null;
  feeKind: string;
  context: string | null;
  isSpecialAmount: boolean;
  isCurrent: boolean;
  sourceType: string;
}

interface ThRow {
  id: string;
  companyName: string | null;
  courseName: string | null;
  startDate: Date | null;
  endDate: Date | null;
  dealFeeHourly: number | null;
  specialNotes: string | null;
  feeExtra: string | null;
}

function normalizeFeeLinkText(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[\s()[\]{}.,:;'"`~!?+\-_/\\|]+/g, "")
    .trim();
}

function getTitle(th: ThRow): string {
  // teaching-history-display의 displayTitle 단순 재현 — courseName 우선
  return (th.courseName ?? "").trim();
}

function getMatchKeys(th: ThRow): string[] {
  return Array.from(
    new Set(
      [getTitle(th), th.courseName ?? "", th.companyName ?? ""]
        .map((v) => normalizeFeeLinkText(v))
        .filter((v) => v.length >= 4)
    )
  );
}

function buildSearchBlob(fee: FeeRow): string {
  return normalizeFeeLinkText(
    [fee.context ?? "", fee.effectiveLabel ?? ""].join(" ")
  );
}

function tryTextMatch(
  th: ThRow,
  feeRows: FeeRow[]
): { matchedId: string | null; matchedFee: FeeRow | null } {
  const keys = getMatchKeys(th);
  if (keys.length === 0) return { matchedId: null, matchedFee: null };

  let matched: FeeRow | null = null;
  for (const fee of feeRows) {
    const blob = buildSearchBlob(fee);
    if (keys.some((k) => blob.includes(k))) {
      matched = fee; // 가장 마지막(최신) 매칭 우선 (정렬 가정)
    }
  }
  return { matchedId: matched?.id ?? null, matchedFee: matched };
}

function hasContractNotes(th: ThRow): boolean {
  return Boolean((th.specialNotes ?? "").trim() || (th.feeExtra ?? "").trim());
}

interface Trace {
  name: string;
  isPracticeCoach: boolean;
  isFulltime: boolean;
  flag: string | null;
  feeRowsTotal: number;
  thNotesTotal: number;
  matched: number;
  unmatched: Array<{
    th: ThRow;
    matchKeys: string[];
    closestSamples: Array<{ feeContext: string | null; effectiveLabel: string | null; amount: number | null }>;
  }>;
}

async function trace(name: string): Promise<Trace | null> {
  const inst = await prisma.instructor.findUnique({
    where: { name },
    select: {
      id: true,
      name: true,
      isPracticeCoach: true,
      isFulltime: true,
      flag: true,
    },
  });
  if (!inst) return null;

  const fees = (await prisma.feeHistory.findMany({
    where: { instructorDbId: inst.id },
    orderBy: [{ effectiveDate: "asc" }, { createdAt: "asc" }],
  })) as FeeRow[];
  const ths = (await prisma.teachingHistory.findMany({
    where: { instructorDbId: inst.id },
    orderBy: { startDate: "asc" },
  })) as ThRow[];

  const thNotes = ths.filter(hasContractNotes);
  let matched = 0;
  const unmatched: Trace["unmatched"] = [];
  for (const th of thNotes) {
    const r = tryTextMatch(th, fees);
    if (r.matchedId) {
      matched++;
    } else {
      unmatched.push({
        th,
        matchKeys: getMatchKeys(th),
        closestSamples: fees.slice(0, 3).map((f) => ({
          feeContext: f.context,
          effectiveLabel: f.effectiveLabel,
          amount: f.amount,
        })),
      });
    }
  }

  return {
    name: inst.name,
    isPracticeCoach: inst.isPracticeCoach,
    isFulltime: inst.isFulltime,
    flag: inst.flag,
    feeRowsTotal: fees.length,
    thNotesTotal: thNotes.length,
    matched,
    unmatched,
  };
}

async function main() {
  const targets = ["김인섭", "박요한", "박건민", "신동원", "정백"];
  const traces: Trace[] = [];
  for (const n of targets) {
    const t = await trace(n);
    if (!t) continue;
    traces.push(t);
    console.log(
      `[${t.name}] coach=${t.isPracticeCoach} fulltime=${t.isFulltime} flag=${t.flag} | fee=${t.feeRowsTotal} thNotes=${t.thNotesTotal} matched=${t.matched} unmatched=${t.unmatched.length}`
    );
  }

  const md: string[] = [];
  md.push("# 단가 칩 매칭 진단 v2 — 진짜 textmatch 기준");
  md.push(`Generated at: ${new Date().toISOString()}`);
  md.push("");
  md.push("## 매칭 로직 (재현)");
  md.push("- key = teaching_history의 [title/course_name/company_name] 정규화 후 4자+");
  md.push("- blob = fee_history의 context + effective_label 정규화");
  md.push("- 매칭 = 어떤 key든 blob에 substring 포함");
  md.push("");
  md.push("## 강사별 요약");
  md.push("| 강사 | coach | fulltime | flag | fee | th_notes | matched | unmatched | 매칭률 |");
  md.push("|---|---|---|---|---|---|---|---|---|");
  for (const t of traces) {
    const rate =
      t.thNotesTotal > 0 ? ((t.matched / t.thNotesTotal) * 100).toFixed(1) : "-";
    md.push(
      `| ${t.name} | ${t.isPracticeCoach} | ${t.isFulltime} | ${t.flag ?? "—"} | ${t.feeRowsTotal} | ${t.thNotesTotal} | ${t.matched} | ${t.unmatched.length} | ${rate}% |`
    );
  }
  md.push("");

  for (const t of traces) {
    md.push(`## ${t.name} 매칭 실패 케이스 (top 5)`);
    if (t.unmatched.length === 0) {
      md.push("(모두 매칭 성공)");
      md.push("");
      continue;
    }
    md.push("| 회사 | 과정 | start | dealFee | matchKeys |");
    md.push("|---|---|---|---|---|");
    for (const u of t.unmatched.slice(0, 5)) {
      md.push(
        `| ${u.th.companyName ?? "—"} | ${(u.th.courseName ?? "—").slice(0, 30)} | ${u.th.startDate ? u.th.startDate.toISOString().slice(0, 10) : "—"} | ${u.th.dealFeeHourly ?? "—"} | ${u.matchKeys.join(", ") || "(none)"} |`
      );
    }
    md.push("");
    md.push("**fee_history 샘플 (context):**");
    for (const f of t.unmatched[0]?.closestSamples ?? []) {
      md.push(`- amount=${f.amount} label='${f.effectiveLabel}' context='${f.feeContext}'`);
    }
    md.push("");
  }

  const reportDir = path.resolve(process.cwd(), "reports");
  await mkdir(reportDir, { recursive: true });
  const mdPath = path.join(reportDir, "fee-chip-asymmetry-v2.md");
  const jsonPath = path.join(reportDir, "fee-chip-asymmetry-v2.json");
  await writeFile(mdPath, md.join("\n"), "utf-8");
  await writeFile(
    jsonPath,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        traces: traces.map((t) => ({
          ...t,
          unmatched: t.unmatched.map((u) => ({
            th: {
              ...u.th,
              startDate: u.th.startDate?.toISOString().slice(0, 10) ?? null,
              endDate: u.th.endDate?.toISOString().slice(0, 10) ?? null,
            },
            matchKeys: u.matchKeys,
            closestSamples: u.closestSamples,
          })),
        })),
      },
      null,
      2
    ),
    "utf-8"
  );
  console.log("");
  console.log(`Saved: ${mdPath}`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
