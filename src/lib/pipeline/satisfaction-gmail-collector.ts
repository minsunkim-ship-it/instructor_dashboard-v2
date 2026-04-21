import {
  exchangeGoogleUserAccessToken,
  type GoogleApiRequestOptions,
  getGoogleUserOAuthEnv,
  googleApiGet,
} from "@/lib/google-user-oauth";

const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1";
const SATISFACTION_POSITIVE_SIGNAL_PATTERN =
  /(종합 평균 만족도|전체 만족도|강의 만족도|강사 만족도|강의내용 만족도|설문평가 결과|학습자 종합 설문 결과|만족도 결과 전달|만족도 조사 결과|만족도 결과 공유|전체 만족도 송부|만족도 정리|응답 평균\s*\(n\s*=|사전\/사후 설문|사전 설문|사후 설문|설문 Raw Data|설문 raw data|rawdata|raw data)/i;
const SATISFACTION_NEGATIVE_SUBJECT_PATTERN =
  /(정산 안내|교안 전달|협의내용 공유|커리큘럼 공유|제안서|견적서|안내드립니다|안내 드립니다|커리큘럼 확인 요청|강의 안내드립니다|세금계산서|발행 정보 요청|리마인드|요청드립니다|요청 드립니다)/i;
const SATISFACTION_MIN_SIGNAL_SCORE = 3;

export const GMAIL_SATISFACTION_SOURCE_KEY = "gmail_satisfaction" as const;

export interface SatisfactionGmailThread {
  threadId: string;
  messageId: string | null;
  subject: string | null;
  from: string | null;
  to: string | null;
  cc: string | null;
  sentAt: string | null;
  snippet: string | null;
  bodyText: string | null;
}

export interface SatisfactionGmailCollectResult {
  sourceKey: typeof GMAIL_SATISFACTION_SOURCE_KEY;
  query: string;
  accountEmail: string;
  threads: SatisfactionGmailThread[];
  incremental: boolean;
}

export interface SatisfactionGmailCheckpoint {
  lastInternalDateMs: string | null;
}

interface GmailHeader {
  name?: string;
  value?: string;
}

interface GmailMessagePart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailMessagePart[];
}

interface GmailMessage {
  id?: string;
  internalDate?: string;
  snippet?: string;
  payload?: GmailMessagePart & { headers?: GmailHeader[] };
}

interface GmailThreadListResponse {
  threads?: Array<{ id: string }>;
  nextPageToken?: string;
}

interface GmailThreadGetResponse {
  id: string;
  messages?: GmailMessage[];
}

function normalizeTextForMatch(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function decodeBase64Url(input: string | undefined): string | null {
  if (!input) return null;
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

function stripHtmlTags(value: string): string {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function collectBodyParts(part: GmailMessagePart | undefined, out: GmailMessagePart[] = []) {
  if (!part) return out;
  if (part.body?.data && (part.mimeType === "text/plain" || part.mimeType === "text/html")) {
    out.push(part);
  }
  for (const child of part.parts ?? []) {
    collectBodyParts(child, out);
  }
  return out;
}

function findHeader(headers: GmailHeader[] | undefined, name: string): string | null {
  const lowered = name.toLowerCase();
  for (const header of headers ?? []) {
    if ((header.name ?? "").toLowerCase() === lowered) {
      return header.value ?? null;
    }
  }
  return null;
}

function extractBodyText(message: GmailMessage | undefined): string | null {
  const textParts = collectBodyParts(message?.payload);
  for (const part of textParts) {
    const decoded = decodeBase64Url(part.body?.data);
    if (!decoded) continue;
    const text =
      part.mimeType === "text/html" ? stripHtmlTags(decoded) : decoded.replace(/\r/g, "").trim();
    if (text) return text;
  }
  return null;
}

export function extractPrimaryBodyText(value: string | null | undefined): string {
  const text = (value ?? "").replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").trim();
  if (!text) return "";

  const cutPatterns = [
    /\n[-]{2,}\s*forwarded message\s*[-]{2,}/i,
    /\n20\d{2}년 .*작성:/,
    /\nOn .+wrote:/i,
    /\n보낸사람:\s*/i,
    /\nFrom:\s*/i,
  ];

  let next = text;
  for (const pattern of cutPatterns) {
    const match = next.match(pattern);
    if (match?.index !== undefined) {
      next = next.slice(0, match.index).trim();
    }
  }

  const quotedBlockIndex = next.search(/\n>\s*/);
  if (quotedBlockIndex >= 0) {
    next = next.slice(0, quotedBlockIndex).trim();
  }

  return next;
}

function hasScoreSignal(text: string): boolean {
  return (
    /(종합 평균 만족도|전체 만족도|평균 만족도|만족도 평균|평균 점수|강의 만족도|강사 만족도|강의내용 만족도|\[강의 만족도 결과\]|\[객관식 분석\])/i.test(
      text
    ) ||
    /([1-5](?:\.\d+)?)\s*\/\s*5(?:\.0)?/.test(text)
  );
}

function hasPositiveSubjectSignal(subject: string): boolean {
  return (
    SATISFACTION_POSITIVE_SIGNAL_PATTERN.test(subject) ||
    /(만족도|설문평가|설문 결과|조사 결과|학습자 종합 설문 결과|사전\s*설문|사후\s*설문|raw\s*data|rawdata)/i.test(
      subject
    )
  );
}

function getSatisfactionSignalScore(message: GmailMessage | undefined): number {
  const headers = message?.payload?.headers;
  const subject = normalizeTextForMatch(findHeader(headers, "Subject"));
  const snippet = normalizeTextForMatch(message?.snippet ?? null);
  const bodyText = extractBodyText(message);
  const primaryBodyText = extractPrimaryBodyText(bodyText);
  const combined = [subject, snippet, primaryBodyText].filter(Boolean).join(" ");

  if (
    SATISFACTION_NEGATIVE_SUBJECT_PATTERN.test(subject) &&
    !hasPositiveSubjectSignal(subject)
  ) {
    return 0;
  }

  const hasSatisfactionKeyword =
    combined.includes("만족도") ||
    combined.includes("설문평가") ||
    combined.includes("설문 결과") ||
    combined.includes("조사 결과") ||
    combined.includes("학습자 종합 설문 결과") ||
    combined.includes("사전 설문") ||
    combined.includes("사후 설문") ||
    /raw\s*data|rawdata/i.test(combined);
  if (!hasSatisfactionKeyword) return 0;

  let score = 1;
  if (hasScoreSignal(primaryBodyText)) score += 4;
  if (/(과정명|교육명|강의명|과정 개요|응답인원|응답 수)/i.test(primaryBodyText)) {
    score += 2;
  }
  if (/(강사님께|강사님|강의교안|사전\/사후 설문|사전 설문|사후 설문|raw\s*data|rawdata)/i.test(combined)) {
    score += 1;
  }
  if (hasScoreSignal(subject) || hasScoreSignal(snippet)) score += 1;
  return score;
}

function parseDateInput(value: string | null | undefined): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    const [, year, month, day] = match;
    return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 0, 0, 0));
  }
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatGmailDate(date: Date): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yyyy}/${mm}/${dd}`;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function buildMonthlyWindows(startDate: Date, endDate: Date): Array<{ start: Date; endExclusive: Date }> {
  const windows: Array<{ start: Date; endExclusive: Date }> = [];
  let cursor = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), 1));
  const finalEndExclusive = addDays(endDate, 1);

  while (cursor < finalEndExclusive) {
    const monthStart = new Date(cursor);
    const nextMonth = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    const start = monthStart < startDate ? startDate : monthStart;
    const endExclusive = nextMonth < finalEndExclusive ? nextMonth : finalEndExclusive;
    if (start < endExclusive) {
      windows.push({ start, endExclusive });
    }
    cursor = nextMonth;
  }

  return windows;
}

async function gmailGet<T>(
  accessToken: string,
  path: string,
  params: Record<string, string> = {},
  options: GoogleApiRequestOptions = {}
): Promise<T> {
  return googleApiGet<T>(accessToken, GMAIL_API_BASE, path, params, options);
}

export async function collectSatisfactionFromGmail(options?: {
  query?: string;
  maxPages?: number;
  pageSize?: number;
  checkpoint?: SatisfactionGmailCheckpoint | null;
  startDate?: string;
  endDate?: string;
  detailConcurrency?: number;
  listRequestTimeoutMs?: number;
  detailRequestTimeoutMs?: number;
}): Promise<SatisfactionGmailCollectResult> {
  const { accountEmail } = getGoogleUserOAuthEnv();
  const accessToken = await exchangeGoogleUserAccessToken();

  const keywordQuery =
    options?.query ??
    '("종합 평균 만족도" OR "전체 만족도" OR "강의 만족도" OR "강사 만족도" OR "설문평가 결과" OR "학습자 종합 설문 결과" OR "만족도 결과 전달" OR "만족도 조사 결과" OR "만족도 결과 공유" OR "전체 만족도 송부" OR "만족도 정리" OR "사전 설문" OR "사후 설문" OR "사전/사후 설문" OR "Raw Data" OR "raw data")';
  const query =
    `in:anywhere from:day1company.co.kr ${keywordQuery}`.trim();
  const maxPages = options?.maxPages ?? 5;
  const pageSize = Math.min(options?.pageSize ?? 50, 100);
  const detailConcurrency = Math.max(1, Math.min(options?.detailConcurrency ?? 8, 20));
  const listRequestTimeoutMs = options?.listRequestTimeoutMs ?? 10_000;
  const detailRequestTimeoutMs = options?.detailRequestTimeoutMs ?? 15_000;
  const checkpoint = options?.checkpoint ?? null;
  const startDate = parseDateInput(options?.startDate);
  const endDate = parseDateInput(options?.endDate);
  const windows =
    startDate && endDate && startDate <= endDate
      ? buildMonthlyWindows(startDate, endDate)
      : [];
  const isIncremental = windows.length === 0 && Boolean(checkpoint?.lastInternalDateMs);

  const threadIds = new Set<string>();
  const dateWindows = windows.length > 0 ? windows : [null];

  for (const window of dateWindows) {
    let pageToken: string | undefined;
    let dateClause = "";
    if (window) {
      dateClause = ` after:${formatGmailDate(window.start)} before:${formatGmailDate(window.endExclusive)}`;
    } else if (checkpoint?.lastInternalDateMs) {
      const ms = Number.parseInt(checkpoint.lastInternalDateMs, 10);
      if (Number.isFinite(ms) && ms > 0) {
        dateClause = ` after:${Math.floor(ms / 1000)}`;
      }
    }

    for (let page = 0; page < maxPages; page += 1) {
      const data = await gmailGet<GmailThreadListResponse>(
        accessToken,
        "/users/me/threads",
        {
          q: `${query}${dateClause}`.trim(),
          maxResults: String(pageSize),
          ...(pageToken ? { pageToken } : {}),
        },
        { timeoutMs: listRequestTimeoutMs }
      );
      for (const thread of data.threads ?? []) {
        threadIds.add(thread.id);
      }
      if (!data.nextPageToken) break;
      pageToken = data.nextPageToken;
    }
  }

  const allThreadIds = [...threadIds];
  const threads: SatisfactionGmailThread[] = [];
  for (let index = 0; index < allThreadIds.length; index += detailConcurrency) {
    const batch = allThreadIds.slice(index, index + detailConcurrency);
    const details = await Promise.all(
      batch.map(async (threadId) => {
        const detail = await gmailGet<GmailThreadGetResponse>(
          accessToken,
          `/users/me/threads/${encodeURIComponent(threadId)}`,
          { format: "full" },
          { timeoutMs: detailRequestTimeoutMs }
        );
        let chosenMessage: GmailMessage | null = null;
        let bestScore = 0;
        for (const message of [...(detail.messages ?? [])].reverse()) {
          const subject = normalizeTextForMatch(
            findHeader(message.payload?.headers, "Subject")
          );
          const snippet = normalizeTextForMatch(message.snippet ?? null);
          if (
            SATISFACTION_NEGATIVE_SUBJECT_PATTERN.test(subject) &&
            !SATISFACTION_POSITIVE_SIGNAL_PATTERN.test(subject) &&
            !SATISFACTION_POSITIVE_SIGNAL_PATTERN.test(snippet)
          ) {
            continue;
          }
          const signalScore = getSatisfactionSignalScore(message);
          if (signalScore > bestScore) {
            bestScore = signalScore;
            chosenMessage = message;
          }
        }
        if (!chosenMessage || bestScore < SATISFACTION_MIN_SIGNAL_SCORE) {
          return null;
        }

        const headers = chosenMessage.payload?.headers;
        const bodyText = extractPrimaryBodyText(extractBodyText(chosenMessage));

        return {
          threadId,
          messageId: chosenMessage.id ?? null,
          subject: findHeader(headers, "Subject"),
          from: findHeader(headers, "From"),
          to: findHeader(headers, "To"),
          cc: findHeader(headers, "Cc"),
          sentAt: findHeader(headers, "Date"),
          snippet: chosenMessage.snippet ?? null,
          bodyText: bodyText?.slice(0, 15000) ?? null,
        } satisfies SatisfactionGmailThread;
      })
    );
    for (const detail of details) {
      if (detail) {
        threads.push(detail);
      }
    }
  }

  return {
    sourceKey: GMAIL_SATISFACTION_SOURCE_KEY,
    query,
    accountEmail,
    threads,
    incremental: isIncremental,
  };
}
