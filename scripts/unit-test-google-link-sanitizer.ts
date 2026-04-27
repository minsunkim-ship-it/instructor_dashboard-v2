import {
  extractDisplayLinesWithoutGoogleLinks,
  stripGoogleLinks,
} from "@/lib/google-link-sanitizer";

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

function assertEqual(
  actual: string | null,
  expected: string | null,
  label: string
): void {
  if (actual === expected) {
    pass(label);
    return;
  }

  fail(label, `expected=${String(expected)} actual=${String(actual)}`);
}

function assertArrayEqual(actual: string[], expected: string[], label: string): void {
  if (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  ) {
    pass(label);
    return;
  }

  fail(label, `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
}

console.log("Google link sanitizer");

assertEqual(
  stripGoogleLinks(
    "* 계약 양식 링크\n : https://drive.google.com/drive/folders/1xOuR1025XoNoqo9RsiTwR5-1jg7Vj1K9"
  ),
  null,
  "링크 레이블만 남는 줄은 제거한다"
);

assertEqual(
  stripGoogleLinks(
    "법인 계약시 https://drive.google.com/drive/u/0/folders/12_StyjYNQC3p7zYsL0R84thMZ4FcJmYn 참고"
  ),
  "법인 계약시 참고",
  "문장 중간의 구글 링크만 제거하고 나머지 문장은 유지한다"
);

assertArrayEqual(
  extractDisplayLinesWithoutGoogleLinks(
    "신분증, 통장사본 첨부할 수 있도록 셋팅 부탁드립니다.\nhttps://docs.google.com/document/d/abc/edit",
    "보조 메모"
  ),
  ["신분증, 통장사본 첨부할 수 있도록 셋팅 부탁드립니다.", "보조 메모"],
  "여러 입력에서 구글 링크 줄만 제거하고 표시용 라인만 남긴다"
);

if (failed > 0) {
  console.error(`\n${failed} tests failed, ${passed} passed.`);
  process.exit(1);
}

console.log(`\n${passed} tests passed.`);
