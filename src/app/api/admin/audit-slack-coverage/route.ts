/**
 * GET /api/admin/audit-slack-coverage
 *
 * Slack 채널별 수집 상태 + 운영보고/general 메시지 분포 진단.
 *
 * 인증: CRON_SECRET
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

type RawRecord = { [key: string]: unknown };
function pickString(o: RawRecord | undefined | null, ...keys: string[]): string | null {
  if (!o) return null;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return null;
}

const OPS_REPORT = "C015YD84VGS";
const GENERAL = "C79GDLS3A";

export async function GET(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const startedAt = Date.now();

  // 전체 slack items
  const items = await prisma.activityImportItem.findMany({
    where: { sourceType: "slack" },
    select: { rawPayload: true, sourceRef: true, activityAt: true },
    take: 50000,
  });

  // channel별 count + date range
  type ChStats = {
    count: number;
    minDate: Date | null;
    maxDate: Date | null;
    samples: string[];
  };
  const byChannel = new Map<string, ChStats>();
  for (const it of items) {
    const raw = (it.rawPayload as RawRecord | null) ?? {};
    const ref = (it.sourceRef as RawRecord | null) ?? {};
    const cid = pickString(raw, "channel_id", "channel") ?? pickString(ref, "channel_id", "channel") ?? "unknown";
    const text = pickString(raw, "text", "message", "body") ?? "";
    const entry = byChannel.get(cid) ?? { count: 0, minDate: null, maxDate: null, samples: [] };
    entry.count += 1;
    if (it.activityAt) {
      if (!entry.minDate || it.activityAt < entry.minDate) entry.minDate = it.activityAt;
      if (!entry.maxDate || it.activityAt > entry.maxDate) entry.maxDate = it.activityAt;
    }
    if (entry.samples.length < 2 && text.length > 20) {
      entry.samples.push(text.slice(0, 140));
    }
    byChannel.set(cid, entry);
  }
  const channels = Array.from(byChannel.entries())
    .map(([cid, s]) => ({
      channel_id: cid,
      is_ops_report: cid === OPS_REPORT,
      is_general: cid === GENERAL,
      count: s.count,
      min_date: s.minDate?.toISOString().slice(0, 10) ?? null,
      max_date: s.maxDate?.toISOString().slice(0, 10) ?? null,
      sample: s.samples[0] ?? null,
    }))
    .sort((a, b) => b.count - a.count);

  // ops_report / general 분석
  const opsCount = byChannel.get(OPS_REPORT)?.count ?? 0;
  const generalCount = byChannel.get(GENERAL)?.count ?? 0;

  // 마지막 sync (sourceCheckpoint 또는 sourceSyncLog)
  const syncs = await prisma.sourceSyncLog.findMany({
    where: { sourceType: { contains: "slack", mode: "insensitive" } },
    orderBy: { startedAt: "desc" },
    take: 10,
    select: {
      id: true,
      sourceType: true,
      status: true,
      startedAt: true,
      finishedAt: true,
      fetchedCount: true,
      updatedCount: true,
      errorMessage: true,
    },
  });

  // pipeline 최근 실행 (실패 포함)
  const runs = await prisma.pipelineRun.findMany({
    orderBy: { startedAt: "desc" },
    take: 30,
    select: { id: true, runType: true, status: true, startedAt: true, finishedAt: true, triggeredBy: true },
  });
  const recentFailed = runs.filter((r) => r.status !== "succeeded" && r.status !== "running");

  return NextResponse.json({
    ok: true,
    durationMs: Date.now() - startedAt,
    total_slack_items: items.length,
    channel_count: byChannel.size,
    ops_report_count: opsCount,
    general_count: generalCount,
    channels: channels.slice(0, 30),
    recent_slack_syncs: syncs,
    recent_pipeline_runs: runs.slice(0, 10),
    recent_failed_runs: recentFailed,
  });
}
