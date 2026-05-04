import { collectSatisfactionFromDrive } from "@/lib/pipeline/satisfaction-drive-collector";
import { normalizeSatisfactionDriveResults } from "@/lib/pipeline/satisfaction-drive-normalizer";
import { applySatisfactionImports } from "@/lib/pipeline/satisfaction-applier";
import { prisma } from "@/lib/prisma";

async function main() {
  console.log("[start] 만족도 Drive backfill (2025-01-01 ~ 2025-12-31)");

  const run = await prisma.pipelineRun.create({
    data: {
      runType: "pilot_4_4_satisfaction_sheets",
      status: "running",
      triggeredBy: "script:run-satisfaction-drive-backfill",
    },
  });

  try {
    const driveCollected = await collectSatisfactionFromDrive({
      startDate: "2025-01-01",
      endDate: "2025-12-31",
    });
    console.log(
      `[collected] ${driveCollected.files.length} files read (${driveCollected.totalFilesFound} found, ${driveCollected.readErrors} read errors)`
    );
    for (const file of driveCollected.files) {
      const sheetRows = file.sheets.reduce((s, sh) => s + sh.rows.length, 0);
      console.log(`  - ${file.fileName} (${file.sheets.length} sheets, ${sheetRows} rows)`);
    }

    const driveNormalized = await normalizeSatisfactionDriveResults(driveCollected);
    console.log(`[normalized] ${driveNormalized.items.length} items`);
    console.log(`[summary] ${JSON.stringify(driveNormalized.sourceSummary)}`);

    if (driveNormalized.items.length === 0) {
      console.log("[skip] no items to apply");
      await prisma.pipelineRun.update({
        where: { id: run.id },
        data: {
          status: "success",
          finishedAt: new Date(),
          summary: {
            note: "no items extracted from Drive files",
            files_found: driveCollected.totalFilesFound,
            files_read: driveCollected.files.length,
          },
        },
      });
      process.exit(0);
    }

    const applyResult = await applySatisfactionImports({
      runId: run.id,
      items: driveNormalized.items,
      recalculateScores: true,
    });

    await prisma.pipelineRun.update({
      where: { id: run.id },
      data: {
        status: "success",
        finishedAt: new Date(),
        summary: {
          files_found: driveCollected.totalFilesFound,
          files_read: driveCollected.files.length,
          items_stored: applyResult.importItemsStored,
          auto_accepted: applyResult.registries.autoAcceptedCount,
          pending: applyResult.registries.pendingCount,
          canonical_upserted: applyResult.canonicalRecordsUpserted,
          affected_instructors: applyResult.affectedInstructors,
        },
      },
    });

    console.log(`[done] stored: ${applyResult.importItemsStored}`);
    console.log(`[done] auto_accepted: ${applyResult.registries.autoAcceptedCount}`);
    console.log(`[done] pending: ${applyResult.registries.pendingCount}`);
    console.log(`[done] canonical_upserted: ${applyResult.canonicalRecordsUpserted}`);
    console.log(`[done] affected_instructors: ${applyResult.affectedInstructors}`);
  } catch (err) {
    await prisma.pipelineRun.update({
      where: { id: run.id },
      data: {
        status: "failed",
        finishedAt: new Date(),
        summary: { error: err instanceof Error ? err.message : String(err) },
      },
    });
    throw err;
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
