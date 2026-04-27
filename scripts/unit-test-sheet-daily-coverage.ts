import {
  buildSheetCoverageReport,
  buildSheetLegacyIdentity,
  buildSheetSourceIdentity,
  type SheetCoverageCollectedRow,
  type SheetCoverageDbRow,
} from "./lib/sheet-daily-coverage.ts";

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

console.log("Sheet daily coverage helper");
console.log("");

const collectedRows: SheetCoverageCollectedRow[] = [
  {
    sourceType: "contract_sheet",
    sourceLabel: "gid:10",
    spreadsheetId: "sheet-1",
    worksheetGid: 10,
    rowNumber: 2,
    instructorName: "정백",
    companyName: "KT",
    courseName: "AI 과정",
    dateLabel: "2026.01.01",
    parsedDates: ["2026-01-01"],
    startDate: "2026-01-01",
    endDate: "2026-01-01",
  },
  {
    sourceType: "contract_sheet",
    sourceLabel: "gid:10",
    spreadsheetId: "sheet-1",
    worksheetGid: 10,
    rowNumber: 3,
    instructorName: "공지연",
    companyName: "KT",
    courseName: "AI 과정",
    dateLabel: "2026.01.01",
    parsedDates: ["2026-01-01"],
    startDate: "2026-01-01",
    endDate: "2026-01-01",
  },
  {
    sourceType: "contract_sheet",
    sourceLabel: "gid:10",
    spreadsheetId: "sheet-1",
    worksheetGid: 10,
    rowNumber: 4,
    instructorName: "신동원",
    companyName: "KT",
    courseName: "AI 과정",
    dateLabel: "2026.01.02",
    parsedDates: ["2026-01-02"],
    startDate: "2026-01-02",
    endDate: "2026-01-02",
  },
  {
    sourceType: "contract_sheet",
    sourceLabel: "gid:10",
    spreadsheetId: "sheet-1",
    worksheetGid: 10,
    rowNumber: 5,
    instructorName: "신동원",
    companyName: "KT",
    courseName: "심화 과정",
    dateLabel: "2026.01.02, 2026.01.03",
    parsedDates: ["2026-01-03", "2026-01-02", "2026-01-03"],
    startDate: "2026-01-02",
    endDate: "2026-01-03",
  },
  {
    sourceType: "contract_sheet",
    sourceLabel: "gid:10",
    spreadsheetId: "sheet-1",
    worksheetGid: 10,
    rowNumber: 6,
    instructorName: "정백",
    companyName: "KT",
    courseName: "심화 과정",
    dateLabel: "2026.01.03",
    parsedDates: ["2026-01-03"],
    startDate: "2026-01-03",
    endDate: "2026-01-03",
  },
  {
    sourceType: "contract_sheet",
    sourceLabel: "gid:10",
    spreadsheetId: "sheet-1",
    worksheetGid: 10,
    rowNumber: 7,
    instructorName: "정백",
    companyName: "KT",
    courseName: "심화 과정",
    dateLabel: "2026년 상반기 예정",
    parsedDates: [],
    startDate: null,
    endDate: null,
  },
  {
    sourceType: "contract_sheet",
    sourceLabel: "gid:10",
    spreadsheetId: "sheet-1",
    worksheetGid: 10,
    rowNumber: 8,
    instructorName: "정백",
    companyName: "KT",
    courseName: "심화 과정",
    dateLabel: null,
    parsedDates: [],
    startDate: null,
    endDate: null,
  },
];

const dbRows: SheetCoverageDbRow[] = [
  {
    id: "db-1",
    sourceIdentity: buildSheetSourceIdentity("sheet-1", 10, 2),
    legacyIdentity: null,
    startDate: "2026-01-01",
    endDate: "2026-01-01",
    dateLabel: "2026.01.01",
  },
  {
    id: "db-2",
    sourceIdentity: null,
    legacyIdentity: buildSheetLegacyIdentity("sheet-1", 3),
    startDate: "2026-01-01",
    endDate: "2026-01-01",
    dateLabel: "2026.01.01",
  },
  {
    id: "db-3",
    sourceIdentity: buildSheetSourceIdentity("sheet-1", 10, 5),
    legacyIdentity: null,
    startDate: "2026-01-02",
    endDate: "2026-01-04",
    dateLabel: "2026.01.02, 2026.01.04",
  },
  {
    id: "db-4a",
    sourceIdentity: buildSheetSourceIdentity("sheet-1", 10, 6),
    legacyIdentity: null,
    startDate: "2026-01-03",
    endDate: "2026-01-03",
    dateLabel: "2026.01.03",
  },
  {
    id: "db-4b",
    sourceIdentity: buildSheetSourceIdentity("sheet-1", 10, 6),
    legacyIdentity: null,
    startDate: "2026-01-03",
    endDate: "2026-01-03",
    dateLabel: "2026.01.03",
  },
];

const report = buildSheetCoverageReport({
  collectedRows,
  dbRows,
  startDate: "2026-01-01",
  endDate: "2026-01-03",
  sampleLimit: 2,
});

const byDate = new Map(report.rows.map((row) => [row.date, row]));

assertEq("summary totalCollectedRows", report.summary.totalCollectedRows, 7);
assertEq("summary rowsWithAnyParsedDates", report.summary.rowsWithAnyParsedDates, 5);
assertEq("summary rowsInRange", report.summary.rowsInRange, 5);
assertEq("summary rowsWithoutParsedDates", report.summary.rowsWithoutParsedDates, 1);
assertEq("summary blankDateLabelRows", report.summary.blankDateLabelRows, 1);
assertEq("summary rowsMissingInDb", report.summary.rowsMissingInDb, 1);
assertEq("summary rowsDateMismatch", report.summary.rowsDateMismatch, 1);
assertEq("summary rowsDuplicateInDb", report.summary.rowsDuplicateInDb, 1);
assertEq("summary rowsMatchedByLegacyIdentity", report.summary.rowsMatchedByLegacyIdentity, 1);

assertEq("2026-01-01 status", byDate.get("2026-01-01")?.status, "ok");
assertEq("2026-01-01 collectedRows", byDate.get("2026-01-01")?.collectedRows, 2);
assertEq("2026-01-01 exactDateMatch", byDate.get("2026-01-01")?.exactDateMatch, 1);
assertEq("2026-01-01 legacyDbMatch", byDate.get("2026-01-01")?.legacyDbMatch, 1);

assertEq("2026-01-02 status", byDate.get("2026-01-02")?.status, "mixed");
assertEq("2026-01-02 collectedRows", byDate.get("2026-01-02")?.collectedRows, 2);
assertEq("2026-01-02 dbRowsFound", byDate.get("2026-01-02")?.dbRowsFound, 1);
assertEq("2026-01-02 missingInDb", byDate.get("2026-01-02")?.missingInDb, 1);
assertEq("2026-01-02 dateMismatch", byDate.get("2026-01-02")?.dateMismatch, 1);

assertEq("2026-01-03 status", byDate.get("2026-01-03")?.status, "mixed");
assertEq("2026-01-03 collectedRows", byDate.get("2026-01-03")?.collectedRows, 2);
assertEq("2026-01-03 dbRowsFound", byDate.get("2026-01-03")?.dbRowsFound, 2);
assertEq("2026-01-03 dateMismatch", byDate.get("2026-01-03")?.dateMismatch, 1);
assertEq("2026-01-03 duplicateInDb", byDate.get("2026-01-03")?.duplicateInDb, 1);

assertEq("undated sample captured", report.sampleUndatedRows.length, 1);
assertEq("blank date sample captured", report.sampleBlankDateLabelRows.length, 1);
assertEq(
  "duplicate sample keeps both db ids",
  byDate.get("2026-01-03")?.sampleDuplicate[0]?.dbIds.length,
  2
);

console.log(`\nTotal: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
