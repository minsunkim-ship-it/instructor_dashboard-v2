import { prisma } from "@/lib/prisma";

interface LegacyCountRow {
  legacy_count: bigint;
  total_count: bigint;
}

interface CollisionRow {
  instructor_db_id: string;
  spreadsheet_id: string;
  row_number: number;
  gids: bigint;
  has_legacy: boolean;
}

async function main(): Promise<void> {
  // 1. legacy vs total row count
  const counts = await prisma.$queryRaw<LegacyCountRow[]>`
    SELECT
      COUNT(*) FILTER (WHERE NOT (source_ref ? 'worksheet_gid'))::bigint AS legacy_count,
      COUNT(*)::bigint AS total_count
    FROM teaching_histories
    WHERE source_type = 'contract_sheet'
  `;

  const row = counts[0];
  const legacyCount = row ? Number(row.legacy_count) : 0;
  const totalCount = row ? Number(row.total_count) : 0;

  console.log("=== Q1. legacy row count (worksheet_gid 없는 contract_sheet row) ===");
  console.log(`  total contract_sheet rows: ${totalCount}`);
  console.log(`  legacy rows (no worksheet_gid): ${legacyCount}`);
  console.log("");

  // 2. cross-worksheet collisions: same (instructor, spreadsheet, row_number) across multiple worksheets
  const collisions = await prisma.$queryRaw<CollisionRow[]>`
    SELECT
      instructor_db_id::text AS instructor_db_id,
      source_ref->>'spreadsheet_id' AS spreadsheet_id,
      (source_ref->>'row_number')::int AS row_number,
      COUNT(DISTINCT COALESCE(source_ref->>'worksheet_gid', '__legacy__'))::bigint AS gids,
      BOOL_OR(NOT (source_ref ? 'worksheet_gid')) AS has_legacy
    FROM teaching_histories
    WHERE source_type = 'contract_sheet'
      AND source_ref ? 'spreadsheet_id'
      AND source_ref ? 'row_number'
    GROUP BY 1, 2, 3
    HAVING COUNT(DISTINCT COALESCE(source_ref->>'worksheet_gid', '__legacy__')) > 1
  `;

  console.log("=== Q2. cross-worksheet 충돌 (같은 instructor + spreadsheet + row_number) ===");
  console.log(`  total collision groups: ${collisions.length}`);
  const withLegacy = collisions.filter((c) => c.has_legacy);
  console.log(`  그 중 legacy row를 포함한 collision: ${withLegacy.length}`);
  console.log("");

  if (withLegacy.length > 0) {
    console.log("  === 위험 케이스 샘플 (최대 5건) ===");
    for (const c of withLegacy.slice(0, 5)) {
      console.log(
        `    instructor=${c.instructor_db_id.slice(0, 8)}.. spreadsheet=${c.spreadsheet_id.slice(0, 10)}.. row_number=${c.row_number} gids=${Number(c.gids)}`
      );
    }
    console.log("");
  }

  // Verdict
  console.log("=== Verdict ===");
  if (legacyCount === 0) {
    console.log("  LEGACY_0 → legacy row 전무. HIGH 이슈는 이론적. TODO 주석 + naming/perf 정리만");
  } else if (withLegacy.length === 0) {
    console.log(`  LEGACY_${legacyCount}_NO_COLLISION → legacy row는 있지만 cross-worksheet 충돌 케이스 없음.`);
    console.log("  당장 drift 위험 없음. 다만 향후 worksheet_gid 추가되는 re-run 시 충돌 유발 가능성 있음.");
    console.log("  → 방어적 패치 권장 (PREFERRED_CONTRACT_WORKSHEET_GID 단일 허용) 또는 TODO 주석");
  } else {
    console.log(`  DRIFT_RISK_${withLegacy.length} → legacy + cross-worksheet 충돌 실제 존재.`);
    console.log("  → cleanup 로직 일부 복원 또는 PREFERRED_CONTRACT_WORKSHEET_GID 단일 허용 패치 필요");
  }
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
