import { extractOperationalFeedbackNotesFromImport } from "@/lib/operational-intelligence";

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

console.log("Operational feedback extraction — embedded feedback sanitization");

const positiveFeedback =
  "전반적으로 강의가 쉽고 친절하게 진행되어 생성형 AI 활용 내용을 부담 없이 이해할 수 있었다는 의견 / 특히 설명이 디테일하고 학습자 눈높이에 맞춰 진행되어 교육 몰입도와 만족도가 높게 나타남";

const structuredNotes = extractOperationalFeedbackNotesFromImport({
  sourceType: "sheet_summary",
  rawPayload: {
    feedback_notes: [
      {
        note_type: "teaching_feedback_qualitative",
        text: positiveFeedback,
      },
      {
        note_type: "teaching_feedback_qualitative",
        text: "김오틸리아 Othilia Kim",
      },
      {
        note_type: "teaching_feedback_qualitative",
        text: "오전에 GPT 계정 로그인 및 인증 이슈가 있었습니다. / 이에 시간이 소요되어 추후 O",
      },
      {
        note_type: "teaching_feedback_qualitative",
        text: "확인 부탁드리",
      },
    ],
  },
});

assert(
  structuredNotes.length === 2,
  "structured notes drop name-only and action-request fragments",
  `expected 2 notes, got ${structuredNotes.length}: ${JSON.stringify(structuredNotes)}`
);
assert(
  structuredNotes.some((note) => note.text === positiveFeedback),
  "structured notes keep meaningful qualitative feedback",
  JSON.stringify(structuredNotes)
);
assert(
  structuredNotes.some(
    (note) => note.text === "오전에 GPT 계정 로그인 및 인증 이슈가 있었습니다."
  ),
  "structured notes keep valid ops sentence and drop truncated tail",
  JSON.stringify(structuredNotes)
);
assert(
  structuredNotes.every(
    (note) =>
      !note.text.includes("김오틸리아") &&
      !note.text.includes("확인 부탁드리") &&
      !note.text.includes("추후 O")
  ),
  "structured notes exclude noisy fragments",
  JSON.stringify(structuredNotes)
);

const gmailNotes = extractOperationalFeedbackNotesFromImport({
  sourceType: "gmail_summary",
  rawPayload: {
    body_excerpt: "",
    drive_sheet_notes: [
      {
        note_type: "teaching_feedback_qualitative",
        text: "김오틸리아 Othilia Kim",
      },
      {
        note_type: "teaching_feedback_qualitative",
        text: "실습 중심으로 진행되어 직접 체험하고 따라 해볼 수 있었던 점에 대한 만족도가 높았습니다.",
      },
      {
        note_type: "teaching_feedback_qualitative",
        text: "확인 부탁드리",
      },
    ],
  },
});

assert(
  gmailNotes.length === 1,
  "gmail embedded notes apply the same sanitization rules",
  `expected 1 note, got ${gmailNotes.length}: ${JSON.stringify(gmailNotes)}`
);
assert(
  gmailNotes[0]?.text ===
    "실습 중심으로 진행되어 직접 체험하고 따라 해볼 수 있었던 점에 대한 만족도가 높았습니다.",
  "gmail embedded notes keep valid feedback text",
  JSON.stringify(gmailNotes)
);

console.log(`\nTotal: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
