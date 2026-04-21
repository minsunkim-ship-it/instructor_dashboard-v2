import { summarizeBehavioralIntelligenceFromEvidence } from "@/lib/operational-intelligence";
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
                recommendation:
                  "현업 적용형 실습 비중이 높은 과정에 적합합니다. 계정·환경 이슈가 있는 세션은 사전 점검을 더 촘촘히 두는 편이 좋습니다.",
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
  ];

  const humanFollowups: HumanFollowup[] = [];

  const result = await summarizeBehavioralIntelligenceFromEvidence({
    rawNotes,
    classifiedNotes,
    humanFollowups,
    signals: {
      satisfactionAvg: 4.7,
      satisfactionCount: 12,
      slackActivityCount: 4,
      totalCourses: 18,
      recentCourses6mo: 6,
    },
    riskPatterns: [],
    strengthPatterns: ["positive_signal positive 근거 2건"],
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
    result.summary.recommendation?.includes("계정·환경 이슈") === true,
    "recommendation includes operational caveat from raw notes",
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
