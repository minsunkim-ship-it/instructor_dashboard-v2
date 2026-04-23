import { parseReviewDecisionInput } from "@/lib/review-decision-input";

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

console.log("Review decision input parser");

const valid = parseReviewDecisionInput({
  registryType: "activity",
  registryKey: "gmail:foo",
  decisionType: "override_instructor",
  targetInstructorId: " instructor-1 ",
  note: "  keep  ",
  createdBy: " api:user ",
});
assert(valid.ok, "valid override payload is accepted");
if (valid.ok) {
  assert(valid.value.targetInstructorId === "instructor-1", "target instructor is trimmed");
  assert(valid.value.note === "keep", "note is trimmed");
  assert(valid.value.createdBy === "api:user", "createdBy is trimmed");
}

const invalidBody = parseReviewDecisionInput([]);
assert(
  !invalidBody.ok && invalidBody.error.message === "request body must be a JSON object",
  "non-object payload is rejected",
  JSON.stringify(invalidBody)
);

const invalidDecisionType = parseReviewDecisionInput({
  registryType: "activity",
  registryKey: "gmail:foo",
  decisionType: "delete",
});
assert(
  !invalidDecisionType.ok && invalidDecisionType.error.message === "decisionType is invalid",
  "unknown decision type is rejected",
  JSON.stringify(invalidDecisionType)
);

const missingTarget = parseReviewDecisionInput({
  registryType: "activity",
  registryKey: "gmail:foo",
  decisionType: "override_instructor",
});
assert(
  !missingTarget.ok &&
    missingTarget.error.message === "targetInstructorId is required for override_instructor",
  "override decision requires target instructor",
  JSON.stringify(missingTarget)
);

const wrongType = parseReviewDecisionInput({
  registryType: "activity",
  registryKey: "gmail:foo",
  decisionType: "approve",
  note: 123,
});
assert(
  !wrongType.ok && wrongType.error.message === "note must be a string",
  "non-string optional field is rejected",
  JSON.stringify(wrongType)
);

if (failed > 0) {
  console.error(`\n${failed} tests failed, ${passed} passed.`);
  process.exit(1);
}

console.log(`\n${passed} tests passed.`);
