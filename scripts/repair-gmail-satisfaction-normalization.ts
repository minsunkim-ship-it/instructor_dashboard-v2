import { PrismaClient } from "@prisma/client";
import { applySatisfactionImports } from "@/lib/pipeline/satisfaction-applier";
import {
  __test__,
} from "@/lib/pipeline/satisfaction-gmail-normalizer";

const prisma = new PrismaClient();

function getString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseArgs() {
  const args = new Map<string, string>();
  for (const entry of process.argv.slice(2)) {
    const [key, value] = entry.split("=", 2);
    if (key?.startsWith("--")) {
      args.set(key.slice(2), value ?? "");
    }
  }

  return {
    startDate: args.get("startDate") || "2026-01-01",
    endDate: args.get("endDate") || "2026-04-21",
    dryRun: args.get("dryRun") === "1",
    onlyScored: args.get("onlyScored") === "1",
    sourceRefKeys: (args.get("sourceRefKeys") || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  };
}

const { startDate, endDate, dryRun, onlyScored, sourceRefKeys } = parseArgs();

console.log(
  `Repair gmail satisfaction normalization (${startDate} ~ ${endDate})${
    dryRun ? " [dry-run]" : ""
  }${onlyScored ? " [only-scored]" : ""}`
    + `${sourceRefKeys.length > 0 ? ` [keys=${sourceRefKeys.length}]` : ""}`
);

const run = async () => {
  const rows = await prisma.satisfactionImportItem.findMany({
    where: {
      sourceType: "gmail_summary",
      ...(sourceRefKeys.length > 0
        ? {
            sourceRefKey: {
              in: sourceRefKeys,
            },
          }
        : {}),
      OR: [
        {
          responseDate: {
            gte: new Date(`${startDate}T00:00:00.000Z`),
            lte: new Date(`${endDate}T00:00:00.000Z`),
          },
        },
        {
          responseDate: null,
        },
      ],
    },
    select: {
      sourceRefKey: true,
      sourceRef: true,
      rawPayload: true,
      normalizedPayload: true,
      candidateName: true,
      candidateCompanyName: true,
      candidateCourseName: true,
      scoreRaw: true,
      scoreNormalized: true,
      responseDate: true,
    },
  });

  const repairedItems = rows
    .map((row) => {
      const rawPayload = asRecord(row.rawPayload);
      const normalizedPayload = asRecord(row.normalizedPayload);
      const sourceRef = asRecord(row.sourceRef);
      const threadId =
        getString(sourceRef.thread_id) ??
        getString(sourceRef.threadId) ??
        row.sourceRefKey?.split(":")[1] ??
        "unknown-thread";
      const messageId =
        getString(sourceRef.message_id) ??
        getString(sourceRef.messageId) ??
        null;
      const thread = {
        threadId,
        messageId,
        subject: getString(rawPayload.subject),
        from: getString(rawPayload.from),
        to: getString(rawPayload.to),
        cc: getString(rawPayload.cc),
        sentAt: getString(rawPayload.sent_at),
        snippet: null,
        bodyText: getString(rawPayload.body_excerpt),
      };
      const context = {
        accountEmail:
          getString(sourceRef.account_email) ?? "yeonhee.ha@day1company.co.kr",
        instructorHint:
          getString(normalizedPayload.instructor_name) ?? row.candidateName,
        companyHint:
          getString(normalizedPayload.company_name) ?? row.candidateCompanyName,
        suggestedInstructorId:
          getString(normalizedPayload.suggested_instructor_id),
        resolutionBasis:
          getString(normalizedPayload.resolution_basis),
      };
      const multiSectionItems = __test__.extractSectionEvents(thread, context);
      const normalized =
        multiSectionItems.find((item) => item.sourceRefKey === row.sourceRefKey) ??
        (row.scoreNormalized === null
          ? __test__.extractEvidenceOnlyEvent(thread, context)
          : __test__.extractSingleEvent(thread, context));

      if (!normalized) return null;

      return {
        before: {
          courseName: row.candidateCourseName,
          companyName: row.candidateCompanyName,
          score: row.scoreNormalized !== null ? Number(row.scoreNormalized) : null,
        },
        after: {
          courseName: normalized.candidateCourseName ?? null,
          companyName: normalized.candidateCompanyName ?? null,
          score: normalized.scoreNormalized ?? null,
        },
        item: {
          sourceType: "gmail_summary",
          sourceRefKey: normalized.sourceRefKey,
          sourceRef: normalized.sourceRef,
          rawPayload: normalized.rawPayload,
          normalizedPayload: normalized.normalizedPayload,
          candidateName: normalized.candidateName ?? null,
          candidateCompanyName: normalized.candidateCompanyName ?? null,
          candidateCourseName: normalized.candidateCourseName ?? null,
          scoreRaw: normalized.scoreRaw ?? null,
          scoreNormalized: normalized.scoreNormalized ?? null,
          respondentCount: normalized.respondentCount ?? null,
          responseDate: normalized.responseDate ?? null,
        },
      };
    })
    .filter(
      (
        value
      ): value is NonNullable<typeof value> => value !== null
    );

  const changed = repairedItems.filter(
    ({ before, after }) =>
      before.courseName !== after.courseName ||
      before.companyName !== after.companyName ||
      before.score !== after.score
  );
  const filteredChanged = onlyScored
    ? changed.filter((entry) => entry.item.scoreNormalized !== null)
    : changed;

  console.log(
    JSON.stringify(
      {
        scanned: rows.length,
        reparsed: repairedItems.length,
        changed: filteredChanged.length,
        samples: filteredChanged.slice(0, 20),
      },
      null,
      2
    )
  );

  if (dryRun || filteredChanged.length === 0) {
    return;
  }

  const pipelineRun = await prisma.pipelineRun.create({
    data: {
      runType: "repair_gmail_satisfaction_normalization",
      status: "running",
      triggeredBy: "script:repair-gmail-satisfaction-normalization",
      summary: {
        start_date: startDate,
        end_date: endDate,
        target_count: filteredChanged.length,
      },
    },
  });

  try {
    const result = await applySatisfactionImports({
      runId: pipelineRun.id,
      items: filteredChanged.map((entry) => entry.item),
      recalculateScores: true,
    });

    await prisma.pipelineRun.update({
      where: { id: pipelineRun.id },
      data: {
        status: "success",
        finishedAt: new Date(),
        summary: {
          start_date: startDate,
          end_date: endDate,
          target_count: filteredChanged.length,
          import_items_stored: result.importItemsStored,
          affected_instructors: result.affectedInstructors,
          canonical_records_upserted: result.canonicalRecordsUpserted,
        },
      },
    });
  } catch (error) {
    await prisma.pipelineRun.update({
      where: { id: pipelineRun.id },
      data: {
        status: "failed",
        finishedAt: new Date(),
        summary: {
          start_date: startDate,
          end_date: endDate,
          error: error instanceof Error ? error.message : String(error),
        },
      },
    });
    throw error;
  }
};

await run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
