const GOOGLE_LINK_PATTERN = /https?:\/\/(?:drive|docs)\.google\.com\/\S+/giu;
const LINK_LABEL_ONLY_PATTERN =
  /^(?:[*•-]\s*)?(?:(?:계약(?:서)?|계약\s*양식|폴더|문서|파일|자료|드라이브)\s*)?링크\s*:?\s*$/iu;

function normalizeSanitizedLine(line: string): string | null {
  const normalized = line
    .replace(/\(\s*\)/g, " ")
    .replace(/\[\s*\]/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.:;)\]])/g, "$1")
    .replace(/([([])\s+/g, "$1")
    .trim();

  if (!normalized) return null;
  if (!/[0-9A-Za-z가-힣]/u.test(normalized)) return null;
  if (LINK_LABEL_ONLY_PATTERN.test(normalized)) return null;
  return normalized;
}

export function stripGoogleLinks(value: string | null | undefined): string | null {
  if (!value) return null;

  const lines = value
    .split(/\r?\n/)
    .map((line) => normalizeSanitizedLine(line.replace(GOOGLE_LINK_PATTERN, " ")))
    .filter((line): line is string => Boolean(line));

  if (lines.length === 0) return null;
  return lines.join("\n");
}

export function extractDisplayLinesWithoutGoogleLinks(
  ...values: Array<string | null | undefined>
): string[] {
  return values.flatMap((value) => {
    const sanitized = stripGoogleLinks(value);
    if (!sanitized) return [];

    return sanitized
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean);
  });
}
