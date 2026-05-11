/**
 * diagnose-fee-history-asymmetry.ts — 강사료 이력 ↔ 단가 칩 비대칭 진단 (read-only)
 *
 * 가설:
 *   1. fee_history.is_special_amount = true 인 항목은 collapseFeeTimeline에서 제외 →
 *      강사료 이력 화면에는 보이지만 단가 칩의 매칭 대상에서 빠짐.
 *   2. fee_kind !== "hourly" 인 항목도 timeline에서 제외.
 *   3. amount 또는 effective_date(또는 effective_label 파싱 결과)와
 *      teaching_history.deal_fee_hourly + start_date 가 정확히 일치해야 attach 됨.
 *
 * 비교 대상:
 *   - 김인섭 (사용자 지정)
 *   - fee_history × teaching_history 비대칭이 강한 강사 4명 (자동 추출)
 *
 * 안전성: read-only. 어떤 INSERT/UPDATE/DELETE도 실행하지 않음.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";

interface FeeHistoryRow {
  id: string;
  effectiveDate: Date | null;
  effectiveLabel: string | null;
  amount: number | null;
  feeKind: string;
  context: string | null;
  sourceType: string;
  isCurrent: boolean;
  isSpecialAmount: boolean;
}

interface TeachingHistoryRow {
  id: string;
  companyName: string | null;
  courseName: string | null;
  startDate: Date | null;
  endDate: Date | null;
  dealFeeHourly: number | null;
  specialNotes: string | null;
  feeExtra: string | null;
}

interface InstructorTrace {
  name: string;
  id: string;
  feeHistoryAll: FeeHistoryRow[];
  feeHistoryTimeline: FeeHistoryRow[]; // collapseFeeTimeline 필터 통과한 것
  feeHistoryFilteredOut: Array<{ row: FeeHistoryRow; reason: string }>;
  teachingHistoryWithNotes: Array<{
    row: TeachingHistoryRow;
    notes: string[];
    matched: boolean;
    matchedFeeHistoryId: string | null;
    mismatchReason: string | null;
  }>;
  symmetryStats: {
    feeHistoryTotalRows: number;
    feeHistoryTimelineRows: number;
    teachingNotesRows: number;
    matchedNotes: number;
    unmatchedNotes: number;
    specialAmountRows: number;
    nonHourlyRows: number;
  };
}

function isoDate(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

/**
 * collapseFeeTimeline 필터 재현 (InstructorDetail.tsx:540-543).
 * 추가로 필터 통과/탈락 사유를 분리.
 */
function applyTimelineFilter(rows: FeeHistoryRow[]): {
  pass: FeeHistoryRow[];
  filteredOut: Array<{ row: FeeHistoryRow; reason: string }>;
} {
  const pass: FeeHistoryRow[] = [];
  const filteredOut: Array<{ row: FeeHistoryRow; reason: string }> = [];
  for (const r of rows) {
    if (r.isSpecialAmount) {
      filteredOut.push({ row: r, reason: "is_special_amount=true (timeline 제외)" });
      continue;
    }
    if (r.feeKind !== "hourly") {
      filteredOut.push({ row: r, reason: `fee_kind=${r.feeKind} (hourly 아님)` });
      continue;
    }
    if (r.amount === null) {
      filteredOut.push({ row: r, reason: "amount=null" });
      continue;
    }
    const sortKey = isoDate(r.effectiveDate);
    if (!sortKey) {
      filteredOut.push({
        row: r,
        reason: `effective_date 없음 (label='${r.effectiveLabel}' — 파싱 가능 여부 별도)`,
      });
      continue;
    }
    pass.push(r);
  }
  return { pass, filteredOut };
}

/**
 * noteMatchesTimeline 재현 (InstructorDetail.tsx:798-807).
 * 매칭 실패 시 어느 키 때문인지 보고.
 */
function tryMatch(
  th: TeachingHistoryRow,
  feeRows: FeeHistoryRow[]
): { matchedId: string | null; reason: string | null } {
  if (th.dealFeeHourly === null) {
    return { matchedId: null, reason: "teaching_history.deal_fee_hourly=null" };
  }
  const thStart = isoDate(th.startDate);
  if (!thStart) {
    return { matchedId: null, reason: "teaching_history.start_date=null" };
  }

  for (const fee of feeRows) {
    const feeStart = isoDate(fee.effectiveDate);
    if (fee.amount === th.dealFeeHourly && feeStart === thStart) {
      return { matchedId: fee.id, reason: null };
    }
  }

  // 부분 일치 진단
  const sameAmount = feeRows.filter((f) => f.amount === th.dealFeeHourly);
  const sameDate = feeRows.filter((f) => isoDate(f.effectiveDate) === thStart);

  if (sameAmount.length > 0 && sameDate.length === 0) {
    return {
      matchedId: null,
      reason: `amount 일치하나(${th.dealFeeHourly}) start_date 다름 (TH=${thStart}, FH=${sameAmount.map((f) => isoDate(f.effectiveDate) || `label='${f.effectiveLabel}'`).join("|")})`,
    };
  }
  if (sameDate.length > 0 && sameAmount.length === 0) {
    return {
      matchedId: null,
      reason: `start_date 일치하나(${thStart}) amount 다름 (TH=${th.dealFeeHourly}, FH=${sameDate.map((f) => f.amount).join("|")})`,
    };
  }
  return {
    matchedId: null,
    reason: `amount/start_date 모두 다름 (TH amount=${th.dealFeeHourly} start=${thStart})`,
  };
}

function hasContractNotes(th: TeachingHistoryRow): boolean {
  const text = `${th.specialNotes ?? ""}\n${th.feeExtra ?? ""}`;
  return text.trim().length > 0;
}

async function traceInstructor(name: string): Promise<InstructorTrace | null> {
  const inst = await prisma.instructor.findUnique({
    where: { name },
    select: { id: true, name: true },
  });
  if (!inst) return null;

  const fhRaw = await prisma.feeHistory.findMany({
    where: { instructorDbId: inst.id },
    orderBy: { effectiveDate: "asc" },
  });
  const thRaw = await prisma.teachingHistory.findMany({
    where: { instructorDbId: inst.id },
    orderBy: { startDate: "asc" },
  });

  const feeHistoryAll: FeeHistoryRow[] = fhRaw.map((r) => ({
    id: r.id,
    effectiveDate: r.effectiveDate,
    effectiveLabel: r.effectiveLabel,
    amount: r.amount,
    feeKind: r.feeKind,
    context: r.context,
    sourceType: r.sourceType,
    isCurrent: r.isCurrent,
    isSpecialAmount: r.isSpecialAmount,
  }));

  const { pass: feeHistoryTimeline, filteredOut } = applyTimelineFilter(feeHistoryAll);

  const teachingNotes = thRaw
    .map((r) => ({
      id: r.id,
      companyName: r.companyName,
      courseName: r.courseName,
      startDate: r.startDate,
      endDate: r.endDate,
      dealFeeHourly: r.dealFeeHourly,
      specialNotes: r.specialNotes,
      feeExtra: r.feeExtra,
    }))
    .filter(hasContractNotes);

  const teachingHistoryWithNotes = teachingNotes.map((th) => {
    const m = tryMatch(th, feeHistoryTimeline);
    const noteText = `${th.specialNotes ?? ""}\n${th.feeExtra ?? ""}`
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    return {
      row: th,
      notes: noteText,
      matched: Boolean(m.matchedId),
      matchedFeeHistoryId: m.matchedId,
      mismatchReason: m.reason,
    };
  });

  const matchedNotes = teachingHistoryWithNotes.filter((t) => t.matched).length;
  const unmatchedNotes = teachingHistoryWithNotes.filter((t) => !t.matched).length;
  const specialAmountRows = feeHistoryAll.filter((f) => f.isSpecialAmount).length;
  const nonHourlyRows = feeHistoryAll.filter((f) => f.feeKind !== "hourly").length;

  return {
    name: inst.name,
    id: inst.id,
    feeHistoryAll,
    feeHistoryTimeline,
    feeHistoryFilteredOut: filteredOut,
    teachingHistoryWithNotes,
    symmetryStats: {
      feeHistoryTotalRows: feeHistoryAll.length,
      feeHistoryTimelineRows: feeHistoryTimeline.length,
      teachingNotesRows: teachingHistoryWithNotes.length,
      matchedNotes,
      unmatchedNotes,
      specialAmountRows,
      nonHourlyRows,
    },
  };
}

async function findAsymmetricInstructors(
  excludeNames: string[],
  limit: number
): Promise<string[]> {
  // 후보: fee_history 항목 보유 + teaching_history 중 special_notes 또는 fee_extra 있는 행 보유
  const candidates = await prisma.instructor.findMany({
    where: {
      AND: [
        { feeHistories: { some: {} } },
        {
          teachingHistories: {
            some: {
              OR: [
                { specialNotes: { not: null } },
                { feeExtra: { not: null } },
              ],
            },
          },
        },
        { name: { notIn: excludeNames } },
      ],
    },
    select: { id: true, name: true },
    take: 200,
  });

  // 각 강사에 대해 비대칭 점수 계산
  const scored: Array<{ name: string; score: number; signals: string[] }> = [];
  for (const c of candidates) {
    const t = await traceInstructor(c.name);
    if (!t) continue;
    const s = t.symmetryStats;
    if (s.teachingNotesRows === 0) continue;
    let score = 0;
    const signals: string[] = [];
    if (s.unmatchedNotes > 0) {
      score += s.unmatchedNotes * 2;
      signals.push(`unmatched_notes=${s.unmatchedNotes}`);
    }
    if (s.specialAmountRows > 0) {
      score += s.specialAmountRows * 3;
      signals.push(`special_amount=${s.specialAmountRows}`);
    }
    if (s.nonHourlyRows > 0) {
      score += s.nonHourlyRows;
      signals.push(`non_hourly=${s.nonHourlyRows}`);
    }
    if (score > 0) {
      scored.push({ name: t.name, score, signals });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.name);
}

function summarizeTrace(t: InstructorTrace): string[] {
  const lines: string[] = [];
  lines.push(`## ${t.name}`);
  const s = t.symmetryStats;
  lines.push(`- fee_history: 전체 ${s.feeHistoryTotalRows}건, timeline 통과 ${s.feeHistoryTimelineRows}건, special_amount ${s.specialAmountRows}건, 비-hourly ${s.nonHourlyRows}건`);
  lines.push(`- teaching contract notes: ${s.teachingNotesRows}건 (matched ${s.matchedNotes} / unmatched ${s.unmatchedNotes})`);
  lines.push("");

  if (t.feeHistoryFilteredOut.length > 0) {
    lines.push(`### timeline에서 제외된 fee_history (단가 칩 매칭 후보 아님)`);
    lines.push(`| amount | effective_date | label | fee_kind | special | context | reason |`);
    lines.push(`|---|---|---|---|---|---|---|`);
    for (const f of t.feeHistoryFilteredOut.slice(0, 10)) {
      lines.push(
        `| ${f.row.amount ?? "—"} | ${isoDate(f.row.effectiveDate) ?? "—"} | ${f.row.effectiveLabel ?? "—"} | ${f.row.feeKind} | ${f.row.isSpecialAmount} | ${f.row.context ?? "—"} | ${f.reason} |`
      );
    }
    lines.push("");
  }

  if (t.teachingHistoryWithNotes.length > 0) {
    lines.push(`### teaching_history (contract notes 보유) — 매칭 결과`);
    lines.push(`| 회사 | 과정 | start | deal_fee | matched | reason |`);
    lines.push(`|---|---|---|---|---|---|`);
    for (const th of t.teachingHistoryWithNotes.slice(0, 15)) {
      lines.push(
        `| ${th.row.companyName ?? "—"} | ${(th.row.courseName ?? "—").slice(0, 30)} | ${isoDate(th.row.startDate) ?? "—"} | ${th.row.dealFeeHourly ?? "—"} | ${th.matched ? "✅" : "❌"} | ${th.mismatchReason ?? "—"} |`
      );
    }
    lines.push("");
  }
  lines.push("---");
  return lines;
}

async function main() {
  console.log("Phase 3 — 강사료 이력 ↔ 단가 칩 비대칭 진단");
  console.log("");

  const targets: string[] = ["김인섭"];
  console.log("자동 추출 대상 4명 검색 중...");
  const auto = await findAsymmetricInstructors(targets, 4);
  targets.push(...auto);

  console.log(`대상 ${targets.length}명: ${targets.join(", ")}`);
  console.log("");

  const traces: InstructorTrace[] = [];
  for (const name of targets) {
    const t = await traceInstructor(name);
    if (t) {
      traces.push(t);
      const s = t.symmetryStats;
      console.log(`[${t.name}] FH ${s.feeHistoryTotalRows}/${s.feeHistoryTimelineRows} (special=${s.specialAmountRows}), TH notes ${s.teachingNotesRows} (matched ${s.matchedNotes}/${s.unmatchedNotes})`);
    }
  }

  // md 보고서
  const md: string[] = [];
  md.push(`# 강사료 이력 ↔ 단가 칩 비대칭 진단 보고서`);
  md.push(`Generated at: ${new Date().toISOString()}`);
  md.push("");
  md.push(`총 ${traces.length}명 trace.`);
  md.push("");
  md.push(`## 매칭 로직 (현재)`);
  md.push("```typescript");
  md.push(`function noteMatchesTimeline(note, item):`);
  md.push(`  return note.amount === item.amount AND note.start_date === item.start_key`);
  md.push("");
  md.push(`function collapseFeeTimeline 필터:`);
  md.push(`  !item.is_special_amount AND item.fee_kind === "hourly" AND item.amount !== null AND label`);
  md.push("```");
  md.push("");
  md.push(`---`);
  md.push("");
  for (const t of traces) {
    md.push(...summarizeTrace(t));
  }

  // 종합 요약
  md.push(`## 종합 요약`);
  md.push(`| 강사 | FH total | FH timeline | special | non_hourly | TH notes | matched | unmatched |`);
  md.push(`|---|---|---|---|---|---|---|---|`);
  for (const t of traces) {
    const s = t.symmetryStats;
    md.push(
      `| ${t.name} | ${s.feeHistoryTotalRows} | ${s.feeHistoryTimelineRows} | ${s.specialAmountRows} | ${s.nonHourlyRows} | ${s.teachingNotesRows} | ${s.matchedNotes} | ${s.unmatchedNotes} |`
    );
  }
  md.push("");

  const reportDir = path.resolve(process.cwd(), "reports");
  await mkdir(reportDir, { recursive: true });
  const mdPath = path.join(reportDir, "fee-history-asymmetry.md");
  const jsonPath = path.join(reportDir, "fee-history-asymmetry.json");
  await writeFile(mdPath, md.join("\n"), "utf-8");
  await writeFile(
    jsonPath,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        traces: traces.map((t) => ({
          ...t,
          // Date를 string으로 직렬화
          feeHistoryAll: t.feeHistoryAll.map((f) => ({ ...f, effectiveDate: isoDate(f.effectiveDate) })),
          feeHistoryTimeline: t.feeHistoryTimeline.map((f) => ({ ...f, effectiveDate: isoDate(f.effectiveDate) })),
          feeHistoryFilteredOut: t.feeHistoryFilteredOut.map((x) => ({
            row: { ...x.row, effectiveDate: isoDate(x.row.effectiveDate) },
            reason: x.reason,
          })),
          teachingHistoryWithNotes: t.teachingHistoryWithNotes.map((th) => ({
            ...th,
            row: { ...th.row, startDate: isoDate(th.row.startDate), endDate: isoDate(th.row.endDate) },
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
  console.log(`Saved: ${jsonPath}`);
}

main()
  .catch((err) => {
    console.error("Diagnosis error:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
