/**
 * GET /api/admin/debug-last-run
 * 가장 최근 PipelineRun + sourceSyncLogs.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const runId = request.nextUrl.searchParams.get("run_id");
  const limit = parseInt(request.nextUrl.searchParams.get("limit") ?? "5", 10) || 5;
  if (!runId) {
    // multi list mode
    const runs = await prisma.pipelineRun.findMany({
      orderBy: { startedAt: "desc" },
      include: { sourceSyncLogs: true },
      take: limit,
    });
    return NextResponse.json({
      ok: true,
      runs: runs.map((r) => ({
        id: r.id,
        runType: r.runType,
        status: r.status,
        triggeredBy: r.triggeredBy,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        sources: r.sourceSyncLogs.map((s) => ({
          sourceType: s.sourceType,
          status: s.status,
          fetched: s.fetchedCount,
          updated: s.updatedCount,
          error: s.errorMessage,
        })),
      })),
    });
  }
  const run = await prisma.pipelineRun.findUnique({
    where: { id: runId },
    include: { sourceSyncLogs: true },
  });
  if (!run) return NextResponse.json({ ok: true, run: null });
  return NextResponse.json({
    ok: true,
    run: {
      id: run.id,
      runType: run.runType,
      status: run.status,
      triggeredBy: run.triggeredBy,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      summary: run.summary,
      sources: run.sourceSyncLogs.map((s) => ({
        sourceType: s.sourceType,
        status: s.status,
        fetched: s.fetchedCount,
        updated: s.updatedCount,
        error: s.errorMessage,
        startedAt: s.startedAt,
        finishedAt: s.finishedAt,
      })),
    },
  });
}
