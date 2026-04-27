import { parseAmountFromFeeNote } from "../src/lib/pipeline/fee-note-parser.ts";
import { getCurrentFeeTimelineIndex } from "../src/lib/fee-history-timeline.ts";

function assertEqual<T>(actual: T, expected: T, label: string) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function runParseAmountTests() {
  const cases = [
    {
      label: "만원 단위는 그대로 파싱",
      input: "강사료 25만원",
      expected: 250000,
    },
    {
      label: "fee 문맥 없는 주기 숫자는 무시",
      input:
        "** 강사님 자택이 경기도 광주라 오프라인 강의일 경우 주1회가 아닌 연일 과정 선호",
      expected: null,
    },
    {
      label: "fee 문맥 있는 원 단위는 파싱",
      input: "기본 단가 200,000원",
      expected: 200000,
    },
    {
      label: "fee 문맥 없는 순수 숫자는 무시",
      input: "선호 일정은 2025 이후 조율",
      expected: null,
    },
  ] as const;

  for (const testCase of cases) {
    const actual = parseAmountFromFeeNote(testCase.input);
    assertEqual(actual, testCase.expected, testCase.label);
  }
}

function runCurrentTimelineTests() {
  const timeline = [
    { is_current: false },
    { is_current: true },
    { is_current: false },
  ];
  assertEqual(
    getCurrentFeeTimelineIndex(timeline),
    1,
    "is_current가 있으면 그 인덱스를 현재값으로 사용"
  );

  assertEqual(
    getCurrentFeeTimelineIndex([{ is_current: false }, { is_current: false }]),
    1,
    "is_current가 없으면 마지막 인덱스를 현재값으로 사용"
  );

  assertEqual(
    getCurrentFeeTimelineIndex([]),
    -1,
    "빈 타임라인은 -1"
  );
}

function main() {
  runParseAmountTests();
  runCurrentTimelineTests();
  console.log("unit-test-fee-history: ok");
}

main();
