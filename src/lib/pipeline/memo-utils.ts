const NOTION_COMMENT_PREFIX_PATTERN = /^\[Notion comment · .*?\] (.+)$/;

function extractComparableMemoText(line: string): string {
  const match = line.match(NOTION_COMMENT_PREFIX_PATTERN);
  return match?.[1]?.trim() || line;
}

export function mergeMemoNonDestructive(
  existingMemo: string | null,
  incomingMemo: string | null
): string | null {
  const existingLines = existingMemo
    ? existingMemo.split("\n").map((line) => line.trim()).filter(Boolean)
    : [];
  const incomingLines = incomingMemo
    ? incomingMemo.split("\n").map((line) => line.trim()).filter(Boolean)
    : [];

  if (incomingLines.length === 0) return existingMemo;
  if (existingLines.length === 0) return incomingLines.join("\n");

  const merged = [...existingLines];
  const seen = new Set(existingLines);
  const comparableIndexByText = new Map<string, number>();

  for (const [index, line] of merged.entries()) {
    const comparable = extractComparableMemoText(line);
    if (!comparableIndexByText.has(comparable)) {
      comparableIndexByText.set(comparable, index);
    }
  }

  for (const line of incomingLines) {
    if (seen.has(line)) continue;

    const comparable = extractComparableMemoText(line);
    const existingIndex = comparableIndexByText.get(comparable);
    if (
      existingIndex !== undefined &&
      merged[existingIndex] === comparable &&
      comparable !== line
    ) {
      seen.delete(merged[existingIndex]);
      merged[existingIndex] = line;
      seen.add(line);
      continue;
    }

    seen.add(line);
    comparableIndexByText.set(comparable, merged.length);
    merged.push(line);
  }

  return merged.length > 0 ? merged.join("\n") : null;
}
