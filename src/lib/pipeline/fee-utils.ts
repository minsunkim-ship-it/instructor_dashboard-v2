/**
 * fee_note에서 "기본" 라벨에 연결된 시간당 단가만 기본 단가 후보로 추출.
 * docs/04 §12-1: "기본 25만 / 심화 35만 / 특강 55만" → 25만(=250000)만 인정.
 * "기본 25만", "기본 250,000원", "기본: 250000" 같은 표기도 허용.
 * 실패 시 null.
 */
export function parseBaseFeeFromFeeNote(feeNote: string | null): number | null {
  if (!feeNote) return null;

  const labelMatch = feeNote.match(/기본[\s:]*([\d,\.]+)\s*(만\s*원?|원)?/);
  if (!labelMatch) return null;

  const numStr = labelMatch[1].replace(/,/g, "");
  const unit = labelMatch[2] ?? "";
  const num = parseFloat(numStr);
  if (!Number.isFinite(num) || num <= 0) return null;

  if (unit.startsWith("만")) {
    return Math.round(num * 10000);
  }

  if (!unit && num < 1000) {
    return Math.round(num * 10000);
  }

  return Math.round(num);
}
