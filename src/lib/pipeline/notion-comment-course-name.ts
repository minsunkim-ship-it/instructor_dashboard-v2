import { sanitizeCourseNameCandidate } from "./course-id-fallback.ts";

const NOTION_COMMENT_PATTERN =
  /^\[Notion comment · (.+?) · ([^\]]+)\] (.+)$/u;
const LEADING_BULLET_PATTERN = /^[•◦▪‣\-]\s*/u;
const TITLE_STOP_PATTERNS = [
  /\s+교육 준비에/u,
  /\s+강의 준비에/u,
  /\s+수업 준비에/u,
  /\s+교육 준비/u,
  /\s+강의 준비/u,
  /\s+교안 논의/u,
  /\s+교안 피드백/u,
  /\s+커리큘럼 논의/u,
  /\s+커리큘럼 피드백/u,
];

interface ParsedNotionCommentCourseName {
  author: string;
  observedAt: string | null;
  body: string;
}

function normalizeText(value: string | null | undefined): string | null {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  return normalized || null;
}

export function isNotionCommentCourseName(value: string | null | undefined): boolean {
  const normalized = normalizeText(value);
  return normalized ? NOTION_COMMENT_PATTERN.test(normalized) : false;
}

function parseNotionCommentCourseName(
  value: string | null | undefined
): ParsedNotionCommentCourseName | null {
  const normalized = normalizeText(value);
  if (!normalized) return null;

  const match = normalized.match(NOTION_COMMENT_PATTERN);
  if (!match) return null;

  return {
    author: match[1]!.trim(),
    observedAt:
      /^\d{4}-\d{2}-\d{2}$/.test(match[2] ?? "") ? match[2]!.trim() : null,
    body: match[3]!.trim(),
  };
}

function splitNotionCommentBody(body: string): string[] {
  return body
    .split(" / ")
    .map((segment) => normalizeText(segment))
    .filter((segment): segment is string => Boolean(segment));
}

function stripLeadingBullet(value: string): string {
  return value.replace(LEADING_BULLET_PATTERN, "").trim();
}

function extractCourseNameFromSegment(value: string): string | null {
  const stripped = stripLeadingBullet(value);
  if (!stripped || stripped.startsWith("[")) return null;

  for (const pattern of TITLE_STOP_PATTERNS) {
    const match = stripped.match(pattern);
    const endIndex = match?.index ?? -1;
    if (endIndex <= 0) continue;

    const candidate =
      sanitizeCourseNameCandidate(stripped.slice(0, endIndex).trim()) ??
      normalizeText(stripped.slice(0, endIndex));
    if (candidate) return candidate;
  }

  return null;
}

export function sanitizeTeachingHistoryCourseName(
  value: string | null | undefined
): string | null {
  const parsed = parseNotionCommentCourseName(value);
  if (!parsed) return normalizeText(value);

  for (const segment of splitNotionCommentBody(parsed.body)) {
    const recovered = extractCourseNameFromSegment(segment);
    if (recovered) return recovered;
  }

  return null;
}

export function extractNotionCommentMemoLinesFromCourseName(
  value: string | null | undefined
): string[] {
  const parsed = parseNotionCommentCourseName(value);
  if (!parsed) return [];

  const prefix = parsed.observedAt
    ? `[Notion comment · ${parsed.author} · ${parsed.observedAt}]`
    : `[Notion comment · ${parsed.author} · unknown]`;

  return splitNotionCommentBody(parsed.body).map((segment) => `${prefix} ${segment}`);
}
