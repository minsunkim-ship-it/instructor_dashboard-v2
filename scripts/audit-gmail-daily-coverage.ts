import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { prisma } from "@/lib/prisma";
import {
  collectFromGmail,
  GMAIL_ACTIVITY_MAILBOX_QUERY,
} from "@/lib/pipeline/gmail-activity-collector";
import { normalizeGmailCollect } from "@/lib/pipeline/gmail-activity-normalizer";
import { loadDotEnv } from "./lib/audit-helpers.ts";

type DayStatus = "ok" | "missing_in_db" | "empty";

interface CliOptions {
  startDate: string;
  endDate: string;
  maxPages: number;
  pageSize: number;
  requestTimeoutMs: number;
  mailboxTimeoutMs: number;
  threadFetchConcurrency: number;
}

interface DayAuditRow {
  date: string;
  status: DayStatus;
  query: string;
  collectedThreads: number;
  dbRowsFound: number;
  missingInDb: number;
  normalizedInvalid: number;
  dbMatched: number;
  dbUnmatched: number;
  dbAmbiguous: number;
  dbInvalid: number;
  sampleMissing: Array<{
    threadId: string;
    sourceRefKey: string;
    subject: string | null;
    from: string | null;
    to: string | null;
    lastInternalDateMs: string | null;
    invalidReason: string | null;
  }>;
}

function parseDateOnly(value: string | undefined, label: string): Date {
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

function formatDateOnly(date: Date): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function formatGmailDate(date: Date): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yyyy}/${mm}/${dd}`;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function enumerateDates(startDate: Date, endDate: Date): string[] {
  const dates: string[] = [];
  for (let current = startDate; current <= endDate; current = addDays(current, 1)) {
    dates.push(formatDateOnly(current));
  }
  return dates;
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

  const startDate = values.get("start");
  const endDate = values.get("end");
  const parsedStart = parseDateOnly(startDate, "--start");
  const parsedEnd = parseDateOnly(endDate, "--end");
  if (parsedStart > parsedEnd) {
    throw new Error("--start must be on or before --end");
  }

  return {
    startDate: formatDateOnly(parsedStart),
    endDate: formatDateOnly(parsedEnd),
    maxPages: parsePositiveInt(values.get("max-pages"), 10, 50),
    pageSize: parsePositiveInt(values.get("page-size"), 500, 500),
    requestTimeoutMs: parsePositiveInt(values.get("request-timeout-ms"), 10_000),
    mailboxTimeoutMs: parsePositiveInt(values.get("mailbox-timeout-ms"), 60_000),
    threadFetchConcurrency: parsePositiveInt(values.get("thread-fetch-concurrency"), 8, 20),
  };
}

function buildDailyQuery(dateOnly: string): string {
  const date = parseDateOnly(dateOnly, "date");
  const nextDay = addDays(date, 1);
  return `${GMAIL_ACTIVITY_MAILBOX_QUERY} after:${formatGmailDate(date)} before:${formatGmailDate(
    nextDay
  )}`;
}

function toTsv(rows: DayAuditRow[]): string {
  const header = [
    "date",
    "status",
    "collected_threads",
    "db_rows_found",
    "missing_in_db",
    "normalized_invalid",
    "db_matched",
    "db_unmatched",
    "db_ambiguous",
    "db_invalid",
  ].join("\t");

  const body = rows.map((row) =>
    [
      row.date,
      row.status,
      row.collectedThreads,
      row.dbRowsFound,
      row.missingInDb,
      row.normalizedInvalid,
      row.dbMatched,
      row.dbUnmatched,
      row.dbAmbiguous,
      row.dbInvalid,
    ].join("\t")
  );

  return `${[header, ...body].join("\n")}\n`;
}

async function auditDay(dateOnly: string, options: CliOptions): Promise<DayAuditRow> {
  const query = buildDailyQuery(dateOnly);
  const collected = await collectFromGmail({
    query,
    checkpoint: null,
    maxPages: options.maxPages,
    pageSize: options.pageSize,
    requestTimeoutMs: options.requestTimeoutMs,
    mailboxTimeoutMs: options.mailboxTimeoutMs,
    threadFetchConcurrency: options.threadFetchConcurrency,
  });

  const normalized = normalizeGmailCollect(collected);
  const sourceRefKeys = Array.from(new Set(normalized.map((item) => item.sourceRefKey)));
  const existing =
    sourceRefKeys.length === 0
      ? []
      : await prisma.activityImportItem.findMany({
          where: {
            sourceType: "gmail",
            sourceRefKey: { in: sourceRefKeys },
          },
          select: {
            sourceRefKey: true,
            matchStatus: true,
          },
        });

  const existingByKey = new Map(
    existing
      .filter((row): row is { sourceRefKey: string; matchStatus: string } => Boolean(row.sourceRefKey))
      .map((row) => [row.sourceRefKey, row.matchStatus])
  );

  const sampleMissing = normalized
    .filter((item) => !existingByKey.has(item.sourceRefKey))
    .slice(0, 5)
    .map((item) => ({
      threadId: String(item.sourceRef.thread_id),
      sourceRefKey: item.sourceRefKey,
      subject: item.rawPayload.subject,
      from: item.rawPayload.from,
      to: item.rawPayload.to,
      lastInternalDateMs: item.activityAt ? String(item.activityAt.getTime()) : null,
      invalidReason: item.invalidReason,
    }));

  let dbMatched = 0;
  let dbUnmatched = 0;
  let dbAmbiguous = 0;
  let dbInvalid = 0;
  for (const row of existing) {
    if (row.matchStatus === "matched") dbMatched += 1;
    else if (row.matchStatus === "unmatched") dbUnmatched += 1;
    else if (row.matchStatus === "ambiguous") dbAmbiguous += 1;
    else if (row.matchStatus === "invalid") dbInvalid += 1;
  }

  const missingInDb = sourceRefKeys.length - existing.length;
  const status: DayStatus =
    collected.threads.length === 0
      ? "empty"
      : missingInDb > 0
      ? "missing_in_db"
      : "ok";

  return {
    date: dateOnly,
    status,
    query,
    collectedThreads: collected.threads.length,
    dbRowsFound: existing.length,
    missingInDb,
    normalizedInvalid: normalized.filter((item) => Boolean(item.invalidReason)).length,
    dbMatched,
    dbUnmatched,
    dbAmbiguous,
    dbInvalid,
    sampleMissing,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await loadDotEnv(path.join(process.cwd(), ".env"));

  const dates = enumerateDates(
    parseDateOnly(options.startDate, "startDate"),
    parseDateOnly(options.endDate, "endDate")
  );

  const rows: DayAuditRow[] = [];
  for (const date of dates) {
    console.log(`[audit] ${date}`);
    const row = await auditDay(date, options);
    rows.push(row);
    console.log(
      JSON.stringify(
        {
          date: row.date,
          status: row.status,
          collectedThreads: row.collectedThreads,
          dbRowsFound: row.dbRowsFound,
          missingInDb: row.missingInDb,
          dbMatched: row.dbMatched,
          dbUnmatched: row.dbUnmatched,
          dbAmbiguous: row.dbAmbiguous,
          dbInvalid: row.dbInvalid,
        },
        null,
        2
      )
    );
  }

  const reportsDir = path.join(process.cwd(), "reports");
  await mkdir(reportsDir, { recursive: true });

  const baseName = `gmail-daily-coverage-${options.startDate}_${options.endDate}`;
  const jsonPath = path.join(reportsDir, `${baseName}.json`);
  const tsvPath = path.join(reportsDir, `${baseName}.tsv`);

  await writeFile(
    jsonPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        cwd: process.cwd(),
        mailboxQuery: GMAIL_ACTIVITY_MAILBOX_QUERY,
        options,
        rows,
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(tsvPath, toTsv(rows), "utf8");

  const missingDays = rows.filter((row) => row.status === "missing_in_db").length;
  console.log(
    JSON.stringify(
      {
        startDate: options.startDate,
        endDate: options.endDate,
        days: rows.length,
        missingDays,
        jsonReport: jsonPath,
        tsvReport: tsvPath,
      },
      null,
      2
    )
  );
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
