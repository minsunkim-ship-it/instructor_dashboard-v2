import { buildGmailRegistryKey } from "@/lib/pipeline/satisfaction-gmail-normalizer";

let passed = 0;
let failed = 0;

function assertEq(label: string, actual: string, expected: string): void {
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

function assertMatches(label: string, actual: string, pattern: RegExp): void {
  if (pattern.test(actual)) {
    console.log(`  [PASS] ${label}`);
    passed++;
  } else {
    console.log(`  [FAIL] ${label}`);
    console.log(`    pattern: ${pattern}`);
    console.log(`    actual:  ${JSON.stringify(actual)}`);
    failed++;
  }
}

console.log("Registry key backward compatibility — buildGmailRegistryKey");
console.log("");
console.log("  NOTE: this test pins the CURRENT output format so that any");
console.log("  change to key format (e.g. plain-text <-> SHA-1) becomes a");
console.log("  deliberate decision requiring a DB migration.");
console.log("");

// Snapshot: current format has "satisfaction:<encoded-family>:<sha1hex>" shape
// If this changes, someone must add a migration for existing registry rows.
const key1 = buildGmailRegistryKey({
  sourceFamily: "gmail_satisfaction",
  companyName: "KB금융그룹",
  courseName: "데이터 분석 아카데미 1기",
  sessionOrDate: "2025-11-20",
  instructorName: "홍길동",
});

// CURRENT FORMAT (Codex's SHA-1 version) — update ONLY with migration
assertMatches(
  "format shape: satisfaction:<family>:<hex40>",
  key1,
  /^satisfaction:gmail_satisfaction:[0-9a-f]{40}$/
);

// Deterministic
const key1Repeat = buildGmailRegistryKey({
  sourceFamily: "gmail_satisfaction",
  companyName: "KB금융그룹",
  courseName: "데이터 분석 아카데미 1기",
  sessionOrDate: "2025-11-20",
  instructorName: "홍길동",
});
assertEq("deterministic: same input → same key", key1, key1Repeat);

// Different instructor → different key
const keyOtherInstructor = buildGmailRegistryKey({
  sourceFamily: "gmail_satisfaction",
  companyName: "KB금융그룹",
  courseName: "데이터 분석 아카데미 1기",
  sessionOrDate: "2025-11-20",
  instructorName: "김영수",
});
if (key1 !== keyOtherInstructor) {
  console.log("  [PASS] different instructor → different key");
  passed++;
} else {
  console.log("  [FAIL] different instructor → different key (got same)");
  failed++;
}

// Different course → different key
const keyOtherCourse = buildGmailRegistryKey({
  sourceFamily: "gmail_satisfaction",
  companyName: "KB금융그룹",
  courseName: "데이터 분석 아카데미 2기",
  sessionOrDate: "2025-11-20",
  instructorName: "홍길동",
});
if (key1 !== keyOtherCourse) {
  console.log("  [PASS] different course → different key");
  passed++;
} else {
  console.log("  [FAIL] different course → different key (got same)");
  failed++;
}

// Empty instructor still produces valid key
const keyNoInstructor = buildGmailRegistryKey({
  sourceFamily: "gmail_satisfaction",
  companyName: "KB금융그룹",
  courseName: "데이터 분석 아카데미 1기",
  sessionOrDate: "2025-11-20",
  instructorName: null,
});
assertMatches(
  "null instructor → still valid key shape",
  keyNoInstructor,
  /^satisfaction:gmail_satisfaction:[0-9a-f]{40}$/
);

// Case / whitespace normalization: encodeKeyPart lowercases + trims
const keyTrimmed = buildGmailRegistryKey({
  sourceFamily: "gmail_satisfaction",
  companyName: "  KB금융그룹  ",
  courseName: "데이터 분석 아카데미 1기",
  sessionOrDate: "2025-11-20",
  instructorName: "홍길동",
});
assertEq("whitespace trim: padded input normalizes to same key", keyTrimmed, key1);

console.log(`\nTotal: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
