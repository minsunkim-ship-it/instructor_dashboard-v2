/**
 * Fee History Store — T8
 *
 * 03_data_model.md 4-3절: fee_histories 테이블 저장
 * 04_data_pipeline.md 12절: 수수료 이력 구축
 *
 * 다중 소스(Notion fee_note, salesmap, contract_sheet, fee_fix_configs)에서
 * 수수료 이력을 수집하여 fee_histories 테이블에 일괄 저장한다.
 * 전임강사는 skip한다 (05_api_spec.md 6-4절).
 */

import { prisma } from "@/lib/prisma";

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

export interface FeeHistoryStoreResult {
  totalRecords: number;
  instructorsProcessed: number;
  specialAmountRecords: number;
}

interface FeeHistoryEntry {
  instructorDbId: string;
  effectiveDate: Date | null;
  effectiveLabel: string | null;
  amount: number | null;
  feeKind: string;
  context: string | null;
  sourceType: string;
  isCurrent: boolean;
  isSpecialAmount: boolean;
}

function containsSpecialKeyword(text: string | null | undefined): boolean {
  if (!text) return false;
  return SPECIAL_AMOUNT_KEYWORDS.some((kw) => text.includes(kw));
}

/**
 * Notion feeNote에서 금액을 파싱한다.
 * "만원" 단위 숫자를 원 단위로 변환하거나, 숫자만 있으면 그대로 반환.
 * 파싱 실패 시 null.
 */
function parseAmountFromFeeNote(feeNote: string): number | null {
  // "20만원", "20만" 패턴
  const manwonMatch = feeNote.match(/(\d+(?:\.\d+)?)\s*만\s*원?/);
  if (manwonMatch) {
    return Math.round(parseFloat(manwonMatch[1]) * 10000);
  }
  // "200,000원", "200000" 등 순수 숫자 패턴
  const numMatch = feeNote.match(/(\d{1,3}(?:,?\d{3})+|\d+)\s*원?/);
  if (numMatch) {
    const cleaned = numMatch[1].replace(/,/g, "");
    const val = parseInt(cleaned, 10);
    if (!isNaN(val) && val > 0) return val;
  }
  return null;
}

/**
 * fee_histories 테이블을 다중 소스에서 재구축한다.
 *
 * 실행 흐름:
 * 1. 기존 fee_histories 전체 삭제 (full rebuild)
 * 2. 비전임 강사별로 소스 데이터를 수집
 * 3. isCurrent 마킹: baseFeeHourly와 일치하는 엔트리
 * 4. 일괄 insert
 */
export async function storeFeeHistories(): Promise<FeeHistoryStoreResult> {
  const result: FeeHistoryStoreResult = {
    totalRecords: 0,
    instructorsProcessed: 0,
    specialAmountRecords: 0,
  };

  // 1. Clear existing fee_histories (full rebuild)
  await prisma.feeHistory.deleteMany({});

  // 2. Load all needed data in parallel
  const [instructors, feeFixConfigs, teachingHistories] = await Promise.all([
    prisma.instructor.findMany({
      select: {
        id: true,
        name: true,
        isFulltime: true,
        baseFeeHourly: true,
        feeNote: true,
      },
    }),
    prisma.feeFixConfig.findMany({
      where: { active: true },
    }),
    prisma.teachingHistory.findMany({
      where: {
        sourceType: { in: ["salesmap", "contract_sheet"] },
        dealFeeHourly: { not: null },
      },
      select: {
        instructorDbId: true,
        sourceType: true,
        dealFeeHourly: true,
        startDate: true,
        endDate: true,
        companyName: true,
        courseName: true,
        feeExtra: true,
        specialNotes: true,
        dateLabel: true,
      },
      orderBy: { startDate: "desc" },
    }),
  ]);

  // Index fee fix configs by instructorDbId and name
  const fixByDbId = new Map<string, { amount: number; reason: string | null }>();
  const fixByName = new Map<string, { amount: number; reason: string | null }>();
  for (const cfg of feeFixConfigs) {
    if (cfg.instructorDbId) {
      fixByDbId.set(cfg.instructorDbId, {
        amount: cfg.fixedAmount,
        reason: cfg.reason,
      });
    }
    fixByName.set(cfg.name, {
      amount: cfg.fixedAmount,
      reason: cfg.reason,
    });
  }

  // Index teaching histories by instructor
  const historiesByInstructor = new Map<
    string,
    typeof teachingHistories
  >();
  for (const h of teachingHistories) {
    const arr = historiesByInstructor.get(h.instructorDbId);
    if (arr) {
      arr.push(h);
    } else {
      historiesByInstructor.set(h.instructorDbId, [h]);
    }
  }

  // 3. Build fee history entries per instructor
  const allEntries: FeeHistoryEntry[] = [];

  for (const inst of instructors) {
    // Skip fulltime instructors (05_api_spec.md 6-4)
    if (inst.isFulltime) continue;

    const entries: FeeHistoryEntry[] = [];

    // Source 1: Notion fee_note
    if (inst.feeNote) {
      const parsedAmount = parseAmountFromFeeNote(inst.feeNote);
      const isSpecial = containsSpecialKeyword(inst.feeNote);

      entries.push({
        instructorDbId: inst.id,
        effectiveDate: null,
        effectiveLabel: "현재",
        amount: parsedAmount,
        feeKind: isSpecial ? "special" : "hourly",
        context: inst.feeNote,
        sourceType: "notion",
        isCurrent: false, // will be resolved below
        isSpecialAmount: isSpecial,
      });
    }

    // Source 2 & 3: Salesmap and Contract Sheet from teaching_histories
    const histories = historiesByInstructor.get(inst.id) ?? [];
    for (const h of histories) {
      const contextParts: string[] = [];
      if (h.companyName) contextParts.push(h.companyName);
      if (h.courseName) contextParts.push(h.courseName);
      const context = contextParts.length > 0 ? contextParts.join(" / ") : null;

      const isSpecial =
        containsSpecialKeyword(h.feeExtra) ||
        containsSpecialKeyword(h.specialNotes);

      entries.push({
        instructorDbId: inst.id,
        effectiveDate: h.startDate ?? h.endDate ?? null,
        effectiveLabel: h.dateLabel ?? null,
        amount: h.dealFeeHourly!,
        feeKind: isSpecial ? "special" : "hourly",
        context,
        sourceType: h.sourceType as "salesmap" | "contract_sheet",
        isCurrent: false,
        isSpecialAmount: isSpecial,
      });
    }

    // Source 4: Fee fix configs (manual_fix)
    const fix = fixByDbId.get(inst.id) ?? fixByName.get(inst.name);
    if (fix) {
      entries.push({
        instructorDbId: inst.id,
        effectiveDate: null,
        effectiveLabel: "현재",
        amount: fix.amount,
        feeKind: "hourly",
        context: fix.reason ?? "수수료 고정 설정",
        sourceType: "manual_fix",
        isCurrent: false,
        isSpecialAmount: false,
      });
    }

    // Mark isCurrent: the entry matching baseFeeHourly (prefer manual_fix > notion > salesmap > contract_sheet)
    if (inst.baseFeeHourly !== null && entries.length > 0) {
      const sourcePriority = ["manual_fix", "notion", "salesmap", "contract_sheet"];
      let marked = false;

      for (const src of sourcePriority) {
        if (marked) break;
        for (const e of entries) {
          if (
            e.sourceType === src &&
            e.amount === inst.baseFeeHourly &&
            !e.isSpecialAmount
          ) {
            e.isCurrent = true;
            marked = true;
            break;
          }
        }
      }

      // Fallback: if no source-priority match, mark the first amount match
      if (!marked) {
        for (const e of entries) {
          if (e.amount === inst.baseFeeHourly && !e.isSpecialAmount) {
            e.isCurrent = true;
            break;
          }
        }
      }
    }

    if (entries.length > 0) {
      result.instructorsProcessed++;
      allEntries.push(...entries);
    }
  }

  // 4. Batch insert for performance
  const BATCH_SIZE = 500;
  for (let i = 0; i < allEntries.length; i += BATCH_SIZE) {
    const batch = allEntries.slice(i, i + BATCH_SIZE);
    await prisma.feeHistory.createMany({
      data: batch.map((e) => ({
        instructorDbId: e.instructorDbId,
        effectiveDate: e.effectiveDate,
        effectiveLabel: e.effectiveLabel,
        amount: e.amount,
        feeKind: e.feeKind,
        context: e.context,
        sourceType: e.sourceType,
        isCurrent: e.isCurrent,
        isSpecialAmount: e.isSpecialAmount,
      })),
    });
  }

  result.totalRecords = allEntries.length;
  result.specialAmountRecords = allEntries.filter(
    (e) => e.isSpecialAmount
  ).length;

  return result;
}
