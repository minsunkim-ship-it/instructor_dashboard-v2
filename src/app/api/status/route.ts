/**
 * GET /api/status — 05_api_spec.md 8절
 *
 * 데이터 상태, 마지막 업데이트 시간, 소스별 동기화 상태를 반환한다.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { cleanupStalePipelineRuns } from "@/lib/pipeline/pipeline-run-helpers";

const SOURCE_TYPES = [
  "notion",
  "contract_sheet",
  "salesmap",
  "slack",
  "gmail",
  "satisfaction",
  "fulltime",
  "ops_notes",
] as const;

export async function GET() {
  const requestId = `req_${crypto.randomUUID()}`;

  try {
    await cleanupStalePipelineRuns();

    // 1. 최신 성공 PipelineRun 조회
    const latestSuccessfulRun = await prisma.pipelineRun.findFirst({
      where: { status: { in: ["success", "partial"] } },
      orderBy: { finishedAt: "desc" },
    });

    const lastUpdatedAt = latestSuccessfulRun?.finishedAt?.toISOString() ?? null;

    // 2. 현재 running 상태인 PipelineRun이 있는지 확인
    const runningRun = await prisma.pipelineRun.findFirst({
      where: { status: "running" },
    });

    const refreshAvailable = runningRun === null;

    // 3. 소스별 최신 SourceSyncLog 조회
    const allSyncLogs = await prisma.sourceSyncLog.findMany({
      orderBy: [{ startedAt: "desc" }, { finishedAt: "desc" }],
    });

    // 소스 타입 매핑: DB에 저장된 sourceType → 표준 source_type으로 매핑
    function mapToStandardSourceType(dbSourceType: string): string | null {
      // 정확히 일치하는 경우
      if ((SOURCE_TYPES as readonly string[]).includes(dbSourceType)) {
        return dbSourceType;
      }
      // satisfaction_sheet:xxx → satisfaction
      if (dbSourceType.startsWith("satisfaction_sheet:") || dbSourceType.startsWith("satisfaction")) {
        return "satisfaction";
      }
      return null;
    }

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

    for (const log of allSyncLogs) {
      const standardType = mapToStandardSourceType(log.sourceType);
      if (!standardType) continue;
      if (latestBySource.has(standardType)) continue; // 이미 최신 항목이 있음 (finishedAt desc 순)
      latestBySource.set(standardType, {
        status: log.status,
        lastSyncedAt: log.finishedAt?.toISOString() ?? log.startedAt.toISOString(),
        fetchedCount: log.fetchedCount,
        updatedCount: log.updatedCount,
        note: log.errorMessage,
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

    return NextResponse.json({
      status: "success",
      meta: {
        request_id: requestId,
        data_mode: "live",
        is_fallback: false,
        last_updated_at: lastUpdatedAt,
      },
      data: {
        last_updated_at: lastUpdatedAt,
        refresh_available: refreshAvailable,
        sources,
      },
    });
  } catch (err) {
    return NextResponse.json(
      {
        status: "error",
        meta: {
          request_id: requestId,
          data_mode: "live",
          is_fallback: false,
          last_updated_at: null,
        },
        errors: [
          {
            code: "STATUS_FETCH_FAILED",
            message:
              err instanceof Error ? err.message : "상태 조회에 실패했습니다.",
          },
        ],
      },
      { status: 500 }
    );
  }
}
