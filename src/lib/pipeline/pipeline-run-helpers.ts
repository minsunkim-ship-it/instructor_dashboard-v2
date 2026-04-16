import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export const STALE_PIPELINE_RUN_MS = 15 * 60 * 1000;
const STALE_RUN_ERROR_MESSAGE =
  "Stale pipeline run cleaned up after exceeding the allowed runtime.";

function toSummaryObject(value: Prisma.JsonValue | null | undefined): Prisma.InputJsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Prisma.InputJsonObject;
}

/**
 * 오래된 running pipeline run을 failed로 정리한다.
 * dev 서버 종료나 요청 타임아웃 후 stale 상태가 남아 새 refresh를 막는 문제를 방지한다.
 */
export async function cleanupStalePipelineRuns(now: Date = new Date()): Promise<{
  cleanedRunIds: string[];
}> {
  const cutoff = new Date(now.getTime() - STALE_PIPELINE_RUN_MS);

  const staleRuns = await prisma.pipelineRun.findMany({
    where: {
      status: "running",
      startedAt: { lt: cutoff },
    },
    select: {
      id: true,
      summary: true,
    },
  });

  if (staleRuns.length === 0) {
    return { cleanedRunIds: [] };
  }

  for (const run of staleRuns) {
    await prisma.pipelineRun.update({
      where: { id: run.id },
      data: {
        status: "failed",
        finishedAt: now,
        summary: {
          ...toSummaryObject(run.summary),
          abort_reason: "stale_run_cleanup",
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
        errorMessage: STALE_RUN_ERROR_MESSAGE,
        finishedAt: now,
      },
    });
  }

  return {
    cleanedRunIds: staleRuns.map((run) => run.id),
  };
}

