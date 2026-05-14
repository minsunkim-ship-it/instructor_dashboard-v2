/**
 * POST /api/admin/ingest-raw-slack
 *
 * Coolify 호스트가 Slack API outbound 못하는 경우 우회 경로.
 * 외부 환경(GitHub Actions, 로컬, 다른 host)에서 Slack conversations.history를
 * 직접 호출하고 raw 결과를 POST해 normalize + apply만 Coolify에서 처리.
 *
 * Body: {
 *   workspace_id: string,
 *   channels: Array<{
 *     channel_id: string,
 *     kind: "ops_report" | "dispatch_request" | "general",
 *     mapped_instructor_name?: string,
 *     messages: SlackMessage[],
 *     users: Record<string, SlackUserProfile>
 *   }>
 * }
 *
 * Auth: CRON_SECRET
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";
import {
  normalizeSlackCollect,
  type NormalizedSlackActivity,
} from "@/lib/pipeline/slack-activity-normalizer";
import type {
  RawSlackChannelCollect,
  SlackChannelKind,
  SlackCollectResult,
} from "@/lib/pipeline/slack-activity-collector";
import { applyActivities } from "@/lib/pipeline/activity-applier";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

interface IngestBody {
  workspace_id: string;
  channels: Array<{
    channel_id: string;
    kind: SlackChannelKind;
    mapped_instructor_name?: string;
    messages: RawSlackChannelCollect["messages"];
    users: RawSlackChannelCollect["users"];
  }>;
}

export async function POST(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  let body: IngestBody;
  try {
    body = (await request.json()) as IngestBody;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  if (!body.workspace_id || !Array.isArray(body.channels)) {
    return NextResponse.json({ ok: false, error: "missing_workspace_or_channels" }, { status: 400 });
  }

  const startedAt = Date.now();

  // PipelineRun 생성 (sourceSyncLog 작성용)
  const run = await prisma.pipelineRun.create({
    data: {
      runType: "external_ingest_slack",
      status: "running",
      triggeredBy: "api:/api/admin/ingest-raw-slack",
      summary: {},
    },
  });

  const result: SlackCollectResult = {
    workspaceId: body.workspace_id,
    channels: body.channels.map(
      (c) =>
        ({
          channelId: c.channel_id,
          kind: c.kind,
          mappedInstructorName: c.mapped_instructor_name,
          messages: c.messages,
          users: c.users,
        }) as RawSlackChannelCollect
    ),
    incremental: false,
  };

  const totalMessages = result.channels.reduce((s, c) => s + c.messages.length, 0);

  const normalized: NormalizedSlackActivity[] = normalizeSlackCollect(result);

  let applyResult;
  try {
    applyResult = await applyActivities(run.id, normalized, [], {
      onProgress: async () => {},
    });
  } catch (e) {
    await prisma.pipelineRun.update({
      where: { id: run.id },
      data: { status: "failed", finishedAt: new Date(), summary: { error: String(e) } },
    });
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }

  await prisma.pipelineRun.update({
    where: { id: run.id },
    data: {
      status: "success",
      finishedAt: new Date(),
      summary: {
        total_messages: totalMessages,
        items_matched: applyResult.items.matched,
        items_unmatched: applyResult.items.unmatched,
        items_ambiguous: applyResult.items.ambiguous,
        items_invalid: applyResult.items.invalid,
      },
    },
  });

  return NextResponse.json({
    ok: true,
    durationMs: Date.now() - startedAt,
    run_id: run.id,
    total_messages: totalMessages,
    items: applyResult.items,
    aggregate_updates: applyResult.aggregateUpdates.length,
  });
}
