import { prisma } from "@/lib/prisma";

function fmtDuration(startedAt: Date, finishedAt: Date | null): string {
  if (!finishedAt) return "ongoing";
  const ms = finishedAt.getTime() - startedAt.getTime();
  return `${(ms / 1000).toFixed(1)}s`;
}

async function main(): Promise<void> {
  const runs = await prisma.pipelineRun.findMany({
    where: { runType: { in: ["pilot_4_5_slack", "pilot_4_5_slack_reconcile"] } },
    orderBy: { startedAt: "desc" },
    take: 10,
    select: {
      id: true,
      runType: true,
      status: true,
      startedAt: true,
      finishedAt: true,
      summary: true,
    },
  });

  if (runs.length === 0) {
    console.log("NO_SLACK_RUNS");
    return;
  }

  const runIds = runs.map((r) => r.id);
  const logs = await prisma.sourceSyncLog.findMany({
    where: { runId: { in: runIds } },
    orderBy: [{ runId: "asc" }, { startedAt: "asc" }],
  });

  console.log(`=== Recent ${runs.length} /api/pipeline/slack runs ===`);
  for (const run of runs) {
    const dur = fmtDuration(run.startedAt, run.finishedAt);
    console.log(
      `RUN ${run.id.slice(0, 8)}  type=${run.runType}  ${run.status.padEnd(9)}  started=${run.startedAt.toISOString()}  dur=${dur}`
    );
    const summary = run.summary as Record<string, unknown> | null;
    if (summary && Object.keys(summary).length > 0) {
      const keys = Object.keys(summary).slice(0, 8).join(",");
      console.log(`  summary keys: ${keys}`);
      if (summary.stage) console.log(`  summary.stage: ${summary.stage}`);
      if (summary.stage_detail) console.log(`  summary.stage_detail: ${JSON.stringify(summary.stage_detail).slice(0, 200)}`);
    }
    const runLogs = logs.filter((l) => l.runId === run.id);
    for (const log of runLogs) {
      const logDur = fmtDuration(log.startedAt, log.finishedAt);
      const msg = log.errorMessage
        ? log.errorMessage.length > 180
          ? log.errorMessage.slice(0, 180) + "..."
          : log.errorMessage
        : "(null)";
      console.log(
        `  [${log.status.padEnd(8)}] ${log.sourceType.padEnd(12)} dur=${logDur.padEnd(8)} fetched=${log.fetchedCount} updated=${log.updatedCount}`
      );
      console.log(`    errorMessage: ${msg}`);
    }
    console.log("");
  }

  // running 상태의 run이 있는지 확인
  const running = runs.filter((r) => r.status === "running");
  console.log(`=== Stale check ===`);
  console.log(`  running slack runs: ${running.length}`);
  if (running.length > 0) {
    console.log("  → 이 run은 current_run을 block할 수 있음.");
    for (const r of running) {
      const ageMs = Date.now() - r.startedAt.getTime();
      const ageSec = Math.round(ageMs / 1000);
      console.log(`    ${r.id.slice(0, 8)} runType=${r.runType} age=${ageSec}s startedAt=${r.startedAt.toISOString()}`);
    }
  }
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
