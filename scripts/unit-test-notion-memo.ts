const { normalizeNotionData } = await import(
  new URL("../src/lib/pipeline/normalizer.ts", import.meta.url).href
);
const { mergeMemoNonDestructive } = await import(
  new URL("../src/lib/pipeline/memo-utils.ts", import.meta.url).href
);
const {
  extractMemoLinesFromNotionBlock,
  extractMemoLinesFromNotionComment,
} = await import(
  new URL("../src/lib/notion-enrichment.ts", import.meta.url).href
);

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

console.log("Notion memo -> memo_raw candidate");
console.log("");

const normalized = normalizeNotionData([
  {
    notionPageId: "page-1",
    name: "홍길동",
    affiliation: ["데이원"],
    categories: ["생성형AI"],
    memo: [
      "현장 장비 사전 체크 필요",
      "주요 고객사: 삼성",
      "보조 이메일: sub@example.com",
      "짧음",
    ].join("\n"),
    contactEmail: "main@example.com",
    contactEmail2: "sub@example.com",
    contactPhone: "010-1111-2222",
    contactPhone2: "010-3333-4444",
    baseFeeHourly: 200000,
    feeNote: "기본 20만",
  },
]);

assertEq("normalize count", normalized.length, 1);
assertEq(
  "memo_raw candidate filters forbidden/short lines and dedupes appendix",
  normalized[0]?.memoRawCandidate ?? null,
  [
    "현장 장비 사전 체크 필요",
    "보조 이메일: sub@example.com",
    "보조 연락처: 010-3333-4444",
  ].join("\n")
);

const normalizedWithoutUsableMemo = normalizeNotionData([
  {
    notionPageId: "page-2",
    name: "김영희",
    affiliation: [],
    categories: [],
    memo: "짧음",
    contactEmail: null,
    contactEmail2: null,
    contactPhone: null,
    contactPhone2: null,
    baseFeeHourly: null,
    feeNote: null,
  },
]);

assertEq(
  "short notion memo alone does not produce memo_raw candidate",
  normalizedWithoutUsableMemo[0]?.memoRawCandidate ?? null,
  null
);

assertEq(
  "merge memo keeps existing lines and appends only new unique lines",
  mergeMemoNonDestructive(
    ["기존 메모", "보조 연락처: 010-3333-4444"].join("\n"),
    ["기존 메모", "새 운영 메모", "보조 연락처: 010-3333-4444"].join("\n")
  ),
  ["기존 메모", "보조 연락처: 010-3333-4444", "새 운영 메모"].join("\n")
);

assertEq(
  "merge memo upgrades bare notion comment line to authored comment line",
  mergeMemoNonDestructive(
    "최신버전 프로필 (26.04.10)",
    "[Notion comment · user:abc-123 · 2026-04-10] 최신버전 프로필 (26.04.10)"
  ),
  "[Notion comment · user:abc-123 · 2026-04-10] 최신버전 프로필 (26.04.10)"
);

assertEq(
  "extract page/body text lines from notion block rich_text",
  extractMemoLinesFromNotionBlock({
    type: "paragraph",
    paragraph: {
      rich_text: [
        { plain_text: "실습 위주 진행 필요" },
        { plain_text: "\n장비 체크 필수" },
      ],
    },
  }),
  ["실습 위주 진행 필요", "장비 체크 필수"]
);

assertEq(
  "extract table row text lines from notion block",
  extractMemoLinesFromNotionBlock({
    type: "table_row",
    table_row: {
      cells: [
        [{ plain_text: "현장 체크" }],
        [{ plain_text: "사전 리허설 필요" }],
      ],
    },
  }),
  ["현장 체크", "사전 리허설 필요"]
);

assertEq(
  "extract comment text lines from notion comment rich_text",
  extractMemoLinesFromNotionComment({
    created_time: "2026-04-10T09:03:00.000Z",
    created_by: {
      id: "49e77980-aaa7-4a99-99a3-f705a28eb02b",
    },
    rich_text: [{ plain_text: "고객사 요청사항 확인 필요\n당일 장비 변경 가능성 있음" }],
  }),
  [
    "[Notion comment · user:49e77980-aaa7-4a99-99a3-f705a28eb02b · 2026-04-10] 고객사 요청사항 확인 필요 / 당일 장비 변경 가능성 있음",
  ]
);

console.log(`\nTotal: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
