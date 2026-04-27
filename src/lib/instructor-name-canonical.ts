export interface InstructorNameCanonicalRow {
  id: string;
  name: string;
  createdAt: Date;
}

export function compareInstructorCanonicalPriority(
  left: InstructorNameCanonicalRow,
  right: InstructorNameCanonicalRow
): number {
  const byCreatedAt = left.createdAt.getTime() - right.createdAt.getTime();
  if (byCreatedAt !== 0) return byCreatedAt;
  return left.id.localeCompare(right.id);
}

export function buildCanonicalInstructorByNameMap<
  T extends InstructorNameCanonicalRow,
>(rows: T[]): Map<string, T> {
  const sorted = [...rows].sort((left, right) => {
    const byName = left.name.localeCompare(right.name, "ko");
    if (byName !== 0) return byName;
    return compareInstructorCanonicalPriority(left, right);
  });

  const map = new Map<string, T>();
  for (const row of sorted) {
    if (!map.has(row.name)) {
      map.set(row.name, row);
    }
  }

  return map;
}
