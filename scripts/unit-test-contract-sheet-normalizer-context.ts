import { normalizeContractRows } from "../src/lib/pipeline/contract-sheet-normalizer.ts";
import type { RawContractRow } from "../src/lib/pipeline/contract-sheet-collector.ts";

let passed = 0;
let failed = 0;

function assertEq(label: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    console.log(`  [PASS] ${label}`);
    passed++;
  } else {
    console.log(`  [FAIL] ${label}`);
    console.log(`    expected: ${JSON.stringify(expected)}`);
    console.log(`    actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

console.log("Contract sheet contextual schedule normalization");
console.log("");

const rawRows: RawContractRow[] = [
  {
    spreadsheetId: "sheet-1",
    worksheetGid: 1,
    rowNumber: 10,
    values: {
      "강사명": "박성원",
      "강의 코스 ID (숫자만)": "250683",
      "강의 일정": "4.28-5.8",
      "타임스탬프": "",
    },
  },
  {
    spreadsheetId: "sheet-1",
    worksheetGid: 1,
    rowNumber: 11,
    values: {
      "강사명": "강태욱",
      "강의 코스 ID (숫자만)": "250683",
      "강의 일정":
        "2025. 04. 28(월) 09:00~18:00\n2025. 05. 08(목) 09:00~18:00",
      "타임스탬프": "2025. 4. 28 오후 12:13:58",
    },
  },
];

const normalized = normalizeContractRows(rawRows);

assertEq(
  "yearless range inherits course year context start",
  normalized[0]?.startDate?.toISOString().slice(0, 10),
  "2025-04-28"
);
assertEq(
  "yearless range inherits course year context end",
  normalized[0]?.endDate?.toISOString().slice(0, 10),
  "2025-05-08"
);

console.log(`\nTotal: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
