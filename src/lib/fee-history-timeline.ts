export function getCurrentFeeTimelineIndex<
  T extends {
    is_current: boolean;
  },
>(timeline: T[]): number {
  if (timeline.length === 0) return -1;

  const currentIndex = timeline.findIndex((item) => item.is_current);
  return currentIndex >= 0 ? currentIndex : timeline.length - 1;
}
