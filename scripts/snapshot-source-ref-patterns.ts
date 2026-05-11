/**
 * snapshot-source-ref-patterns.ts — 실제 sourceRef 구조 패턴 분석 (read-only)
 *
 * Expert review P0-1: sourceRef는 nested 구조 (source_refs[].source_ref.source_key)
 * 실제 DB sample을 read해서 pattern 정리:
 *   - SatisfactionRecord.sourceRef
 *   - SatisfactionImportItem.sourceRef
 *
 * 산출: reports/source-ref-patterns.json
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";

interface PatternSample {
  table: "satisfactionRecord" | "satisfactionImportItem";
  recordId: string;
  sourceType: string;
  registryKey: string | null;
  sourceKeyAt1Depth: string | null;
  sourceKeyAt2DepthInArray: string | null;
  sourceRef: unknown;
}

async function main() {
  const samples: PatternSample[] = [];

  // SatisfactionRecord — sourceType별 1건씩
  const recordTypes = await prisma.satisfactionRecord.findMany({
    distinct: ["sourceType"],
    select: { sourceType: true },
  });
  for (const t of recordTypes) {
    const records = await prisma.satisfactionRecord.findMany({
      where: { sourceType: t.sourceType },
      take: 2,
      select: { id: true, sourceType: true, sourceRef: true },
    });
    for (const r of records) {
      const ref = r.sourceRef as Record<string, unknown> | null;
      const direct = (ref?.source_key as string | undefined) ?? null;
      let nestedInArray: string | null = null;
      const refs = ref?.source_refs;
      if (Array.isArray(refs) && refs.length > 0) {
        const first = refs[0] as Record<string, unknown>;
        const at1 = first?.source_key as string | undefined;
        const at2 = (first?.source_ref as Record<string, unknown> | undefined)?.source_key as string | undefined;
        nestedInArray = at1 ?? at2 ?? null;
      }
      samples.push({
        table: "satisfactionRecord",
        recordId: r.id,
        sourceType: r.sourceType,
        registryKey: (ref?.registry_key as string | undefined) ?? null,
        sourceKeyAt1Depth: direct,
        sourceKeyAt2DepthInArray: nestedInArray,
        sourceRef: ref,
      });
    }
  }

  // SatisfactionImportItem — sourceType별 1건씩
  const itemTypes = await prisma.satisfactionImportItem.findMany({
    distinct: ["sourceType"],
    select: { sourceType: true },
  });
  for (const t of itemTypes) {
    const items = await prisma.satisfactionImportItem.findMany({
      where: { sourceType: t.sourceType },
      take: 2,
      select: { id: true, sourceType: true, sourceRef: true },
    });
    for (const it of items) {
      const ref = it.sourceRef as Record<string, unknown> | null;
      const direct = (ref?.source_key as string | undefined) ?? null;
      let nested: string | null = null;
      const refs = ref?.source_refs;
      if (Array.isArray(refs) && refs.length > 0) {
        const first = refs[0] as Record<string, unknown>;
        const at1 = first?.source_key as string | undefined;
        const at2 = (first?.source_ref as Record<string, unknown> | undefined)?.source_key as string | undefined;
        nested = at1 ?? at2 ?? null;
      }
      samples.push({
        table: "satisfactionImportItem",
        recordId: it.id,
        sourceType: it.sourceType,
        registryKey: (ref?.registry_key as string | undefined) ?? null,
        sourceKeyAt1Depth: direct,
        sourceKeyAt2DepthInArray: nested,
        sourceRef: ref,
      });
    }
  }

  console.log(`Total samples: ${samples.length}`);
  console.log(`\n패턴별 분류:`);
  const buckets: Record<string, number> = {
    "1depth_only": 0, // record.source_key 만
    "2depth_only": 0, // source_refs[].source_ref.source_key 만
    "both": 0,
    "neither": 0,
  };
  for (const s of samples) {
    const has1 = !!s.sourceKeyAt1Depth;
    const has2 = !!s.sourceKeyAt2DepthInArray;
    if (has1 && has2) buckets.both++;
    else if (has1) buckets["1depth_only"]++;
    else if (has2) buckets["2depth_only"]++;
    else buckets.neither++;
  }
  for (const [k, v] of Object.entries(buckets)) console.log(`  ${k}: ${v}`);

  console.log(`\n샘플 출력 (first 6):`);
  for (const s of samples.slice(0, 6)) {
    console.log(`\n  [${s.table}/${s.sourceType}] ${s.recordId.slice(0, 8)}`);
    console.log(`    1depth=${s.sourceKeyAt1Depth ?? "—"} | 2depth-array=${s.sourceKeyAt2DepthInArray ?? "—"}`);
    const refStr = JSON.stringify(s.sourceRef, null, 2);
    console.log(`    ref: ${refStr.slice(0, 300)}${refStr.length > 300 ? "..." : ""}`);
  }

  const reportDir = path.resolve(process.cwd(), "reports");
  await mkdir(reportDir, { recursive: true });
  const out = path.join(reportDir, "source-ref-patterns.json");
  await writeFile(
    out,
    JSON.stringify({ generatedAt: new Date().toISOString(), buckets, samples }, null, 2),
    "utf-8"
  );
  console.log(`\nSaved: ${out}`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
