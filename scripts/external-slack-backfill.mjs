/**
 * external-slack-backfill.mjs
 *
 * GitHub Actions runner 또는 외부 host에서 실행.
 * Slack conversations.history를 직접 호출하고 결과를 Coolify ingest endpoint로 POST.
 *
 * Env:
 *   SLACK_BOT_TOKEN
 *   SLACK_WORKSPACE_ID
 *   INGEST_URL (e.g. https://instructor-dashboard.skillflo.app/api/admin/ingest-raw-slack)
 *   CRON_SECRET
 *   LOOKBACK_DAYS (default 365)
 */

const SLACK_API_BASE = "https://slack.com/api";
const CHANNELS = [
  { channelId: "C015YD84VGS", kind: "ops_report" },
  { channelId: "C79GDLS3A", kind: "general" },
  { channelId: "C099UH7ACGG", kind: "dispatch_request", mappedInstructorName: "정백" },
  { channelId: "C0AS2VDUXQ8", kind: "dispatch_request", mappedInstructorName: "신동원" },
];

const token = process.env.SLACK_BOT_TOKEN;
const workspaceId = process.env.SLACK_WORKSPACE_ID;
const ingestUrl = process.env.INGEST_URL;
const cronSecret = process.env.CRON_SECRET;
const lookbackDays = Number.parseInt(process.env.LOOKBACK_DAYS ?? "365", 10) || 365;

if (!token || !workspaceId || !ingestUrl || !cronSecret) {
  console.error("Missing env: SLACK_BOT_TOKEN / SLACK_WORKSPACE_ID / INGEST_URL / CRON_SECRET");
  process.exit(1);
}

async function slackGet(path, params) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${SLACK_API_BASE}/${path}?${qs}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "instructor-db-backfill/1.0",
    },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Slack API ${path} HTTP ${res.status}: ${txt.slice(0, 300)}`);
  }
  const json = await res.json();
  if (!json.ok) {
    throw new Error(`Slack API ${path} failed: ${json.error}`);
  }
  return json;
}

async function fetchChannelHistory(channelId, oldestEpoch) {
  const messages = [];
  let cursor;
  const maxPages = 20;
  for (let p = 0; p < maxPages; p++) {
    const params = {
      channel: channelId,
      limit: "200",
      oldest: oldestEpoch.toFixed(6),
    };
    if (cursor) params.cursor = cursor;
    const data = await slackGet("conversations.history", params);
    if (Array.isArray(data.messages)) {
      messages.push(...data.messages);
    }
    if (!data.has_more || !data.response_metadata?.next_cursor) break;
    cursor = data.response_metadata.next_cursor;
    await new Promise((r) => setTimeout(r, 250));
  }
  return messages;
}

async function fetchUserProfile(uid) {
  try {
    const data = await slackGet("users.info", { user: uid });
    const u = data.user;
    const profile = u?.profile ?? {};
    return {
      userId: uid,
      realName: profile.real_name ?? u?.real_name ?? null,
      displayName: profile.display_name ?? u?.name ?? null,
      email: profile.email ?? null,
      isBot: Boolean(u?.is_bot),
    };
  } catch (e) {
    console.warn(`users.info failed for ${uid}:`, e.message);
    return { userId: uid, realName: null, displayName: null, email: null, isBot: false };
  }
}

async function main() {
  const oldestEpoch = Date.now() / 1000 - lookbackDays * 24 * 60 * 60;
  console.log(`[backfill] lookback=${lookbackDays}d oldest_epoch=${oldestEpoch.toFixed(0)}`);

  const channelsOut = [];
  for (const cfg of CHANNELS) {
    console.log(`[backfill] fetching ${cfg.channelId} (${cfg.kind})...`);
    try {
      const messages = await fetchChannelHistory(cfg.channelId, oldestEpoch);
      console.log(`  → ${messages.length} messages`);
      const userIds = new Set();
      for (const m of messages) {
        if (m.user) userIds.add(m.user);
      }
      console.log(`  → ${userIds.size} unique users to resolve...`);
      const users = {};
      let i = 0;
      for (const uid of userIds) {
        users[uid] = await fetchUserProfile(uid);
        i += 1;
        if (i % 50 === 0) console.log(`    resolved ${i}/${userIds.size}`);
        await new Promise((r) => setTimeout(r, 80));
      }
      channelsOut.push({
        channel_id: cfg.channelId,
        kind: cfg.kind,
        mapped_instructor_name: cfg.mappedInstructorName,
        messages,
        users,
      });
    } catch (e) {
      console.error(`  channel ${cfg.channelId} FAILED:`, e.message);
    }
  }

  console.log(`[backfill] posting to ingest endpoint...`);
  const res = await fetch(ingestUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-cron-secret": cronSecret,
    },
    body: JSON.stringify({
      workspace_id: workspaceId,
      channels: channelsOut,
    }),
  });
  const ingestResult = await res.json();
  console.log(`[backfill] ingest response status=${res.status}:`, JSON.stringify(ingestResult, null, 2));
  if (!res.ok || !ingestResult.ok) {
    process.exit(2);
  }
  console.log("[backfill] done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
