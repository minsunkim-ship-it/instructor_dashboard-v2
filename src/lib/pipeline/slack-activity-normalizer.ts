/**
 * Slack Activity Normalizer — Pilot 4-5 v1
 *
 * 04_data_pipeline.md 5-4-1절, 5-5-1절
 * 08_decision_log.md 2026-04-15 "Pilot 4-5 v1" 결정 항목
 *
 * 책임:
 * - Slack collector 가 수집한 raw 메시지를 activity_import_items 형태로 정규화한다.
 * - Slack count 규칙 적용:
 *   - `thread_ts == ts && reply_count > 0` → thread 1개 = activity 1건
 *   - 그 외 top-level message → message 1개 = activity 1건
 *   - reply는 count에 포함하지 않는다. 스레드 마지막 reply 시각은 last_activity_at 후보로 사용한다.
 * - candidate_name/email은 dispatch_request 채널 매핑 또는 Slack user profile에서 추출한다.
 * - match_status는 본 normalizer에서는 확정하지 않는다. applier가 instructors.name/email exact match를 수행한다.
 */

import type {
  RawSlackChannelCollect,
  SlackCollectResult,
  SlackMessage,
  SlackUserProfile,
} from "./slack-activity-collector";

/**
 * Slack 활동 1건(= thread 1개 또는 standalone message 1개)의 정규화 결과.
 */
export interface NormalizedSlackActivity {
  /**
   * activity_import_items.source_ref 에 들어갈 JSON 값.
   * 5-4-1: workspace_id, channel_id, thread_ts 또는 message_ts
   */
  sourceRef: {
    workspace_id: string;
    channel_id: string;
    thread_ts?: string;
    message_ts?: string;
  };
  /**
   * dedupe 용 stable string key.
   * `source_type + source_ref_key` 조합으로 중복 판정한다 (08_decision_log 2026-04-15 Pilot 4-5 v1).
   */
  sourceRefKey: string;
  /**
   * activity_import_items.raw_payload — full body dump 금지 (5-4-1).
   * 검토 가능한 최소 메타만 저장한다.
   */
  rawPayload: {
    text: string | null;
    reply_count: number;
    latest_reply_at: string | null;
    channel_id: string;
    channel_kind: "ops_report" | "dispatch_request";
    activity_unit: "thread" | "message";
    author_user_id: string | null;
    author_real_name: string | null;
    author_display_name: string | null;
    is_bot: boolean;
  };
  candidateName: string | null;
  candidateEmail: string | null;
  activityAt: Date | null;
  isOpsReport: boolean;
  isDispatchRequest: boolean;
  /** 정규화 단계에서 detect한 invalid 사유 (applier가 match_status=invalid 로 기록). */
  invalidReason: string | null;
}

/**
 * Slack ts(string seconds.microseconds)를 Date로 변환한다.
 */
function slackTsToDate(ts: string | undefined | null): Date | null {
  if (!ts) return null;
  const n = Number.parseFloat(ts);
  if (!Number.isFinite(n)) return null;
  const ms = Math.round(n * 1000);
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * text 를 검토용 메타로 제한된 길이로 자른다. v1 raw_payload 에는 full body 저장 금지.
 */
function truncateText(text: string | undefined | null, max = 300): string | null {
  if (!text) return null;
  const s = String(text);
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

/**
 * 단일 메시지 1개를 정규화한다.
 * activity 단위(thread vs message)와 last_activity_at 후보를 결정한다.
 */
function normalizeMessage(
  workspaceId: string,
  channel: RawSlackChannelCollect,
  m: SlackMessage
): NormalizedSlackActivity | null {
  // Slack bot 메시지, 시스템 메시지(채널 join/leave 등)는 활동 단위에서 제외한다.
  // subtype 이 존재하면 대부분 비활동성 이벤트이므로 본 normalizer에서는 invalid로 남긴다.
  // (bot 메시지는 필요 시 후속 확장에서 분리)
  const isThreadRoot =
    Boolean(m.thread_ts) && m.thread_ts === m.ts && (m.reply_count ?? 0) > 0;
  const isTopLevel = !m.thread_ts || m.thread_ts === m.ts;

  if (!isTopLevel) {
    // reply 메시지 — count에 포함하지 않는다 (5-4-1)
    return null;
  }

  // 메시지 채널 분류
  const isOpsReport = channel.kind === "ops_report";
  const isDispatchRequest = channel.kind === "dispatch_request";

  // activity_at 후보: thread면 latest_reply, 없으면 ts
  const latestReplyDate = isThreadRoot ? slackTsToDate(m.latest_reply) : null;
  const messageDate = slackTsToDate(m.ts);
  const activityAt = latestReplyDate ?? messageDate;

  // candidate 추출
  let candidateName: string | null = null;
  let candidateEmail: string | null = null;

  if (isDispatchRequest && channel.mappedInstructorName) {
    // 5-4-1 / 사용자 지시: 출강요청은 channel → 강사명 매핑을 우선 적용
    candidateName = channel.mappedInstructorName;
  } else {
    // 운영보고: 작성자 profile에서 name/email 후보 추출
    const author: SlackUserProfile | undefined = m.user
      ? channel.users[m.user]
      : undefined;
    if (author) {
      candidateName = author.realName ?? author.displayName ?? null;
      candidateEmail = author.email ?? null;
    }
  }

  const author = m.user ? channel.users[m.user] : undefined;
  const isBot = Boolean(m.bot_id) || Boolean(author?.isBot);

  // invalid detection
  let invalidReason: string | null = null;
  if (m.subtype && m.subtype !== "thread_broadcast") {
    invalidReason = `slack_subtype:${m.subtype}`;
  } else if (isBot && channel.kind === "ops_report") {
    invalidReason = "slack_bot_message";
  }

  // source_ref: thread면 thread_ts, 아니면 message_ts
  const sourceRef: NormalizedSlackActivity["sourceRef"] = isThreadRoot
    ? { workspace_id: workspaceId, channel_id: channel.channelId, thread_ts: m.ts }
    : { workspace_id: workspaceId, channel_id: channel.channelId, message_ts: m.ts };

  const sourceRefKey = isThreadRoot
    ? `slack:${workspaceId}:${channel.channelId}:thread:${m.ts}`
    : `slack:${workspaceId}:${channel.channelId}:message:${m.ts}`;

  return {
    sourceRef,
    sourceRefKey,
    rawPayload: {
      text: truncateText(m.text),
      reply_count: m.reply_count ?? 0,
      latest_reply_at: latestReplyDate ? latestReplyDate.toISOString() : null,
      channel_id: channel.channelId,
      channel_kind: channel.kind,
      activity_unit: isThreadRoot ? "thread" : "message",
      author_user_id: m.user ?? null,
      author_real_name: author?.realName ?? null,
      author_display_name: author?.displayName ?? null,
      is_bot: isBot,
    },
    candidateName,
    candidateEmail,
    activityAt,
    isOpsReport,
    isDispatchRequest,
    invalidReason,
  };
}

/**
 * 수집 결과 전체를 정규화 activity 배열로 변환한다.
 */
export function normalizeSlackCollect(
  collect: SlackCollectResult
): NormalizedSlackActivity[] {
  const out: NormalizedSlackActivity[] = [];
  for (const channel of collect.channels) {
    for (const m of channel.messages) {
      const normalized = normalizeMessage(collect.workspaceId, channel, m);
      if (normalized) out.push(normalized);
    }
  }
  return out;
}
