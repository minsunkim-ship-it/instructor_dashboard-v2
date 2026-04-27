export function parseAmountFromFeeNote(feeNote: string): number | null {
  const hasFeeContext = /(강사료|단가|기본|시급|시간당|페이|fee)/iu.test(feeNote);

  const manwonMatch = feeNote.match(/(\d+(?:\.\d+)?)\s*만\s*원?/);
  if (manwonMatch) {
    return Math.round(parseFloat(manwonMatch[1]) * 10000);
  }

  if (!hasFeeContext) {
    return null;
  }

  const numMatch = feeNote.match(/(\d{1,3}(?:,?\d{3})+|\d+)\s*원?/);
  if (numMatch) {
    const cleaned = numMatch[1].replace(/,/g, "");
    const val = parseInt(cleaned, 10);
    if (!isNaN(val) && val > 0) return val;
  }

  return null;
}
