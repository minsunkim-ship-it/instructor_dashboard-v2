/**
 * Gmail Activity Collector — Pilot 4-5 v1
 *
 * 04_data_pipeline.md 5-5절, 5-5-2절
 * 02_system_architecture.md 11-3절
 * 08_decision_log.md 2026-04-15 "Pilot 4-5 v1" 결정 항목
 *
 * 확정 계약:
 * - Canonical source: direct Gmail API
 * - 인증: OAuth refresh token (GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_ACCOUNT_EMAIL)
 * - count 규칙: thread 1개 = activity 1건
 * - full body dump 금지. raw_payload는 subject, snippet, from, to 등 최소 메타만 사용한다.
 */

import {
  exchangeGoogleUserAccessToken,
  getGoogleUserOAuthEnv,
  googleApiGet,
} from "@/lib/google-user-oauth";

const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1";
export const GMAIL_ACTIVITY_MAILBOX_QUERY = "from:day1company.co.kr";

/**
 * Gmail thread 원본 수집 결과 1건. collector는 thread 단위로 메시지 원본 최소 메타만 가져온다.
 */
export interface RawGmailThread {
  threadId: string;
  accountEmail: string;
  mailboxQuery: string;
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
  mailboxQuery: string;
  threads: RawGmailThread[];
  /** 이번 수집이 incremental이었는지 여부. afterEpochSeconds가 없으면 false (full backfill). */
  incremental: boolean;
  diagnostics: GmailCollectDiagnostics;
}

export interface GmailCollectDiagnostics {
  listPagesFetched: number;
  pageSize: number;
  maxPages: number;
  pageCapHit: boolean;
  nextPageTokenRemaining: boolean;
  resultSizeEstimate: number | null;
  threadsListed: number;
  threadsLoaded: number;
  threadsDroppedBeforeApply: number;
  detailFetchFailures: number;
  detailEmptyThreads: number;
  fetchComplete: boolean;
}

/**
 * Gmail mailbox checkpoint 정보. scope_key = `gmail:mailbox`
 * checkpoint_json 내부: { last_internal_date_ms: string, mailbox_query: string }
 */
export interface GmailMailboxCheckpoint {
  /** 마지막으로 확인한 thread의 internalDate (ms string). incremental 시 after: 쿼리에 사용. */
  lastInternalDateMs: string | null;
}

function getEnv(): {
  accountEmail: string;
} {
  const { accountEmail } = getGoogleUserOAuthEnv();
  return { accountEmail };
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

type ThreadLoadResult =
  | { status: "loaded"; thread: RawGmailThread }
  | { status: "empty"; threadId: string }
  | { status: "failed"; threadId: string };

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

function isDay1SenderHeader(value: string | null): boolean {
  if (!value) return false;
  return /@day1company\.co\.kr\b/i.test(value);
}

/**
 * Pilot 4-5 v3: authenticated account mailbox 전체에서 `from:day1company.co.kr` 기준 thread를 수집한다.
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
  /** mailbox checkpoint. 없으면 full backfill. */
  checkpoint?: GmailMailboxCheckpoint | null;
  requestTimeoutMs?: number;
  mailboxTimeoutMs?: number;
  threadFetchConcurrency?: number;
}): Promise<GmailCollectResult> {
  const { accountEmail } = getEnv();
  const accessToken = await exchangeGoogleUserAccessToken();

  const mailboxQuery = options?.query?.trim() || GMAIL_ACTIVITY_MAILBOX_QUERY;
  const maxPages = options?.maxPages ?? 5;
  const pageSize = Math.min(options?.pageSize ?? 100, 500);
  const requestTimeoutMs = Math.max(options?.requestTimeoutMs ?? 10_000, 1_000);
  const mailboxTimeoutMs = Math.max(options?.mailboxTimeoutMs ?? 60_000, 5_000);
  const threadFetchConcurrency = Math.max(
    options?.threadFetchConcurrency ?? 8,
    1
  );

  const checkpoint = options?.checkpoint ?? null;
  const isIncremental = Boolean(checkpoint);

  const threadIds = new Set<string>();
  const threads: RawGmailThread[] = [];
  let listPagesFetched = 0;
  let listResultSizeEstimate: number | null = null;
  let nextPageTokenRemaining = false;

  const mailboxController = new AbortController();
  const mailboxTimeout = setTimeout(() => {
    mailboxController.abort(
      new Error(`Gmail mailbox query timeout after ${mailboxTimeoutMs}ms`)
    );
  }, mailboxTimeoutMs);

  try {
    let afterClause = "";
    if (checkpoint?.lastInternalDateMs) {
      const ms = Number.parseInt(checkpoint.lastInternalDateMs, 10);
      if (Number.isFinite(ms) && ms > 0) {
        afterClause = ` after:${Math.floor(ms / 1000)}`;
      }
    }

    let pageToken: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const params: Record<string, string> = {
        q: `${mailboxQuery}${afterClause}`,
        maxResults: String(pageSize),
      };
      if (pageToken) params.pageToken = pageToken;

      const data = await gmailGet<GmailThreadsListResponse>(
        accessToken,
        "/users/me/threads",
        params,
        {
          signal: mailboxController.signal,
          timeoutMs: requestTimeoutMs,
        }
      );
      listPagesFetched += 1;
      listResultSizeEstimate =
        typeof data.resultSizeEstimate === "number" ? data.resultSizeEstimate : null;

      if (Array.isArray(data.threads)) {
        for (const thread of data.threads) {
          threadIds.add(thread.id);
        }
      }

      if (!data.nextPageToken) {
        nextPageTokenRemaining = false;
        break;
      }
      pageToken = data.nextPageToken;
      nextPageTokenRemaining = true;
    }
  } finally {
    clearTimeout(mailboxTimeout);
  }

  // Step 2: deduped thread 상세 로드
  const threadEntries = Array.from(threadIds);
  const loadedThreads = await mapWithConcurrency(
    threadEntries,
    threadFetchConcurrency,
    async (threadId): Promise<ThreadLoadResult> => {
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
        if (messages.length === 0) {
          return { status: "empty", threadId };
        }

        const representative =
          [...messages]
            .reverse()
            .find((message) =>
              isDay1SenderHeader(findHeader(message.payload?.headers, "From"))
            ) ?? messages[0];
        const last = messages[messages.length - 1];

        const subject = findHeader(representative.payload?.headers, "Subject");
        const from = findHeader(representative.payload?.headers, "From");
        const to = findHeader(representative.payload?.headers, "To");

        return {
          status: "loaded",
          thread: {
            threadId,
            accountEmail,
            mailboxQuery,
            firstMessageId: representative.id ?? null,
            lastInternalDateMs: last.internalDate ?? null,
            subject,
            snippet: (representative.snippet ?? null)?.slice(0, 300) ?? null,
            from,
            to,
          } satisfies RawGmailThread,
        };
      } catch {
        return { status: "failed", threadId };
      }
    }
  );

  let detailFetchFailures = 0;
  let detailEmptyThreads = 0;
  for (const result of loadedThreads) {
    if (result.status === "loaded") {
      threads.push(result.thread);
      continue;
    }
    if (result.status === "empty") {
      detailEmptyThreads += 1;
      continue;
    }
    detailFetchFailures += 1;
  }

  const threadsListed = threadEntries.length;
  const threadsLoaded = threads.length;
  const threadsDroppedBeforeApply = threadsListed - threadsLoaded;
  const pageCapHit = nextPageTokenRemaining;
  const fetchComplete =
    !pageCapHit && detailFetchFailures === 0 && detailEmptyThreads === 0;

  return {
    accountEmail,
    mailboxQuery,
    threads,
    incremental: isIncremental,
    diagnostics: {
      listPagesFetched,
      pageSize,
      maxPages,
      pageCapHit,
      nextPageTokenRemaining,
      resultSizeEstimate: listResultSizeEstimate,
      threadsListed,
      threadsLoaded,
      threadsDroppedBeforeApply,
      detailFetchFailures,
      detailEmptyThreads,
      fetchComplete,
    },
  };
}
