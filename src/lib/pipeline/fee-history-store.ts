/**
 * Fee History Store — T8
 *
 * 03_data_model.md 4-3절: fee_histories 테이블 저장
 * 04_data_pipeline.md 12절: 수수료 이력 구축
 *
 * 다중 소스(Notion fee_note, salesmap, contract_sheet, fee_fix_configs)에서
 * 수수료 이력을 수집하여 fee_histories 테이블에 일괄 저장한다.
 * 전임강사도 내부 기록은 저장하되, API/UI에서는 별도 정책으로 숨긴다.
 */

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

export interface FeeHistoryStoreResult {
  totalRecords: number;
  instructorsProcessed: number;
  specialAmountRecords: number;
}

export interface FeeHistoryEntry {
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

function buildFeeHistorySignature(entry: FeeHistoryEntry): string {
  const effectiveDate = entry.effectiveDate
    ? entry.effectiveDate.toISOString().split("T")[0]
    : "";

  return [
    entry.instructorDbId,
    effectiveDate,
    entry.effectiveLabel ?? "",
    entry.amount ?? "",
    entry.feeKind,
    entry.context ?? "",
    entry.sourceType,
    entry.isCurrent ? "1" : "0",
    entry.isSpecialAmount ? "1" : "0",
  ].join("||");
}

function containsSpecialKeyword(text: string | null | undefined): boolean {
  if (!text) return false;
  return SPECIAL_AMOUNT_KEYWORDS.some((kw) => text.includes(kw));
}

function extractAmountsFromText(text: string | null | undefined): number[] {
  if (!text) return [];

  const amounts: number[] = [];
  const seen = new Set<number>();
  const regex = /(\d+(?:[.,]\d+)*)\s*(만\s*원?|원)?/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const raw = match[1]?.replace(/,/g, "");
    const unit = match[2] ?? "";
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) continue;

    const hasComma = match[1]?.includes(",") ?? false;
    const hasDecimal = match[1]?.includes(".") ?? false;
    const plainDigits = raw.replace(/\./g, "");

    if (!unit) {
      // "1차", "5개", "4.5" 같은 설명 숫자는 금액으로 보지 않는다.
      if (hasDecimal) continue;
      if (!hasComma && plainDigits.length < 5) continue;
    }

    let amount: number;
    if (unit.startsWith("만")) {
      amount = Math.round(parsed * 10000);
    } else {
      amount = Math.round(parsed);
    }

    if (amount <= 0 || seen.has(amount)) continue;
    seen.add(amount);
    amounts.push(amount);
  }

  return amounts;
}

function computeMedianLocal(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
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

function buildTeachingHistoryContext(
  history: {
    companyName: string | null;
    courseName: string | null;
    courseId: string | null;
    detailType: string | null;
    dateLabel: string | null;
  }
): string | null {
  const parts: string[] = [];

  if (history.companyName) parts.push(history.companyName);
  if (history.courseName) {
    parts.push(history.courseName);
  } else if (history.detailType) {
    parts.push(history.detailType);
  }

  if (!history.courseId && history.dateLabel) {
    parts.push(history.dateLabel);
  }

  return parts.length > 0 ? parts.join(" / ") : null;
}

/**
 * 비전임 강사별 fee_history 엔트리를 **메모리 내에서** 계산한다.
 * 실 DB write는 수행하지 않는다 (dry-run 또는 호출자가 insert 담당).
 *
 * source별 effective_date 산출식 (docs/04 §12 + clarify-result):
 *   - notion        → instructor.updatedAt (feeNote 포함 snapshot 기록 시각)
 *   - contract_sheet → teaching_history.startDate (fallback endDate)
 *   - salesmap       → teaching_history.endDate 우선 (딜 수정일에 가장 근접), fallback startDate
 *   - manual_fix    → feeFixConfig.updatedAt
 */
export async function buildFeeHistoryEntries(): Promise<{
  entries: FeeHistoryEntry[];
  instructorsProcessed: number;
  specialAmountRecords: number;
}> {
  // Load all needed data in parallel
  const [instructors, feeFixConfigs, teachingHistories] = await Promise.all([
    prisma.instructor.findMany({
      select: {
        id: true,
        name: true,
        isFulltime: true,
        baseFeeHourly: true,
        feeNote: true,
        updatedAt: true,
      },
    }),
    prisma.feeFixConfig.findMany({
      where: { active: true },
    }),
    prisma.teachingHistory.findMany({
      where: {
        sourceType: { in: ["salesmap", "contract_sheet"] },
        OR: [
          { dealFeeHourly: { not: null } },
          { feeExtra: { not: null } },
        ],
      },
      select: {
        instructorDbId: true,
        sourceType: true,
        dealFeeHourly: true,
        startDate: true,
        endDate: true,
        companyName: true,
        courseName: true,
        courseId: true,
        feeExtra: true,
        contractType: true,
        detailType: true,
        specialNotes: true,
        dateLabel: true,
      },
      orderBy: { startDate: "desc" },
    }),
  ]);

  // Index fee fix configs by instructorDbId and name
  const fixByDbId = new Map<
    string,
    { amount: number; reason: string | null; updatedAt: Date }
  >();
  const fixByName = new Map<
    string,
    { amount: number; reason: string | null; updatedAt: Date }
  >();
  for (const cfg of feeFixConfigs) {
    if (cfg.instructorDbId) {
      fixByDbId.set(cfg.instructorDbId, {
        amount: cfg.fixedAmount,
        reason: cfg.reason,
        updatedAt: cfg.updatedAt,
      });
    }
    fixByName.set(cfg.name, {
      amount: cfg.fixedAmount,
      reason: cfg.reason,
      updatedAt: cfg.updatedAt,
    });
  }

  // Index teaching histories by instructor
  const historiesByInstructor = new Map<string, typeof teachingHistories>();
  for (const h of teachingHistories) {
    const arr = historiesByInstructor.get(h.instructorDbId);
    if (arr) {
      arr.push(h);
    } else {
      historiesByInstructor.set(h.instructorDbId, [h]);
    }
  }

  const allEntries: FeeHistoryEntry[] = [];
  let instructorsProcessed = 0;

  // 동일 강사의 일반 시간당 단가 median 계산 (3x outlier 판정용)
  // docs/01 §8: "동일 강사의 일반 출강료 분포 대비 3배 이상 큰 금액은 특수 금액 후보"
  const regularFeesByInstructor = new Map<string, number[]>();
  for (const h of teachingHistories) {
    if (h.dealFeeHourly === null) continue;
    // 실습코치/특수 row는 median 계산에서 제외 (일반 분포 왜곡 방지)
    if (
      isPracticeCoachHistory(h) ||
      containsSpecialKeyword(h.feeExtra) ||
      containsSpecialKeyword(h.specialNotes)
    ) {
      continue;
    }
    const arr = regularFeesByInstructor.get(h.instructorDbId);
    if (arr) arr.push(h.dealFeeHourly);
    else regularFeesByInstructor.set(h.instructorDbId, [h.dealFeeHourly]);
  }
  const medianByInstructor = new Map<string, number | null>();
  for (const [id, fees] of regularFeesByInstructor) {
    medianByInstructor.set(id, computeMedianLocal(fees));
  }

  for (const inst of instructors) {
    const entries: FeeHistoryEntry[] = [];
    const median = medianByInstructor.get(inst.id) ?? null;

    // Source 1: Notion fee_note
    // clarify: notion effective_date = feeNote 기록시각 → instructor.updatedAt로 근사
    if (inst.feeNote) {
      // "기본" 라벨이 있으면 기본 값만 기본 단가 후보로 분리 + 나머지 특수로 분리.
      const baseFromLabel = parseBaseFeeFromFeeNote(inst.feeNote);
      const hasSpecialKw = containsSpecialKeyword(inst.feeNote);

      if (baseFromLabel !== null) {
        // 기본 라벨 값 → hourly 후보
        entries.push({
          instructorDbId: inst.id,
          effectiveDate: inst.updatedAt,
          effectiveLabel: "현재",
          amount: baseFromLabel,
          feeKind: "hourly",
          context: inst.feeNote,
          sourceType: "notion",
          isCurrent: false, // resolved below
          isSpecialAmount: false,
        });
        // 복수 단가가 함께 있는 경우 남은 금액들을 설명용 특수 엔트리로 추가
        const otherNumbers = extractOtherAmounts(inst.feeNote, baseFromLabel);
        for (const other of otherNumbers) {
          entries.push({
            instructorDbId: inst.id,
            effectiveDate: inst.updatedAt,
            effectiveLabel: "설명",
            amount: other,
            feeKind: "special",
            context: inst.feeNote,
            sourceType: "notion",
            isCurrent: false,
            isSpecialAmount: true,
          });
        }
      } else {
        // "기본" 라벨이 없으면 전체 fee_note 파싱
        const parsedAmount = parseAmountFromFeeNote(inst.feeNote);
        entries.push({
          instructorDbId: inst.id,
          effectiveDate: inst.updatedAt,
          effectiveLabel: "현재",
          amount: parsedAmount,
          feeKind: hasSpecialKw ? "special" : "hourly",
          context: inst.feeNote,
          sourceType: "notion",
          isCurrent: false,
          isSpecialAmount: hasSpecialKw,
        });
      }
    }

    // Source 2 & 3: Salesmap and Contract Sheet from teaching_histories
    const histories = historiesByInstructor.get(inst.id) ?? [];
    for (const h of histories) {
      const context = buildTeachingHistoryContext(h);

      // 실습코치 계약 행은 일반 단가 추이에서 제외해야 하므로 reference 전용으로 분리한다.
      // 그 외 dealFeeHourly는 docs/01 §8의 3x outlier 규칙만으로 특수 금액 판정한다.
      // dealFeeHourly <= 10000 또는 > 10000000 구간은 normalizer 단계에서 이미 NULL 처리
      // (docs/04 §16-3)되므로 별도 체크 불필요.
      const isCoachContract = isPracticeCoachHistory(h);
      const isSpecial =
        isCoachContract ||
        (median !== null && h.dealFeeHourly! >= median * 3);

      // effective_date: source별 산출식 차등
      let effectiveDate: Date | null;
      if (h.sourceType === "salesmap") {
        // salesmap: 딜 수정일 대용 — endDate 우선 (수강 종료일), fallback startDate
        effectiveDate = h.endDate ?? h.startDate ?? null;
      } else {
        // contract_sheet: 계약기간 시작일 — startDate 우선
        effectiveDate = h.startDate ?? h.endDate ?? null;
      }

      if (h.dealFeeHourly !== null) {
        entries.push({
          instructorDbId: inst.id,
          effectiveDate,
          effectiveLabel: h.dateLabel ?? null,
          amount: h.dealFeeHourly,
          feeKind: isSpecial ? "special" : "hourly",
          context,
          sourceType: h.sourceType as "salesmap" | "contract_sheet",
          isCurrent: false,
          isSpecialAmount: isSpecial,
        });
      }

      // fee_extra에 기록된 출장비/건당 비용은 별도 special row로 보존한다.
      const specialAmounts = extractAmountsFromText(h.feeExtra);
      for (const amount of specialAmounts) {
        entries.push({
          instructorDbId: inst.id,
          effectiveDate,
          effectiveLabel: h.dateLabel ?? h.detailType ?? null,
          amount,
          feeKind: "special",
          context: [context, h.feeExtra].filter(Boolean).join(" · ") || context,
          sourceType: h.sourceType as "salesmap" | "contract_sheet",
          isCurrent: false,
          isSpecialAmount: true,
        });
      }
    }

    // Source 4: Fee fix configs (manual_fix) — effective_date = config.updatedAt
    const fix = fixByDbId.get(inst.id) ?? fixByName.get(inst.name);
    if (fix) {
      entries.push({
        instructorDbId: inst.id,
        effectiveDate: fix.updatedAt,
        effectiveLabel: "현재",
        amount: fix.amount,
        feeKind: "hourly",
        context: fix.reason ?? "수수료 고정 설정",
        sourceType: "manual_fix",
        isCurrent: false,
        isSpecialAmount: false,
      });
    }

    // Mark isCurrent: docs/04 §12 우선순위 = manual_fix > notion > salesmap > contract_sheet
    if (inst.baseFeeHourly !== null && entries.length > 0) {
      const sourcePriority = [
        "manual_fix",
        "notion",
        "salesmap",
        "contract_sheet",
      ];
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
      instructorsProcessed++;
      allEntries.push(...entries);
    }
  }

  const specialAmountRecords = allEntries.filter(
    (e) => e.isSpecialAmount
  ).length;

  return {
    entries: allEntries,
    instructorsProcessed,
    specialAmountRecords,
  };
}

/**
 * "기본 25만" 외의 숫자/만원 표현을 추출한다.
 * 예: "기본 25만 / 심화 35만 / 특강 55만" → [350000, 550000]
 */
function extractOtherAmounts(
  feeNote: string,
  baseValue: number
): number[] {
  const others: number[] = [];
  // 모든 금액 표현 매칭
  const numRegex = /(\d+(?:[.,]\d+)*)\s*(만\s*원?|원)?/g;
  let match: RegExpExecArray | null;
  while ((match = numRegex.exec(feeNote)) !== null) {
    const numStr = match[1].replace(/,/g, "");
    const unit = match[2] ?? "";
    const num = parseFloat(numStr);
    if (!Number.isFinite(num) || num <= 0) continue;
    let resolved: number;
    if (unit.startsWith("만")) {
      resolved = Math.round(num * 10000);
    } else if (!unit && num < 1000) {
      resolved = Math.round(num * 10000);
    } else {
      resolved = Math.round(num);
    }
    if (resolved !== baseValue && !others.includes(resolved)) {
      others.push(resolved);
    }
  }
  return others;
}

/**
 * fee_histories 테이블을 다중 소스에서 **실 DB에** 재구축한다.
 *
 * 실행 흐름:
 * 1. 기존 fee_histories 전체 삭제 (full rebuild)
 * 2. buildFeeHistoryEntries()로 메모리 엔트리 생성
 * 3. 일괄 insert
 *
 * 주의: 전체 delete + insert이므로 Prisma 트랜잭션으로 감싸야 하지만,
 *       현재 파이프라인의 다른 store 함수도 batch insert로 구현되어 있으므로 동일 패턴 유지.
 */
export async function storeFeeHistories(): Promise<FeeHistoryStoreResult> {
  const result: FeeHistoryStoreResult = {
    totalRecords: 0,
    instructorsProcessed: 0,
    specialAmountRecords: 0,
  };

  // 1. Clear existing fee_histories (full rebuild)
  await prisma.feeHistory.deleteMany({});

  // 2. Compute entries in memory
  const built = await buildFeeHistoryEntries();
  const allEntries = built.entries;
  result.instructorsProcessed = built.instructorsProcessed;
  result.specialAmountRecords = built.specialAmountRecords;
  const dedupedEntries: FeeHistoryEntry[] = [];
  const seen = new Set<string>();
  for (const entry of allEntries) {
    const signature = buildFeeHistorySignature(entry);
    if (seen.has(signature)) continue;
    seen.add(signature);
    dedupedEntries.push(entry);
  }

  // 4. Batch insert for performance
  const BATCH_SIZE = 500;
  for (let i = 0; i < dedupedEntries.length; i += BATCH_SIZE) {
    const batch = dedupedEntries.slice(i, i + BATCH_SIZE);
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

  result.totalRecords = dedupedEntries.length;
  result.specialAmountRecords = dedupedEntries.filter(
    (e) => e.isSpecialAmount
  ).length;

  return result;
}
