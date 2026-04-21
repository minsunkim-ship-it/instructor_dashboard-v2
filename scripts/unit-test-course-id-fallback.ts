const {
  buildDriveCourseIdFallbackRegistryFromReports,
  sanitizeCourseNameCandidate,
} = await import(
  new URL("../src/lib/pipeline/course-id-fallback.ts", import.meta.url).href
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

console.log("Course ID fallback registry");
console.log("");

const registry = buildDriveCourseIdFallbackRegistryFromReports([
  {
    path: "reports/test-drive-a.json",
    report: {
      files: [
        {
          name: "2601~2601_에스케이이앤에스_신입사원 생성형AI 교육_싱크업 문서.xlsx",
          modifiedTime: "2026-01-17T03:16:20.833Z",
          preview: [
            {
              tab: "교육 개요",
              previewRows: [
                "과정 폴더 | 2601~2601_에스케이이앤에스_신입사원 생성형AI 교육",
                "백오피스 | 259216.0",
              ],
            },
          ],
        },
        {
          name: "2503~2504_LG유플러스_FE개발자 업스킬 과정_싱크업 문서",
          modifiedTime: "2025-03-10T10:00:00.000Z",
          preview: [
            {
              tab: "교육 개요",
              previewRows: ["코스 ID: 249657"],
            },
          ],
        },
      ],
    },
  },
  {
    path: "reports/test-drive-b.json",
    report: {
      files: [
        {
          name: "2512_오뚜기_생성형 AI를 활용한 데이터 리터러시_싱크업 문서.xlsx",
          modifiedTime: "2025-12-01T12:00:00.000Z",
          preview: [
            {
              tab: "교육 개요",
              previewRows: [
                "| 강의명 | 데이터 리터러시 입문 - 홍길동 강사님",
                "| 과정명 | 오뚜기 생성형 AI를 활용한 데이터 리터러시",
                "https://fastcampus.day1co.kr/#/courses/258247/",
              ],
            },
          ],
        },
        {
          name: "(★NEW TEMPLATE) 교육시작월~교육종료월_기업명_과정명_강의관리 시트.xlsx",
          modifiedTime: "2026-01-01T00:00:00.000Z",
          preview: [
            {
              tab: "교육 개요",
              previewRows: [
                "과정 폴더 | 링크",
                "코스 ID: 999999",
              ],
            },
          ],
        },
      ],
    },
  },
]);

assertEq(
  "sanitize strips date prefix and file suffix",
  sanitizeCourseNameCandidate(
    "2601~2601_에스케이이앤에스_신입사원 생성형AI 교육_싱크업 문서.xlsx"
  ),
  "에스케이이앤에스_신입사원 생성형AI 교육"
);

assertEq(
  "course folder row wins over file name fallback",
  registry.get("259216")?.courseName ?? null,
  "에스케이이앤에스_신입사원 생성형AI 교육"
);

assertEq(
  "file name fallback still works when preview only has course id",
  registry.get("249657")?.courseName ?? null,
  "LG유플러스_FE개발자 업스킬 과정"
);

assertEq(
  "course-level label outranks lecture-level label",
  registry.get("258247")?.courseName ?? null,
  "오뚜기 생성형 AI를 활용한 데이터 리터러시"
);

assertEq(
  "template placeholders are rejected",
  registry.has("999999"),
  false
);

console.log(`\nTotal: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
