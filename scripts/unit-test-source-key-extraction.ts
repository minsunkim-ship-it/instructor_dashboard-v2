/**
 * unit-test-source-key-extraction.ts — getSourceKeyFromSourceRef 6 패턴 검증
 *
 * 직전 실수: 1-depth array 만 보고 fix 했다고 보고. 실제는 2-depth nested.
 * 이번엔 모든 실제 패턴 (snapshot 기반) 커버.
 */
import { prisma } from "@/lib/prisma";

// helper를 직접 import 못함 (private). 동일 로직 복제 + 비교.
function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function getString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function getSourceKey(sourceRef: unknown): string | null {
  const record = asRecord(sourceRef);
  const direct = getString(record.source_key);
  if (direct) return direct;
  const sourceRefs = record.source_refs;
  if (Array.isArray(sourceRefs) && sourceRefs.length > 0) {
    const first = asRecord(sourceRefs[0]);
    const nested = asRecord(first.source_ref);
    const nestedKey = getString(nested.source_key);
    if (nestedKey) return nestedKey;
    const flatInArray = getString(first.source_key);
    if (flatInArray) return flatInArray;
  }
  return null;
}

interface TestCase {
  name: string;
  input: unknown;
  expected: string | null;
}

const cases: TestCase[] = [
  // Pattern 1: 1-depth flat (SatisfactionImportItem)
  {
    name: "1-depth flat (ImportItem - kt)",
    input: { source_key: "kt_ai_campus", row_number: 6, worksheet_gid: 123 },
    expected: "kt_ai_campus",
  },
  // Pattern 2: 2-depth nested (SatisfactionRecord 정상)
  {
    name: "2-depth nested (Record - woori)",
    input: {
      registry_key: "satisfaction:woori_ax_forms:abc",
      source_refs: [
        {
          source_ref: { source_key: "woori_ax_forms", row_number: 11 },
          response_date: "2025-11-26",
        },
      ],
    },
    expected: "woori_ax_forms",
  },
  // Pattern 3: gmail (source_key 없음)
  {
    name: "gmail (no source_key)",
    input: {
      source_refs: [
        {
          source_ref: { thread_id: "abc", message_id: "def", account_email: "x@y.com" },
        },
      ],
    },
    expected: null,
  },
  // Pattern 4: 1-depth in array (안전망 — 미래 구조 변경 대비)
  {
    name: "1-depth in array (fallback)",
    input: {
      source_refs: [{ source_key: "dongkuk_steel_dk_ai_2026_03_6", row_number: 1 }],
    },
    expected: "dongkuk_steel_dk_ai_2026_03_6",
  },
  // Pattern 5: 빈 sourceRef
  {
    name: "empty sourceRef",
    input: {},
    expected: null,
  },
  // Pattern 6: null
  {
    name: "null",
    input: null,
    expected: null,
  },
  // Pattern 7: 2-depth with multiple entries (registry 가 여러 응답 aggregate)
  {
    name: "2-depth multiple entries",
    input: {
      registry_key: "satisfaction:dongkuk_steel:xyz",
      source_refs: [
        { source_ref: { source_key: "dongkuk_steel_dk_ai_2026_03_6", row_number: 5 } },
        { source_ref: { source_key: "dongkuk_steel_dk_ai_2026_03_6", row_number: 7 } },
        { source_ref: { source_key: "dongkuk_steel_dk_ai_2026_03_6", row_number: 9 } },
      ],
    },
    expected: "dongkuk_steel_dk_ai_2026_03_6",
  },
];

let passed = 0;
let failed = 0;
for (const c of cases) {
  const actual = getSourceKey(c.input);
  const ok = actual === c.expected;
  console.log(`  ${ok ? "✓" : "✗"} ${c.name} → ${actual} (expected: ${c.expected})`);
  if (ok) passed++;
  else failed++;
}
console.log(`\n결과: ${passed}/${cases.length} passed`);

// 실제 DB 5개 record로 sanity check
console.log(`\n실제 DB sanity check:`);
const records = await prisma.satisfactionRecord.findMany({
  take: 5,
  select: { id: true, sourceType: true, sourceRef: true },
});
for (const r of records) {
  const k = getSourceKey(r.sourceRef);
  console.log(`  [${r.sourceType}] ${r.id.slice(0, 8)}: source_key=${k ?? "null"}`);
}

const items = await prisma.satisfactionImportItem.findMany({
  take: 3,
  select: { id: true, sourceType: true, sourceRef: true },
});
for (const it of items) {
  const k = getSourceKey(it.sourceRef);
  console.log(`  [Item ${it.sourceType}] ${it.id.slice(0, 8)}: source_key=${k ?? "null"}`);
}

await prisma.$disconnect();
if (failed > 0) process.exit(1);
