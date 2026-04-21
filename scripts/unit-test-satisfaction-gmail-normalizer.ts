import { __test__ } from "@/lib/pipeline/satisfaction-gmail-normalizer";

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

function assert(condition: boolean, label: string, detail?: string): void {
  if (condition) {
    pass(label);
  } else {
    fail(label, detail);
  }
}

console.log("Satisfaction Gmail normalizer");

const hyundaiSubject =
  "Re: [패스트캠퍼스] 최재석 강사님께 - 현대모비스_연구직 실무 AI 리더 교육 강의 안내 메일 드립니다.";
const hyundaiBody = `안녕하세요 강사님
패스트캠퍼스 황지민 매니저입니다.

금일 만족도 조사 결과 보내드립니다. ^_^
강사님 덕분에 이번 현대모비스 과정 만족도도 정말 잘 나왔습니다!

1. 객관식
문항 평균 점수 (5점 만점)
1. 강의 만족도 평가 5.0
2. 강의 난이도 정도 3.6`;

const hyundaiEvent = __test__.extractSingleEvent(
  {
    threadId: "thread-hyundai",
    messageId: "message-hyundai",
    subject: hyundaiSubject,
    from: "\"황지민\" <jimin.hwang@day1company.co.kr>",
    to: "\"최재석\" <kelite0929@gmail.com>",
    cc: null,
    sentAt: "Wed, 28 Jan 2026 18:37:33 +0900",
    snippet: null,
    bodyText: hyundaiBody,
  },
  {
    accountEmail: "yeonhee.ha@day1company.co.kr",
    instructorHint: "최재석",
    companyHint: "현대모비스",
    suggestedInstructorId: "test-instructor",
    resolutionBasis: "name_exact",
  }
);

assert(
  hyundaiEvent?.candidateCourseName === "현대모비스_연구직 실무 AI 리더 교육",
  "subject scaffold suffix is stripped from Hyundai Mobis course name",
  JSON.stringify(hyundaiEvent?.candidateCourseName)
);
assert(
  hyundaiEvent?.scoreNormalized === 5,
  "Hyundai Mobis thread still parses the actual satisfaction score",
  JSON.stringify(hyundaiEvent?.scoreNormalized)
);

const lotteSubject = "Re: [패스트캠퍼스] 롯데캐피탈 기업교육 출강문의드립니다.";
const lotteBody = `안녕하세요, 강사님.
패스트캠퍼스 운영매니저 안서연 입니다.

유선으로 요청주셨던 롯데캐피탈_AI 엑셀 업무 자동화 과정 만족도 조사 결과 전달드립니다.

[문항별 만족도 결과]

- 강사 만족도
1. 전반적인 강사 만족도: 4.43/5
2. 교육 주제에 대한 강사의 전문성과 역량: 4.57/5`;

const lotteEvent = __test__.extractSingleEvent(
  {
    threadId: "thread-lotte",
    messageId: "message-lotte",
    subject: lotteSubject,
    from: "\"안서연\" <seoyeon.an@day1company.co.kr>",
    to: "\"신동원\" <davidshin1213@gmail.com>",
    cc: null,
    sentAt: "Thu, 5 Mar 2026 10:11:35 +0900",
    snippet: null,
    bodyText: lotteBody,
  },
  {
    accountEmail: "yeonhee.ha@day1company.co.kr",
    instructorHint: "신동원",
    companyHint: null,
    suggestedInstructorId: "test-instructor",
    resolutionBasis: "email_exact",
  }
);

assert(
  lotteEvent?.candidateCourseName === "롯데캐피탈_AI 엑셀 업무 자동화 과정",
  "reply subject fallback is overridden by body intro course name for Lotte Capital",
  JSON.stringify(lotteEvent?.candidateCourseName)
);
assert(
  lotteEvent?.scoreNormalized === 4.43,
  "numbered question index is not misread as the satisfaction score",
  JSON.stringify(lotteEvent?.scoreNormalized)
);

assert(
  __test__.cleanCourseName(
    "KB국민은행_원데이 AI 실습 과정 만족도 설문 결과 공유드립니다."
  ) === "KB국민은행_원데이 AI 실습 과정",
  "cleanCourseName strips polite result-sharing suffixes",
  JSON.stringify(
    __test__.cleanCourseName(
      "KB국민은행_원데이 AI 실습 과정 만족도 설문 결과 공유드립니다."
    )
  )
);

assert(
  __test__.cleanCourseName(
    "1월 16일 진행되었던, NH 투자증권 리더대상 바이브 코딩 과정"
  ) === "NH 투자증권 리더대상 바이브 코딩 과정",
  "cleanCourseName strips date-prefix scaffolding",
  JSON.stringify(
    __test__.cleanCourseName(
      "1월 16일 진행되었던, NH 투자증권 리더대상 바이브 코딩 과정"
    )
  )
);

assert(
  __test__.cleanCourseName(
    "김보희 과장님께 - KB국민은행_원데이 AI 실습 과정 만족도 설문 결과 공유드립니다."
  ) === "KB국민은행_원데이 AI 실습 과정",
  "cleanCourseName strips recipient prefix scaffolding",
  JSON.stringify(
    __test__.cleanCourseName(
      "김보희 과장님께 - KB국민은행_원데이 AI 실습 과정 만족도 설문 결과 공유드립니다."
    )
  )
);

console.log(`\nTotal: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
