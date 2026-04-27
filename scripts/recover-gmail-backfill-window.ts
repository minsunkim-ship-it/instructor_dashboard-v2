import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { applyActivities } from "@/lib/pipeline/activity-applier";
import { collectFromGmail } from "@/lib/pipeline/gmail-activity-collector";
import { normalizeGmailCollect } from "@/lib/pipeline/gmail-activity-normalizer";
import { loadDotEnv } from "./lib/audit-helpers.ts";

interface CliOptions {
  startDate: string;
  endDate: string;
  dates: string[];
  maxPages: number;
  pageSize: number;
  requestTimeoutMs: number;
  mailboxTimeoutMs: number;
  threadFetchConcurrency: number;
}

interface RecoveryDayResult {
  date: string;
  query: string;
  beforeCollected: number;
  beforeDbRows: number;
  beforeMissing: number;
  fetchComplete: boolean;
  pageCapHit: boolean;
  nextPageTokenRemaining: boolean;
  threadsListed: number;
  threadsLoaded: number;
  detailFetchFailures: number;
  detailEmptyThreads: number;
  inserted: number;
  updated: number;
  matched: number;
  unmatched: number;
  ambiguous: number;
  invalid: number;
  afterDbRows: number;
  afterMissing: number;
  action: "skipped" | "recovered" | "aborted";
  note: string | null;
}

function parseDateOnly(value: string | undefined, label: string): Date {
  if (!value) throw new Error(`${label} is required (YYYY-MM-DD)`);
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`${label} must be YYYY-MM-DD`);
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 0, 0, 0));
  if (Number.isNaN(date.getTime())) throw new Error(`${label} must be a valid date`);
  return date;
}

function parseMonthOnly(value: string | undefined, label: string): {
  startDate: Date;
  endDate: Date;
} {
  if (!value) throw new Error(`${label} is required (YYYY-MM)`);
  const match = value.trim().match(/^(\d{4})-(\d{2})$/);
  if (!match) throw new Error(`${label} must be YYYY-MM`);
  const [, year, month] = match;
  const startDate = new Date(Date.UTC(Number(year), Number(month) - 1, 1, 0, 0, 0));
  const nextMonth = new Date(Date.UTC(Number(year), Number(month), 1, 0, 0, 0));
  const endDate = addDays(nextMonth, -1);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    throw new Error(`${label} must be a valid month`);
  }
  return { startDate, endDate };
}

function parseMonthToken(value: string, label: string): {
  startDate: Date;
  endDate: Date;
} {
  return parseMonthOnly(value, label);
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

function dedupePreservingOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
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

  const month = values.get("month");
  const months = values.get("months");
  const startMonth = values.get("start-month");
  const endMonth = values.get("end-month");
  const startDate = values.get("start");
  const endDate = values.get("end");
  const monthModeCount = [month, months, startMonth || endMonth ? "range" : undefined].filter(
    Boolean
  ).length;
  if (monthModeCount > 1) {
    throw new Error("Use only one of --month, --months, or --start-month/--end-month");
  }

  let parsedRange: { startDate: Date; endDate: Date };
  let dates: string[];
  if (month) {
    parsedRange = parseMonthOnly(month, "--month");
    dates = enumerateDates(parsedRange.startDate, parsedRange.endDate);
  } else if (months) {
    const tokens = months
      .split(",")
      .map((token) => token.trim())
      .filter(Boolean);
    if (tokens.length === 0) {
      throw new Error("--months must include at least one YYYY-MM value");
    }
    const ranges = tokens.map((token) => parseMonthToken(token, "--months"));
    parsedRange = {
      startDate: ranges[0].startDate,
      endDate: ranges[ranges.length - 1].endDate,
    };
    dates = dedupePreservingOrder(
      ranges.flatMap((range) => enumerateDates(range.startDate, range.endDate))
    );
  } else if (startMonth || endMonth) {
    if (!startMonth || !endMonth) {
      throw new Error("--start-month and --end-month must be provided together");
    }
    const parsedStartMonth = parseMonthOnly(startMonth, "--start-month");
    const parsedEndMonth = parseMonthOnly(endMonth, "--end-month");
    parsedRange = {
      startDate: parsedStartMonth.startDate,
      endDate: parsedEndMonth.endDate,
    };
    dates = enumerateDates(parsedRange.startDate, parsedRange.endDate);
  } else {
    parsedRange = {
      startDate: parseDateOnly(startDate, "--start"),
      endDate: parseDateOnly(endDate, "--end"),
    };
    dates = enumerateDates(parsedRange.startDate, parsedRange.endDate);
  }
  const parsedStart = parsedRange.startDate;
  const parsedEnd = parsedRange.endDate;
  if (parsedStart > parsedEnd) {
    throw new Error("--start must be on or before --end");
  }

  return {
    startDate: formatDateOnly(parsedStart),
    endDate: formatDateOnly(parsedEnd),
    dates,
    maxPages: parsePositiveInt(values.get("max-pages"), 20, 50),
    pageSize: parsePositiveInt(values.get("page-size"), 500, 500),
    requestTimeoutMs: parsePositiveInt(values.get("request-timeout-ms"), 10_000),
    mailboxTimeoutMs: parsePositiveInt(values.get("mailbox-timeout-ms"), 60_000),
    threadFetchConcurrency: parsePositiveInt(values.get("thread-fetch-concurrency"), 8, 20),
  };
}

function buildDailyQuery(dateOnly: string): string {
  const date = parseDateOnly(dateOnly, "date");
  const nextDay = addDays(date, 1);
  return `from:day1company.co.kr after:${formatGmailDate(date)} before:${formatGmailDate(nextDay)}`;
}

function toMarkdown(results: RecoveryDayResult[], options: CliOptions): string {
  const lines = [
    "# Gmail Backfill Recovery Run",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Range: ${options.startDate} to ${options.endDate}`,
    "",
    "| Date | Action | Before Missing | After Missing | Inserted | Updated | Fetch Complete | Note |",
    "| --- | --- | ---: | ---: | ---: | ---: | --- | --- |",
  ];

  for (const row of results) {
    lines.push(
      `| ${row.date} | ${row.action} | ${row.beforeMissing} | ${row.afterMissing} | ${row.inserted} | ${row.updated} | ${row.fetchComplete} | ${row.note ?? ""} |`
    );
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

async function loadExistingRows(sourceRefKeys: string[]) {
  return prisma.activityImportItem.findMany({
    where: {
      sourceType: "gmail",
      sourceRefKey: { in: sourceRefKeys },
    },
    select: {
      sourceRefKey: true,
    },
  });
}

async function recoverDate(date: string, options: CliOptions): Promise<RecoveryDayResult> {
  const query = buildDailyQuery(date);
  const collect = await collectFromGmail({
    query,
    checkpoint: null,
    maxPages: options.maxPages,
    pageSize: options.pageSize,
    requestTimeoutMs: options.requestTimeoutMs,
    mailboxTimeoutMs: options.mailboxTimeoutMs,
    threadFetchConcurrency: options.threadFetchConcurrency,
  });
  const normalized = normalizeGmailCollect(collect);
  const sourceRefKeys = Array.from(new Set(normalized.map((item) => item.sourceRefKey)));
  const beforeExisting = await loadExistingRows(sourceRefKeys);
  const beforeMissing = sourceRefKeys.length - beforeExisting.length;

  if (!collect.diagnostics.fetchComplete) {
    return {
      date,
      query,
      beforeCollected: collect.threads.length,
      beforeDbRows: beforeExisting.length,
      beforeMissing,
      fetchComplete: collect.diagnostics.fetchComplete,
      pageCapHit: collect.diagnostics.pageCapHit,
      nextPageTokenRemaining: collect.diagnostics.nextPageTokenRemaining,
      threadsListed: collect.diagnostics.threadsListed,
      threadsLoaded: collect.diagnostics.threadsLoaded,
      detailFetchFailures: collect.diagnostics.detailFetchFailures,
      detailEmptyThreads: collect.diagnostics.detailEmptyThreads,
      inserted: 0,
      updated: 0,
      matched: 0,
      unmatched: 0,
      ambiguous: 0,
      invalid: 0,
      afterDbRows: beforeExisting.length,
      afterMissing: beforeMissing,
      action: "aborted",
      note: "fetch_incomplete",
    };
  }

  if (beforeMissing === 0) {
    return {
      date,
      query,
      beforeCollected: collect.threads.length,
      beforeDbRows: beforeExisting.length,
      beforeMissing,
      fetchComplete: collect.diagnostics.fetchComplete,
      pageCapHit: collect.diagnostics.pageCapHit,
      nextPageTokenRemaining: collect.diagnostics.nextPageTokenRemaining,
      threadsListed: collect.diagnostics.threadsListed,
      threadsLoaded: collect.diagnostics.threadsLoaded,
      detailFetchFailures: collect.diagnostics.detailFetchFailures,
      detailEmptyThreads: collect.diagnostics.detailEmptyThreads,
      inserted: 0,
      updated: 0,
      matched: 0,
      unmatched: 0,
      ambiguous: 0,
      invalid: 0,
      afterDbRows: beforeExisting.length,
      afterMissing: 0,
      action: "skipped",
      note: "already_complete",
    };
  }

  const run = await prisma.pipelineRun.create({
    data: {
      runType: "diagnostic_gmail_window_recovery",
      status: "running",
      triggeredBy: `codex:gmail-window-recovery:${date}`,
    },
  });

  const applyResult = await applyActivities(run.id, [], normalized);

  const summary: Prisma.InputJsonObject = {
    date,
    query,
    diagnostics: collect.diagnostics as unknown as Prisma.InputJsonObject,
    items_inserted: applyResult.items.inserted,
    items_updated: applyResult.items.updated,
    matched: applyResult.items.matched,
    unmatched: applyResult.items.unmatched,
    ambiguous: applyResult.items.ambiguous,
    invalid: applyResult.items.invalid,
  };

  await prisma.pipelineRun.update({
    where: { id: run.id },
    data: {
      status: "success",
      finishedAt: new Date(),
      summary,
    },
  });

  const afterExisting = await loadExistingRows(sourceRefKeys);
  const afterMissing = sourceRefKeys.length - afterExisting.length;

  return {
    date,
    query,
    beforeCollected: collect.threads.length,
    beforeDbRows: beforeExisting.length,
    beforeMissing,
    fetchComplete: collect.diagnostics.fetchComplete,
    pageCapHit: collect.diagnostics.pageCapHit,
    nextPageTokenRemaining: collect.diagnostics.nextPageTokenRemaining,
    threadsListed: collect.diagnostics.threadsListed,
    threadsLoaded: collect.diagnostics.threadsLoaded,
    detailFetchFailures: collect.diagnostics.detailFetchFailures,
    detailEmptyThreads: collect.diagnostics.detailEmptyThreads,
    inserted: applyResult.items.inserted,
    updated: applyResult.items.updated,
    matched: applyResult.items.matched,
    unmatched: applyResult.items.unmatched,
    ambiguous: applyResult.items.ambiguous,
    invalid: applyResult.items.invalid,
    afterDbRows: afterExisting.length,
    afterMissing,
    action: "recovered",
    note: afterMissing === 0 ? "gap_closed" : "gap_remains",
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await loadDotEnv(path.join(process.cwd(), ".env"));

  const results: RecoveryDayResult[] = [];

  for (const date of options.dates) {
    console.log(`[recover] ${date}`);
    const result = await recoverDate(date, options);
    results.push(result);
    console.log(
      JSON.stringify(
        {
          date: result.date,
          action: result.action,
          beforeMissing: result.beforeMissing,
          afterMissing: result.afterMissing,
          inserted: result.inserted,
          updated: result.updated,
          fetchComplete: result.fetchComplete,
          pageCapHit: result.pageCapHit,
          detailFetchFailures: result.detailFetchFailures,
          note: result.note,
        },
        null,
        2
      )
    );
    if (result.action === "aborted") {
      break;
    }
  }

  const reportsDir = path.join(process.cwd(), "reports");
  await mkdir(reportsDir, { recursive: true });
  const baseName = `gmail-window-recovery-${options.startDate}_${options.endDate}`;
  const jsonPath = path.join(reportsDir, `${baseName}.json`);
  const mdPath = path.join(reportsDir, `${baseName}.md`);

  await writeFile(
    jsonPath,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), options, results }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(mdPath, toMarkdown(results, options), "utf8");

  console.log(
    JSON.stringify(
      {
        days: results.length,
        recoveredDays: results.filter((item) => item.action === "recovered").length,
        aborted: results.some((item) => item.action === "aborted"),
        jsonReport: jsonPath,
        markdownReport: mdPath,
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
