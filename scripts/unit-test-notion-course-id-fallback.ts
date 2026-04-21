const {
  extractTeachingHistoryEntriesFromNotionLines,
  buildNotionCourseIdFallbackRegistryFromEntries,
} = await import(
  new URL(
    "../src/lib/pipeline/notion-course-id-fallback.ts",
    import.meta.url
  ).href
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

console.log("Notion course-id fallback");
console.log("");

const parsedEntries = extractTeachingHistoryEntriesFromNotionLines([
  "강사 프로필",
  "주요 경력사항",
  "주요 강의이력",
  "2025Y",
  "KB국민은행 2025 디지털 분야 위탁 교육",
  "삼성전자 Citizen Developer 과정_25년 09월",
  "김용담_세부정보",
  "이 줄은 무시되어야 함",
]);

assertEq(
  "extracts only course-history entries with section/year context",
  parsedEntries.map((entry: { courseName: string; years: number[] }) => ({
    courseName: entry.courseName,
    years: entry.years,
  })),
  [
    {
      courseName: "KB국민은행 2025 디지털 분야 위탁 교육",
      years: [2025],
    },
    {
      courseName: "삼성전자 Citizen Developer 과정_25년 09월",
      years: [2025],
    },
  ]
);

const consensusRegistry = buildNotionCourseIdFallbackRegistryFromEntries({
  inputs: [
    {
      courseId: "235240",
      notionPageId: "page-a",
      instructorName: "송재욱",
      referenceYears: [2025],
    },
    {
      courseId: "235240",
      notionPageId: "page-b",
      instructorName: "김용담",
      referenceYears: [2025],
    },
  ],
  entriesByPageId: new Map([
    [
      "page-a",
      extractTeachingHistoryEntriesFromNotionLines([
        "주요 강의이력",
        "2025Y",
        "KB국민은행 2025 디지털 분야 위탁 교육",
      ]),
    ],
    [
      "page-b",
      extractTeachingHistoryEntriesFromNotionLines([
        "주요 강의이력",
        "2025Y",
        "KB국민은행 2025 디지털 분야 위탁 교육 멘토",
      ]),
    ],
  ]),
});

assertEq(
  "accepts multi-page consensus cluster",
  consensusRegistry.get("235240")?.courseName ?? null,
  "KB국민은행 2025 디지털 분야 위탁 교육"
);

const singlePageRegistry = buildNotionCourseIdFallbackRegistryFromEntries({
  inputs: [
    {
      courseId: "260724",
      notionPageId: "page-c",
      instructorName: "김민호",
      referenceYears: [2026],
    },
  ],
  entriesByPageId: new Map([
    [
      "page-c",
      extractTeachingHistoryEntriesFromNotionLines([
        "주요 강의이력",
        "2026Y",
        "성균관대학교 겨울방학 DT역량강화 과정",
      ]),
    ],
  ]),
});

assertEq(
  "accepts single-page unique year match",
  singlePageRegistry.get("260724")?.courseName ?? null,
  "성균관대학교 겨울방학 DT역량강화 과정"
);

const noConsensusRegistry = buildNotionCourseIdFallbackRegistryFromEntries({
  inputs: [
    {
      courseId: "239169",
      notionPageId: "page-d",
      instructorName: "최우영",
      referenceYears: [2025],
    },
    {
      courseId: "239169",
      notionPageId: "page-e",
      instructorName: "채시은",
      referenceYears: [2025],
    },
  ],
  entriesByPageId: new Map([
    [
      "page-d",
      extractTeachingHistoryEntriesFromNotionLines([
        "주요 강의이력",
        "2025Y",
        "삼성전자 Citizen Developer 과정_25년 09월",
      ]),
    ],
    [
      "page-e",
      extractTeachingHistoryEntriesFromNotionLines([
        "주요 강의이력",
        "2025Y",
        "SK텔링크_2025년 생성형AI 업무 활용 과정",
      ]),
    ],
  ]),
});

assertEq(
  "skips unrelated multi-page candidates",
  noConsensusRegistry.has("239169"),
  false
);

console.log(`\nTotal: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
