/**
 * Gmail Activity Collector — Pilot 4-5 v1
 *
 * 04_data_pipeline.md 5-5절, 5-5-2절
 * 02_system_architecture.md 11-3절
 * 08_decision_log.md 2026-04-15 "Pilot 4-5 v1" 결정 항목
 *
 * 확정 계약:
 * - Canonical source: direct Gmail API
 * - 인증: OAuth refresh token (GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_ACCOUNT_EMAIL, GMAIL_TARGET_ADDRESSES)
 * - count 규칙: thread 1개 = activity 1건
 * - full body dump 금지. raw_payload는 subject, snippet, from, to 등 최소 메타만 사용한다.
 */

import {
  exchangeGoogleUserAccessToken,
  getGoogleUserOAuthEnv,
  googleApiGet,
} from "@/lib/google-user-oauth";

const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1";

/**
 * Gmail thread 원본 수집 결과 1건. collector는 thread 단위로 메시지 원본 최소 메타만 가져온다.
 */
export interface RawGmailThread {
  threadId: string;
  accountEmail: string;
  matchedTargetAddresses: string[];
  /** 스레드 내부 첫 메시지 id (source_ref에 저장) */
  firstMessageId: string | null;
  /** 스레드 내부 마지막 메시지의 internalDate (ms string). */
  lastInternalDateMs: string | null;
  /** 스레드 내부 첫 메시지의 Subject header */
  subject: string | null;
  /** 스레드 내부 첫 메시지의 snippet (최대 ~200자) */
  snippet: string | null;
  /** 스레드 내부 첫 메시지 From 헤더 */
  from: string | null;
  /** 스레드 내부 첫 메시지 To 헤더 */
  to: string | null;
}

export interface GmailCollectResult {
  accountEmail: string;
  targetAddresses: string[];
  targetAddressErrors: { targetAddress: string; error: string }[];
  threads: RawGmailThread[];
  /** 이번 수집이 incremental이었는지 여부. afterEpochSeconds가 없으면 false (full backfill). */
  incremental: boolean;
}

/**
 * Gmail checkpoint 정보. scope_key = `gmail:target:{targetAddress}`
 * checkpoint_json 내부: { last_internal_date_ms: string }
 */
export interface GmailTargetCheckpoint {
  targetAddress: string;
  /** 마지막으로 확인한 thread의 internalDate (ms string). incremental 시 after: 쿼리에 사용. */
  lastInternalDateMs: string | null;
}

function getEnv(): {
  accountEmail: string;
  targetAddresses: string[];
} {
  const { accountEmail } = getGoogleUserOAuthEnv();
  const targetAddresses = (process.env.GMAIL_TARGET_ADDRESSES ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (targetAddresses.length === 0) {
    throw new Error("GMAIL_TARGET_ADDRESSES 환경변수가 설정되지 않았습니다.");
  }
  return { accountEmail, targetAddresses };
}

interface GmailThreadsListItem {
  id: string;
  historyId?: string;
}

interface GmailThreadsListResponse {
  threads?: GmailThreadsListItem[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

interface GmailHeader {
  name?: string;
  value?: string;
}

interface GmailMessage {
  id: string;
  threadId: string;
  internalDate?: string;
  snippet?: string;
  payload?: {
    headers?: GmailHeader[];
  };
}

interface GmailThreadGetResponse {
  id: string;
  messages?: GmailMessage[];
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];

  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (true) {
        const current = nextIndex++;
        if (current >= items.length) return;
        results[current] = await worker(items[current], current);
      }
    })
  );

  return results;
}

async function gmailGet<T>(
  accessToken: string,
  path: string,
  params: Record<string, string> = {},
  options?: { signal?: AbortSignal; timeoutMs?: number }
): Promise<T> {
  return googleApiGet<T>(accessToken, GMAIL_API_BASE, path, params, options);
}

function findHeader(headers: GmailHeader[] | undefined, name: string): string | null {
  if (!headers) return null;
  const target = name.toLowerCase();
  for (const h of headers) {
    if ((h.name ?? "").toLowerCase() === target) {
      return h.value ?? null;
    }
  }
  return null;
}

/**
 * Pilot 4-5 v2: authenticated account mailbox 안에서 GMAIL_TARGET_ADDRESSES 기준 thread를 수집한다.
 *
 * - checkpoint가 있으면 incremental: `after:<epoch_seconds>` 쿼리 사용
 * - checkpoint가 없으면 full backfill
 * - `users.threads.list` 로 thread id 를 페이지 단위로 수집한다.
 * - 각 thread를 `users.threads.get` 으로 로드해 첫 메시지의 subject/snippet/from/to 와
 *   마지막 메시지의 internalDate 를 raw 정보로 추린다.
 */
export async function collectFromGmail(options?: {
  query?: string;
  maxPages?: number;
  pageSize?: number;
  /** target address 별 checkpoint. 없으면 full backfill. */
  checkpoints?: GmailTargetCheckpoint[];
  requestTimeoutMs?: number;
  targetTimeoutMs?: number;
  threadFetchConcurrency?: number;
}): Promise<GmailCollectResult> {
  const { accountEmail, targetAddresses } = getEnv();
  const accessToken = await exchangeGoogleUserAccessToken();

  const baseQuery = options?.query ?? "in:anywhere";
  const maxPages = options?.maxPages ?? 5;
  const pageSize = Math.min(options?.pageSize ?? 100, 500);
  const checkpoints = options?.checkpoints ?? [];
  const requestTimeoutMs = Math.max(options?.requestTimeoutMs ?? 10_000, 1_000);
  const targetTimeoutMs = Math.max(options?.targetTimeoutMs ?? 60_000, 5_000);
  const threadFetchConcurrency = Math.max(
    options?.threadFetchConcurrency ?? 8,
    1
  );

  const cpMap = new Map<string, GmailTargetCheckpoint>();
  for (const cp of checkpoints) {
    cpMap.set(cp.targetAddress, cp);
  }
  const isIncremental = checkpoints.length > 0;

  const threadTargets = new Map<string, Set<string>>();
  const threads: RawGmailThread[] = [];
  const targetAddressErrors: { targetAddress: string; error: string }[] = [];

  for (const targetAddress of targetAddresses) {
    const targetController = new AbortController();
    const targetTimeout = setTimeout(() => {
      targetController.abort(
        new Error(
          `Gmail target ${targetAddress} timeout after ${targetTimeoutMs}ms`
        )
      );
    }, targetTimeoutMs);
    try {
      // incremental: after:<epoch_seconds> 쿼리 추가
      let afterClause = "";
      const cp = cpMap.get(targetAddress);
      if (cp?.lastInternalDateMs) {
        const ms = Number.parseInt(cp.lastInternalDateMs, 10);
        if (Number.isFinite(ms) && ms > 0) {
          const epochSeconds = Math.floor(ms / 1000);
          afterClause = ` after:${epochSeconds}`;
        }
      }

      let pageToken: string | undefined;

      for (let page = 0; page < maxPages; page++) {
        const params: Record<string, string> = {
          q: `${baseQuery}${afterClause} (to:${targetAddress} OR cc:${targetAddress} OR deliveredto:${targetAddress})`,
          maxResults: String(pageSize),
        };
        if (pageToken) params.pageToken = pageToken;

        const data = await gmailGet<GmailThreadsListResponse>(
          accessToken,
          "/users/me/threads",
          params,
          {
            signal: targetController.signal,
            timeoutMs: requestTimeoutMs,
          }
        );

        if (Array.isArray(data.threads)) {
          for (const t of data.threads) {
            const existing = threadTargets.get(t.id) ?? new Set<string>();
            existing.add(targetAddress);
            threadTargets.set(t.id, existing);
          }
        }

        if (!data.nextPageToken) break;
        pageToken = data.nextPageToken;
      }
    } catch (error) {
      targetAddressErrors.push({
        targetAddress,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearTimeout(targetTimeout);
    }
  }

  // Step 2: deduped thread 상세 로드
  const threadEntries = Array.from(threadTargets.entries());
  const loadedThreads = await mapWithConcurrency(
    threadEntries,
    threadFetchConcurrency,
    async ([threadId, matchedTargets]) => {
      try {
        const t = await gmailGet<GmailThreadGetResponse>(
          accessToken,
          `/users/me/threads/${encodeURIComponent(threadId)}`,
          // `metadataHeaders`를 comma-joined 단일 파라미터로 보내면 Gmail API가
          // 헤더명을 하나로 인식해 Subject/From/To가 비는 경우가 있다.
          // v2에서는 format=metadata만 지정해 표준 헤더 전체를 받아온 뒤 필요한
          // 헤더만 추린다.
          { format: "metadata" },
          { timeoutMs: requestTimeoutMs }
        );

        const messages = t.messages ?? [];
        if (messages.length === 0) return null;

        const first = messages[0];
        const last = messages[messages.length - 1];

        const subject = findHeader(first.payload?.headers, "Subject");
        const from = findHeader(first.payload?.headers, "From");
        const to = findHeader(first.payload?.headers, "To");

        return {
          threadId,
          accountEmail,
          matchedTargetAddresses: Array.from(matchedTargets).sort(),
          firstMessageId: first.id ?? null,
          lastInternalDateMs: last.internalDate ?? null,
          subject,
          snippet: (first.snippet ?? null)?.slice(0, 300) ?? null,
          from,
          to,
        } satisfies RawGmailThread;
      } catch {
        return null;
      }
    }
  );

  for (const thread of loadedThreads) {
    if (thread) threads.push(thread);
  }

  if (threads.length === 0 && targetAddressErrors.length === targetAddresses.length) {
    throw new Error(
      `모든 Gmail target address 수집에 실패했습니다: ${targetAddressErrors
        .map((entry) => `${entry.targetAddress}=${entry.error}`)
        .join(" | ")}`
    );
  }

  return { accountEmail, targetAddresses, targetAddressErrors, threads, incremental: isIncremental };
}
