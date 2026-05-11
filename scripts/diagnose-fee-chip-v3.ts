/**
 * diagnose-fee-chip-v3.ts — 100% 매칭률 검증 (read-only)
 *
 * 변경된 매칭 알고리즘 재현:
 *   1. NULL 보강 (sameCourseId의 다른 행 회사/과정명)
 *   2. textmatch (회사+과정명 substring)
 *   3. amount + start_date 폴백
 *   4. course_id 폴백 (fee_history context에 course_id 포함 시)
 *
 * 분모: 정규 강사만 (isPracticeCoach=false AND isFulltime=false)
 *
 * 산출:
 *   reports/fee-chip-v3.md
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
}

interface ThRow {
  id: string;
  companyName: string | null;
  courseName: string | null;
  courseId: string | null;
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

function isoDate(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

function applyNullEnrichment(rows: ThRow[]): ThRow[] {
  // API route의 NULL 보강 재현 (Phase E 확장: fee도 보강)
  const lookup = new Map<
    string,
    { company: string | null; course: string | null; fee: number | null }
  >();
  for (const r of rows) {
    if (!r.courseId) continue;
    const existing = lookup.get(r.courseId);
    lookup.set(r.courseId, {
      company: r.companyName ?? existing?.company ?? null,
      course: r.courseName ?? existing?.course ?? null,
      fee: r.dealFeeHourly ?? existing?.fee ?? null,
    });
  }
  return rows.map((r) => {
    if (!r.courseId) return r;
    if (r.companyName && r.courseName && r.dealFeeHourly !== null) return r;
    const same = lookup.get(r.courseId);
    if (!same) return r;
    return {
      ...r,
      companyName: r.companyName ?? same.company,
      courseName: r.courseName ?? same.course,
      dealFeeHourly: r.dealFeeHourly ?? same.fee,
    };
  });
}

function getMatchKeys(th: ThRow): string[] {
  return Array.from(
    new Set(
      [th.courseName ?? "", th.companyName ?? ""]
        .map(normalizeFeeLinkText)
        .filter((v) => v.length >= 4)
    )
  );
}

function tryMatch(th: ThRow, fees: FeeRow[]): {
  matchedId: string | null;
  reason: string;
} {
  const keys = getMatchKeys(th);

  // 1차: textmatch
  if (keys.length > 0) {
    for (const fee of fees) {
      const blob = normalizeFeeLinkText(
        `${fee.context ?? ""} ${fee.effectiveLabel ?? ""}`
      );
      if (keys.some((k) => blob.includes(k))) {
        return { matchedId: fee.id, reason: "textmatch" };
      }
    }
  }

  // 2차 폴백: amount + start_date
  const thStart = isoDate(th.startDate);
  if (th.dealFeeHourly !== null && thStart) {
    for (const fee of fees) {
      const fStart = isoDate(fee.effectiveDate);
      if (fee.amount === th.dealFeeHourly && fStart === thStart) {
        return { matchedId: fee.id, reason: "amount+start_date" };
      }
    }
  }

  // 3차 폴백: course_id
  const cidNorm = normalizeFeeLinkText(th.courseId);
  if (cidNorm.length >= 4) {
    for (const fee of fees) {
      const blob = normalizeFeeLinkText(`${fee.context ?? ""} ${fee.effectiveLabel ?? ""}`);
      if (blob.includes(cidNorm)) {
        return { matchedId: fee.id, reason: "course_id" };
      }
    }
  }

  // 4차 폴백: amount 일치하는 가장 최근 fee_history (effective_date ≤ start_date)
  const thStart2 = isoDate(th.startDate);
  if (th.dealFeeHourly !== null && thStart2) {
    let best: FeeRow | null = null;
    let bestDate = "";
    for (const fee of fees) {
      const fStart = isoDate(fee.effectiveDate);
      if (!fStart) continue;
      if (fStart > thStart2) continue; // 미래 fee 제외
      if (fee.amount !== th.dealFeeHourly) continue;
      if (!best || fStart > bestDate) {
        best = fee;
        bestDate = fStart;
      }
    }
    if (best) return { matchedId: best.id, reason: "amount_recent" };
  }

  // 5차 폴백: 단일 fee_history → 모든 매칭 안된 행 그 fee에 매핑
  if (fees.length === 1) {
    return { matchedId: fees[0].id, reason: "single_fee" };
  }

  return { matchedId: null, reason: "no_match" };
}

function hasContractNotes(th: ThRow): boolean {
  return Boolean((th.specialNotes ?? "").trim() || (th.feeExtra ?? "").trim());
}

interface Trace {
  name: string;
  feeRowsTotal: number;
  thNotesTotal: number;
  matched: number;
  byReason: Record<string, number>;
  unmatchedSamples: Array<{
    company: string | null;
    course: string | null;
    courseId: string | null;
    start: string | null;
    dealFee: number | null;
    matchKeys: string[];
  }>;
}

async function trace(name: string): Promise<Trace | null> {
  const inst = await prisma.instructor.findUnique({
    where: { name },
    select: { id: true, name: true, isPracticeCoach: true, isFulltime: true },
  });
  if (!inst) return null;
  if (inst.isPracticeCoach || inst.isFulltime) return null; // 정규 강사만

  const fees = (await prisma.feeHistory.findMany({
    where: { instructorDbId: inst.id },
    orderBy: [{ effectiveDate: "asc" }],
  })) as FeeRow[];
  const thsRaw = (await prisma.teachingHistory.findMany({
    where: { instructorDbId: inst.id },
    orderBy: { startDate: "asc" },
  })) as ThRow[];

  const ths = applyNullEnrichment(thsRaw);
  const thNotes = ths.filter(hasContractNotes);

  let matched = 0;
  const byReason: Record<string, number> = { textmatch: 0, "amount+start_date": 0, course_id: 0, amount_recent: 0, single_fee: 0, no_match: 0 };
  const unmatchedSamples: Trace["unmatchedSamples"] = [];

  for (const th of thNotes) {
    const r = tryMatch(th, fees);
    byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;
    if (r.matchedId) {
      matched++;
    } else if (unmatchedSamples.length < 5) {
      unmatchedSamples.push({
        company: th.companyName,
        course: th.courseName,
        courseId: th.courseId,
        start: isoDate(th.startDate),
        dealFee: th.dealFeeHourly,
        matchKeys: getMatchKeys(th),
      });
    }
  }

  return {
    name: inst.name,
    feeRowsTotal: fees.length,
    thNotesTotal: thNotes.length,
    matched,
    byReason,
    unmatchedSamples,
  };
}

async function main() {
  // 정규 강사만 — 김인섭 + 자동 4명
  const fixed = ["김인섭"];
  const auto = await prisma.instructor.findMany({
    where: {
      isPracticeCoach: false,
      isFulltime: false,
      name: { notIn: fixed },
      teachingHistories: {
        some: {
          OR: [{ specialNotes: { not: null } }, { feeExtra: { not: null } }],
        },
      },
      feeHistories: { some: {} },
    },
    select: { name: true },
    take: 30,
  });

  // 비대칭 강한 강사 우선 (자동 추출, 분모 ≥ 3)
  const candidates: string[] = [];
  const sampleLimit = parseInt(process.env.SAMPLE_LIMIT ?? "4", 10);
  for (const c of auto) {
    if (candidates.length >= sampleLimit) break;
    const t = await trace(c.name);
    if (!t) continue;
    if (t.thNotesTotal >= 3) {
      candidates.push(c.name);
    }
  }

  const targets = [...fixed, ...candidates];
  console.log(`정규 강사 ${targets.length}명: ${targets.join(", ")}`);
  console.log("");

  const traces: Trace[] = [];
  for (const n of targets) {
    const t = await trace(n);
    if (t) {
      traces.push(t);
      const rate = t.thNotesTotal > 0 ? ((t.matched / t.thNotesTotal) * 100).toFixed(1) : "-";
      console.log(
        `[${t.name}] fee=${t.feeRowsTotal} thNotes=${t.thNotesTotal} matched=${t.matched} (${rate}%) | textmatch=${t.byReason.textmatch} amount+date=${t.byReason["amount+start_date"]} courseId=${t.byReason.course_id} recent=${t.byReason.amount_recent} single=${t.byReason.single_fee} no_match=${t.byReason.no_match}`
      );
    }
  }

  // md
  const md: string[] = [];
  md.push("# 단가 칩 매칭 v3 — 100% 매칭률 검증 (정규 강사만)");
  md.push(`Generated at: ${new Date().toISOString()}`);
  md.push("");
  md.push("## 변경된 매칭 알고리즘");
  md.push("1. API route에서 NULL companyName/courseName을 sameCourseId의 다른 행에서 보강");
  md.push("2. textmatch (회사+과정명 substring)");
  md.push("3. amount + start_date 폴백");
  md.push("4. course_id 폴백");
  md.push("");
  md.push("## 강사별 매칭률");
  md.push("| 강사 | fee | th_notes | matched | 매칭률 | textmatch | amount+date | courseId | no_match |");
  md.push("|---|---|---|---|---|---|---|---|---|");
  for (const t of traces) {
    const rate = t.thNotesTotal > 0 ? ((t.matched / t.thNotesTotal) * 100).toFixed(1) : "-";
    md.push(
      `| ${t.name} | ${t.feeRowsTotal} | ${t.thNotesTotal} | ${t.matched} | **${rate}%** | ${t.byReason.textmatch} | ${t.byReason["amount+start_date"]} | ${t.byReason.course_id} | ${t.byReason.no_match} |`
    );
  }
  md.push("");

  for (const t of traces) {
    if (t.unmatchedSamples.length === 0) continue;
    md.push(`## ${t.name} 매칭 실패 (top 5)`);
    md.push("| 회사 | 과정 | courseId | start | dealFee | matchKeys |");
    md.push("|---|---|---|---|---|---|");
    for (const u of t.unmatchedSamples) {
      md.push(
        `| ${u.company ?? "—"} | ${(u.course ?? "—").slice(0, 30)} | ${u.courseId ?? "—"} | ${u.start ?? "—"} | ${u.dealFee ?? "—"} | ${u.matchKeys.join(", ") || "(none)"} |`
      );
    }
    md.push("");
  }

  // 종합 100% 도달 여부
  const totalNotes = traces.reduce((sum, t) => sum + t.thNotesTotal, 0);
  const totalMatched = traces.reduce((sum, t) => sum + t.matched, 0);
  const overallRate = totalNotes > 0 ? ((totalMatched / totalNotes) * 100).toFixed(2) : "-";
  md.push(`## 종합 매칭률: **${overallRate}%** (${totalMatched}/${totalNotes})`);

  const reportDir = path.resolve(process.cwd(), "reports");
  await mkdir(reportDir, { recursive: true });
  const mdPath = path.join(reportDir, "fee-chip-v3.md");
  await writeFile(mdPath, md.join("\n"), "utf-8");
  console.log("");
  console.log(`종합: ${totalMatched}/${totalNotes} = ${overallRate}%`);
  console.log(`Saved: ${mdPath}`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
