/**
 * Unit test — ground-truth Stage C non-lecture blocklist + status decider.
 *
 * 회귀 케이스 (2026-05-29 진단):
 *   소준섭 record (2025-10-15, score 4.78) 의 HD조선해양 문항개발 매칭이
 *   false_positive. 강화된 룰이 같은 fixture 를 만났을 때:
 *     1) detectNonLectureReason → non_lecture_keyword 사유 반환
 *     2) decideStageCStatus → cross-source 부재 시 low_confidence_stage_c
 *
 * 동시에 cross-source 신호가 있는 정상 케이스 (소준섭 삼성전자 Vision
 * Detection 3차수) 는 resolved 결정이 가능해야 한다 (회귀 가드).
 */
import {
  detectNonLectureReason,
  decideStageCStatus,
} from "@/lib/ground-truth-stage-c";

let passed = 0;
let failed = 0;

function assertEq<T>(label: string, actual: T, expected: T): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  [PASS] ${label}`);
    passed++;
  } else {
    console.log(`  [FAIL] ${label}`);
    console.log(`    expected: ${e}`);
    console.log(`    actual:   ${a}`);
    failed++;
  }
}

function assertTrue(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  [PASS] ${label}`);
    passed++;
  } else {
    console.log(`  [FAIL] ${label}`);
    failed++;
  }
}

console.log("Ground-truth Stage C — non-lecture blocklist + status decider");
console.log("");

// Group A — non-lecture keyword 차단
console.log("Group A: non-lecture keyword 차단");

assertTrue(
  "소준섭 HD조선해양 문항출제·채점 계약 → non_lecture (회귀 케이스 sj#1)",
  detectNonLectureReason({
    courseName:
      "HD한국조선해양_2026 AIC AI 역량 평가문제출제 및 채점 계약서",
    specialNotes: null,
    detailType: null,
    contractType: "(B2B) 평가문제 출제·채점",
    startDate: new Date("2025-09-22"),
    endDate: new Date("2026-03-31"),
    totalHours: null,
  }) !== null
);

assertTrue(
  "삼성전자 Vision Detection 3차수 강의 → 강의 가능 (null 반환)",
  detectNonLectureReason({
    courseName: "Vision Detection 3차수",
    specialNotes: null,
    detailType: "AI 인텐시브",
    contractType: "(B2B) 출강",
    startDate: new Date("2025-10-13"),
    endDate: new Date("2025-10-17"),
    totalHours: 40,
  }) === null
);

assertTrue(
  "단순 '자문' 키워드 → non_lecture",
  detectNonLectureReason({
    courseName: "삼성전자 AI 자문 프로젝트",
    specialNotes: null,
    detailType: null,
    contractType: null,
    startDate: null,
    endDate: null,
    totalHours: null,
  }) !== null
);

assertTrue(
  "IBK LLM 역량 육성 강의 (12/18-19, 18명 응답) → 강의 가능 (회귀 가드 — confirmed_backfill 이승유 케이스)",
  detectNonLectureReason({
    courseName: "(B2B) IBK 기업은행_LLM 역량 육성 과정",
    specialNotes: "1일차/3일차 이승유 강사",
    detailType: null,
    contractType: "(B2B) 출강",
    startDate: new Date("2025-12-18"),
    endDate: new Date("2025-12-19"),
    totalHours: 16,
  }) === null
);

// Group B — long span + no hours 휴리스틱
console.log("");
console.log("Group B: long-span no-hours heuristic");

assertTrue(
  "6개월 계약 + totalHours null → non_lecture (long-term 프로젝트 의심)",
  detectNonLectureReason({
    courseName: "AI 운영 컨설팅",
    specialNotes: null,
    detailType: null,
    contractType: null,
    startDate: new Date("2025-10-01"),
    endDate: new Date("2026-04-01"),
    totalHours: null,
  }) !== null
);

assertTrue(
  "30일 span + totalHours 0 → 통과 (장기 아님)",
  detectNonLectureReason({
    courseName: "AI 트레이닝",
    specialNotes: null,
    detailType: null,
    contractType: null,
    startDate: new Date("2025-10-01"),
    endDate: new Date("2025-10-30"),
    totalHours: 0,
  }) === null
);

// Group C — decideStageCStatus
console.log("");
console.log("Group C: decideStageCStatus");

assertEq(
  "cross-source 부재 → low_confidence_stage_c",
  decideStageCStatus(0.85, {
    found: false,
    slack_hits: 0,
    gmail_hits: 0,
    sample_refs: [],
  }),
  "low_confidence_stage_c"
);

assertEq(
  "cross-source confirmed + confidence 0.78 → resolved",
  decideStageCStatus(0.78, {
    found: true,
    slack_hits: 1,
    gmail_hits: 2,
    sample_refs: ["slack:abc", "gmail:def"],
  }),
  "resolved"
);

assertEq(
  "cross-source confirmed but confidence 0.6 → low_confidence_stage_c",
  decideStageCStatus(0.6, {
    found: true,
    slack_hits: 1,
    gmail_hits: 0,
    sample_refs: ["slack:abc"],
  }),
  "low_confidence_stage_c"
);

// Group D — 회귀 케이스 합성 (소준섭 sj#1 false_positive vs sj#3 confirmed_backfill)
console.log("");
console.log("Group D: 통합 회귀 케이스 (소준섭 sj#1 vs sj#3)");

// sj#1: HD조선해양 문항개발 → non-lecture skip → no Stage C candidate
const sj1NonLecture = detectNonLectureReason({
  courseName:
    "HD한국조선해양_2026 AIC AI 역량 평가문제출제 및 채점 계약서",
  specialNotes: null,
  detailType: null,
  contractType: "(B2B) 평가문제 출제·채점",
  startDate: new Date("2025-09-22"),
  endDate: new Date("2026-03-31"),
  totalHours: null,
});
assertTrue("sj#1 (HD조선해양 문항개발) blocklist 적용", sj1NonLecture !== null);

// sj#3: 삼성전자 Vision Detection 3차수 5일차 강의 → 강의 통과 + cross-source 있음 → resolved
const sj3NonLecture = detectNonLectureReason({
  courseName: "삼성전자 Vision Detection 3차수",
  specialNotes: "임주희 프로 / 5일 일정",
  detailType: "AI/BigData 인텐시브",
  contractType: "(B2B) 출강",
  startDate: new Date("2025-10-13"),
  endDate: new Date("2025-10-17"),
  totalHours: 40,
});
assertTrue("sj#3 (삼성 Vision Detection 강의) blocklist 통과", sj3NonLecture === null);

const sj3Status = decideStageCStatus(0.78, {
  found: true,
  slack_hits: 1,
  gmail_hits: 1,
  sample_refs: ["slack:b2b_2팀_운영논의", "gmail:19a0e68f1b6584a0"],
});
assertEq(
  "sj#3 (gmail thread 19a0e68f + slack b2b_2팀_운영논의) → resolved",
  sj3Status,
  "resolved"
);

// sj#1 합성: 일정 단독 매칭 + cross-source 부재 시
const sj1Status = decideStageCStatus(0.55, {
  found: false,
  slack_hits: 0,
  gmail_hits: 0,
  sample_refs: [],
});
assertEq(
  "sj#1 (HD조선해양 일정 단독, cross-source 부재) → low_confidence_stage_c (false positive 차단)",
  sj1Status,
  "low_confidence_stage_c"
);

console.log("");
console.log(`Total: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
