import {
  extractOperationalIntelligencePayload,
  deriveBehavioralPatternLists,
  normalizeOperationalPatternLabels,
  summarizeBehavioralIntelligenceFromEvidence,
} from "@/lib/operational-intelligence";
import type {
  ClassifiedOperationalNote,
  HumanFollowup,
  RawOperationalNote,
} from "@/types/operational-intelligence";

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

console.log("Operational intelligence raw-note summary");

const originalFetch = globalThis.fetch;
const originalApiKey = process.env.OPENAI_API_KEY;
const originalModel = process.env.OPERATIONAL_INTELLIGENCE_LLM_MODEL;

process.env.OPENAI_API_KEY = "test-key";
process.env.OPERATIONAL_INTELLIGENCE_LLM_MODEL = "gpt-test";

globalThis.fetch = (async () => {
  return new Response(
    JSON.stringify({
      output: [
        {
          content: [
            {
              type: "output_text",
              text: JSON.stringify({
                teaching_style:
                  "설명을 쉽게 풀고 실습 맥락에 맞춰 학습자를 끌고 가는 편입니다.",
                curriculum_compliance:
                  "실습과 예시 중심 구성에는 강점이 있지만 초반 환경 점검이 부족하면 흐름이 흔들릴 수 있습니다.",
                attitude:
                  "질문 대응과 피드백 반영은 빠른 편으로 보입니다.",
                strength_patterns: [
                  "비전공자와 고연령층도 따라오기 쉽게 설명하며 공감대를 만듭니다.",
                  "실습과 예시를 충분히 곁들여 배운 내용을 바로 적용해보게 합니다.",
                  "반복 회차에서 만족도 상승과 재요청 반응이 함께 확인됩니다.",
                ],
                risk_patterns: [
                  "계정·환경 이슈가 생기면 초반 실습 흐름이 잠시 흔들릴 수 있습니다.",
                  "비정기 요청이나 급한 일정 변경에는 회신 속도를 미리 확인할 필요가 있습니다.",
                ],
                recommendation:
                  "현업 적용형 실습 비중이 높은 과정에 적합합니다. 계정·환경 이슈가 있는 세션은 사전 점검을 더 촘촘히 두는 편이 좋습니다.",
                key_question_for_humans:
                  "실습 환경 준비와 계정 안내 시점을 한 번 더 확인해두는 편이 좋습니다.",
              }),
            },
          ],
        },
      ],
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    }
  );
}) as typeof fetch;

try {
  const rawNotes: RawOperationalNote[] = [
    {
      id: "raw-1",
      instructor_id: "inst-1",
      source_type: "teaching_feedback_qualitative",
      source_ref: {},
      client_name: "테스트회사",
      course_name: "생성형 AI 실습",
      round_label: "1차",
      observed_at: "2026-04-21",
      raw_text:
        "설명이 디테일하고 학습자 눈높이에 맞춰 진행되어 몰입도가 높았습니다.",
      ingested_at: "2026-04-21T10:00:00.000Z",
    },
    {
      id: "raw-2",
      instructor_id: "inst-1",
      source_type: "teaching_feedback_qualitative",
      source_ref: {},
      client_name: "테스트회사",
      course_name: "생성형 AI 실습",
      round_label: "1차",
      observed_at: "2026-04-21",
      raw_text:
        "다양한 예시와 직접 실습하는 시간이 충분해 내용을 쉽게 이해하고 활용해볼 수 있었습니다.",
      ingested_at: "2026-04-21T10:00:00.000Z",
    },
    {
      id: "raw-3",
      instructor_id: "inst-1",
      source_type: "teaching_feedback_ops",
      source_ref: {},
      client_name: "테스트회사",
      course_name: "생성형 AI 실습",
      round_label: "1차",
      observed_at: "2026-04-21",
      raw_text:
        "오전에 GPT 계정 로그인 이슈가 있어 초반 실습 진행이 지연되었습니다.",
      ingested_at: "2026-04-21T10:00:00.000Z",
    },
    {
      id: "raw-4",
      instructor_id: "inst-1",
      source_type: "teaching_feedback_qualitative",
      source_ref: {},
      client_name: "테스트회사",
      course_name: "생성형 AI 실습",
      round_label: "2차",
      observed_at: "2026-04-22",
      raw_text:
        "반복 회차로 갈수록 수강생 합격률과 만족도가 함께 상승해 재요청 의견이 나왔습니다.",
      ingested_at: "2026-04-22T10:00:00.000Z",
    },
    {
      id: "raw-5",
      instructor_id: "inst-1",
      source_type: "teaching_feedback_qualitative",
      source_ref: {},
      client_name: "테스트회사",
      course_name: "생성형 AI 실습",
      round_label: "3차",
      observed_at: "2026-04-23",
      raw_text:
        "회차가 반복될수록 합격자 비율과 만족도 상승이 같이 확인되었습니다.",
      ingested_at: "2026-04-23T10:00:00.000Z",
    },
    {
      id: "raw-6",
      instructor_id: "inst-1",
      source_type: "teaching_feedback_ops",
      source_ref: {},
      client_name: "테스트회사",
      course_name: "생성형 AI 실습",
      round_label: "2차",
      observed_at: "2026-04-22",
      raw_text:
        "기술 장애가 있었지만 강사님이 침착하게 대체 운영으로 수업을 이어갔습니다.",
      ingested_at: "2026-04-22T10:00:00.000Z",
    },
    {
      id: "raw-7",
      instructor_id: "inst-1",
      source_type: "teaching_feedback_ops",
      source_ref: {},
      client_name: "테스트회사",
      course_name: "생성형 AI 실습",
      round_label: "3차",
      observed_at: "2026-04-23",
      raw_text:
        "계정 오류 상황에서도 침착한 대응과 우회 진행으로 흐름을 유지했습니다.",
      ingested_at: "2026-04-23T10:00:00.000Z",
    },
    {
      id: "raw-8",
      instructor_id: "inst-1",
      source_type: "teaching_feedback_qualitative",
      source_ref: {},
      client_name: "테스트회사",
      course_name: "생성형 AI 실습",
      round_label: "2차",
      observed_at: "2026-04-22",
      raw_text:
        "비전공자도 이해하기 쉽게 풀어 설명해 공감대가 잘 형성되었습니다.",
      ingested_at: "2026-04-22T10:00:00.000Z",
    },
    {
      id: "raw-9",
      instructor_id: "inst-1",
      source_type: "teaching_feedback_qualitative",
      source_ref: {},
      client_name: "테스트회사",
      course_name: "생성형 AI 실습",
      round_label: "3차",
      observed_at: "2026-04-23",
      raw_text:
        "고연령층 수강생도 눈높이에 맞게 설명해줘 낯설지 않게 따라올 수 있었습니다.",
      ingested_at: "2026-04-23T10:00:00.000Z",
    },
    {
      id: "raw-10",
      instructor_id: "inst-1",
      source_type: "teaching_feedback_ops",
      source_ref: {},
      client_name: "테스트회사",
      course_name: "생성형 AI 실습",
      round_label: "4차",
      observed_at: "2026-04-24",
      raw_text:
        "FGI와 같은 비정기 요청에는 응답 지연이 있어 일정 조율이 늦었습니다.",
      ingested_at: "2026-04-24T10:00:00.000Z",
    },
    {
      id: "raw-11",
      instructor_id: "inst-1",
      source_type: "teaching_feedback_ops",
      source_ref: {},
      client_name: "테스트회사",
      course_name: "생성형 AI 실습",
      round_label: "5차",
      observed_at: "2026-04-25",
      raw_text:
        "긴급 일정 변경 같은 급한 요청에도 회신이 늦어 대응 착수가 지연됐습니다.",
      ingested_at: "2026-04-25T10:00:00.000Z",
    },
  ];

  const classifiedNotes: ClassifiedOperationalNote[] = [
    {
      raw_note_id: "raw-1",
      family: "delivery_quality",
      owner: "instructor",
      polarity: "positive",
      auto_confidence: "high",
      needs_followup: false,
      why_flagged: "test",
    },
    {
      raw_note_id: "raw-2",
      family: "positive_signal",
      owner: "instructor",
      polarity: "positive",
      auto_confidence: "high",
      needs_followup: false,
      why_flagged: "test",
    },
    {
      raw_note_id: "raw-3",
      family: "environment_issue",
      owner: "client_or_env",
      polarity: "negative",
      auto_confidence: "medium",
      needs_followup: false,
      why_flagged: "test",
    },
    {
      raw_note_id: "raw-4",
      family: "positive_signal",
      owner: "instructor",
      polarity: "positive",
      auto_confidence: "high",
      needs_followup: false,
      why_flagged: "test",
    },
    {
      raw_note_id: "raw-5",
      family: "positive_signal",
      owner: "instructor",
      polarity: "positive",
      auto_confidence: "high",
      needs_followup: false,
      why_flagged: "test",
    },
    {
      raw_note_id: "raw-6",
      family: "environment_issue",
      owner: "instructor",
      polarity: "positive",
      auto_confidence: "medium",
      needs_followup: false,
      why_flagged: "test",
    },
    {
      raw_note_id: "raw-7",
      family: "environment_issue",
      owner: "instructor",
      polarity: "positive",
      auto_confidence: "medium",
      needs_followup: false,
      why_flagged: "test",
    },
    {
      raw_note_id: "raw-8",
      family: "delivery_quality",
      owner: "instructor",
      polarity: "positive",
      auto_confidence: "high",
      needs_followup: false,
      why_flagged: "test",
    },
    {
      raw_note_id: "raw-9",
      family: "delivery_quality",
      owner: "instructor",
      polarity: "positive",
      auto_confidence: "high",
      needs_followup: false,
      why_flagged: "test",
    },
    {
      raw_note_id: "raw-10",
      family: "responsiveness_or_schedule",
      owner: "instructor",
      polarity: "negative",
      auto_confidence: "high",
      needs_followup: false,
      why_flagged: "test",
    },
    {
      raw_note_id: "raw-11",
      family: "responsiveness_or_schedule",
      owner: "instructor",
      polarity: "negative",
      auto_confidence: "high",
      needs_followup: false,
      why_flagged: "test",
    },
  ];

  const humanFollowups: HumanFollowup[] = [];
  const patterns = deriveBehavioralPatternLists({
    rawNotes,
    classifiedNotes,
    signals: {
      satisfactionAvg: 4.7,
      satisfactionCount: 12,
      slackActivityCount: 4,
      totalCourses: 24,
      recentCourses6mo: 6,
    },
  });

  assert(
    patterns.strengthPatterns.includes(
      "반복 회차에서 만족도 상승과 재요청 반응이 함께 확인됨"
    ),
    "strength patterns capture outcome uplift narrative",
    JSON.stringify(patterns)
  );
  assert(
    patterns.strengthPatterns.includes("기술 장애 발생 시 침착 대체 운영"),
    "strength patterns capture incident response narrative",
    JSON.stringify(patterns)
  );
  assert(
    patterns.strengthPatterns.includes("비전공자·고연령층 공감대 형성"),
    "strength patterns capture audience empathy narrative",
    JSON.stringify(patterns)
  );
  assert(
    patterns.riskPatterns.includes("비정기 요청(FGI, 긴급 일정)에 대한 응답 지연"),
    "risk patterns capture irregular request delay narrative",
    JSON.stringify(patterns)
  );

  const normalizedPayload = extractOperationalIntelligencePayload({
    operational_intelligence_phase1: {
      raw_operational_notes: [],
      classified_notes: [],
      human_followups: [],
      behavioral_intelligence: {
        risk_patterns: ["delivery_quality 반복 근거 3건"],
        strength_patterns: [
          "delivery_quality positive 근거 3건",
          "positive_signal positive 근거 4건",
          "출강 이력 20건 이상",
        ],
      },
    },
  });

  assert(
    normalizedPayload.behavioral_intelligence.risk_patterns.includes(
      "강의 전달력과 학습자 이해도 점검 보완 필요"
    ),
    "stored legacy risk patterns are normalized on read",
    JSON.stringify(normalizedPayload.behavioral_intelligence)
  );
  assert(
    normalizedPayload.behavioral_intelligence.strength_patterns.includes(
      "수강생 눈높이에 맞춘 설명과 몰입도 높은 진행"
    ),
    "stored legacy strength patterns are normalized on read",
    JSON.stringify(normalizedPayload.behavioral_intelligence)
  );
  assert(
    normalizeOperationalPatternLabels(
      ["delivery_quality 반복 근거 3건"],
      "risk"
    )[0] === "강의 전달력과 학습자 이해도 점검 보완 필요",
    "legacy risk note arrays can be normalized directly",
    JSON.stringify(
      normalizeOperationalPatternLabels(
        ["delivery_quality 반복 근거 3건"],
        "risk"
      )
    )
  );

  const result = await summarizeBehavioralIntelligenceFromEvidence({
    rawNotes,
    classifiedNotes,
    humanFollowups,
    signals: {
      satisfactionAvg: 4.7,
      satisfactionCount: 12,
      slackActivityCount: 4,
      totalCourses: 24,
      recentCourses6mo: 6,
    },
    riskPatterns: [],
    strengthPatterns: ["비전공자·고연령층 공감대 형성"],
    dataRichness: "moderate",
    confidence: "medium",
  });

  assert(result.usedLlm === true, "summary helper marks LLM usage");
  assert(
    result.summary.teaching_style ===
      "설명을 쉽게 풀고 실습 맥락에 맞춰 학습자를 끌고 가는 편입니다.",
    "teaching_style is populated from raw-note summary",
    JSON.stringify(result.summary)
  );
  assert(
    result.summary.curriculum_compliance?.includes("실습과 예시 중심") ===
      true,
    "curriculum_compliance is populated",
    JSON.stringify(result.summary)
  );
  assert(
    result.summary.attitude === "질문 대응과 피드백 반영은 빠른 편으로 보입니다.",
    "attitude is populated",
    JSON.stringify(result.summary)
  );
  assert(
    result.summary.strength_patterns.includes(
      "비전공자와 고연령층도 따라오기 쉽게 설명하며 공감대를 만듭니다."
    ) &&
      result.summary.strength_patterns.includes(
        "실습과 예시를 충분히 곁들여 배운 내용을 바로 적용해보게 합니다."
      ),
    "strength_patterns are populated from differentiated collected reactions",
    JSON.stringify(result.summary)
  );
  assert(
    result.summary.risk_patterns.includes(
      "계정·환경 이슈가 생기면 초반 실습 흐름이 잠시 흔들릴 수 있습니다."
    ) &&
      result.summary.risk_patterns.includes(
        "비정기 요청이나 급한 일정 변경에는 회신 속도를 미리 확인할 필요가 있습니다."
      ),
    "risk_patterns are populated from differentiated collected cautions",
    JSON.stringify(result.summary)
  );
  assert(
    result.summary.recommendation?.includes("계정·환경 이슈") === true,
    "recommendation includes operational caveat from raw notes",
    JSON.stringify(result.summary)
  );
  assert(
    result.summary.key_question_for_humans ===
      "실습 환경 준비와 계정 안내 시점을 한 번 더 확인해두는 편이 좋습니다.",
    "key_question_for_humans is populated by LLM summary",
    JSON.stringify(result.summary)
  );
} finally {
  globalThis.fetch = originalFetch;
  if (originalApiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalApiKey;
  }
  if (originalModel === undefined) {
    delete process.env.OPERATIONAL_INTELLIGENCE_LLM_MODEL;
  } else {
    process.env.OPERATIONAL_INTELLIGENCE_LLM_MODEL = originalModel;
  }
}

console.log(`\nTotal: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
