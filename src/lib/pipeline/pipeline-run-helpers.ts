import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export const STALE_PIPELINE_RUN_MS = 15 * 60 * 1000;
export const STALLED_PIPELINE_STAGE_MS = 6 * 60 * 1000;
const STALE_RUN_ERROR_MESSAGE =
  "Stale pipeline run cleaned up after exceeding the allowed runtime.";
const STALLED_STAGE_ERROR_MESSAGE =
  "Stalled pipeline run cleaned up after stage progress stopped updating.";

function toSummaryObject(value: Prisma.JsonValue | null | undefined): Prisma.InputJsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Prisma.InputJsonObject;
}

function parseIsoDate(value: unknown): Date | null {
  if (typeof value !== "string") {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

function getRunHeartbeatAt(args: {
  startedAt: Date;
  summary: Prisma.JsonValue | null;
  runningSourceStartedAt: Date | null;
}): Date {
  const summary = toSummaryObject(args.summary);
  const stageStartedAt = parseIsoDate(summary.stage_started_at);

  return (
    stageStartedAt ??
    args.runningSourceStartedAt ??
    args.startedAt
  );
}

/**
 * 오래된 running pipeline run을 failed로 정리한다.
 * dev 서버 종료나 요청 타임아웃 후 stale 상태가 남아 새 refresh를 막는 문제를 방지한다.
 */
export async function cleanupStalePipelineRuns(now: Date = new Date()): Promise<{
  cleanedRunIds: string[];
}> {
  const cutoff = new Date(now.getTime() - STALE_PIPELINE_RUN_MS);
  const stalledCutoff = new Date(now.getTime() - STALLED_PIPELINE_STAGE_MS);

  const runningRuns = await prisma.pipelineRun.findMany({
    where: {
      status: "running",
    },
    select: {
      id: true,
      startedAt: true,
      summary: true,
      sourceSyncLogs: {
        where: {
          status: "running",
        },
        orderBy: {
          startedAt: "desc",
        },
        take: 1,
        select: {
          startedAt: true,
        },
      },
    },
  });

  const staleRuns = runningRuns
    .map((run) => {
      const heartbeatAt = getRunHeartbeatAt({
        startedAt: run.startedAt,
        summary: run.summary,
        runningSourceStartedAt: run.sourceSyncLogs[0]?.startedAt ?? null,
      });

      const staleReason =
        run.startedAt < cutoff
          ? "runtime_exceeded"
          : heartbeatAt < stalledCutoff
            ? "stage_stalled"
            : null;

      return {
        ...run,
        staleReason,
      };
    })
    .filter(
      (run): run is typeof run & { staleReason: "runtime_exceeded" | "stage_stalled" } =>
        run.staleReason !== null
    );

  if (staleRuns.length === 0) {
    return { cleanedRunIds: [] };
  }

  for (const run of staleRuns) {
    const reasonMessage =
      run.staleReason === "runtime_exceeded"
        ? STALE_RUN_ERROR_MESSAGE
        : STALLED_STAGE_ERROR_MESSAGE;

    await prisma.pipelineRun.update({
      where: { id: run.id },
      data: {
        status: "failed",
        finishedAt: now,
        summary: {
          ...toSummaryObject(run.summary),
          abort_reason:
            run.staleReason === "runtime_exceeded"
              ? "stale_run_cleanup"
              : "stalled_stage_cleanup",
          aborted_by: "system:cleanup_stale_pipeline_runs",
          aborted_at: now.toISOString(),
        },
      },
    });

    await prisma.sourceSyncLog.updateMany({
      where: {
        runId: run.id,
        status: "running",
      },
      data: {
        status: "failed",
        errorMessage: reasonMessage,
        finishedAt: now,
      },
    });
  }

  return {
    cleanedRunIds: staleRuns.map((run) => run.id),
  };
}
