import { parseManualSatisfactionInput } from "@/lib/manual-satisfaction-input";

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
    return;
  }

  fail(label, detail);
}

console.log("Manual satisfaction input parser");

const valid = parseManualSatisfactionInput({
  score: 4.5,
  comment: "  만족  ",
  company_name: " ACME ",
  course_name: " 리더십 ",
  response_date: "2026-04-23",
});
assert(valid.ok, "valid payload is accepted");
if (valid.ok) {
  assert(valid.value.score === 4.5, "score is preserved");
  assert(valid.value.comment === "만족", "comment is trimmed");
  assert(valid.value.company_name === "ACME", "company name is trimmed");
  assert(valid.value.course_name === "리더십", "course name is trimmed");
  assert(valid.value.response_date === "2026-04-23", "response date is preserved");
}

const stringScore = parseManualSatisfactionInput({ score: "5" });
assert(
  !stringScore.ok && stringScore.error.code === "INVALID_SATISFACTION_SCORE",
  "string score is rejected",
  JSON.stringify(stringScore)
);

const invalidDate = parseManualSatisfactionInput({
  score: 5,
  response_date: "2026-02-30",
});
assert(
  !invalidDate.ok && invalidDate.error.code === "INVALID_INPUT",
  "invalid response date is rejected",
  JSON.stringify(invalidDate)
);

const invalidComment = parseManualSatisfactionInput({
  score: 3,
  comment: 123,
});
assert(
  !invalidComment.ok && invalidComment.error.code === "INVALID_INPUT",
  "non-string optional field is rejected",
  JSON.stringify(invalidComment)
);

const emptyStrings = parseManualSatisfactionInput({
  score: 2,
  comment: "   ",
  company_name: "",
  course_name: " ",
  response_date: null,
});
assert(emptyStrings.ok, "blank optional strings are normalized");
if (emptyStrings.ok) {
  assert(emptyStrings.value.comment === null, "blank comment becomes null");
  assert(emptyStrings.value.company_name === null, "blank company becomes null");
  assert(emptyStrings.value.course_name === null, "blank course becomes null");
  assert(emptyStrings.value.response_date === null, "null response date stays null");
}

if (failed > 0) {
  console.error(`\n${failed} tests failed, ${passed} passed.`);
  process.exit(1);
}

console.log(`\n${passed} tests passed.`);
