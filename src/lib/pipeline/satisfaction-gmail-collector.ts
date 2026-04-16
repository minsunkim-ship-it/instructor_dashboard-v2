import {
  exchangeGoogleUserAccessToken,
  getGoogleUserOAuthEnv,
  googleApiGet,
} from "@/lib/google-user-oauth";

const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1";

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
  targetAddresses: string[];
  threads: SatisfactionGmailThread[];
  incremental: boolean;
}

export interface SatisfactionGmailTargetCheckpoint {
  targetAddress: string;
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

function looksLikeSatisfactionMessage(message: GmailMessage | undefined): boolean {
  const headers = message?.payload?.headers;
  const subject = normalizeTextForMatch(findHeader(headers, "Subject"));
  const snippet = normalizeTextForMatch(message?.snippet ?? null);
  const bodyText = normalizeTextForMatch(extractBodyText(message));
  const combined = [subject, snippet, bodyText].filter(Boolean).join(" ");

  if (!combined.includes("만족도")) return false;
  return /(결과 공유|결과 전달|조사 결과|설문 결과|만족도 조사)/.test(combined);
}

function getTargetAddresses(): string[] {
  return (process.env.GMAIL_TARGET_ADDRESSES ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
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
  params: Record<string, string> = {}
): Promise<T> {
  return googleApiGet<T>(accessToken, GMAIL_API_BASE, path, params);
}

export async function collectSatisfactionFromGmail(options?: {
  query?: string;
  maxPages?: number;
  pageSize?: number;
  checkpoints?: SatisfactionGmailTargetCheckpoint[];
  startDate?: string;
  endDate?: string;
  detailConcurrency?: number;
}): Promise<SatisfactionGmailCollectResult> {
  const { accountEmail } = getGoogleUserOAuthEnv();
  const targetAddresses = getTargetAddresses();
  const accessToken = await exchangeGoogleUserAccessToken();

  const targetQuery =
    targetAddresses.length > 0
      ? `(${targetAddresses
          .map(
            (address) => `(to:${address} OR cc:${address} OR deliveredto:${address})`
          )
          .join(" OR ")})`
      : "";
  const keywordQuery =
    '("만족도 결과 공유" OR "만족도 조사 공유" OR "만족도조사 결과" OR "강의 만족도 결과" OR "설문 결과" OR "만족도 결과")';
  const query =
    options?.query ??
    `in:anywhere from:day1company.co.kr ${targetQuery} ${keywordQuery}`.trim();
  const maxPages = options?.maxPages ?? 5;
  const pageSize = Math.min(options?.pageSize ?? 50, 100);
  const detailConcurrency = Math.max(1, Math.min(options?.detailConcurrency ?? 8, 20));
  const checkpoints = options?.checkpoints ?? [];
  const checkpointMap = new Map(checkpoints.map((cp) => [cp.targetAddress, cp]));
  const startDate = parseDateInput(options?.startDate);
  const endDate = parseDateInput(options?.endDate);
  const windows =
    startDate && endDate && startDate <= endDate
      ? buildMonthlyWindows(startDate, endDate)
      : [];
  const isIncremental = windows.length === 0 && checkpoints.length > 0;

  const threadIds = new Set<string>();
  for (const targetAddress of targetAddresses) {
    const scopedTargetQuery = `(to:${targetAddress} OR cc:${targetAddress} OR deliveredto:${targetAddress})`;
    const dateWindows = windows.length > 0 ? windows : [null];

    for (const window of dateWindows) {
      let pageToken: string | undefined;
      let dateClause = "";
      if (window) {
        dateClause = ` after:${formatGmailDate(window.start)} before:${formatGmailDate(window.endExclusive)}`;
      } else {
        const checkpoint = checkpointMap.get(targetAddress);
        if (checkpoint?.lastInternalDateMs) {
          const ms = Number.parseInt(checkpoint.lastInternalDateMs, 10);
          if (Number.isFinite(ms) && ms > 0) {
            dateClause = ` after:${Math.floor(ms / 1000)}`;
          }
        }
      }

      for (let page = 0; page < maxPages; page += 1) {
        const data = await gmailGet<GmailThreadListResponse>(
          accessToken,
          "/users/me/threads",
          {
            q: `${query} ${scopedTargetQuery}${dateClause}`.trim(),
            maxResults: String(pageSize),
            ...(pageToken ? { pageToken } : {}),
          }
        );
        for (const thread of data.threads ?? []) {
          threadIds.add(thread.id);
        }
        if (!data.nextPageToken) break;
        pageToken = data.nextPageToken;
      }
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
          { format: "full" }
        );
        const chosenMessage =
          [...(detail.messages ?? [])].reverse().find(looksLikeSatisfactionMessage) ??
          detail.messages?.[0];
        if (!chosenMessage) return null;

        const headers = chosenMessage.payload?.headers;
        const bodyText = extractBodyText(chosenMessage);

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
    targetAddresses,
    threads,
    incremental: isIncremental,
  };
}
