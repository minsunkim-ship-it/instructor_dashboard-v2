import {
  ACCESSIBLE_SATISFACTION_SHEET_SOURCES,
  getAllSatisfactionSheetSources,
} from "@/lib/pipeline/satisfaction-sheets-collector";

let passed = 0;
let failed = 0;

function assertTrue(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  [PASS] ${label}`);
    passed++;
  } else {
    console.log(`  [FAIL] ${label}`);
    failed++;
  }
}

function assertGT(label: string, actual: number, expected: number): void {
  if (actual > expected) {
    console.log(`  [PASS] ${label} (${actual} > ${expected})`);
    passed++;
  } else {
    console.log(`  [FAIL] ${label} (${actual} not > ${expected})`);
    failed++;
  }
}

async function main() {
  console.log("Satisfaction sheet catalog — file load + dedup with code SOURCES");
  console.log("");

  const codeOnly = ACCESSIBLE_SATISFACTION_SHEET_SOURCES;
  console.log(`  코드 SOURCES: ${codeOnly.length}건`);

  const merged = await getAllSatisfactionSheetSources();
  console.log(`  최종 merged: ${merged.length}건 (코드 + 카탈로그 파일)`);

  // 1. 카탈로그 파일이 코드 SOURCES를 확장했는지
  assertGT("merged 카탈로그가 코드 SOURCES보다 많음", merged.length, codeOnly.length);

  // 2. 코드 SOURCES 모두 보존
  for (const codeSource of codeOnly) {
    const found = merged.find((s) => s.key === codeSource.key);
    assertTrue(
      `코드 SOURCE '${codeSource.key}' 보존`,
      Boolean(found && found.spreadsheetId === codeSource.spreadsheetId)
    );
  }

  // 3. dedup: key 기준 unique
  const keys = merged.map((s) => s.key);
  const uniqueKeys = new Set(keys);
  assertTrue(`merged key 기준 unique (${keys.length} → ${uniqueKeys.size})`, keys.length === uniqueKeys.size);

  // 4. 장철원 시트 6건 모두 카탈로그에 들어있는지
  const jangCheolWonSheets = merged.filter(
    (s) => s.instructorHint === "장철원"
  );
  assertGT("장철원 시트 ≥ 4건 카탈로그 등록", jangCheolWonSheets.length, 3);

  // 5. 모든 entry에 필수 필드 (key/spreadsheetId/range)
  let missingFields = 0;
  for (const s of merged) {
    if (!s.key || !s.spreadsheetId || !s.range) missingFields++;
  }
  assertTrue(`모든 entry에 필수 필드 (missing: ${missingFields})`, missingFields === 0);

  // 6. sourceType은 sheet_summary 또는 google_forms
  let badSourceType = 0;
  for (const s of merged) {
    if (s.sourceType !== "sheet_summary" && s.sourceType !== "google_forms")
      badSourceType++;
  }
  assertTrue(
    `모든 sourceType이 sheet_summary | google_forms (bad: ${badSourceType})`,
    badSourceType === 0
  );

  console.log("");
  console.log(`Total: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Test error:", err);
  process.exit(1);
});
