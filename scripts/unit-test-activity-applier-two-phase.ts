import {
  buildRegistryGroups,
  augmentAffectedGroupsWithHeavy,
  type StoredActivityRow,
  type HeavyActivityRow,
} from "@/lib/pipeline/activity-applier";

let passed = 0;
let failed = 0;

function assertEq<T>(label: string, actual: T, expected: T): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  [PASS] ${label}`);
    passed++;
  } else {
    console.log(`  [FAIL] ${label}`);
    console.log(`    expected: ${JSON.stringify(expected)}`);
    console.log(`    actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

function assertTrue(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  [PASS] ${label}`);
    passed++;
  } else {
    console.log(`  [FAIL] ${label}${detail ? " — " + detail : ""}`);
    failed++;
  }
}

console.log("activity-applier two-phase load — buildRegistryGroups + augmentAffectedGroupsWithHeavy");
console.log("");

const instructorId = "00000000-0000-0000-0000-000000000001";

// Synthetic light rows: 2 groups
// Group A: matched to instructorId, 3 slack + 1 gmail rows
// Group B: unmatched candidate "unknown_candidate", 2 rows
const lightRows: StoredActivityRow[] = [
  {
    id: "row-a-slack-1",
    sourceType: "slack",
    sourceRefKey: "a-key-1",
    candidateName: "홍길동",
    candidateEmail: null,
    activityAt: new Date("2026-04-01T10:00:00Z"),
    isOpsReport: false,
    isDispatchRequest: false,
    matchStatus: "matched",
    matchedInstructorId: instructorId,
    matchBasis: "name",
    errorReason: null,
  },
  {
    id: "row-a-slack-2",
    sourceType: "slack",
    sourceRefKey: "a-key-2",
    candidateName: "홍길동",
    candidateEmail: null,
    activityAt: new Date("2026-04-05T10:00:00Z"),
    isOpsReport: true, // ops_report
    isDispatchRequest: false,
    matchStatus: "matched",
    matchedInstructorId: instructorId,
    matchBasis: "name",
    errorReason: null,
  },
  {
    id: "row-a-slack-3-dispatch",
    sourceType: "slack",
    sourceRefKey: "a-key-1", // duplicate sourceRefKey — should dedupe in sourceRefs
    candidateName: "홍길동",
    candidateEmail: null,
    activityAt: new Date("2026-04-10T10:00:00Z"),
    isOpsReport: false,
    isDispatchRequest: true, // dispatch_request
    matchStatus: "matched",
    matchedInstructorId: instructorId,
    matchBasis: "name",
    errorReason: null,
  },
  {
    id: "row-a-gmail-1",
    sourceType: "gmail",
    sourceRefKey: "a-gmail-1",
    candidateName: "홍길동",
    candidateEmail: "hong@example.com",
    activityAt: new Date("2026-03-15T10:00:00Z"),
    isOpsReport: false,
    isDispatchRequest: false,
    matchStatus: "matched",
    matchedInstructorId: instructorId,
    matchBasis: "email",
    errorReason: null,
  },
  {
    id: "row-b-1",
    sourceType: "slack",
    sourceRefKey: "b-key-1",
    candidateName: "unknown_candidate",
    candidateEmail: null,
    activityAt: new Date("2026-04-02T10:00:00Z"),
    isOpsReport: false,
    isDispatchRequest: false,
    matchStatus: "unmatched",
    matchedInstructorId: null,
    matchBasis: null,
    errorReason: null,
  },
  {
    id: "row-b-2",
    sourceType: "slack",
    sourceRefKey: "b-key-2",
    candidateName: "unknown_candidate",
    candidateEmail: null,
    activityAt: new Date("2026-04-03T10:00:00Z"),
    isOpsReport: false,
    isDispatchRequest: false,
    matchStatus: "unmatched",
    matchedInstructorId: null,
    matchBasis: null,
    errorReason: null,
  },
];

// === Phase 1 ===
console.log("Phase 1 — buildRegistryGroups with light rows only");
const groups = buildRegistryGroups(lightRows);

// 3 distinct registry keys because each sourceType is separate:
// - slack:instructor:<id>  (3 slack matched rows)
// - gmail:instructor:<id>  (1 gmail matched row)
// - slack:candidate:unknown_candidate|  (2 unmatched slack rows)
assertEq("group count = 3", groups.size, 3);

const aKey = `slack:instructor:${instructorId}`;
const bKey = `gmail:instructor:${instructorId}`;
const groupA = groups.get(aKey);
const groupB_gmail = groups.get(bKey);
const groupB_unmatched = groups.get("slack:candidate:unknown_candidate|");

assertTrue("group A (slack:instructor) exists", !!groupA);
assertTrue("group B_gmail (gmail:instructor) exists", !!groupB_gmail);
assertTrue("group C (slack:candidate unmatched) exists", !!groupB_unmatched);

if (groupA) {
  assertEq("group A slackActivityCount", groupA.slackActivityCount, 3);
  assertEq("group A emailActivityCount", groupA.emailActivityCount, 0);
  assertEq("group A opsReportActivityCount", groupA.opsReportActivityCount, 1);
  assertEq("group A dispatchRequestActivityCount", groupA.dispatchRequestActivityCount, 1);
  assertEq(
    "group A lastActivityAt (max of A rows)",
    groupA.lastActivityAt?.toISOString(),
    "2026-04-10T10:00:00.000Z"
  );
  assertEq("group A candidateName", groupA.candidateName, "홍길동");
  assertEq("group A suggestedInstructorId", groupA.suggestedInstructorId, instructorId);
  assertEq("group A rowIds", groupA.rowIds.sort(), ["row-a-slack-1", "row-a-slack-2", "row-a-slack-3-dispatch"].sort());
  assertEq("group A sourceRefs EMPTY in Phase 1", groupA.sourceRefs.length, 0);
  assertEq("group A evidenceSamples EMPTY in Phase 1", groupA.evidenceSamples.length, 0);
}

if (groupB_gmail) {
  assertEq("group B_gmail emailActivityCount", groupB_gmail.emailActivityCount, 1);
  assertEq("group B_gmail slackActivityCount", groupB_gmail.slackActivityCount, 0);
  assertEq("group B_gmail candidateEmail", groupB_gmail.candidateEmail, "hong@example.com");
}

if (groupB_unmatched) {
  assertEq("group C (unmatched) slackActivityCount", groupB_unmatched.slackActivityCount, 2);
  assertEq("group C (unmatched) suggestedInstructorId", groupB_unmatched.suggestedInstructorId, null);
  assertEq("group C rowIds", groupB_unmatched.rowIds.sort(), ["row-b-1", "row-b-2"].sort());
}

console.log("");

// === Phase 2 ===
console.log("Phase 2 — augmentAffectedGroupsWithHeavy");

// Mark only group A + unmatched as "affected" (gmail group NOT affected)
const affectedKeys = [aKey, "slack:candidate:unknown_candidate|"];

const heavyRows: HeavyActivityRow[] = [
  {
    id: "row-a-slack-1",
    sourceRef: { channel_id: "C1", ts: "1" },
    sourceRefKey: "a-key-1",
    rawPayload: { text: "hello world 1" },
    activityAt: new Date("2026-04-01T10:00:00Z"),
  },
  {
    id: "row-a-slack-2",
    sourceRef: { channel_id: "C1", ts: "2" },
    sourceRefKey: "a-key-2",
    rawPayload: { text: "ops report msg" },
    activityAt: new Date("2026-04-05T10:00:00Z"),
  },
  {
    id: "row-a-slack-3-dispatch",
    sourceRef: { channel_id: "C1", ts: "3" },
    sourceRefKey: "a-key-1", // same key as row 1 → should NOT be added again to sourceRefs
    rawPayload: { text: "dispatch request" },
    activityAt: new Date("2026-04-10T10:00:00Z"),
  },
  {
    id: "row-b-1",
    sourceRef: { channel_id: "C2", ts: "1" },
    sourceRefKey: "b-key-1",
    rawPayload: { text: "unknown msg 1" },
    activityAt: new Date("2026-04-02T10:00:00Z"),
  },
  {
    id: "row-b-2",
    sourceRef: { channel_id: "C2", ts: "2" },
    sourceRefKey: "b-key-2",
    rawPayload: { text: "unknown msg 2" },
    activityAt: new Date("2026-04-03T10:00:00Z"),
  },
];

augmentAffectedGroupsWithHeavy(groups, affectedKeys, heavyRows);

if (groupA) {
  assertEq("group A sourceRefs after augment (dedupe by sourceRefKey)", groupA.sourceRefs.length, 2);
  assertEq("group A evidenceSamples after augment (3 rows)", groupA.evidenceSamples.length, 3);

  // Sorted desc by activity_at — latest first
  const firstTs = (groupA.evidenceSamples[0] as Record<string, unknown>).activity_at;
  const lastTs = (groupA.evidenceSamples[2] as Record<string, unknown>).activity_at;
  assertEq("group A evidence[0] is latest (2026-04-10)", firstTs, "2026-04-10T10:00:00.000Z");
  assertEq("group A evidence[2] is earliest (2026-04-01)", lastTs, "2026-04-01T10:00:00.000Z");
}

if (groupB_unmatched) {
  assertEq("group C sourceRefs after augment", groupB_unmatched.sourceRefs.length, 2);
  assertEq("group C evidenceSamples after augment", groupB_unmatched.evidenceSamples.length, 2);
}

if (groupB_gmail) {
  // NOT in affected keys → should remain empty
  assertEq("group B_gmail sourceRefs still EMPTY (not affected)", groupB_gmail.sourceRefs.length, 0);
  assertEq("group B_gmail evidenceSamples still EMPTY (not affected)", groupB_gmail.evidenceSamples.length, 0);
}

console.log("");

// === Edge case: evidence trim at 5 ===
console.log("Edge case — evidenceSamples trimmed to top 5");

const bigInstructorId = "00000000-0000-0000-0000-000000000002";
const manyLightRows: StoredActivityRow[] = Array.from({ length: 8 }, (_, i) => ({
  id: `big-row-${i}`,
  sourceType: "slack" as const,
  sourceRefKey: `big-key-${i}`,
  candidateName: "김영수",
  candidateEmail: null,
  activityAt: new Date(`2026-04-${String(i + 1).padStart(2, "0")}T10:00:00Z`),
  isOpsReport: false,
  isDispatchRequest: false,
  matchStatus: "matched" as const,
  matchedInstructorId: bigInstructorId,
  matchBasis: "name",
  errorReason: null,
}));

const manyHeavyRows: HeavyActivityRow[] = manyLightRows.map((r, i) => ({
  id: r.id,
  sourceRef: { channel_id: "Cbig", ts: String(i) },
  sourceRefKey: r.sourceRefKey,
  rawPayload: { text: `msg ${i}` },
  activityAt: r.activityAt,
}));

const bigGroups = buildRegistryGroups(manyLightRows);
const bigKey = `slack:instructor:${bigInstructorId}`;
augmentAffectedGroupsWithHeavy(bigGroups, [bigKey], manyHeavyRows);
const bigGroup = bigGroups.get(bigKey);
assertTrue("big group exists", !!bigGroup);
if (bigGroup) {
  assertEq("big group slackActivityCount = 8 (counts ALL rows)", bigGroup.slackActivityCount, 8);
  assertEq("big group evidenceSamples trimmed to 5", bigGroup.evidenceSamples.length, 5);
  assertEq(
    "big group evidence[0] is latest (2026-04-08)",
    (bigGroup.evidenceSamples[0] as Record<string, unknown>).activity_at,
    "2026-04-08T10:00:00.000Z"
  );
  assertEq(
    "big group evidence[4] is 2026-04-04 (5th newest)",
    (bigGroup.evidenceSamples[4] as Record<string, unknown>).activity_at,
    "2026-04-04T10:00:00.000Z"
  );
}

console.log("");

// === Edge case: empty inputs ===
console.log("Edge case — empty / no-op inputs");
const empty = new Map();
augmentAffectedGroupsWithHeavy(empty, [], []);
assertEq("empty groups + empty keys + empty heavy → no crash", empty.size, 0);

const oneGroupMap = buildRegistryGroups([lightRows[0]!]);
augmentAffectedGroupsWithHeavy(oneGroupMap, [], heavyRows);
const onlyGroup = Array.from(oneGroupMap.values())[0];
assertEq(
  "empty affectedKeys → no augmentation applied",
  onlyGroup?.sourceRefs.length ?? -1,
  0
);

console.log("");
console.log(`Total: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
