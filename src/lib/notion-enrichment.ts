import { getEnvValue } from "@/lib/local-env";
import { mergeMemoNonDestructive } from "@/lib/pipeline/memo-utils";
import { acceptOpsMemo } from "@/lib/pipeline/ops-notes-loader";

const NOTION_API_VERSION = "2022-06-28";
const NOTION_BASE_URL = "https://api.notion.com/v1";
const NOTION_REQUEST_TIMEOUT_MS = 60_000;
let notionCommentCapabilityEnabled: boolean | null = null;
const BLOCK_TEXT_EXCLUDED_PAGE_IDS = new Set([
  "3a64576d-6ffa-8362-8f6d-815166f48f08", // 김인섭
]);
const MEMO_SANITIZED_PAGE_IDS = new Set([
  "3a64576d-6ffa-8362-8f6d-815166f48f08", // 김인섭
]);

type NotionListResponse<T> = {
  results: T[];
  has_more: boolean;
  next_cursor: string | null;
};

type NotionComment = {
  id?: string;
  rich_text?: Array<{ plain_text?: string }>;
  created_time?: string;
  created_by?: {
    id?: string;
    name?: string | null;
  };
};

type NotionBlock = {
  id?: string;
  type?: string;
  has_children?: boolean;
  [key: string]: unknown;
};

type NotionPage = {
  properties?: Record<string, unknown>;
  title?: Array<{ plain_text?: string }> | string;
};

export interface NotionMemoEnrichmentResult {
  mergedMemo: string | null;
  incomingMemo: string | null;
  updated: boolean;
  commentCapability: "enabled" | "disabled" | "unknown";
  pageCommentCount: number;
  blockCommentCount: number;
  blockTextCount: number;
  incomingLineCount: number;
}

function getNotionHeaders(): HeadersInit {
  const apiKey = getEnvValue("NOTION_API_KEY");
  if (!apiKey) {
    throw new Error("NOTION_API_KEY 환경변수가 설정되지 않았습니다.");
  }

  return {
    Authorization: `Bearer ${apiKey}`,
    "Notion-Version": NOTION_API_VERSION,
    "Content-Type": "application/json",
  };
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function extractPlainTextArray(
  value: unknown
): string {
  if (!Array.isArray(value)) return "";

  return value
    .map((item) =>
      item && typeof item === "object" && "plain_text" in item
        ? typeof item.plain_text === "string"
          ? item.plain_text
          : ""
        : ""
    )
    .join("");
}

function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => normalizeText(line))
    .filter(Boolean);
}

function sanitizeExistingMemoForPage(
  existingMemo: string | null,
  notionPageId: string
): string | null {
  if (!existingMemo) return existingMemo;
  if (!MEMO_SANITIZED_PAGE_IDS.has(notionPageId)) return existingMemo;

  const keptLines = existingMemo
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(
      (line) =>
        line.startsWith("•") ||
        line.startsWith("보조 ")
    );

  return keptLines.length > 0 ? keptLines.join("\n") : null;
}

function formatNotionCommentAuthor(comment: NotionComment): string {
  const name = typeof comment.created_by?.name === "string"
    ? normalizeText(comment.created_by.name)
    : "";
  if (name) return name;

  const id = typeof comment.created_by?.id === "string"
    ? comment.created_by.id.trim()
    : "";
  if (id) return `user:${id}`;

  return "user:unknown";
}

function formatNotionCommentDate(comment: NotionComment): string {
  const createdTime = typeof comment.created_time === "string"
    ? comment.created_time
    : "";
  if (!createdTime) return "unknown-date";

  const parsed = new Date(createdTime);
  if (Number.isNaN(parsed.getTime())) return "unknown-date";
  return parsed.toISOString().slice(0, 10);
}

export function extractMemoLinesFromNotionBlock(block: NotionBlock): string[] {
  const type = typeof block.type === "string" ? block.type : null;
  if (!type) return [];

  const payload =
    block[type] && typeof block[type] === "object" ? (block[type] as Record<string, unknown>) : null;
  if (!payload) return [];

  const candidates: string[] = [];

  const richText = extractPlainTextArray(payload.rich_text);
  if (richText) candidates.push(richText);

  const titleText = extractPlainTextArray(payload.title);
  if (titleText) candidates.push(titleText);

  const captionText = extractPlainTextArray(payload.caption);
  if (captionText) candidates.push(captionText);

  if (Array.isArray(payload.cells)) {
    for (const cell of payload.cells) {
      const cellText = extractPlainTextArray(cell);
      if (cellText) candidates.push(cellText);
    }
  }

  if (typeof payload.title === "string" && normalizeText(payload.title)) {
    candidates.push(normalizeText(payload.title));
  }

  return candidates.flatMap(splitLines);
}

export function extractMemoLinesFromNotionComment(comment: NotionComment): string[] {
  const author = formatNotionCommentAuthor(comment);
  const date = formatNotionCommentDate(comment);
  const body = splitLines(extractPlainTextArray(comment.rich_text)).join(" / ");
  if (!body) return [];
  return [`[Notion comment · ${author} · ${date}] ${body}`];
}

export function extractMemoLinesFromNotionPage(page: NotionPage): string[] {
  const candidates: string[] = [];

  const directTitle = extractPlainTextArray(page.title);
  if (directTitle) candidates.push(directTitle);
  if (typeof page.title === "string" && normalizeText(page.title)) {
    candidates.push(normalizeText(page.title));
  }

  const properties =
    page.properties &&
    typeof page.properties === "object" &&
    !Array.isArray(page.properties)
      ? page.properties
      : null;

  if (properties) {
    for (const prop of Object.values(properties)) {
      if (!prop || typeof prop !== "object" || Array.isArray(prop)) continue;
      const property = prop as Record<string, unknown>;
      if (property.type !== "title") continue;

      const titleText = extractPlainTextArray(property.title);
      if (titleText) candidates.push(titleText);

      if (typeof property.title === "string" && normalizeText(property.title)) {
        candidates.push(normalizeText(property.title));
      }
    }
  }

  return [...new Set(candidates.flatMap(splitLines))];
}

function buildMemoCandidate(lines: string[]): string | null {
  const deduped: string[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const normalized = normalizeText(line);
    if (!normalized) continue;
    if (!acceptOpsMemo(normalized)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(normalized);
  }

  return deduped.length > 0 ? deduped.join("\n") : null;
}

async function fetchPaginated<T>(
  url: URL,
  headers: HeadersInit
): Promise<T[]> {
  const results: T[] = [];
  let nextCursor: string | null = null;

  do {
    if (nextCursor) {
      url.searchParams.set("start_cursor", nextCursor);
    } else {
      url.searchParams.delete("start_cursor");
    }

    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(NOTION_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(
        `Notion API 호출 실패: ${response.status} ${response.statusText} — ${message}`
      );
    }

    const data = (await response.json()) as NotionListResponse<T>;
    results.push(...data.results);
    nextCursor = data.has_more ? data.next_cursor : null;
  } while (nextCursor);

  return results;
}

async function listCommentsForBlock(
  blockId: string,
  headers: HeadersInit
): Promise<NotionComment[]> {
  if (notionCommentCapabilityEnabled === false) {
    return [];
  }

  const url = new URL(`${NOTION_BASE_URL}/comments`);
  url.searchParams.set("block_id", blockId);
  url.searchParams.set("page_size", "100");
  try {
    const comments = await fetchPaginated<NotionComment>(url, headers);
    notionCommentCapabilityEnabled = true;
    return comments;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("403")) {
      notionCommentCapabilityEnabled = false;
      return [];
    }
    throw error;
  }
}

async function listBlockChildren(
  blockId: string,
  headers: HeadersInit
): Promise<NotionBlock[]> {
  const url = new URL(`${NOTION_BASE_URL}/blocks/${blockId}/children`);
  url.searchParams.set("page_size", "100");
  return fetchPaginated<NotionBlock>(url, headers);
}

async function retrievePage(
  pageId: string,
  headers: HeadersInit
): Promise<NotionPage> {
  const response = await fetch(`${NOTION_BASE_URL}/pages/${pageId}`, {
    headers,
    signal: AbortSignal.timeout(NOTION_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(
      `Notion API 호출 실패: ${response.status} ${response.statusText} — ${message}`
    );
  }

  return (await response.json()) as NotionPage;
}

async function collectMemoLinesFromBlocks(
  blockId: string,
  headers: HeadersInit,
  options?: {
    includeBlockText?: boolean;
  }
): Promise<{
  blockLines: string[];
  blockTextCount: number;
  blockCommentLines: string[];
  blockCommentCount: number;
}> {
  const blockLines: string[] = [];
  const blockCommentLines: string[] = [];
  let blockTextCount = 0;
  let blockCommentCount = 0;
  const includeBlockText = options?.includeBlockText !== false;

  const children = await listBlockChildren(blockId, headers);
  for (const child of children) {
    if (includeBlockText) {
      const extracted = extractMemoLinesFromNotionBlock(child);
      blockLines.push(...extracted);
      if (extracted.length > 0) {
        blockTextCount += extracted.length;
      }
    }

    if (typeof child.id === "string") {
      const childComments = await listCommentsForBlock(child.id, headers);
      const childCommentLines = childComments.flatMap(extractMemoLinesFromNotionComment);
      blockCommentLines.push(...childCommentLines);
      blockCommentCount += childCommentLines.length;
    }

    if (child.has_children && typeof child.id === "string") {
      const nested = await collectMemoLinesFromBlocks(child.id, headers, {
        includeBlockText,
      });
      blockLines.push(...nested.blockLines);
      blockTextCount += nested.blockTextCount;
      blockCommentLines.push(...nested.blockCommentLines);
      blockCommentCount += nested.blockCommentCount;
    }
  }

  return {
    blockLines,
    blockTextCount,
    blockCommentLines,
    blockCommentCount,
  };
}

export async function collectNotionPageContentLines(args: {
  notionPageId: string;
  includePageComments?: boolean;
  includeBlockComments?: boolean;
  includeBlockText?: boolean;
}): Promise<{
  pageTitleLines: string[];
  pageCommentLines: string[];
  pageCommentCount: number;
  blockLines: string[];
  blockTextCount: number;
  blockCommentLines: string[];
  blockCommentCount: number;
}> {
  const headers = getNotionHeaders();
  const includeBlockText =
    args.includeBlockText !== false &&
    !BLOCK_TEXT_EXCLUDED_PAGE_IDS.has(args.notionPageId);

  const [page, pageComments, nested] = await Promise.all([
    retrievePage(args.notionPageId, headers),
    args.includePageComments === false
      ? Promise.resolve([])
      : listCommentsForBlock(args.notionPageId, headers),
    collectMemoLinesFromBlocks(args.notionPageId, headers, {
      includeBlockText,
    }),
  ]);

  const pageTitleLines = extractMemoLinesFromNotionPage(page);
  const pageCommentLines = pageComments.flatMap(extractMemoLinesFromNotionComment);

  return {
    pageTitleLines,
    pageCommentLines,
    pageCommentCount: pageCommentLines.length,
    blockLines: includeBlockText ? nested.blockLines : [],
    blockTextCount: includeBlockText ? nested.blockTextCount : 0,
    blockCommentLines:
      args.includeBlockComments === false ? [] : nested.blockCommentLines,
    blockCommentCount:
      args.includeBlockComments === false ? 0 : nested.blockCommentCount,
  };
}

export async function enrichMemoFromNotionPage(args: {
  existingMemo: string | null;
  notionPageId: string;
}): Promise<NotionMemoEnrichmentResult> {
  const sanitizedExistingMemo = sanitizeExistingMemoForPage(
    args.existingMemo,
    args.notionPageId
  );
  const contentLines = await collectNotionPageContentLines({
    notionPageId: args.notionPageId,
  });

  const incomingMemo = buildMemoCandidate([
    ...contentLines.pageTitleLines,
    ...contentLines.pageCommentLines,
    ...contentLines.blockLines,
    ...contentLines.blockCommentLines,
  ]);
  const mergedMemo = mergeMemoNonDestructive(sanitizedExistingMemo, incomingMemo);

  return {
    mergedMemo,
    incomingMemo,
    updated: mergedMemo !== args.existingMemo,
    commentCapability:
      notionCommentCapabilityEnabled === null
        ? "unknown"
        : notionCommentCapabilityEnabled
          ? "enabled"
          : "disabled",
    pageCommentCount: contentLines.pageCommentCount,
    blockCommentCount: contentLines.blockCommentCount,
    blockTextCount: contentLines.blockTextCount,
    incomingLineCount: incomingMemo ? incomingMemo.split("\n").length : 0,
  };
}
