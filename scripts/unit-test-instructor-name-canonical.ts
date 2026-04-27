import {
  buildCanonicalInstructorByNameMap,
  compareInstructorCanonicalPriority,
} from "../src/lib/instructor-name-canonical.ts";

let passed = 0;
let failed = 0;

function assertEq(label: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    console.log(`  [PASS] ${label}`);
    passed++;
  } else {
    console.log(`  [FAIL] ${label}`);
    console.log(`    expected: ${JSON.stringify(expected)}`);
    console.log(`    actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

console.log("Instructor canonical name map");
console.log("");

const t0 = new Date("2026-04-15T08:28:05.812Z");
const t1 = new Date("2026-04-15T08:28:06.030Z");

assertEq(
  "priority prefers earlier createdAt",
  compareInstructorCanonicalPriority(
    { id: "b", name: "윤자동", createdAt: t1 },
    { id: "a", name: "윤자동", createdAt: t0 }
  ) > 0,
  true
);

const canonical = buildCanonicalInstructorByNameMap([
  { id: "b", name: "윤자동", createdAt: t1 },
  { id: "a", name: "윤자동", createdAt: t0 },
  { id: "c", name: "정백", createdAt: t1 },
]);

assertEq("earliest duplicate wins", canonical.get("윤자동")?.id, "a");
assertEq("unique name preserved", canonical.get("정백")?.id, "c");
assertEq("map size reflects unique names", canonical.size, 2);

console.log(`\nTotal: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
