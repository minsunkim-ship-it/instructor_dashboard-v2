export interface ParsedContractTimestamp {
  raw: string | null;
  recordedAt: Date | null;
  yearHint: number | null;
}

export interface ParsedContractSchedule {
  raw: string | null;
  dates: Date[];
  startDate: Date | null;
  endDate: Date | null;
}

function normalizeRaw(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function buildDate(year: number, month: number, day: number): Date | null {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }
  if (year < 1900 || year > 2100) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;

  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime())) return null;

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return date;
}

function normalizeTwoDigitYear(year: number): number {
  if (year >= 0 && year <= 69) return 2000 + year;
  if (year >= 70 && year <= 99) return 1900 + year;
  return year;
}

function overlaps(
  start: number,
  end: number,
  ranges: Array<{ start: number; end: number }>
): boolean {
  return ranges.some((range) => start < range.end && end > range.start);
}

function pushMatch(
  target: Array<{ index: number; date: Date; start: number; end: number }>,
  occupied: Array<{ start: number; end: number }>,
  start: number,
  end: number,
  date: Date | null
) {
  if (!date) return;
  if (overlaps(start, end, occupied)) return;
  occupied.push({ start, end });
  target.push({ index: start, date, start, end });
}

export function parseContractTimestamp(raw: string | null | undefined): ParsedContractTimestamp {
  const normalized = normalizeRaw(raw);
  if (!normalized) {
    return { raw: null, recordedAt: null, yearHint: null };
  }

  const explicit = normalized.match(
    /(\d{4})\s*(?:년|[./-])\s*(\d{1,2})\s*(?:월|[./-])\s*(\d{1,2})/
  );
  if (explicit) {
    const date = buildDate(+explicit[1], +explicit[2], +explicit[3]);
    return {
      raw: normalized,
      recordedAt: date,
      yearHint: date?.getUTCFullYear() ?? null,
    };
  }

  const short = normalized.match(
    /(?<![\d./-])(\d{2})\s*(?:년|[./-])\s*(\d{1,2})\s*(?:월|[./-])\s*(\d{1,2})/
  );
  if (short) {
    const date = buildDate(
      normalizeTwoDigitYear(+short[1]),
      +short[2],
      +short[3]
    );
    return {
      raw: normalized,
      recordedAt: date,
      yearHint: date?.getUTCFullYear() ?? null,
    };
  }

  return { raw: normalized, recordedAt: null, yearHint: null };
}

export function extractDatesFromContractSchedule(
  raw: string | null | undefined,
  defaultYear: number | null = null
): Date[] {
  const text = normalizeRaw(raw);
  if (!text) return [];

  const found: Array<{ index: number; date: Date; start: number; end: number }> = [];
  const occupied: Array<{ start: number; end: number }> = [];

  const fourDigitRe =
    /(\d{4})\s*(?:년|[./-])\s*(\d{1,2})\s*(?:월|[./-])\s*(\d{1,2})\s*(?:일)?/g;
  let match: RegExpExecArray | null;
  while ((match = fourDigitRe.exec(text)) !== null) {
    pushMatch(
      found,
      occupied,
      match.index,
      match.index + match[0].length,
      buildDate(+match[1], +match[2], +match[3])
    );
  }

  const twoDigitRe =
    /(?<![\d./-])(\d{2})\s*(?:년|[./-])\s*(\d{1,2})\s*(?:월|[./-])\s*(\d{1,2})\s*(?:일)?/g;
  while ((match = twoDigitRe.exec(text)) !== null) {
    pushMatch(
      found,
      occupied,
      match.index,
      match.index + match[0].length,
      buildDate(
        normalizeTwoDigitYear(+match[1]),
        +match[2],
        +match[3]
      )
    );
  }

  found.sort((a, b) => a.index - b.index);

  const inferYearAt = (index: number): number | null => {
    let year: number | null = defaultYear;
    for (const item of found) {
      if (item.index >= index) break;
      year = item.date.getUTCFullYear();
    }
    return year;
  };

  const monthDayKoreanRe = /(\d{1,2})\s*월\s*(\d{1,2})\s*일/g;
  while ((match = monthDayKoreanRe.exec(text)) !== null) {
    const start = match.index;
    const end = match.index + match[0].length;
    if (overlaps(start, end, occupied)) continue;
    const year = inferYearAt(start);
    if (!year) continue;
    pushMatch(found, occupied, start, end, buildDate(year, +match[1], +match[2]));
  }

  const monthDayNumericRe =
    /(?<!\d)(\d{1,2})\s*[./-]\s*(\d{1,2})(?=(?:\s*[()])|(?:\s*[,~\-])|(?:\s)|$)/g;
  while ((match = monthDayNumericRe.exec(text)) !== null) {
    const start = match.index;
    const end = match.index + match[0].length;
    if (overlaps(start, end, occupied)) continue;
    const year = inferYearAt(start);
    if (!year) continue;
    pushMatch(found, occupied, start, end, buildDate(year, +match[1], +match[2]));
  }

  found.sort((a, b) => a.index - b.index);
  return found.map((item) => item.date);
}

export function parseContractSchedule(
  raw: string | null | undefined,
  defaultYear: number | null = null
): ParsedContractSchedule {
  const normalized = normalizeRaw(raw);
  const dates = extractDatesFromContractSchedule(normalized, defaultYear);

  return {
    raw: normalized,
    dates,
    startDate: dates[0] ?? null,
    endDate: dates[dates.length - 1] ?? null,
  };
}

export function toDateOnlyString(date: Date | null): string | null {
  if (!date) return null;
  return date.toISOString().split("T")[0];
}
