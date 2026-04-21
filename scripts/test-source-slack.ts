import {
  collectFromSlack,
  SLACK_PILOT_4_5_CHANNELS,
  type SlackChannelCheckpoint,
} from "@/lib/pipeline/slack-activity-collector";
import {
  addLine,
  loadCheckpoints,
  runSingleSourceAudit,
  summarizePassFail,
  type AuditSection,
  type CheckLine,
  type SourceSyncSnapshot,
} from "./lib/audit-helpers.ts";

function checkpointToSlackOldest(
  checkpoint: SlackChannelCheckpoint | null,
  overlapSeconds: number
): string | null {
  if (!checkpoint?.lastSeenTs) return null;
  const epoch = Number.parseFloat(checkpoint.lastSeenTs);
  if (!Number.isFinite(epoch) || epoch <= 0) return null;
  return (epoch - overlapSeconds).toFixed(6);
}

async function auditSlack(
  syncSnapshots: Record<string, SourceSyncSnapshot>
): Promise<AuditSection> {
  const lines: CheckLine[] = [];
  const checkpointRows = await loadCheckpoints("slack");
  const checkpoints: SlackChannelCheckpoint[] = checkpointRows.map((row) => ({
    channelId: row.scopeKey.replace(/^slack:channel:/, ""),
    lastSeenTs:
      typeof (row.checkpointJson as Record<string, unknown>)?.last_seen_ts === "string"
        ? String((row.checkpointJson as Record<string, unknown>).last_seen_ts)
        : null,
  }));

  const full = await collectFromSlack({
    checkpoints: [],
    fullBackfillMaxPages: 15,
    perPageLimit: 200,
  });
  const incremental = await collectFromSlack({
    checkpoints,
    incrementalMaxPages: 5,
    perPageLimit: 200,
  });

  for (const channel of full.channels) {
    if (channel.error) {
      addLine(lines, "fail", `Slack ${channel.channelId} full backfill 실패: ${channel.error}`);
      continue;
    }
    if (channel.messages.length === 0) {
      addLine(lines, "fail", `Slack ${channel.channelId} full backfill 메시지 0건`);
      continue;
    }
    addLine(
      lines,
      "pass",
      `Slack ${channel.channelId} full=${channel.messages.length} / incremental=${
        incremental.channels.find((item) => item.channelId === channel.channelId)?.messages.length ?? 0
      }`
    );
  }

  if (full.channels.every((channel) => channel.error)) {
    addLine(lines, "fail", "Slack canonical channel 3개 전부 접근 실패");
  }

  const status = summarizePassFail(lines);
  return {
    name: "slack",
    status,
    summary: `full backfill ${full.channels.reduce((sum, channel) => sum + channel.messages.length, 0)}건, incremental ${incremental.channels.reduce((sum, channel) => sum + channel.messages.length, 0)}건`,
    lines,
    data: {
      recentSync: syncSnapshots.slack ?? null,
      checkpoints: checkpointRows,
      channels: SLACK_PILOT_4_5_CHANNELS,
      overlapSeconds: 600,
      full: full.channels.map((channel) => ({
        channelId: channel.channelId,
        kind: channel.kind,
        mappedInstructorName: channel.mappedInstructorName ?? null,
        messageCount: channel.messages.length,
        distinctUsers: Object.keys(channel.users).length,
        error: channel.error ?? null,
      })),
      incremental: incremental.channels.map((channel) => {
        const checkpoint = checkpoints.find((item) => item.channelId === channel.channelId) ?? null;
        return {
          channelId: channel.channelId,
          kind: channel.kind,
          mappedInstructorName: channel.mappedInstructorName ?? null,
          checkpointLastSeenTs: checkpoint?.lastSeenTs ?? null,
          oldestUsed: checkpointToSlackOldest(checkpoint, 600),
          messageCount: channel.messages.length,
          distinctUsers: Object.keys(channel.users).length,
          error: channel.error ?? null,
        };
      }),
    },
  };
}

await runSingleSourceAudit(
  "slack",
  ["slack"],
  auditSlack,
  "external-source-audit-slack.latest.json"
);
