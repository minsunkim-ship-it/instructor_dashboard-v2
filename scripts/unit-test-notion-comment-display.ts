import { dedupeKeyQuestionAgainstNotionComments } from "@/lib/notion-comment-display";

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

function assertEqual(actual: string | null, expected: string | null, label: string): void {
  if (actual === expected) {
    pass(label);
    return;
  }

  fail(label, `expected=${String(expected)} actual=${String(actual)}`);
}

console.log("Notion comment display dedupe");

const duplicatedQuestion =
  "확인 포인트: 실습 위주의 커리큘럼: [LG 유플러스 - AI 기반 개발 Workflow 설계] 강의 전 커리큘럼 요청에 답이 없었고, 막상 강의 시작 후 클로드 계정이 필요하다고 안내해 실습 환경 준비가 되지 않았습니다.";
const duplicatedComment =
  "[LG 유플러스 - AI 기반 개발 Workflow 설계] 강의 전 커리큘럼 요청에 답이 없었고, 막상 강의 시작 후 클로드 계정이 필요하다고 안내해 실습 환경 준비가 되지 않았습니다.";

assertEqual(
  dedupeKeyQuestionAgainstNotionComments(duplicatedQuestion, [duplicatedComment]),
  null,
  "노션 코멘트와 동일한 확인 필요 문구는 숨긴다"
);

const partiallyDuplicatedQuestion =
  "확인 포인트: 실습 위주의 커리큘럼: 실습 환경 준비가 되지 않았습니다. / 운영 및 수강 환경: 외부 Tool 이용은 내부 시스템에서 지원하지 않는 기능이 있는 경우에만 사전 협의가 필요합니다.";

assertEqual(
  dedupeKeyQuestionAgainstNotionComments(partiallyDuplicatedQuestion, [
    "실습 환경 준비가 되지 않았습니다.",
  ]),
  "확인 포인트: 운영 및 수강 환경: 외부 Tool 이용은 내부 시스템에서 지원하지 않는 기능이 있는 경우에만 사전 협의가 필요합니다.",
  "중복된 세그먼트만 제거하고 남은 확인 필요 문구는 유지한다"
);

assertEqual(
  dedupeKeyQuestionAgainstNotionComments(
    partiallyDuplicatedQuestion,
    []
  ),
  partiallyDuplicatedQuestion,
  "노션 코멘트가 없으면 원문을 유지한다"
);

if (failed > 0) {
  console.error(`\n${failed} tests failed, ${passed} passed.`);
  process.exit(1);
}

console.log(`\n${passed} tests passed.`);
