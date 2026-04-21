import { extractOperationalFeedbackNotesFromImport } from "@/lib/operational-intelligence";
import { normalizeFeedbackNotesInImportItems } from "@/lib/pipeline/feedback-note-llm";
import type { SatisfactionImportItemInput } from "@/lib/pipeline/satisfaction-applier";

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

console.log("Feedback note LLM normalization");

const originalFetch = globalThis.fetch;
const originalApiKey = process.env.OPENAI_API_KEY;
const originalModel = process.env.SATISFACTION_FEEDBACK_LLM_MODEL;

process.env.OPENAI_API_KEY = "test-key";
process.env.SATISFACTION_FEEDBACK_LLM_MODEL = "gpt-test";

globalThis.fetch = (async () => {
  return new Response(
    JSON.stringify({
      output: [
        {
          content: [
            {
              type: "output_text",
              text: JSON.stringify({
                normalized_notes: [
                  {
                    source_id: "item:0:body",
                    units: [
                      {
                        note_type: "teaching_feedback_qualitative",
                        text: "설명이 쉬워서 몰입도가 높았습니다.",
                      },
                      {
                        note_type: "teaching_feedback_ops",
                        text: "노트북 화면 분할과 알트탭 전환이 불편했습니다.",
                      },
                    ],
                  },
                  {
                    source_id: "item:1:feedback:0",
                    units: [
                      {
                        note_type: "teaching_feedback_qualitative",
                        text: "실무 예시가 풍부해 이해가 쉬웠습니다.",
                      },
                      {
                        note_type: "teaching_feedback_ops",
                        text: "GPT 계정 로그인 이슈로 초반 시간이 지연되었습니다.",
                      },
                    ],
                  },
                ],
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
  const items: SatisfactionImportItemInput[] = [
    {
      sourceType: "gmail_summary",
      sourceRefKey: "gmail:test:1",
      sourceRef: {},
      rawPayload: {
        body_excerpt:
          "김오틸리아 Othilia Kim\n좋았던 점\n설명이 쉬웠습니다.\n노트북 화면 분할과 알트탭 전환이 어려웠습니다.\n확인 부탁드리",
      },
      normalizedPayload: {
        company_name: "테스트회사",
        course_name: "생성형 AI 과정",
        response_date: "2026-04-21",
      },
      candidateName: null,
      candidateCompanyName: "테스트회사",
      candidateCourseName: "생성형 AI 과정",
      scoreRaw: null,
      scoreNormalized: null,
      respondentCount: 1,
      responseDate: null,
    },
    {
      sourceType: "sheet_summary",
      sourceRefKey: "sheet:test:1",
      sourceRef: {},
      rawPayload: {
        feedback_notes: [
          {
            note_type: "teaching_feedback_qualitative",
            text: "실무 예시가 풍부해 이해가 쉬웠습니다. / 오전에 GPT 계정 로그인 이슈가 있었습니다.",
            header: "주관식 주요 의견",
            row_index: 4,
            column_index: 8,
          },
        ],
      },
      normalizedPayload: {
        company_name: "테스트회사",
        course_name: "생성형 AI 과정",
        response_date: "2026-04-21",
      },
      candidateName: null,
      candidateCompanyName: "테스트회사",
      candidateCourseName: "생성형 AI 과정",
      scoreRaw: "4.6",
      scoreNormalized: 4.6,
      respondentCount: 1,
      responseDate: "2026-04-21",
    },
  ];

  await normalizeFeedbackNotesInImportItems(items);

  const gmailPayload = items[0]?.rawPayload as Record<string, unknown>;
  const gmailFeedbackNotes = Array.isArray(gmailPayload.feedback_notes)
    ? (gmailPayload.feedback_notes as Array<Record<string, unknown>>)
    : [];
  assert(
    gmailPayload.feedback_notes_llm_extracted === true,
    "gmail body excerpt is converted into explicit feedback notes"
  );
  assert(
    gmailFeedbackNotes.length === 2,
    "gmail body excerpt yields two meaning units",
    JSON.stringify(gmailFeedbackNotes)
  );
  assert(
    gmailFeedbackNotes.some(
      (note) =>
        note.note_type === "teaching_feedback_qualitative" &&
        note.text === "설명이 쉬워서 몰입도가 높았습니다."
    ),
    "gmail body excerpt keeps qualitative unit",
    JSON.stringify(gmailFeedbackNotes)
  );
  assert(
    gmailFeedbackNotes.some(
      (note) =>
        note.note_type === "teaching_feedback_ops" &&
        note.text === "노트북 화면 분할과 알트탭 전환이 불편했습니다."
    ),
    "gmail body excerpt keeps ops unit",
    JSON.stringify(gmailFeedbackNotes)
  );

  const sheetPayload = items[1]?.rawPayload as Record<string, unknown>;
  const sheetFeedbackNotes = Array.isArray(sheetPayload.feedback_notes)
    ? (sheetPayload.feedback_notes as Array<Record<string, unknown>>)
    : [];
  assert(
    Array.isArray(sheetPayload.feedback_notes_original),
    "existing feedback notes keep original payload for audit"
  );
  assert(
    sheetFeedbackNotes.length === 2,
    "sheet feedback note is split into two meaning units",
    JSON.stringify(sheetFeedbackNotes)
  );
  assert(
    sheetFeedbackNotes.some(
      (note) =>
        note.note_type === "teaching_feedback_qualitative" &&
        note.text === "실무 예시가 풍부해 이해가 쉬웠습니다."
    ),
    "sheet note keeps qualitative unit",
    JSON.stringify(sheetFeedbackNotes)
  );
  assert(
    sheetFeedbackNotes.some(
      (note) =>
        note.note_type === "teaching_feedback_ops" &&
        note.text === "GPT 계정 로그인 이슈로 초반 시간이 지연되었습니다."
    ),
    "sheet note reclassifies ops issue as ops unit",
    JSON.stringify(sheetFeedbackNotes)
  );

  const extractedGmailNotes = extractOperationalFeedbackNotesFromImport({
    sourceType: "gmail_summary",
    rawPayload: gmailPayload,
  });
  assert(
    extractedGmailNotes.length === 2,
    "gmail extraction prefers LLM-derived explicit notes over regex body parsing",
    JSON.stringify(extractedGmailNotes)
  );
  assert(
    extractedGmailNotes.every((note) => !note.text.includes("김오틸리아")),
    "gmail extraction excludes metadata/name fragments after LLM normalization",
    JSON.stringify(extractedGmailNotes)
  );
} finally {
  globalThis.fetch = originalFetch;
  if (originalApiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalApiKey;
  }
  if (originalModel === undefined) {
    delete process.env.SATISFACTION_FEEDBACK_LLM_MODEL;
  } else {
    process.env.SATISFACTION_FEEDBACK_LLM_MODEL = originalModel;
  }
}

console.log(`\nTotal: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
