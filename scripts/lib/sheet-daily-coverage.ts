export type SheetCoverageSourceType =
  | "contract_sheet"
  | "instructor_dispatch_sheet";

export type SheetCoverageDayStatus =
  | "ok"
  | "empty"
  | "missing_in_db"
  | "date_mismatch"
  | "duplicate_in_db"
  | "mixed";

export interface SheetCoverageCollectedRow {
  sourceType: SheetCoverageSourceType;
  sourceLabel: string;
  spreadsheetId: string;
  worksheetGid: number;
  rowNumber: number;
  instructorName: string | null;
  companyName: string | null;
  courseName: string | null;
  dateLabel: string | null;
  parsedDates: string[];
  startDate: string | null;
  endDate: string | null;
}

export interface SheetCoverageDbRow {
  id: string;
  sourceIdentity: string | null;
  legacyIdentity: string | null;
  startDate: string | null;
  endDate: string | null;
  dateLabel: string | null;
}

export interface SheetCoverageIssueSample {
  sourceIdentity: string;
  sourceLabel: string;
  instructorName: string | null;
  companyName: string | null;
  courseName: string | null;
  dateLabel: string | null;
  parsedDates: string[];
  undatedCategory: string | null;
  dbIds: string[];
  dbStartDate: string | null;
  dbEndDate: string | null;
  dbDateLabel: string | null;
}

export interface SheetCoverageDayRow {
  date: string;
  status: SheetCoverageDayStatus;
  collectedRows: number;
  dbRowsFound: number;
  exactDateMatch: number;
  legacyDbMatch: number;
  missingInDb: number;
  dateMismatch: number;
  duplicateInDb: number;
  sampleMissing: SheetCoverageIssueSample[];
  sampleDateMismatch: SheetCoverageIssueSample[];
  sampleDuplicate: SheetCoverageIssueSample[];
}

export interface SheetCoverageSummary {
  totalCollectedRows: number;
  rowsWithAnyParsedDates: number;
  rowsInRange: number;
  blankDateLabelRows: number;
  rowsWithoutParsedDates: number;
  rowsWithoutParsedDatesNotApplicable: number;
  rowsWithoutParsedDatesSummaryOrMeta: number;
  rowsWithoutParsedDatesContextDependent: number;
  rowsWithoutParsedDatesUnknown: number;
  rowsMissingInDb: number;
  rowsDateMismatch: number;
  rowsDuplicateInDb: number;
  rowsMatchedByLegacyIdentity: number;
}

export interface SheetCoverageReport {
  rows: SheetCoverageDayRow[];
  summary: SheetCoverageSummary;
  sampleUndatedRows: SheetCoverageIssueSample[];
  sampleBlankDateLabelRows: SheetCoverageIssueSample[];
}

interface CoverageMatch {
  kind: "exact_match" | "legacy_match" | "missing" | "date_mismatch" | "duplicate";
  dbRows: SheetCoverageDbRow[];
}

type UndatedCategory =
  | "not_applicable"
  | "summary_or_meta"
  | "context_dependent_date"
  | "unknown";

function trimToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function parseDateOnly(value: string | undefined, label: string): Date {
  if (!value) {
    throw new Error(`${label} is required (YYYY-MM-DD)`);
  }

  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new Error(`${label} must be YYYY-MM-DD`);
  }

  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 0, 0, 0));
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${label} must be a valid date`);
  }

  return date;
}

export function formatDateOnly(date: Date): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

export function enumerateDates(startDate: Date, endDate: Date): string[] {
  const dates: string[] = [];
  for (let current = startDate; current <= endDate; current = addDays(current, 1)) {
    dates.push(formatDateOnly(current));
  }
  return dates;
}

export function toDateOnly(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

export function buildSheetSourceIdentity(
  spreadsheetId: string,
  worksheetGid: number,
  rowNumber: number
): string {
  return `${spreadsheetId}::${worksheetGid}::${rowNumber}`;
}

export function buildSheetLegacyIdentity(
  spreadsheetId: string,
  rowNumber: number
): string {
  return `${spreadsheetId}::${rowNumber}`;
}

function normalizeParsedDates(parsedDates: string[]): string[] {
  return Array.from(
    new Set(parsedDates.map((value) => value.trim()).filter(Boolean))
  ).sort((a, b) => a.localeCompare(b));
}

function buildIssueSample(
  row: SheetCoverageCollectedRow,
  dbRows: SheetCoverageDbRow[],
  undatedCategory: UndatedCategory | null = null
): SheetCoverageIssueSample {
  return {
    sourceIdentity: buildSheetSourceIdentity(
      row.spreadsheetId,
      row.worksheetGid,
      row.rowNumber
    ),
    sourceLabel: row.sourceLabel,
    instructorName: row.instructorName,
    companyName: row.companyName,
    courseName: row.courseName,
    dateLabel: trimToNull(row.dateLabel),
    parsedDates: normalizeParsedDates(row.parsedDates),
    undatedCategory,
    dbIds: dbRows.map((dbRow) => dbRow.id),
    dbStartDate: dbRows[0]?.startDate ?? null,
    dbEndDate: dbRows[0]?.endDate ?? null,
    dbDateLabel: dbRows[0]?.dateLabel ?? null,
  };
}

function pushSample(
  target: SheetCoverageIssueSample[],
  sample: SheetCoverageIssueSample,
  sampleLimit: number
): void {
  if (target.length < sampleLimit) {
    target.push(sample);
  }
}

function dateFieldsMatch(
  row: SheetCoverageCollectedRow,
  dbRow: SheetCoverageDbRow
): boolean {
  return (
    row.startDate === dbRow.startDate &&
    row.endDate === dbRow.endDate &&
    trimToNull(row.dateLabel) === trimToNull(dbRow.dateLabel)
  );
}

function resolveCoverageMatch(
  row: SheetCoverageCollectedRow,
  exactMatches: SheetCoverageDbRow[],
  legacyMatches: SheetCoverageDbRow[]
): CoverageMatch {
  if (exactMatches.length > 1) {
    return { kind: "duplicate", dbRows: exactMatches };
  }

  if (exactMatches.length === 1) {
    return {
      kind: dateFieldsMatch(row, exactMatches[0]) ? "exact_match" : "date_mismatch",
      dbRows: exactMatches,
    };
  }

  if (legacyMatches.length > 1) {
    return { kind: "duplicate", dbRows: legacyMatches };
  }

  if (legacyMatches.length === 1) {
    return {
      kind: dateFieldsMatch(row, legacyMatches[0]) ? "legacy_match" : "date_mismatch",
      dbRows: legacyMatches,
    };
  }

  return { kind: "missing", dbRows: [] };
}

function initDayRow(date: string): SheetCoverageDayRow {
  return {
    date,
    status: "empty",
    collectedRows: 0,
    dbRowsFound: 0,
    exactDateMatch: 0,
    legacyDbMatch: 0,
    missingInDb: 0,
    dateMismatch: 0,
    duplicateInDb: 0,
    sampleMissing: [],
    sampleDateMismatch: [],
    sampleDuplicate: [],
  };
}

function computeDayStatus(row: SheetCoverageDayRow): SheetCoverageDayStatus {
  if (row.collectedRows === 0) return "empty";

  let issueKinds = 0;
  if (row.missingInDb > 0) issueKinds += 1;
  if (row.dateMismatch > 0) issueKinds += 1;
  if (row.duplicateInDb > 0) issueKinds += 1;

  if (issueKinds === 0) return "ok";
  if (issueKinds > 1) return "mixed";
  if (row.missingInDb > 0) return "missing_in_db";
  if (row.dateMismatch > 0) return "date_mismatch";
  return "duplicate_in_db";
}

function buildBlankDateLabelSample(
  row: SheetCoverageCollectedRow
): SheetCoverageIssueSample {
  return buildIssueSample(row, []);
}

function classifyUndatedLabel(
  sourceType: SheetCoverageSourceType,
  dateLabel: string | null
): UndatedCategory {
  const label = trimToNull(dateLabel);
  if (!label) return "unknown";

  if (/^[.\-]+$/.test(label)) {
    return "not_applicable";
  }

  if (
    /시트 참고|별도산정|별첨 내용 참고|온라인 콘텐츠 임대 계약|매출액|시청 시간/i.test(label) ||
    /^010-\d{4}-\d{4}$/.test(label)
  ) {
    return "not_applicable";
  }

  if (sourceType === "instructor_dispatch_sheet") {
    if (/^\d{1,2}월\s*최종$/.test(label) || /^\d{4}\.\d{1,2}$/.test(label)) {
      return "summary_or_meta";
    }
    if (/^\d{4}\.\d{1,2}\s*[~-]\s*\d{4}\.\d{1,2}/.test(label)) {
      return "summary_or_meta";
    }
  }

  if (/^\d{1,2}\s*[./-]\s*\d{1,2}\s*[~-]\s*\d{1,2}\s*[./-]\s*\d{1,2}$/.test(label)) {
    return "context_dependent_date";
  }

  return "unknown";
}

export function buildSheetCoverageReport(args: {
  collectedRows: SheetCoverageCollectedRow[];
  dbRows: SheetCoverageDbRow[];
  startDate: string;
  endDate: string;
  sampleLimit?: number;
}): SheetCoverageReport {
  const sampleLimit = Math.max(args.sampleLimit ?? 5, 1);
  const startDate = parseDateOnly(args.startDate, "startDate");
  const endDate = parseDateOnly(args.endDate, "endDate");
  if (startDate > endDate) {
    throw new Error("startDate must be on or before endDate");
  }

  const dateKeys = enumerateDates(startDate, endDate);
  const dateKeySet = new Set(dateKeys);
  const rowsByDate = new Map(dateKeys.map((date) => [date, initDayRow(date)]));

  const exactDbRowsByIdentity = new Map<string, SheetCoverageDbRow[]>();
  const legacyDbRowsByIdentity = new Map<string, SheetCoverageDbRow[]>();

  for (const dbRow of args.dbRows) {
    if (dbRow.sourceIdentity) {
      const existing = exactDbRowsByIdentity.get(dbRow.sourceIdentity) ?? [];
      existing.push(dbRow);
      exactDbRowsByIdentity.set(dbRow.sourceIdentity, existing);
    }
    if (dbRow.legacyIdentity) {
      const existing = legacyDbRowsByIdentity.get(dbRow.legacyIdentity) ?? [];
      existing.push(dbRow);
      legacyDbRowsByIdentity.set(dbRow.legacyIdentity, existing);
    }
  }

  const summary: SheetCoverageSummary = {
    totalCollectedRows: 0,
    rowsWithAnyParsedDates: 0,
    rowsInRange: 0,
    blankDateLabelRows: 0,
    rowsWithoutParsedDates: 0,
    rowsWithoutParsedDatesNotApplicable: 0,
    rowsWithoutParsedDatesSummaryOrMeta: 0,
    rowsWithoutParsedDatesContextDependent: 0,
    rowsWithoutParsedDatesUnknown: 0,
    rowsMissingInDb: 0,
    rowsDateMismatch: 0,
    rowsDuplicateInDb: 0,
    rowsMatchedByLegacyIdentity: 0,
  };

  const sampleUndatedRows: SheetCoverageIssueSample[] = [];
  const sampleBlankDateLabelRows: SheetCoverageIssueSample[] = [];

  for (const inputRow of args.collectedRows) {
    const row: SheetCoverageCollectedRow = {
      ...inputRow,
      dateLabel: trimToNull(inputRow.dateLabel),
      parsedDates: normalizeParsedDates(inputRow.parsedDates),
    };

    summary.totalCollectedRows += 1;

    if (!row.dateLabel) {
      summary.blankDateLabelRows += 1;
      pushSample(
        sampleBlankDateLabelRows,
        buildBlankDateLabelSample(row),
        sampleLimit
      );
    }

    if (row.parsedDates.length === 0) {
      if (row.dateLabel) {
        const undatedCategory = classifyUndatedLabel(row.sourceType, row.dateLabel);
        summary.rowsWithoutParsedDates += 1;
        if (undatedCategory === "not_applicable") {
          summary.rowsWithoutParsedDatesNotApplicable += 1;
        } else if (undatedCategory === "summary_or_meta") {
          summary.rowsWithoutParsedDatesSummaryOrMeta += 1;
        } else if (undatedCategory === "context_dependent_date") {
          summary.rowsWithoutParsedDatesContextDependent += 1;
        } else {
          summary.rowsWithoutParsedDatesUnknown += 1;
        }
        pushSample(
          sampleUndatedRows,
          buildIssueSample(row, [], undatedCategory),
          sampleLimit
        );
      }
      continue;
    }

    summary.rowsWithAnyParsedDates += 1;

    const datesInRange = row.parsedDates.filter((date) => dateKeySet.has(date));
    if (datesInRange.length === 0) {
      continue;
    }

    summary.rowsInRange += 1;

    const exactIdentity = buildSheetSourceIdentity(
      row.spreadsheetId,
      row.worksheetGid,
      row.rowNumber
    );
    const legacyIdentity =
      row.sourceType === "contract_sheet"
        ? buildSheetLegacyIdentity(row.spreadsheetId, row.rowNumber)
        : null;

    const match = resolveCoverageMatch(
      row,
      exactDbRowsByIdentity.get(exactIdentity) ?? [],
      legacyIdentity ? legacyDbRowsByIdentity.get(legacyIdentity) ?? [] : []
    );

    if (match.kind === "missing") {
      summary.rowsMissingInDb += 1;
    } else if (match.kind === "date_mismatch") {
      summary.rowsDateMismatch += 1;
    } else if (match.kind === "duplicate") {
      summary.rowsDuplicateInDb += 1;
    } else if (match.kind === "legacy_match") {
      summary.rowsMatchedByLegacyIdentity += 1;
    }

    const sample = buildIssueSample(row, match.dbRows);

    for (const date of datesInRange) {
      const dayRow = rowsByDate.get(date);
      if (!dayRow) continue;

      dayRow.collectedRows += 1;

      if (match.kind !== "missing") {
        dayRow.dbRowsFound += 1;
      }

      if (match.kind === "exact_match") {
        dayRow.exactDateMatch += 1;
      } else if (match.kind === "legacy_match") {
        dayRow.legacyDbMatch += 1;
      } else if (match.kind === "missing") {
        dayRow.missingInDb += 1;
        pushSample(dayRow.sampleMissing, sample, sampleLimit);
      } else if (match.kind === "date_mismatch") {
        dayRow.dateMismatch += 1;
        pushSample(dayRow.sampleDateMismatch, sample, sampleLimit);
      } else if (match.kind === "duplicate") {
        dayRow.duplicateInDb += 1;
        pushSample(dayRow.sampleDuplicate, sample, sampleLimit);
      }
    }
  }

  const rows = Array.from(rowsByDate.values()).map((row) => ({
    ...row,
    status: computeDayStatus(row),
  }));

  return {
    rows,
    summary,
    sampleUndatedRows,
    sampleBlankDateLabelRows,
  };
}
