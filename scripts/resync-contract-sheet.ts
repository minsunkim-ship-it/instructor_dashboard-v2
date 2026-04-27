import path from "node:path";

import { collectFromContractSheets } from "@/lib/pipeline/contract-sheet-collector";
import { normalizeContractRows } from "@/lib/pipeline/contract-sheet-normalizer";
import {
  recomputeAggregatesForInstructors,
  storeContractRows,
} from "@/lib/pipeline/contract-sheet-store";
import { prisma } from "@/lib/prisma";
import { loadDotEnv } from "./lib/audit-helpers.ts";

async function main() {
  await loadDotEnv(path.join(process.cwd(), ".env"));

  const collected = await collectFromContractSheets();
  const affectedInstructorIds = new Set<string>();
  const worksheetSummaries: Array<Record<string, unknown>> = [];

  for (const worksheet of collected.worksheets) {
    if (worksheet.error) {
      throw new Error(`gid=${worksheet.gid} collect failed: ${worksheet.error}`);
    }

    const normalized = normalizeContractRows(worksheet.rows);
    const stored = await storeContractRows(normalized);
    stored.instructorIdsAffected.forEach((id) => affectedInstructorIds.add(id));

    worksheetSummaries.push({
      gid: worksheet.gid,
      fetched: worksheet.fetchedCount,
      appended: stored.appended,
      updated: stored.updated,
      skipped: stored.skipped,
      deduped: stored.deduped,
      instructorsCreated: stored.instructorsCreated,
      errors: stored.errors.length,
      sampleErrors: stored.errors.slice(0, 5),
    });
  }

  const aggregatesUpdated = await recomputeAggregatesForInstructors(affectedInstructorIds);

  console.log(
    JSON.stringify(
      {
        spreadsheetId: collected.spreadsheetId,
        worksheetSummaries,
        affectedInstructors: affectedInstructorIds.size,
        aggregatesUpdated,
      },
      null,
      2
    )
  );
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
