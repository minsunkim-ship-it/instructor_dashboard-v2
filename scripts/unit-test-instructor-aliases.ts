import {
  KNOWN_ALIASES,
  ALIAS_REVIEW_FLAGGED,
  resolveCanonical,
  getAllAliases,
  isReviewFlaggedAlias,
  areAliases,
} from "@/lib/instructor-aliases";
import { buildCanonicalInstructorByNameMap } from "@/lib/instructor-name-canonical";

let passed = 0;
let failed = 0;

function assertEq<T>(label: string, actual: T, expected: T): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  [PASS] ${label}`);
    passed++;
  } else {
    console.log(`  [FAIL] ${label}`);
    console.log(`    expected: ${e}`);
    console.log(`    actual:   ${a}`);
    failed++;
  }
}

function assertTrue(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  [PASS] ${label}`);
    passed++;
  } else {
    console.log(`  [FAIL] ${label}`);
    failed++;
  }
}

console.log("Instructor aliases — KNOWN_ALIASES + resolveCanonical + canonical map");
console.log("");

// 0. 분리 확정 강사 — KNOWN_ALIASES에 없어야 함
console.log("Group 0: 분리 확정 강사 (ground truth 검증 결과 다른 강사)");
assertTrue("'신동원' is NOT in KNOWN_ALIASES", !("신동원" in KNOWN_ALIASES));
assertTrue("'신동형' is NOT in KNOWN_ALIASES", !("신동형" in KNOWN_ALIASES));
assertTrue("'서주란' is NOT in KNOWN_ALIASES (이메일/전화/노션 모두 다름)", !("서주란" in KNOWN_ALIASES));
assertTrue("'강주란' is NOT in KNOWN_ALIASES", !("강주란" in KNOWN_ALIASES));

// 1. KNOWN_ALIASES 정합성: 양방향 등록 + canonical 일관
console.log("");
console.log("Group 1: KNOWN_ALIASES 정합성");
for (const [key, group] of Object.entries(KNOWN_ALIASES)) {
  // 모든 alias의 첫 번째(canonical)는 동일해야 함
  for (const alias of group) {
    const aliasGroup = KNOWN_ALIASES[alias];
    if (!aliasGroup) {
      assertTrue(`alias '${alias}' (under '${key}') is registered as key`, false);
      continue;
    }
    assertEq(
      `'${alias}' canonical = '${group[0]}'`,
      aliasGroup[0],
      group[0],
    );
  }
}

// 2. resolveCanonical 동작
console.log("");
console.log("Group 2: resolveCanonical");
// 신동원/신동형은 KNOWN_ALIASES에서 제거됨 (다른 강사로 확정)
assertEq("resolveCanonical('신동원') = 신동원 (별칭 아님)", resolveCanonical("신동원"), "신동원");
assertEq("resolveCanonical('신동형') = 신동형 (별칭 아님)", resolveCanonical("신동형"), "신동형");
assertEq("resolveCanonical('이동훈') = 이동훈", resolveCanonical("이동훈"), "이동훈");
assertEq("resolveCanonical('이동훈A') → 이동훈", resolveCanonical("이동훈A"), "이동훈");
assertEq("resolveCanonical('김영민C') → 김영민", resolveCanonical("김영민C"), "김영민");
// 서주란/강주란은 KNOWN_ALIASES에서 제거됨 (다른 강사로 확정)
assertEq("resolveCanonical('서주란') = 서주란 (별칭 아님)", resolveCanonical("서주란"), "서주란");
assertEq("resolveCanonical('강주란') = 강주란 (별칭 아님)", resolveCanonical("강주란"), "강주란");
assertEq("resolveCanonical('신주혜 (Zemma)') → 신주혜", resolveCanonical("신주혜 (Zemma)"), "신주혜");
assertEq("resolveCanonical('장철원') = 장철원 (등록 안됨)", resolveCanonical("장철원"), "장철원");
assertEq("resolveCanonical('') = ''", resolveCanonical(""), "");
assertEq("resolveCanonical(null) = ''", resolveCanonical(null), "");

// 3. getAllAliases
console.log("");
console.log("Group 3: getAllAliases");
assertEq(
  "getAllAliases('이동훈')",
  getAllAliases("이동훈"),
  ["이동훈", "이동훈A"],
);
assertEq(
  "getAllAliases('이동훈A') (same group)",
  getAllAliases("이동훈A"),
  ["이동훈", "이동훈A"],
);
assertEq(
  "getAllAliases('장철원') (등록 안됨, self만)",
  getAllAliases("장철원"),
  ["장철원"],
);

// 4. isReviewFlaggedAlias — 모든 KNOWN_ALIASES entry가 검토 대상
console.log("");
console.log("Group 4: ALIAS_REVIEW_FLAGGED");
assertTrue("이동훈A is review-flagged", isReviewFlaggedAlias("이동훈A"));
assertTrue("김영민C is review-flagged", isReviewFlaggedAlias("김영민C"));
assertTrue("신주혜 (Zemma) is review-flagged", isReviewFlaggedAlias("신주혜 (Zemma)"));
assertTrue("신동원 is NOT review-flagged (별칭 제거됨)", !isReviewFlaggedAlias("신동원"));
assertTrue("서주란 is NOT review-flagged (별칭 제거됨)", !isReviewFlaggedAlias("서주란"));
assertTrue("장철원 is NOT review-flagged", !isReviewFlaggedAlias("장철원"));

// 5. areAliases
console.log("");
console.log("Group 5: areAliases");
assertTrue("이동훈 ↔ 이동훈A", areAliases("이동훈", "이동훈A"));
assertTrue("NOT aliases (서주란 vs 강주란 — 다른 강사)", !areAliases("서주란", "강주란"));
assertTrue("self ↔ self (장철원)", areAliases("장철원", "장철원"));
assertTrue("NOT aliases (신동원 vs 신동형 — 다른 강사)", !areAliases("신동원", "신동형"));
assertTrue("not aliases (장철원 vs 이동훈)", !areAliases("장철원", "이동훈"));

// 6. buildCanonicalInstructorByNameMap — alias 통합 동작
console.log("");
console.log("Group 6: buildCanonicalInstructorByNameMap with aliases");
const t = new Date("2024-01-01T00:00:00Z");
type Row = { id: string; name: string; createdAt: Date };

// 케이스 6.1: "이동훈" row만 존재 → map.get("이동훈A")도 같은 row
{
  const rows: Row[] = [{ id: "i1", name: "이동훈", createdAt: t }];
  const map = buildCanonicalInstructorByNameMap(rows);
  assertEq("'이동훈' lookup → i1", map.get("이동훈")?.id, "i1");
  assertEq("'이동훈A' alias lookup → i1 (보강)", map.get("이동훈A")?.id, "i1");
  assertEq("'장철원' (등록 안됨) → undefined", map.get("장철원")?.id, undefined);
}

// 케이스 6.2: "이동훈"과 "이동훈A" row 둘 다 존재 → 각각 별개 row (alias 무력)
{
  const rows: Row[] = [
    { id: "i1", name: "이동훈", createdAt: t },
    { id: "i2", name: "이동훈A", createdAt: t },
  ];
  const map = buildCanonicalInstructorByNameMap(rows);
  assertEq("dual row '이동훈' → i1", map.get("이동훈")?.id, "i1");
  assertEq("dual row '이동훈A' → i2 (row.name 우선)", map.get("이동훈A")?.id, "i2");
}

// 케이스 6.3: "이동훈A" row만 존재 → "이동훈" alias도 i2
{
  const rows: Row[] = [{ id: "i2", name: "이동훈A", createdAt: t }];
  const map = buildCanonicalInstructorByNameMap(rows);
  assertEq("'이동훈A' lookup → i2", map.get("이동훈A")?.id, "i2");
  assertEq("'이동훈' alias lookup → i2 (역방향)", map.get("이동훈")?.id, "i2");
}

// 케이스 6.4: "신주혜 (Zemma)" row만 존재 → "신주혜" alias도 같은 row
{
  const rows: Row[] = [{ id: "z1", name: "신주혜 (Zemma)", createdAt: t }];
  const map = buildCanonicalInstructorByNameMap(rows);
  assertEq("'신주혜 (Zemma)' lookup → z1", map.get("신주혜 (Zemma)")?.id, "z1");
  assertEq("'신주혜' alias lookup → z1", map.get("신주혜")?.id, "z1");
}

console.log("");
console.log(`Total: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
