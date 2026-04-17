/**
 * Group 3 pure unit tests — T6/T7/T8
 *
 * DB 접근 없이 sample 데이터만으로 판정 규칙을 검증한다.
 * 실행: npx tsx scripts/unit-test-group3.ts
 */

import { parseBaseFeeFromFeeNote } from "../src/lib/pipeline/fee-resolver";

let passed = 0;
let failed = 0;

function assertEq<T>(label: string, actual: T, expected: T) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  [PASS] ${label}`);
    passed++;
  } else {
    console.log(`  [FAIL] ${label}`);
    console.log(`    expected: ${JSON.stringify(expected)}`);
    console.log(`    actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

// ====== T7: parseBaseFeeFromFeeNote 단위 테스트 ======
console.log("\n=== T7: parseBaseFeeFromFeeNote() ===");
assertEq("기본 25만", parseBaseFeeFromFeeNote("기본 25만"), 250000);
assertEq(
  "기본 25만 / 심화 35만 / 특강 55만",
  parseBaseFeeFromFeeNote("기본 25만 / 심화 35만 / 특강 55만"),
  250000
);
assertEq("기본 250,000원", parseBaseFeeFromFeeNote("기본 250,000원"), 250000);
assertEq("기본 25만원", parseBaseFeeFromFeeNote("기본 25만원"), 250000);
assertEq("기본: 300000", parseBaseFeeFromFeeNote("기본: 300000"), 300000);
assertEq("기본: 250000", parseBaseFeeFromFeeNote("기본: 250000"), 250000);
assertEq("기본 25만 + 자료개발비 별도 100만", parseBaseFeeFromFeeNote("기본 25만 + 자료개발비 별도 100만"), 250000);
assertEq("출장비 별도 (no 기본 label)", parseBaseFeeFromFeeNote("출장비 별도"), null);
assertEq("empty string", parseBaseFeeFromFeeNote(""), null);
assertEq("null", parseBaseFeeFromFeeNote(null), null);
assertEq("250,000원 no label", parseBaseFeeFromFeeNote("250,000원"), null);

// ====== T6: L1 판정 프레임워크 ======
console.log("\n=== T6: L1 matchCount vs regularCount ===");

type History = { contractType: string | null; detailType: string | null };
const PRACTICE_COACH_KEYWORDS = ["보조강사", "코치", "실습코치", "멘토", "문항개발"];

function matchesKeyword(value: string | null | undefined): boolean {
  if (!value) return false;
  return PRACTICE_COACH_KEYWORDS.some((kw) => value.includes(kw));
}

function l1Candidate(histories: History[]): boolean {
  if (histories.length === 0) return false;
  const matchCount = histories.filter(
    (h) => matchesKeyword(h.contractType) || matchesKeyword(h.detailType)
  ).length;
  const regularCount = histories.length - matchCount;
  return matchCount > regularCount;
}

// Sample 1: 보조 2, 정규 3 → 후보 아님 (clarify 예시)
assertEq(
  "보조2 정규3 → 후보 아님",
  l1Candidate([
    { contractType: "보조강사", detailType: null },
    { contractType: "보조강사", detailType: null },
    { contractType: "정규", detailType: null },
    { contractType: "정규", detailType: null },
    { contractType: "정규", detailType: null },
  ]),
  false
);

// Sample 2: 코치 6, 정규 4 → 후보
assertEq(
  "코치6 정규4 → 후보",
  l1Candidate([
    ...Array(6).fill({ contractType: "코치", detailType: null }),
    ...Array(4).fill({ contractType: "정규", detailType: null }),
  ]),
  true
);

// Sample 3: 동률 5/5 → 후보 아님 (clarify strict: matchCount > regularCount)
assertEq(
  "동률 5/5 → 후보 아님",
  l1Candidate([
    ...Array(5).fill({ contractType: "멘토", detailType: null }),
    ...Array(5).fill({ contractType: "정규", detailType: null }),
  ]),
  false
);

// Sample 4: 이력 없음 → 후보 아님
assertEq("이력 없음 → 후보 아님", l1Candidate([]), false);

// Sample 5: detailType에 키워드
assertEq(
  "detailType에 '실습코치' 3 / 정규 2 → 후보",
  l1Candidate([
    ...Array(3).fill({ contractType: null, detailType: "실습코치 과정" }),
    ...Array(2).fill({ contractType: "정규", detailType: null }),
  ]),
  true
);

// ====== T6: L2 + L3 프레임워크 ======
console.log("\n=== T6: L2 + L3 protection ===");

type Instructor = {
  isFulltime: boolean;
  baseFeeHourly: number | null;
  categories: string[];
  specialties: string[];
};

function applyProtection(inst: Instructor): { candidate: boolean; reason: string } {
  if (inst.isFulltime) return { candidate: false, reason: "L3 fulltime" };
  if (
    inst.baseFeeHourly !== null &&
    inst.baseFeeHourly >= 100000 &&
    inst.categories.length > 0 &&
    inst.specialties.length > 0
  ) {
    return { candidate: false, reason: "L2 regular" };
  }
  return { candidate: true, reason: "eligible coach" };
}

assertEq(
  "전임 + coach 이력 → L3 제외",
  applyProtection({
    isFulltime: true,
    baseFeeHourly: 500000,
    categories: ["AI"],
    specialties: ["GPT"],
  }),
  { candidate: false, reason: "L3 fulltime" }
);

assertEq(
  "비전임 baseFee=200k, cat/spec 비어있지 않음 → L2 제외",
  applyProtection({
    isFulltime: false,
    baseFeeHourly: 200000,
    categories: ["AI"],
    specialties: ["GPT"],
  }),
  { candidate: false, reason: "L2 regular" }
);

assertEq(
  "비전임 baseFee=99k → L2 불충족 → eligible",
  applyProtection({
    isFulltime: false,
    baseFeeHourly: 99000,
    categories: ["AI"],
    specialties: ["GPT"],
  }),
  { candidate: true, reason: "eligible coach" }
);

assertEq(
  "비전임 baseFee=200k, categories=[] → L2 불충족 → eligible",
  applyProtection({
    isFulltime: false,
    baseFeeHourly: 200000,
    categories: [],
    specialties: ["GPT"],
  }),
  { candidate: true, reason: "eligible coach" }
);

assertEq(
  "비전임 baseFee=null → L2 불충족 → eligible",
  applyProtection({
    isFulltime: false,
    baseFeeHourly: null,
    categories: ["AI"],
    specialties: ["GPT"],
  }),
  { candidate: true, reason: "eligible coach" }
);

// ====== T8: effective_date 산출식 프레임워크 ======
console.log("\n=== T8: effective_date source-specific rule ===");

function resolveEffectiveDate(
  sourceType: "notion" | "salesmap" | "contract_sheet" | "manual_fix",
  input: {
    instructorUpdatedAt?: Date;
    startDate?: Date | null;
    endDate?: Date | null;
    feeFixUpdatedAt?: Date;
  }
): Date | null {
  switch (sourceType) {
    case "notion":
      return input.instructorUpdatedAt ?? null;
    case "salesmap":
      return input.endDate ?? input.startDate ?? null;
    case "contract_sheet":
      return input.startDate ?? input.endDate ?? null;
    case "manual_fix":
      return input.feeFixUpdatedAt ?? null;
  }
}

const d1 = new Date("2026-01-01");
const d2 = new Date("2026-02-01");
const d3 = new Date("2026-03-01");

assertEq(
  "notion → instructor.updatedAt",
  resolveEffectiveDate("notion", { instructorUpdatedAt: d1 }),
  d1
);
assertEq(
  "contract_sheet → startDate 우선",
  resolveEffectiveDate("contract_sheet", { startDate: d1, endDate: d2 }),
  d1
);
assertEq(
  "contract_sheet startDate null → endDate fallback",
  resolveEffectiveDate("contract_sheet", { startDate: null, endDate: d2 }),
  d2
);
assertEq(
  "salesmap → endDate 우선",
  resolveEffectiveDate("salesmap", { startDate: d1, endDate: d2 }),
  d2
);
assertEq(
  "salesmap endDate null → startDate fallback",
  resolveEffectiveDate("salesmap", { startDate: d1, endDate: null }),
  d1
);
assertEq(
  "manual_fix → feeFixConfig.updatedAt",
  resolveEffectiveDate("manual_fix", { feeFixUpdatedAt: d3 }),
  d3
);

// ====== Summary ======
console.log();
console.log("=== Unit Test Summary ===");
console.log(`  passed=${passed}, failed=${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
