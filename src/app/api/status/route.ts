/**
 * GET /api/status — 05_api_spec.md 8절
 *
 * 데이터 상태, 마지막 업데이트 시간, 소스별 동기화 상태를 반환한다.
 */

import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { cleanupStalePipelineRuns } from "@/lib/pipeline/pipeline-run-helpers";
import {
  FALLBACK_LAST_UPDATED_AT,
  getFallbackStatusData,
  hasStaticFallbackData,
} from "@/lib/fallback-data";
import { readStoredFallbackSnapshot } from "@/lib/fallback-snapshot";

const SOURCE_TYPES = [
  "notion",
  "contract_sheet",
  "instructor_dispatch_sheet",
  "salesmap",
  "slack",
  "gmail",
  "satisfaction",
  "fulltime",
  "ops_notes",
] as const;

type LatestSourceSyncRow = {
  standard_type: string;
  status: string;
  finished_at: Date | null;
  started_at: Date;
  fetched_count: number;
  updated_count: number;
  error_message: string | null;
};

const STANDARD_SOURCE_TYPE_SQL = Prisma.sql`
  CASE
    WHEN "source_type" IN (${Prisma.join(SOURCE_TYPES)}) THEN "source_type"
    WHEN "source_type" LIKE 'satisfaction%' THEN 'satisfaction'
    ELSE NULL
  END
`;

async function loadLatestSourceSyncRows(): Promise<LatestSourceSyncRow[]> {
  return prisma.$queryRaw<LatestSourceSyncRow[]>(Prisma.sql`
    WITH ranked_logs AS (
      SELECT
        ${STANDARD_SOURCE_TYPE_SQL} AS standard_type,
        "status",
        "finished_at",
        "started_at",
        "fetched_count",
        "updated_count",
        "error_message",
        ROW_NUMBER() OVER (
          PARTITION BY ${STANDARD_SOURCE_TYPE_SQL}
          ORDER BY "started_at" DESC, "finished_at" DESC NULLS LAST
        ) AS row_num
      FROM "source_sync_logs"
    )
    SELECT
      standard_type,
      status,
      finished_at,
      started_at,
      fetched_count,
      updated_count,
      error_message
    FROM ranked_logs
    WHERE standard_type IS NOT NULL
      AND row_num = 1
  `);
}

export async function GET() {
  const requestId = `req_${crypto.randomUUID()}`;
  const fallbackReady = hasStaticFallbackData();

  try {
    await cleanupStalePipelineRuns();

    // 1. 최신 완료 PipelineRun 조회
    const [latestFinishedRun, latestSuccessfulRun] = await Promise.all([
      prisma.pipelineRun.findFirst({
        where: { status: { in: ["success", "partial", "failed"] } },
        orderBy: { finishedAt: "desc" },
      }),
      prisma.pipelineRun.findFirst({
        where: { status: { in: ["success", "partial"] } },
        orderBy: { finishedAt: "desc" },
      }),
    ]);

    const lastUpdatedAt = latestSuccessfulRun?.finishedAt?.toISOString() ?? null;

    // 2. 현재 running 상태인 PipelineRun이 있는지 확인
    const runningRun = await prisma.pipelineRun.findFirst({
      where: { status: "running" },
      orderBy: { startedAt: "desc" },
    });

    const refreshAvailable = runningRun === null;
    const runningSummary =
      runningRun?.summary &&
      typeof runningRun.summary === "object" &&
      !Array.isArray(runningRun.summary)
        ? (runningRun.summary as Record<string, unknown>)
        : null;

    // 3. 소스별 최신 SourceSyncLog 조회
    const latestSourceRows = await loadLatestSourceSyncRows();

    const latestBySource = new Map<
      string,
      {
        status: string;
        lastSyncedAt: string | null;
        fetchedCount: number;
        updatedCount: number;
        note: string | null;
      }
    >();

    for (const row of latestSourceRows) {
      latestBySource.set(row.standard_type, {
        status: row.status,
        lastSyncedAt: row.finished_at?.toISOString() ?? row.started_at.toISOString(),
        fetchedCount: row.fetched_count,
        updatedCount: row.updated_count,
        note: row.error_message,
      });
    }

    // 모든 표준 소스 타입에 대해 결과 생성
    const sources = SOURCE_TYPES.map((sourceType) => {
      const entry = latestBySource.get(sourceType);
      return {
        source_type: sourceType,
        status: entry?.status ?? "never_synced",
        last_synced_at: entry?.lastSyncedAt ?? null,
        fetched_count: entry?.fetchedCount ?? 0,
        updated_count: entry?.updatedCount ?? 0,
        note: entry?.note ?? null,
      };
    });

    const latestRunStatus =
      latestFinishedRun?.status === "success" ||
      latestFinishedRun?.status === "partial" ||
      latestFinishedRun?.status === "failed"
        ? latestFinishedRun.status
        : "never_synced";

    const hasSourceIssue = sources.some((source) =>
      source.status === "failed" || source.status === "partial"
    );
    const responseStatus = hasSourceIssue ? "partial" : "success";

    return NextResponse.json({
      status: responseStatus,
      meta: {
        request_id: requestId,
        data_mode: "live",
        is_fallback: false,
        last_updated_at: lastUpdatedAt,
      },
      data: {
        last_updated_at: lastUpdatedAt,
        refresh_available: refreshAvailable,
        latest_run_status: latestRunStatus,
        current_run: runningRun
          ? {
              id: runningRun.id,
              run_type: runningRun.runType,
              status: runningRun.status,
              started_at: runningRun.startedAt.toISOString(),
              stage:
                typeof runningSummary?.stage === "string"
                  ? runningSummary.stage
                  : null,
              stage_started_at:
                typeof runningSummary?.stage_started_at === "string"
                  ? runningSummary.stage_started_at
                  : null,
              stage_progress:
                runningSummary?.stage_progress &&
                typeof runningSummary.stage_progress === "object" &&
                !Array.isArray(runningSummary.stage_progress)
                  ? (runningSummary.stage_progress as Record<string, unknown>)
                  : null,
            }
          : null,
        fallback_ready: fallbackReady,
        sources,
      },
      ...(hasSourceIssue
        ? {
            errors: [
              {
                code: "PARTIAL_DATA",
                message: "일부 source가 partial 또는 failed 상태입니다.",
              },
            ],
          }
        : {}),
    });
  } catch (err) {
    const snapshot = await readStoredFallbackSnapshot();
    return NextResponse.json(
      {
        status: snapshot || fallbackReady ? "partial" : "error",
        meta: {
          request_id: requestId,
          data_mode: snapshot ? "stored" : fallbackReady ? "fallback" : "live",
          is_fallback: Boolean(snapshot || fallbackReady),
          last_updated_at: snapshot?.generated_at ?? (fallbackReady ? FALLBACK_LAST_UPDATED_AT : null),
        },
        ...(snapshot || fallbackReady
          ? {
              data: snapshot?.status_data ?? getFallbackStatusData(),
              errors: [
                {
                  code: snapshot ? "STATUS_STORED_FALLBACK" : "STATUS_FALLBACK",
                  message: snapshot
                    ? "상태 조회에 실패해 마지막 정상 스냅샷 상태를 표시합니다."
                    : "상태 조회에 실패해 정적 fallback 기준 상태를 표시합니다.",
                },
              ],
            }
          : {
              errors: [
                {
                  code: "STATUS_FETCH_FAILED",
                  message:
                    err instanceof Error
                      ? err.message
                      : "상태 조회에 실패했습니다.",
                },
              ],
            }),
      },
      { status: snapshot || fallbackReady ? 200 : 500 }
    );
  }
}
