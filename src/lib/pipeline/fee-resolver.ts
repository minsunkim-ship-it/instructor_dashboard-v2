import { prisma } from "@/lib/prisma";
import { parseBaseFeeFromFeeNote } from "./fee-utils";
import { isPracticeCoachHistory } from "./practice-coach-utils";

const SPECIAL_AMOUNT_KEYWORDS = [
  "콘텐츠",
  "제작",
  "개발비",
  "출장비",
  "별도",
  "건당",
  "프로젝트",
  "패키지",
  "특강",
  "자료개발",
  "원고",
  "감수",
];

export interface FeeResolverResult {
  resolved: number;
  unchanged: number;
  specialDetected: number;
  skippedFulltime: number;
}

function containsSpecialKeyword(text: string | null): boolean {
  if (!text) return false;
  return SPECIAL_AMOUNT_KEYWORDS.some((kw) => text.includes(kw));
}

function computeMode(values: number[]): number | null {
  if (values.length === 0) return null;
  const freq = new Map<number, number>();
  for (const v of values) {
    freq.set(v, (freq.get(v) ?? 0) + 1);
  }
  let maxCount = 0;
  let mode: number | null = null;
  for (const [val, count] of freq) {
    if (count > maxCount) {
      maxCount = count;
      mode = val;
    }
  }
  return mode;
}

function computeMedian(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

export async function resolveFees(): Promise<FeeResolverResult> {
  const result: FeeResolverResult = {
    resolved: 0,
    unchanged: 0,
    specialDetected: 0,
    skippedFulltime: 0,
  };

  const instructors = await prisma.instructor.findMany({
    select: {
      id: true,
      name: true,
      isFulltime: true,
      baseFeeHourly: true,
      feeNote: true,
    },
  });

  const feeFixConfigs = await prisma.feeFixConfig.findMany({
    where: { active: true },
  });

  const fixByDbId = new Map<string, number>();
  const fixByName = new Map<string, number>();
  for (const cfg of feeFixConfigs) {
    if (cfg.instructorDbId) {
      fixByDbId.set(cfg.instructorDbId, cfg.fixedAmount);
    }
    fixByName.set(cfg.name, cfg.fixedAmount);
  }

  const allHistories = await prisma.teachingHistory.findMany({
    where: {
      sourceType: { in: ["salesmap", "contract_sheet"] },
      dealFeeHourly: { not: null },
    },
    select: {
      instructorDbId: true,
      sourceType: true,
      dealFeeHourly: true,
      feeExtra: true,
      contractType: true,
      detailType: true,
      specialNotes: true,
    },
  });

  interface HistoryEntry {
    dealFeeHourly: number;
    feeExtra: string | null;
    contractType: string | null;
    detailType: string | null;
    specialNotes: string | null;
  }

  const salesmapByInstructor = new Map<string, HistoryEntry[]>();
  const contractByInstructor = new Map<string, HistoryEntry[]>();

  for (const h of allHistories) {
    const entry: HistoryEntry = {
      dealFeeHourly: h.dealFeeHourly!,
      feeExtra: h.feeExtra,
      contractType: h.contractType,
      detailType: h.detailType,
      specialNotes: h.specialNotes,
    };
    const map =
      h.sourceType === "salesmap"
        ? salesmapByInstructor
        : contractByInstructor;
    const arr = map.get(h.instructorDbId);
    if (arr) {
      arr.push(entry);
    } else {
      map.set(h.instructorDbId, [entry]);
    }
  }

  const updateBatch: { id: string; baseFeeHourly: number }[] = [];

  for (const inst of instructors) {
    if (inst.isFulltime) {
      // 전임강사: docs/04 §12-2 — 노션 기본 강사료 또는 fee_note 기준만 유지.
      // 이미 Notion 단계에서 baseFeeHourly/feeNote가 반영되었으므로 resolveFees는 skip.
      result.skippedFulltime++;
      continue;
    }

    const salesmapEntries = salesmapByInstructor.get(inst.id) ?? [];
    const contractEntries = contractByInstructor.get(inst.id) ?? [];
    const allEntries = [...salesmapEntries, ...contractEntries];

    const regularFees = allEntries
      .filter(
        (e) =>
          !isPracticeCoachHistory(e) &&
          !containsSpecialKeyword(e.feeExtra) &&
          !containsSpecialKeyword(e.specialNotes)
      )
      .map((e) => e.dealFeeHourly);

    const median = computeMedian(regularFees);

    let specialCount = 0;
    for (const e of allEntries) {
      const isKeyword =
        containsSpecialKeyword(e.feeExtra) ||
        containsSpecialKeyword(e.specialNotes);
      const isOutlier =
        median !== null && e.dealFeeHourly >= median * 3;
      if (isKeyword || isOutlier) {
        specialCount++;
      }
    }
    if (containsSpecialKeyword(inst.feeNote)) {
      specialCount = Math.max(specialCount, 1);
    }
    result.specialDetected += specialCount;

    const filterSpecial = (entries: HistoryEntry[]): number[] => {
      return entries
        .filter((e) => {
          if (isPracticeCoachHistory(e)) return false;
          if (
            containsSpecialKeyword(e.feeExtra) ||
            containsSpecialKeyword(e.specialNotes)
          )
            return false;
          if (median !== null && e.dealFeeHourly >= median * 3) return false;
          return true;
        })
        .map((e) => e.dealFeeHourly);
    };

    // Priority 1: fee_fix_configs (docs/04 §12-1)
    let resolvedFee: number | null =
      fixByDbId.get(inst.id) ?? fixByName.get(inst.name) ?? null;

    // Priority 2: Notion base fee or fee_note "기본" 라벨
    // inst.baseFeeHourly는 이미 Notion upsert에서 반영되어 있음.
    // baseFeeHourly가 null일 때만 fee_note에서 "기본" 라벨 값을 추가 추출.
    if (resolvedFee === null && inst.baseFeeHourly !== null) {
      result.unchanged++;
      continue;
    }
    if (resolvedFee === null) {
      const fromFeeNote = parseBaseFeeFromFeeNote(inst.feeNote);
      if (fromFeeNote !== null) {
        resolvedFee = fromFeeNote;
      }
    }

    // Priority 3: Salesmap mode
    if (resolvedFee === null) {
      const validSalesmap = filterSpecial(salesmapEntries);
      resolvedFee = computeMode(validSalesmap);
    }

    // Priority 4: Contract sheet mode
    if (resolvedFee === null) {
      const validContract = filterSpecial(contractEntries);
      resolvedFee = computeMode(validContract);
    }

    if (resolvedFee === null) {
      result.unchanged++;
      continue;
    }

    if (resolvedFee === inst.baseFeeHourly) {
      result.unchanged++;
      continue;
    }

    updateBatch.push({ id: inst.id, baseFeeHourly: resolvedFee });
    result.resolved++;
  }

  const BATCH_SIZE = 500;
  for (let i = 0; i < updateBatch.length; i += BATCH_SIZE) {
    const batch = updateBatch.slice(i, i + BATCH_SIZE);
    await prisma.$transaction(
      batch.map((item) =>
        prisma.instructor.update({
          where: { id: item.id },
          data: { baseFeeHourly: item.baseFeeHourly },
        })
      )
    );
  }

  return result;
}
