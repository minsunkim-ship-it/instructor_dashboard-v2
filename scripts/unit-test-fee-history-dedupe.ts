import { dedupeFeeHistoryItems } from "@/lib/fee-history-dedupe";

let passed = 0;
let failed = 0;

function pass(label: string): void {
  console.log(`  [PASS] ${label}`);
  passed += 1;
}

function fail(label: string, detail?: string): void {
  console.log(`  [FAIL] ${label}`);
  if (detail) console.log(`    ${detail}`);
  failed += 1;
}

function assert(condition: boolean, label: string, detail?: string): void {
  if (condition) {
    pass(label);
    return;
  }

  fail(label, detail);
}

console.log("Fee history dedupe");

const regular = dedupeFeeHistoryItems([
  {
    effectiveDate: new Date("2026-04-01"),
    effectiveLabel: null,
    amount: 100000,
    feeKind: "hourly",
    context: "contract",
    sourceType: "contract_sheet",
    isCurrent: false,
    isSpecialAmount: false,
  },
  {
    effectiveDate: new Date("2026-04-01"),
    effectiveLabel: null,
    amount: 100000,
    feeKind: "hourly",
    context: "contract",
    sourceType: "contract_sheet",
    isCurrent: true,
    isSpecialAmount: false,
  },
]);
assert(regular.length === 1, "duplicate regular rows collapse to one");
assert(regular[0]?.isCurrent === true, "current regular row wins");

const special = dedupeFeeHistoryItems([
  {
    effectiveDate: new Date("2026-04-02"),
    effectiveLabel: "special",
    amount: 120000,
    feeKind: "hourly",
    context: "memo",
    sourceType: "salesmap",
    isCurrent: false,
    isSpecialAmount: true,
  },
  {
    effectiveDate: new Date("2026-04-02"),
    effectiveLabel: "special",
    amount: 150000,
    feeKind: "hourly",
    context: "memo",
    sourceType: "salesmap",
    isCurrent: false,
    isSpecialAmount: true,
  },
]);
assert(special.length === 1, "duplicate special rows collapse to one");
assert(special[0]?.amount === 150000, "higher special amount wins");

const ordered = dedupeFeeHistoryItems([
  {
    effectiveDate: new Date("2026-01-01"),
    effectiveLabel: null,
    amount: 90000,
    feeKind: "hourly",
    context: null,
    sourceType: "contract_sheet",
    isCurrent: true,
    isSpecialAmount: false,
  },
  {
    effectiveDate: new Date("2026-03-01"),
    effectiveLabel: null,
    amount: 110000,
    feeKind: "hourly",
    context: null,
    sourceType: "contract_sheet",
    isCurrent: true,
    isSpecialAmount: false,
  },
]);
assert(
  ordered[0]?.effectiveDate?.toISOString().slice(0, 10) === "2026-03-01",
  "deduped results remain reverse-chronological"
);

if (failed > 0) {
  console.error(`\n${failed} tests failed, ${passed} passed.`);
  process.exit(1);
}

console.log(`\n${passed} tests passed.`);
