import { prisma } from "@/lib/prisma";

const latest = await prisma.pipelineRun.findFirst({
  where: { runType: "pilot_4_4_satisfaction_sheets" },
  orderBy: { startedAt: "desc" },
});
if (!latest) {
  console.log("No runs");
  process.exit(0);
}

console.log(`Run: ${latest.id} | status=${latest.status} | start=${latest.startedAt.toISOString()}`);
const summary = latest.summary as Record<string, unknown> | null;
if (!summary) {
  console.log("No summary");
  process.exit(0);
}

const sourceSummaries = summary.source_summaries as Array<Record<string, unknown>> | undefined;
if (!Array.isArray(sourceSummaries)) {
  console.log("No source_summaries");
  process.exit(0);
}

for (const s of sourceSummaries) {
  console.log(
    `  ${s.source_key} | ${s.source_type} | fetched=${s.fetched_rows} | imported=${s.imported_items} | status=${s.status} | note=${s.note ?? "—"}`
  );
}

await prisma.$disconnect();
