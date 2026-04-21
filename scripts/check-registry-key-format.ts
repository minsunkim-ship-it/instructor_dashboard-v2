import { prisma } from "@/lib/prisma";

async function main(): Promise<void> {
  const rows = await prisma.satisfactionReviewRegistry.findMany({
    where: { sourceType: "gmail_satisfaction" },
    select: { registryKey: true },
    take: 10,
  });

  if (rows.length === 0) {
    console.log("result: NO_ROWS");
    console.log("  → DB에 gmail_satisfaction 레지스트리 데이터가 없음. 현재 포맷(SHA-1)으로 그대로 가도 안전.");
    return;
  }

  const sha1Pattern = /^satisfaction:gmail_satisfaction:[0-9a-f]{40}$/;
  const plainPattern = /^satisfaction:gmail_satisfaction:/;
  const sha1Count = rows.filter((r) => sha1Pattern.test(r.registryKey)).length;
  const plainCount = rows.filter(
    (r) => !sha1Pattern.test(r.registryKey) && plainPattern.test(r.registryKey)
  ).length;
  const unknownCount = rows.length - sha1Count - plainCount;

  console.log(`fetched: ${rows.length} rows`);
  console.log(`  SHA-1 format (satisfaction:gmail_satisfaction:<hex40>): ${sha1Count}`);
  console.log(`  plain-text format (satisfaction:gmail_satisfaction:...): ${plainCount}`);
  console.log(`  unknown format: ${unknownCount}`);
  console.log("");
  console.log("sample keys:");
  for (const row of rows) {
    console.log(`  ${row.registryKey}`);
  }
  console.log("");

  if (sha1Count === rows.length) {
    console.log("verdict: ALL_SHA1 → 현재 Codex 버전(SHA-1) 그대로 유지 OK, 조치 불필요");
  } else if (plainCount === rows.length) {
    console.log("verdict: ALL_PLAIN → SHA-1 변경 시 모든 기존 레코드가 silent 오버라이트됨. plain-text로 revert 또는 migration 필요");
  } else {
    console.log("verdict: MIXED → 수동 확인 필요. 두 포맷이 섞여 있음");
  }
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
