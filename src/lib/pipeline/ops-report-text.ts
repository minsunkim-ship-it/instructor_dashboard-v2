const HTML_ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

const INSTRUCTOR_TITLE_PATTERN =
  /(?:강사님|강사|교수님|교수|대표님|대표|실습코치님|실습코치|코치님|코치)/u;
const ROUND_SEGMENT_PATTERN =
  /(?:^|\s)\d+\s*(?:회차|일차|차수)(?:\s*\/\s*\d+\s*(?:회차|일차|차수))*(?:$|\s)/u;
const GENERIC_SEGMENT_PATTERN =
  /(강의\s*내용\s*공유|강의내용\s*공유|내용\s*공유|공유드립니다|공유\s*드립니다|강의요약|시트)/u;
const TOKEN_STOPWORDS = new Set([
  "b2b",
  "강의",
  "내용",
  "공유",
  "공유드립니다",
  "과정",
  "교육",
  "오프라인",
  "온라인",
  "회차",
  "일차",
  "차수",
  "강사",
  "강사님",
  "교수",
  "교수님",
  "대표",
  "대표님",
]);

function decodeHtmlEntities(value: string): string {
  let output = value;
  for (const [entity, decoded] of Object.entries(HTML_ENTITY_MAP)) {
    output = output.split(entity).join(decoded);
  }
  return output;
}

function normalizeText(value: string | null | undefined): string {
  return decodeHtmlEntities(value ?? "")
    .replace(/\*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeComparableText(value: string | null | undefined): string {
  return normalizeText(value).replace(/\s+/g, "").toLowerCase();
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

export function extractSlackLinkLabels(text: string | null | undefined): string[] {
  const raw = text ?? "";
  const labels = Array.from(raw.matchAll(/<[^|>]+\|([^>]+)>/g))
    .map((match) => normalizeText(match[1]))
    .filter(Boolean);
  return dedupeStrings(labels);
}

function splitMentionNames(value: string): string[] {
  return value
    .split(/\s*(?:\/|,|·|및)\s*/u)
    .map((item) => normalizeText(item))
    .filter(Boolean);
}

export function extractInstructorMentionsFromOpsReportText(
  text: string | null | undefined
): string[] {
  const titles = extractSlackLinkLabels(text);
  const searchSpace = titles.length > 0 ? titles : [normalizeText(text)];
  const mentions: string[] = [];

  for (const title of searchSpace) {
    const regex =
      /([가-힣]{2,6}(?:\s*[가-힣]{1,6})?(?:\s*(?:\/|,|·|및)\s*[가-힣]{2,6}(?:\s*[가-힣]{1,6})?)*)\s*(?:강사님|강사|교수님|교수|대표님|대표|실습코치님|실습코치|코치님|코치)/gu;
    for (const match of title.matchAll(regex)) {
      mentions.push(...splitMentionNames(match[1] ?? ""));
    }
  }

  return dedupeStrings(mentions);
}

export interface OpsReportCourseContext {
  title: string;
  fullTitle: string;
  companyName: string | null;
  courseName: string | null;
  tokens: string[];
}

function tokenizeComparableText(value: string): string[] {
  const tokens = normalizeText(value)
    .match(/[A-Za-z]+|[가-힣0-9]+/gu) ?? [];
  return Array.from(
    new Set(
      tokens
        .map((token) => token.toLowerCase())
        .filter((token) => token.length >= 2)
        .filter((token) => !TOKEN_STOPWORDS.has(token))
        .filter((token) => !/^\d+$/.test(token))
    )
  );
}

function cleanupSegment(value: string): string | null {
  const cleaned = normalizeText(value)
    .replace(/^\(?b2b\)?/iu, "")
    .replace(GENERIC_SEGMENT_PATTERN, "")
    .trim();
  if (!cleaned) return null;
  if (ROUND_SEGMENT_PATTERN.test(cleaned)) return null;
  return cleaned;
}

function segmentContainsInstructor(value: string): boolean {
  return INSTRUCTOR_TITLE_PATTERN.test(value);
}

export function extractOpsReportCourseContext(
  text: string | null | undefined
): OpsReportCourseContext | null {
  const titles = extractSlackLinkLabels(text);
  const searchSpace = titles.length > 0 ? titles : [normalizeText(text)];

  for (const title of searchSpace) {
    const segments = title
      .split("_")
      .map((segment) => normalizeText(segment))
      .filter(Boolean);
    if (segments.length === 0) continue;

    const instructorIndex = segments.findIndex(
      (segment) => segmentContainsInstructor(segment) || GENERIC_SEGMENT_PATTERN.test(segment)
    );
    const prefix =
      instructorIndex >= 0 ? segments.slice(0, instructorIndex) : segments;
    const cleanedPrefix = prefix
      .map(cleanupSegment)
      .filter((segment): segment is string => Boolean(segment));

    if (cleanedPrefix.length === 0) continue;

    const fullTitle = cleanedPrefix.join(" ").trim();
    const companyName = cleanedPrefix.length >= 2 ? cleanedPrefix[0] : null;
    const courseName =
      cleanedPrefix.length >= 2
        ? cleanedPrefix.slice(1).join(" ").trim()
        : cleanedPrefix[0];
    const tokens = tokenizeComparableText(fullTitle);

    if (!fullTitle || tokens.length === 0) continue;

    return {
      title,
      fullTitle,
      companyName,
      courseName,
      tokens,
    };
  }

  return null;
}

export function courseContextOverlapScore(
  left: OpsReportCourseContext | null,
  comparableText: string | null | undefined,
  companyName?: string | null
): number {
  if (!left || !comparableText) return 0;

  const rightTokens = tokenizeComparableText(comparableText);
  if (left.tokens.length === 0 || rightTokens.length === 0) return 0;

  const rightSet = new Set(rightTokens);
  let intersection = 0;
  for (const token of left.tokens) {
    if (rightSet.has(token)) intersection += 1;
  }

  let score = (intersection / Math.min(left.tokens.length, rightTokens.length)) * 10;
  if (
    companyName &&
    left.companyName &&
    normalizeComparableText(companyName) === normalizeComparableText(left.companyName)
  ) {
    score += 2;
  }

  return score;
}
