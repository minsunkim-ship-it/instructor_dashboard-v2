import { prisma } from "@/lib/prisma";

interface RunRow {
  id: string;
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
  summary: unknown;
}

interface SyncRow {
  runId: string;
  sourceType: string;
  status: string;
  fetchedCount: number;
  updatedCount: number;
  startedAt: Date;
  finishedAt: Date | null;
  errorMessage: string | null;
}

function fmtDuration(startedAt: Date, finishedAt: Date | null): string {
  if (!finishedAt) return "ongoing";
  const ms = finishedAt.getTime() - startedAt.getTime();
  return `${(ms / 1000).toFixed(1)}s`;
}

async function main(): Promise<void> {
  // 최근 10개 refresh run 가져오기
  const runs = (await prisma.pipelineRun.findMany({
    where: { runType: { in: ["refresh", "pipeline_refresh", "manual_refresh"] } },
    orderBy: { startedAt: "desc" },
    take: 10,
    select: {
      id: true,
      status: true,
      startedAt: true,
      finishedAt: true,
      summary: true,
    },
  })) as RunRow[];

  if (runs.length === 0) {
    console.log("NO_RECENT_REFRESH_RUNS");
    return;
  }

  const runIds = runs.map((r) => r.id);
  const logs = (await prisma.sourceSyncLog.findMany({
    where: { runId: { in: runIds } },
    orderBy: [{ runId: "asc" }, { startedAt: "asc" }],
  })) as SyncRow[];

  const logsByRun = new Map<string, SyncRow[]>();
  for (const log of logs) {
    const bucket = logsByRun.get(log.runId) ?? [];
    bucket.push(log);
    logsByRun.set(log.runId, bucket);
  }

  console.log(`=== Recent ${runs.length} refresh runs ===`);
  console.log("");

  for (const run of runs) {
    const dur = fmtDuration(run.startedAt, run.finishedAt);
    console.log(
      `RUN ${run.id.slice(0, 8)}  ${run.status.padEnd(9)}  started=${run.startedAt.toISOString()}  dur=${dur}`
    );

    const summary = run.summary as Record<string, unknown> | null;
    if (summary?.stage) {
      console.log(`  final summary.stage: ${summary.stage}`);
    }

    const runLogs = logsByRun.get(run.id) ?? [];
    for (const log of runLogs) {
      const logDur = fmtDuration(log.startedAt, log.finishedAt);
      const errorSummary = log.errorMessage
        ? log.errorMessage.length > 140
          ? `${log.errorMessage.slice(0, 140)}...`
          : log.errorMessage
        : "(null)";
      console.log(
        `  [${log.status.padEnd(8)}] ${log.sourceType.padEnd(26)} dur=${logDur.padEnd(8)} fetched=${String(log.fetchedCount).padEnd(5)} updated=${String(log.updatedCount).padEnd(5)}`
      );
      console.log(`    last_errorMessage: ${errorSummary}`);
    }
    console.log("");
  }

  // contract_sheet + notion 패턴 분석
  console.log("=== contract_sheet pattern across runs ===");
  const cs = logs.filter((l) => l.sourceType === "contract_sheet");
  if (cs.length === 0) {
    console.log("  (no contract_sheet logs found)");
  } else {
    for (const log of cs.slice(0, 10)) {
      const logDur = fmtDuration(log.startedAt, log.finishedAt);
      const stageMatch = log.errorMessage?.match(/last_stage=(\S+)/);
      const stageField = log.errorMessage?.match(/^stage=(\S+)/);
      const stageSig = stageMatch?.[1] ?? stageField?.[1] ?? "(no stage marker)";
      console.log(
        `  ${log.startedAt.toISOString()} status=${log.status} dur=${logDur.padEnd(8)} stage_at_exit=${stageSig}`
      );
    }
  }
  console.log("");

  console.log("=== notion pattern across runs ===");
  const notion = logs.filter((l) => l.sourceType === "notion");
  if (notion.length === 0) {
    console.log("  (no notion logs found)");
  } else {
    for (const log of notion.slice(0, 10)) {
      const logDur = fmtDuration(log.startedAt, log.finishedAt);
      const stageField = log.errorMessage?.match(/^stage=(\S+)/);
      const stageSig = stageField?.[1] ?? "(no stage marker)";
      console.log(
        `  ${log.startedAt.toISOString()} status=${log.status} dur=${logDur.padEnd(8)} stage_at_exit=${stageSig} msg="${(log.errorMessage ?? "").slice(0, 100)}"`
      );
    }
  }
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
