import { shouldIncludeInInstructorList } from "@/lib/instructor-list-visibility";

let passed = 0;
let failed = 0;

function assertEq(label: string, actual: boolean, expected: boolean): void {
  if (actual === expected) {
    console.log(`  [PASS] ${label}`);
    passed++;
  } else {
    console.log(`  [FAIL] ${label}`);
    console.log(`    expected: ${expected}`);
    console.log(`    actual:   ${actual}`);
    failed++;
  }
}

console.log("Instructor list visibility");

assertEq(
  "regular instructor stays visible",
  shouldIncludeInInstructorList({
    flag: null,
    isPracticeCoach: false,
  }),
  true
);

assertEq(
  "practice coach flag is excluded",
  shouldIncludeInInstructorList({
    flag: "실습코치",
    isPracticeCoach: false,
  }),
  false
);

assertEq(
  "live boolean practice coach is excluded",
  shouldIncludeInInstructorList({
    flag: null,
    isPracticeCoach: true,
  }),
  false
);

assertEq(
  "fallback snake-case practice coach is excluded",
  shouldIncludeInInstructorList({
    flag: null,
    is_practice_coach: true,
  }),
  false
);

assertEq(
  "flag wins even when boolean is missing",
  shouldIncludeInInstructorList({
    flag: " 실습코치 ",
  }),
  false
);

console.log(`\nTotal: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
