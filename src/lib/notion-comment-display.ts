function normalizeComparableText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitKeyQuestionSegments(keyQuestion: string): string[] {
  const normalized = keyQuestion
    .replace(
      /^(?:검토 큐 human_followups 원문 \d+건 요약:|검토 큐 요약:|확인 포인트:)\s*/u,
      ""
    )
    .trim();
  if (!normalized) return [];

  return normalized
    .split(/\s\/\s/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function stripThemeLabel(segment: string): string {
  const separatorIndex = segment.indexOf(":");
  if (separatorIndex < 0) return segment.trim();
  return segment.slice(separatorIndex + 1).trim();
}

function isCoveredByNotionComment(
  segment: string,
  notionCommentTexts: string[]
): boolean {
  const comparableSegment = normalizeComparableText(stripThemeLabel(segment));
  if (comparableSegment.length < 16) return false;

  return notionCommentTexts.some((text) => {
    const comparableText = normalizeComparableText(text);
    if (!comparableText) return false;
    return (
      comparableText.includes(comparableSegment) ||
      comparableSegment.includes(comparableText)
    );
  });
}

export function dedupeKeyQuestionAgainstNotionComments(
  keyQuestion: string | null,
  notionCommentTexts: string[]
): string | null {
  const trimmedQuestion = keyQuestion?.trim() ?? "";
  if (!trimmedQuestion) return null;

  const normalizedCommentTexts = notionCommentTexts
    .map((text) => text.trim())
    .filter(Boolean);
  if (normalizedCommentTexts.length === 0) {
    return trimmedQuestion;
  }

  const segments = splitKeyQuestionSegments(trimmedQuestion);
  if (segments.length === 0) {
    return trimmedQuestion;
  }

  const visibleSegments = segments.filter(
    (segment) => !isCoveredByNotionComment(segment, normalizedCommentTexts)
  );

  if (visibleSegments.length === segments.length) {
    return trimmedQuestion;
  }

  if (visibleSegments.length === 0) {
    return null;
  }

  return `확인 포인트: ${visibleSegments.join(" / ")}`;
}
