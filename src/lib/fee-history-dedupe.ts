export interface FeeHistoryDedupableItem {
  effectiveDate: Date | null;
  effectiveLabel: string | null;
  amount: number | null;
  feeKind: string;
  context: string | null;
  sourceType: string;
  isCurrent: boolean;
  isSpecialAmount: boolean;
}

export function dedupeFeeHistoryItems<T extends FeeHistoryDedupableItem>(
  items: T[]
): T[] {
  const deduped = new Map<string, T>();

  for (const item of items) {
    const key = item.isSpecialAmount
      ? [
          item.effectiveDate?.toISOString().split("T")[0] ?? "",
          item.effectiveLabel ?? "",
          item.feeKind,
          item.context ?? "",
          item.sourceType,
          "1",
        ].join("||")
      : [
          item.effectiveDate?.toISOString().split("T")[0] ?? "",
          item.effectiveLabel ?? "",
          item.amount ?? "",
          item.feeKind,
          item.context ?? "",
          item.sourceType,
          "0",
        ].join("||");

    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, item);
      continue;
    }

    if (item.isSpecialAmount) {
      const existingAmount = existing.amount ?? 0;
      const nextAmount = item.amount ?? 0;
      if (nextAmount > existingAmount) {
        deduped.set(key, item);
      }
      continue;
    }

    if (!existing.isCurrent && item.isCurrent) {
      deduped.set(key, item);
    }
  }

  return Array.from(deduped.values()).sort((a, b) => {
    const aDate = a.effectiveDate?.toISOString().split("T")[0] ?? "";
    const bDate = b.effectiveDate?.toISOString().split("T")[0] ?? "";
    return bDate.localeCompare(aDate);
  });
}
