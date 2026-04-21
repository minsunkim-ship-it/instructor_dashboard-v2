const { extractNotionCommentNotesFromMemo } = await import(
  new URL("../src/lib/operational-intelligence.ts", import.meta.url).href
);

let passed = 0;
let failed = 0;

function assertEq<T>(label: string, actual: T, expected: T) {
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

console.log("Operational notion comments");
console.log("");

const memoRaw = [
  "[Notion comment · user:cf6eda97-f45f-433e-9e88-ba225f3773b1 · 2026-04-10] [가급적 섭외 지양]",
  "[Notion comment · user:cf6eda97-f45f-433e-9e88-ba225f3773b1 · 2026-04-10] • 삼성전자 영업마케팅 스쿨 (인재개발원) 교육 준비에 비협조적이며 연락이 잘 안 되는 편",
  "[Notion comment · user:cf6eda97-f45f-433e-9e88-ba225f3773b1 · 2026-04-10] ◦ 문자/메일 회신의 텀이 매우 길고, 전화는 안 받거나 전원을 꺼버리는 편",
  "[Notion comment · user:cf6eda97-f45f-433e-9e88-ba225f3773b1 · 2026-04-10] • 보안 사업장에서 보안 위규 사항 등이 있었음에도 불구하고 패캠에 알리지 않는다거나 // 교안 논의 및 피드백에 대한 소통 등 중요한 소통을 회피하는 성향으로 생각됨..",
].join("\n");

assertEq("same author/date notion lines are grouped into one note", extractNotionCommentNotesFromMemo(memoRaw), [
  {
    author: "user:cf6eda97-f45f-433e-9e88-ba225f3773b1",
    observedAt: "2026-04-10",
    text: "[가급적 섭외 지양] / • 삼성전자 영업마케팅 스쿨 (인재개발원) 교육 준비에 비협조적이며 연락이 잘 안 되는 편 / ◦ 문자/메일 회신의 텀이 매우 길고, 전화는 안 받거나 전원을 꺼버리는 편 / • 보안 사업장에서 보안 위규 사항 등이 있었음에도 불구하고 패캠에 알리지 않는다거나 // 교안 논의 및 피드백에 대한 소통 등 중요한 소통을 회피하는 성향으로 생각됨..",
  },
]);

console.log(`\nTotal: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
