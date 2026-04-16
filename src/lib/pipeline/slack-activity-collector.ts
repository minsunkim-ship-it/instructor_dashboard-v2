/**
 * Slack Activity Collector — Pilot 4-5 v1
 *
 * 04_data_pipeline.md 5-4절, 5-4-1절
 * 02_system_architecture.md 11-3절
 * 08_decision_log.md 2026-04-15 "Pilot 4-5 v1" 결정 항목
 *
 * 확정 계약:
 * - Canonical source: direct Slack Web API
 * - 인증: SLACK_BOT_TOKEN, SLACK_WORKSPACE_ID
 * - canonical scope 3개 채널만 수집:
 *   - 운영보고: C015YD84VGS (ops_report)
 *   - 출강요청(정백): C099UH7ACGG (dispatch_request)
 *   - 출강요청(신동원): C0AS2VDUXQ8 (dispatch_request)
 * - count 규칙 (5-4-1):
 *   - thread 있음 → thread 1개 = activity 1건
 *   - thread 없음 → message 1개 = activity 1건
 *   - reply 수는 count를 직접 늘리지 않는다.
 *
 * 본 collector는 원본 수집만 담당하며, 매칭/저장/aggregate 반영은 activity-applier.ts에서 처리한다.
 */

// Slack Web API base URL
const SLACK_API_BASE = "https://slack.com/api";

/**
 * Pilot 4-5 v1 canonical channel 종류.
 * - ops_report: 운영보고 채널
 * - dispatch_request: 출강요청 채널 (채널 → 강사 mapping 적용 대상)
 */
export type SlackChannelKind = "ops_report" | "dispatch_request";

export interface SlackChannelConfig {
  channelId: string;
  kind: SlackChannelKind;
  /**
   * dispatch_request 채널일 때만 사용: 채널 고정 강사명.
   * 5-4-1 / 사용자 지시: `channel_id -> instructor name` 매핑을 우선 적용한다.
   */
  mappedInstructorName?: string;
}

/**
 * Pilot 4-5 v1 canonical scope 채널 목록.
 * Source of Truth: 04_data_pipeline.md 5-4-1, 08_decision_log.md 2026-04-15 Pilot 4-5 v1 결정 항목.
 */
export const SLACK_PILOT_4_5_CHANNELS: readonly SlackChannelConfig[] = [
  { channelId: "C015YD84VGS", kind: "ops_report" },
  {
    channelId: "C099UH7ACGG",
    kind: "dispatch_request",
    mappedInstructorName: "정백",
  },
  {
    channelId: "C0AS2VDUXQ8",
    kind: "dispatch_request",
    mappedInstructorName: "신동원",
  },
] as const;

/**
 * Slack 메시지 최소 필드.
 * Slack Web API `conversations.history` 응답 message 오브젝트 중 v1에서 사용하는 부분집합.
 */
export interface SlackMessage {
  type?: string;
  subtype?: string;
  ts: string;
  thread_ts?: string;
  text?: string;
  user?: string;
  bot_id?: string;
  reply_count?: number;
  /** Slack API: 스레드 마지막 reply의 ts (string seconds.microseconds) */
  latest_reply?: string;
}

/**
 * 채널 1개에서 수집한 raw 메시지 집합.
 */
export interface RawSlackChannelCollect {
  channelId: string;
  kind: SlackChannelKind;
  mappedInstructorName?: string;
  /** 수집된 top-level 메시지. thread 반복 내부의 reply 메시지는 포함하지 않는다. */
  messages: SlackMessage[];
  /** 메시지 작성자 user id → Slack profile (real_name, email, display_name) */
  users: Record<string, SlackUserProfile>;
  error?: string;
}

export interface SlackUserProfile {
  userId: string;
  realName: string | null;
  displayName: string | null;
  email: string | null;
  isBot: boolean;
}

export interface SlackCollectResult {
  workspaceId: string;
  channels: RawSlackChannelCollect[];
  /** 이번 수집이 incremental이었는지 여부. checkpoint가 없으면 false (full backfill). */
  incremental: boolean;
}

/**
 * 채널별 checkpoint 정보. scope_key = `slack:channel:{channelId}`
 * checkpoint_json 내부: { last_seen_ts: string }
 */
export interface SlackChannelCheckpoint {
  channelId: string;
  /** 마지막으로 확인한 top-level 메시지 ts. incremental 시 oldest = last_seen_ts - overlap_seconds */
  lastSeenTs: string | null;
}

/**
 * Slack incremental 수집 옵션.
 */
export interface SlackCollectOptions {
  channels?: readonly SlackChannelConfig[];
  /** 채널별 checkpoint. 없으면 full backfill. */
  checkpoints?: SlackChannelCheckpoint[];
  /**
   * conversations.history page size.
   * Slack API 최대 200.
   */
  perPageLimit?: number;
  /**
   * checkpoint가 있는 incremental 수집 시 채널당 최대 페이지 수.
   * 기본값은 작게 유지해 일상 실행 비용을 제한한다.
   */
  incrementalMaxPages?: number;
  /**
   * checkpoint가 없는 full backfill / reconcile 시 채널당 최대 페이지 수.
   * 운영보고 채널 과거분을 더 넓게 읽기 위해 incremental보다 크게 둔다.
   */
  fullBackfillMaxPages?: number;
  /**
   * incremental 겹침 초. 오래된 thread reply가 누락되지 않도록 보수적으로 사용한다.
   * 기본값 600초 (10분). 문서 가이드: 300~600초 범위.
   *
   * LIMITATION: Slack conversations.history oldest 파라미터는 top-level 메시지의 ts만
   * 기준으로 필터한다. 오래된 thread에 새 reply가 달려도 top-level ts는 변하지 않으므로,
   * overlap_seconds 범위 밖의 오래된 thread 신규 reply는 incremental 수집에서 놓칠 수 있다.
   * 이를 보완하려면 주기적 full reconcile이 필요하다.
   */
  overlapSeconds?: number;
}

function getEnv(): { token: string; workspaceId: string } {
  const token = process.env.SLACK_BOT_TOKEN;
  const workspaceId = process.env.SLACK_WORKSPACE_ID;
  if (!token) {
    throw new Error("SLACK_BOT_TOKEN 환경변수가 설정되지 않았습니다.");
  }
  if (!workspaceId) {
    throw new Error("SLACK_WORKSPACE_ID 환경변수가 설정되지 않았습니다.");
  }
  return { token, workspaceId };
}

interface SlackApiEnvelope {
  ok: boolean;
  error?: string;
  warning?: string;
}

interface SlackConversationsHistoryResponse extends SlackApiEnvelope {
  messages?: SlackMessage[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
}

interface SlackUsersInfoResponse extends SlackApiEnvelope {
  user?: {
    id: string;
    is_bot?: boolean;
    real_name?: string;
    profile?: {
      real_name?: string;
      display_name?: string;
      email?: string;
    };
  };
}

async function slackGet<T extends SlackApiEnvelope>(
  token: string,
  path: string,
  params: Record<string, string>
): Promise<T> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${SLACK_API_BASE}/${path}?${qs}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
    },
  });
  if (!res.ok) {
    throw new Error(
      `Slack API ${path} HTTP ${res.status}: ${await res.text()}`
    );
  }
  const json = (await res.json()) as T;
  if (!json.ok) {
    throw new Error(
      `Slack API ${path} 실패: ${json.error ?? "unknown"}`
    );
  }
  return json;
}

/**
 * 단일 채널의 메시지 수집.
 * @param oldest - Slack ts 형식. 이 ts 이후의 메시지만 수집한다 (exclusive). incremental 수집 시 사용.
 */
async function fetchChannelHistory(
  token: string,
  channelId: string,
  options?: { oldest?: string; perPageLimit?: number; maxPages?: number }
): Promise<SlackMessage[]> {
  const perPageLimit = options?.perPageLimit ?? 200;
  const maxPages = options?.maxPages ?? 5;
  const collected: SlackMessage[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const params: Record<string, string> = {
      channel: channelId,
      limit: String(perPageLimit),
    };
    if (options?.oldest) params.oldest = options.oldest;
    if (cursor) params.cursor = cursor;

    const data = await slackGet<SlackConversationsHistoryResponse>(
      token,
      "conversations.history",
      params
    );

    if (Array.isArray(data.messages)) {
      collected.push(...data.messages);
    }

    if (!data.has_more || !data.response_metadata?.next_cursor) break;
    cursor = data.response_metadata.next_cursor;
  }

  return collected;
}

/**
 * `users.info` 호출로 user profile 수집. cache를 활용해 중복 조회를 줄인다.
 */
async function fetchUserProfile(
  token: string,
  userId: string,
  cache: Map<string, SlackUserProfile>
): Promise<SlackUserProfile> {
  const cached = cache.get(userId);
  if (cached) return cached;

  try {
    const data = await slackGet<SlackUsersInfoResponse>(token, "users.info", {
      user: userId,
    });
    const profile = data.user?.profile;
    const resolved: SlackUserProfile = {
      userId,
      realName: (profile?.real_name ?? data.user?.real_name ?? null) || null,
      displayName: (profile?.display_name ?? null) || null,
      email: (profile?.email ?? null) || null,
      isBot: Boolean(data.user?.is_bot),
    };
    cache.set(userId, resolved);
    return resolved;
  } catch {
    // user 조회 실패는 전체 실패로 확산시키지 않는다. 빈 profile을 반환.
    const resolved: SlackUserProfile = {
      userId,
      realName: null,
      displayName: null,
      email: null,
      isBot: false,
    };
    cache.set(userId, resolved);
    return resolved;
  }
}

/**
 * Slack ts를 epoch seconds number로 변환한다.
 */
function slackTsToEpoch(ts: string): number {
  return Number.parseFloat(ts);
}

/**
 * epoch seconds를 Slack ts 형식 문자열로 변환한다.
 */
function epochToSlackTs(epoch: number): string {
  return `${epoch.toFixed(6)}`;
}

/**
 * Pilot 4-5 v2: canonical scope 3개 채널에서 메시지를 수집한다.
 *
 * - checkpoint가 있으면 incremental: oldest = last_seen_ts - overlapSeconds
 * - checkpoint가 없으면 full backfill
 * - top-level 메시지만 수집한다. 스레드 replies는 별도 호출하지 않으며,
 *   `thread_ts == ts` 이면서 `reply_count > 0` 인 메시지의 `latest_reply` 를
 *   last_activity_at 계산 후보로 사용한다 (5-4-1).
 * - 메시지 작성자 profile은 `users.info` 로 조회해 name/email 후보로 사용한다.
 *
 * LIMITATION: incremental 수집은 top-level 메시지 ts 기준이므로, overlap 범위 밖의
 * 오래된 thread에 새 reply가 달린 경우 놓칠 수 있다. 주기적 full reconcile로 보완해야 한다.
 * reconcile 모드: checkpoints를 빈 배열로 전달하면 full backfill을 수행한다.
 */
export async function collectFromSlack(
  opts?: SlackCollectOptions
): Promise<SlackCollectResult> {
  const { token, workspaceId } = getEnv();
  const channels = opts?.channels ?? SLACK_PILOT_4_5_CHANNELS;
  const checkpoints = opts?.checkpoints ?? [];
  const perPageLimit = Math.min(Math.max(opts?.perPageLimit ?? 200, 1), 200);
  const incrementalMaxPages = Math.max(opts?.incrementalMaxPages ?? 5, 1);
  const fullBackfillMaxPages = Math.max(opts?.fullBackfillMaxPages ?? 10, 1);
  const overlapSeconds = opts?.overlapSeconds ?? 600;

  const cpMap = new Map<string, SlackChannelCheckpoint>();
  for (const cp of checkpoints) {
    cpMap.set(cp.channelId, cp);
  }

  const isIncremental = checkpoints.length > 0;
  const userCache = new Map<string, SlackUserProfile>();
  const results: RawSlackChannelCollect[] = [];

  for (const cfg of channels) {
    try {
      // incremental: oldest = last_seen_ts - overlap_seconds
      let oldest: string | undefined;
      const cp = cpMap.get(cfg.channelId);
      if (cp?.lastSeenTs) {
        const epoch = slackTsToEpoch(cp.lastSeenTs);
        if (Number.isFinite(epoch) && epoch > 0) {
          oldest = epochToSlackTs(epoch - overlapSeconds);
        }
      }

      const messages = await fetchChannelHistory(token, cfg.channelId, {
        oldest,
        perPageLimit,
        maxPages: oldest ? incrementalMaxPages : fullBackfillMaxPages,
      });

      const userIds = new Set<string>();
      for (const m of messages) {
        if (m.user) userIds.add(m.user);
      }

      const users: Record<string, SlackUserProfile> = {};
      for (const uid of userIds) {
        const profile = await fetchUserProfile(token, uid, userCache);
        users[uid] = profile;
      }

      results.push({
        channelId: cfg.channelId,
        kind: cfg.kind,
        mappedInstructorName: cfg.mappedInstructorName,
        messages,
        users,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        channelId: cfg.channelId,
        kind: cfg.kind,
        mappedInstructorName: cfg.mappedInstructorName,
        messages: [],
        users: {},
        error: message,
      });
    }
  }

  return { workspaceId, channels: results, incremental: isIncremental };
}
