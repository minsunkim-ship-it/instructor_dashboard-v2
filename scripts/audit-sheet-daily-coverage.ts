import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { prisma } from "@/lib/prisma";
import { parseContractSchedule, toDateOnlyString } from "@/lib/contract-sheet-parser";
import { collectFromContractSheets } from "@/lib/pipeline/contract-sheet-collector";
import { normalizeContractRows } from "@/lib/pipeline/contract-sheet-normalizer";
import { collectInstructorDispatchSheets } from "@/lib/pipeline/instructor-dispatch-sheet-collector";
import { normalizeInstructorDispatchRow } from "@/lib/pipeline/instructor-dispatch-sheet-normalizer";
import { loadDotEnv } from "./lib/audit-helpers.ts";
import {
  buildSheetCoverageReport,
  buildSheetLegacyIdentity,
  buildSheetSourceIdentity,
  parseDateOnly,
  formatDateOnly,
  toDateOnly,
  type SheetCoverageCollectedRow,
  type SheetCoverageDbRow,
  type SheetCoverageDayRow,
  type SheetCoverageSourceType,
} from "./lib/sheet-daily-coverage.ts";

interface CliOptions {
  source: SheetCoverageSourceType;
  startDate: string;
  endDate: string;
  sampleLimit: number;
}

interface CollectCoverageResult {
  rows: SheetCoverageCollectedRow[];
  meta: Record<string, unknown>;
}

function parsePositiveInt(raw: string | undefined, fallback: number, max?: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return typeof max === "number" ? Math.min(parsed, max) : parsed;
}

function parseArgs(argv: string[]): CliOptions {
  const values = new Map<string, string>();
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const equalIndex = arg.indexOf("=");
    if (equalIndex === -1) continue;
    values.set(arg.slice(2, equalIndex), arg.slice(equalIndex + 1));
  }

  const source = values.get("source");
  if (source !== "contract_sheet" && source !== "instructor_dispatch_sheet") {
    throw new Error("--source must be contract_sheet or instructor_dispatch_sheet");
  }

  const startDate = values.get("start");
  const endDate = values.get("end");
  const parsedStart = parseDateOnly(startDate, "--start");
  const parsedEnd = parseDateOnly(endDate, "--end");
  if (parsedStart > parsedEnd) {
    throw new Error("--start must be on or before --end");
  }

  return {
    source,
    startDate: formatDateOnly(parsedStart),
    endDate: formatDateOnly(parsedEnd),
    sampleLimit: parsePositiveInt(values.get("sample-limit"), 5, 20),
  };
}

function toTsv(rows: SheetCoverageDayRow[]): string {
  const header = [
    "date",
    "status",
    "collected_rows",
    "db_rows_found",
    "exact_date_match",
    "legacy_db_match",
    "missing_in_db",
    "date_mismatch",
    "duplicate_in_db",
  ].join("\t");

  const body = rows.map((row) =>
    [
      row.date,
      row.status,
      row.collectedRows,
      row.dbRowsFound,
      row.exactDateMatch,
      row.legacyDbMatch,
      row.missingInDb,
      row.dateMismatch,
      row.duplicateInDb,
    ].join("\t")
  );

  return `${[header, ...body].join("\n")}\n`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

async function collectContractCoverageRows(): Promise<CollectCoverageResult> {
  const collected = await collectFromContractSheets();
  const worksheetErrors = collected.worksheets.filter((worksheet) => worksheet.error);
  if (worksheetErrors.length > 0) {
    throw new Error(
      `contract_sheet worksheet 수집 실패: ${worksheetErrors
        .map((worksheet) => `gid=${worksheet.gid}:${worksheet.error}`)
        .join(", ")}`
    );
  }

  const rows = collected.worksheets.flatMap((worksheet) => {
    const normalizedRows = normalizeContractRows(worksheet.rows);
    return worksheet.rows.map((raw, index) => {
      const normalized = normalizedRows[index];
      const parsedDates = parseContractSchedule(
        normalized.dateLabel,
        normalized.recordedAt?.getUTCFullYear() ?? null
      ).dates;
      const effectiveParsedDates =
        parsedDates.length > 0
          ? parsedDates
          : [normalized.startDate, normalized.endDate].filter(
              (value): value is Date => Boolean(value)
            );

      return {
        sourceType: "contract_sheet" as const,
        sourceLabel: `gid:${raw.worksheetGid}`,
        spreadsheetId: raw.spreadsheetId,
        worksheetGid: raw.worksheetGid,
        rowNumber: raw.rowNumber,
        instructorName: normalized.name,
        companyName: normalized.companyName,
        courseName: normalized.courseName,
        dateLabel: normalized.dateLabel,
        parsedDates: effectiveParsedDates
          .map((date) => toDateOnlyString(date))
          .filter((value): value is string => Boolean(value)),
        startDate: toDateOnlyString(normalized.startDate),
        endDate: toDateOnlyString(normalized.endDate),
      };
    });
  });

  return {
    rows,
    meta: {
      spreadsheetId: collected.spreadsheetId,
      worksheets: collected.worksheets.map((worksheet) => ({
        gid: worksheet.gid,
        fetchedCount: worksheet.fetchedCount,
      })),
    },
  };
}

async function collectDispatchCoverageRows(): Promise<CollectCoverageResult> {
  const collected = await collectInstructorDispatchSheets();
  const definitionErrors = collected.filter((item) => item.error);
  if (definitionErrors.length > 0) {
    throw new Error(
      `instructor_dispatch_sheet 수집 실패: ${definitionErrors
        .map((item) => `${item.definition.key}:${item.error}`)
        .join(", ")}`
    );
  }

  const rows = collected.flatMap((item) =>
    item.rows.map((raw) => {
      const normalized = normalizeInstructorDispatchRow(raw);
      const parsedDates = parseContractSchedule(normalized.dateLabel).dates;

      return {
        sourceType: "instructor_dispatch_sheet" as const,
        sourceLabel: item.definition.key,
        spreadsheetId: raw.spreadsheetId,
        worksheetGid: raw.worksheetGid,
        rowNumber: raw.rowNumber,
        instructorName: normalized.name,
        companyName: normalized.companyName,
        courseName: normalized.courseName,
        dateLabel: normalized.dateLabel,
        parsedDates: parsedDates
          .map((date) => toDateOnlyString(date))
          .filter((value): value is string => Boolean(value)),
        startDate: toDateOnlyString(normalized.startDate),
        endDate: toDateOnlyString(normalized.endDate),
      };
    })
  );

  return {
    rows,
    meta: {
      definitions: collected.map((item) => ({
        key: item.definition.key,
        instructorName: item.definition.instructorName,
        spreadsheetId: item.definition.spreadsheetId,
        worksheetGid: item.definition.worksheetGid,
        fetchedCount: item.fetchedCount,
      })),
    },
  };
}

async function collectCoverageRows(
  source: SheetCoverageSourceType
): Promise<CollectCoverageResult> {
  if (source === "contract_sheet") {
    return collectContractCoverageRows();
  }
  return collectDispatchCoverageRows();
}

async function loadDbCoverageRows(
  source: SheetCoverageSourceType
): Promise<SheetCoverageDbRow[]> {
  const rows = await prisma.teachingHistory.findMany({
    where: { sourceType: source },
    select: {
      id: true,
      startDate: true,
      endDate: true,
      dateLabel: true,
      sourceRef: true,
    },
  });

  return rows.map((row) => {
    const sourceRef = asRecord(row.sourceRef);
    const spreadsheetId =
      typeof sourceRef?.spreadsheet_id === "string" ? sourceRef.spreadsheet_id : null;
    const worksheetGid =
      typeof sourceRef?.worksheet_gid === "number" ? sourceRef.worksheet_gid : null;
    const rowNumber =
      typeof sourceRef?.row_number === "number" ? sourceRef.row_number : null;

    const sourceIdentity =
      spreadsheetId && worksheetGid !== null && rowNumber !== null
        ? buildSheetSourceIdentity(spreadsheetId, worksheetGid, rowNumber)
        : null;
    const legacyIdentity =
      source === "contract_sheet" &&
      spreadsheetId &&
      worksheetGid === null &&
      rowNumber !== null
        ? buildSheetLegacyIdentity(spreadsheetId, rowNumber)
        : null;

    return {
      id: row.id,
      sourceIdentity,
      legacyIdentity,
      startDate: toDateOnly(row.startDate),
      endDate: toDateOnly(row.endDate),
      dateLabel: row.dateLabel?.trim() || null,
    };
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await loadDotEnv(path.join(process.cwd(), ".env"));

  const collected = await collectCoverageRows(options.source);
  const dbRows = await loadDbCoverageRows(options.source);
  const report = buildSheetCoverageReport({
    collectedRows: collected.rows,
    dbRows,
    startDate: options.startDate,
    endDate: options.endDate,
    sampleLimit: options.sampleLimit,
  });

  for (const row of report.rows) {
    console.log(
      JSON.stringify(
        {
          date: row.date,
          status: row.status,
          collectedRows: row.collectedRows,
          dbRowsFound: row.dbRowsFound,
          exactDateMatch: row.exactDateMatch,
          legacyDbMatch: row.legacyDbMatch,
          missingInDb: row.missingInDb,
          dateMismatch: row.dateMismatch,
          duplicateInDb: row.duplicateInDb,
        },
        null,
        2
      )
    );
  }

  const reportsDir = path.join(process.cwd(), "reports");
  await mkdir(reportsDir, { recursive: true });

  const baseName = `sheet-daily-coverage-${options.source}-${options.startDate}_${options.endDate}`;
  const jsonPath = path.join(reportsDir, `${baseName}.json`);
  const tsvPath = path.join(reportsDir, `${baseName}.tsv`);

  await writeFile(
    jsonPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        cwd: process.cwd(),
        options,
        collectorMeta: collected.meta,
        dbRowCount: dbRows.length,
        summary: report.summary,
        rows: report.rows,
        sampleUndatedRows: report.sampleUndatedRows,
        sampleBlankDateLabelRows: report.sampleBlankDateLabelRows,
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(tsvPath, toTsv(report.rows), "utf8");

  const issueDays = report.rows.filter(
    (row) => row.status !== "ok" && row.status !== "empty"
  ).length;
  const hasIssues =
    issueDays > 0 ||
    report.summary.rowsWithoutParsedDatesUnknown > 0 ||
    report.summary.rowsMissingInDb > 0 ||
    report.summary.rowsDateMismatch > 0 ||
    report.summary.rowsDuplicateInDb > 0;

  console.log(
    JSON.stringify(
      {
        source: options.source,
        startDate: options.startDate,
        endDate: options.endDate,
        days: report.rows.length,
        issueDays,
        rowsMissingInDb: report.summary.rowsMissingInDb,
        rowsDateMismatch: report.summary.rowsDateMismatch,
        rowsDuplicateInDb: report.summary.rowsDuplicateInDb,
        rowsWithoutParsedDates: report.summary.rowsWithoutParsedDates,
        rowsWithoutParsedDatesNotApplicable:
          report.summary.rowsWithoutParsedDatesNotApplicable,
        rowsWithoutParsedDatesSummaryOrMeta:
          report.summary.rowsWithoutParsedDatesSummaryOrMeta,
        rowsWithoutParsedDatesContextDependent:
          report.summary.rowsWithoutParsedDatesContextDependent,
        rowsWithoutParsedDatesUnknown:
          report.summary.rowsWithoutParsedDatesUnknown,
        jsonReport: jsonPath,
        tsvReport: tsvPath,
      },
      null,
      2
    )
  );

  if (hasIssues) {
    process.exitCode = 1;
  }
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
