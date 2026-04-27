import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { prisma } from "@/lib/prisma";
import {
  collectFromSlack,
  SLACK_PILOT_4_5_CHANNELS,
} from "@/lib/pipeline/slack-activity-collector";
import { normalizeSlackCollect } from "@/lib/pipeline/slack-activity-normalizer";
import { loadCheckpoints, loadDotEnv } from "./lib/audit-helpers.ts";

type DayStatus =
  | "ok"
  | "empty"
  | "missing_in_db"
  | "stale_activity_at"
  | "missing_and_stale";

interface CliOptions {
  startDate: string;
  endDate: string;
  timezone: string;
  perPageLimit: number;
  fullBackfillMaxPages: number;
  replyRootBufferDays: number;
  requestTimeoutMs: number;
  channelTimeoutMs: number;
  userLookupConcurrency: number;
  sampleLimit: number;
}

interface DayIssueSample {
  sourceRefKey: string;
  channelId: string;
  kind: "ops_report" | "dispatch_request";
  activityUnit: "thread" | "message";
  collectedActivityAt: string | null;
  collectedDate: string | null;
  dbActivityAt: string | null;
  dbDate: string | null;
  sourceMessageAt: string | null;
  sourceMessageDate: string | null;
  latestReplyAt: string | null;
  matchStatus: string | null;
}

interface DayAuditRow {
  date: string;
  status: DayStatus;
  collectedActivities: number;
  dbRowsFound: number;
  dbExactDayMatch: number;
  missingInDb: number;
  staleActivityAt: number;
  lateReplyActivities: number;
  dbMatched: number;
  dbUnmatched: number;
  dbAmbiguous: number;
  dbInvalid: number;
  sampleMissing: DayIssueSample[];
  sampleStale: DayIssueSample[];
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
    timezone: values.get("timezone")?.trim() || "Asia/Seoul",
    perPageLimit: parsePositiveInt(values.get("per-page-limit"), 200, 200),
    fullBackfillMaxPages: parsePositiveInt(values.get("full-backfill-max-pages"), 15, 200),
    replyRootBufferDays: parsePositiveInt(values.get("reply-root-buffer-days"), 90, 3650),
    requestTimeoutMs: parsePositiveInt(values.get("request-timeout-ms"), 10_000),
    channelTimeoutMs: parsePositiveInt(values.get("channel-timeout-ms"), 120_000),
    userLookupConcurrency: parsePositiveInt(values.get("user-lookup-concurrency"), 8, 20),
    sampleLimit: parsePositiveInt(values.get("sample-limit"), 5, 20),
  };
}

function getDateFormatter(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function formatDateInTimeZone(
  value: Date | string | null | undefined,
  timezone: string
): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const parts = getDateFormatter(timezone).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) return null;
  return `${year}-${month}-${day}`;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function computeLookbackDays(startDate: string, timezone: string, replyRootBufferDays: number): number {
  const start = parseDateOnly(startDate, "startDate");
  const today = parseDateOnly(
    formatDateInTimeZone(new Date(), timezone) ?? formatDateOnly(new Date()),
    "today"
  );
  const dayMs = 24 * 60 * 60 * 1000;
  const diffDays = Math.max(0, Math.floor((today.getTime() - start.getTime()) / dayMs));
  return diffDays + 1 + replyRootBufferDays;
}

function initDayRow(date: string): DayAuditRow {
  return {
    date,
    status: "empty",
    collectedActivities: 0,
    dbRowsFound: 0,
    dbExactDayMatch: 0,
    missingInDb: 0,
    staleActivityAt: 0,
    lateReplyActivities: 0,
    dbMatched: 0,
    dbUnmatched: 0,
    dbAmbiguous: 0,
    dbInvalid: 0,
    sampleMissing: [],
    sampleStale: [],
  };
}

function toTsv(rows: DayAuditRow[]): string {
  const header = [
    "date",
    "status",
    "collected_activities",
    "db_rows_found",
    "db_exact_day_match",
    "missing_in_db",
    "stale_activity_at",
    "late_reply_activities",
    "db_matched",
    "db_unmatched",
    "db_ambiguous",
    "db_invalid",
  ].join("\t");

  const body = rows.map((row) =>
    [
      row.date,
      row.status,
      row.collectedActivities,
      row.dbRowsFound,
      row.dbExactDayMatch,
      row.missingInDb,
      row.staleActivityAt,
      row.lateReplyActivities,
      row.dbMatched,
      row.dbUnmatched,
      row.dbAmbiguous,
      row.dbInvalid,
    ].join("\t")
  );

  return `${[header, ...body].join("\n")}\n`;
}

function incrementMatchStatus(row: DayAuditRow, matchStatus: string | null | undefined): void {
  if (matchStatus === "matched") row.dbMatched += 1;
  else if (matchStatus === "unmatched") row.dbUnmatched += 1;
  else if (matchStatus === "ambiguous") row.dbAmbiguous += 1;
  else if (matchStatus === "invalid") row.dbInvalid += 1;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await loadDotEnv(path.join(process.cwd(), ".env"));

  const lookbackDays = computeLookbackDays(
    options.startDate,
    options.timezone,
    options.replyRootBufferDays
  );
  const dates = enumerateDates(
    parseDateOnly(options.startDate, "startDate"),
    parseDateOnly(options.endDate, "endDate")
  );
  const rows = new Map<string, DayAuditRow>(dates.map((date) => [date, initDayRow(date)]));

  const checkpointRows = await loadCheckpoints("slack");
  const full = await collectFromSlack({
    checkpoints: [],
    perPageLimit: options.perPageLimit,
    fullBackfillMaxPages: options.fullBackfillMaxPages,
    fullBackfillMinLookbackDays: lookbackDays,
    requestTimeoutMs: options.requestTimeoutMs,
    channelTimeoutMs: options.channelTimeoutMs,
    userLookupConcurrency: options.userLookupConcurrency,
  });

  const normalized = normalizeSlackCollect(full);
  const inRange = normalized.filter((item) => {
    const activityDate = formatDateInTimeZone(item.activityAt, options.timezone);
    return Boolean(
      activityDate && activityDate >= options.startDate && activityDate <= options.endDate
    );
  });

  const sourceRefKeys = Array.from(new Set(inRange.map((item) => item.sourceRefKey)));
  const existing =
    sourceRefKeys.length === 0
      ? []
      : await prisma.activityImportItem.findMany({
          where: {
            sourceType: "slack",
            sourceRefKey: { in: sourceRefKeys },
          },
          select: {
            sourceRefKey: true,
            activityAt: true,
            matchStatus: true,
          },
        });

  const existingByKey = new Map(
    existing
      .filter(
        (row): row is { sourceRefKey: string; activityAt: Date | null; matchStatus: string } =>
          Boolean(row.sourceRefKey)
      )
      .map((row) => [row.sourceRefKey, row])
  );

  for (const item of inRange) {
    const activityDate = formatDateInTimeZone(item.activityAt, options.timezone);
    if (!activityDate) continue;

    const row = rows.get(activityDate);
    if (!row) continue;

    row.collectedActivities += 1;

    const sourceTs = item.sourceRef.thread_ts ?? item.sourceRef.message_ts ?? null;
    const sourceMessageAt = toIso(sourceTs ? new Date(Number.parseFloat(sourceTs) * 1000) : null);
    const sourceMessageDate = formatDateInTimeZone(sourceMessageAt, options.timezone);
    const isLateReplyActivity =
      Boolean(item.rawPayload.latest_reply_at) &&
      Boolean(sourceMessageDate) &&
      sourceMessageDate !== activityDate;
    if (isLateReplyActivity) {
      row.lateReplyActivities += 1;
    }

    const dbRow = existingByKey.get(item.sourceRefKey) ?? null;
    if (!dbRow) {
      row.missingInDb += 1;
      if (row.sampleMissing.length < options.sampleLimit) {
        row.sampleMissing.push({
          sourceRefKey: item.sourceRefKey,
          channelId: item.rawPayload.channel_id,
          kind: item.rawPayload.channel_kind,
          activityUnit: item.rawPayload.activity_unit,
          collectedActivityAt: toIso(item.activityAt),
          collectedDate: activityDate,
          dbActivityAt: null,
          dbDate: null,
          sourceMessageAt,
          sourceMessageDate,
          latestReplyAt: item.rawPayload.latest_reply_at,
          matchStatus: null,
        });
      }
      continue;
    }

    row.dbRowsFound += 1;
    incrementMatchStatus(row, dbRow.matchStatus);

    const dbDate = formatDateInTimeZone(dbRow.activityAt, options.timezone);
    if (dbDate === activityDate) {
      row.dbExactDayMatch += 1;
      continue;
    }

    row.staleActivityAt += 1;
    if (row.sampleStale.length < options.sampleLimit) {
      row.sampleStale.push({
        sourceRefKey: item.sourceRefKey,
        channelId: item.rawPayload.channel_id,
        kind: item.rawPayload.channel_kind,
        activityUnit: item.rawPayload.activity_unit,
        collectedActivityAt: toIso(item.activityAt),
        collectedDate: activityDate,
        dbActivityAt: toIso(dbRow.activityAt),
        dbDate,
        sourceMessageAt,
        sourceMessageDate,
        latestReplyAt: item.rawPayload.latest_reply_at,
        matchStatus: dbRow.matchStatus,
      });
    }
  }

  const orderedRows = dates.map((date) => {
    const row = rows.get(date) ?? initDayRow(date);
    if (row.collectedActivities === 0) {
      row.status = "empty";
    } else if (row.missingInDb > 0 && row.staleActivityAt > 0) {
      row.status = "missing_and_stale";
    } else if (row.missingInDb > 0) {
      row.status = "missing_in_db";
    } else if (row.staleActivityAt > 0) {
      row.status = "stale_activity_at";
    } else {
      row.status = "ok";
    }
    return row;
  });

  for (const row of orderedRows) {
    console.log(
      JSON.stringify(
        {
          date: row.date,
          status: row.status,
          collectedActivities: row.collectedActivities,
          dbRowsFound: row.dbRowsFound,
          dbExactDayMatch: row.dbExactDayMatch,
          missingInDb: row.missingInDb,
          staleActivityAt: row.staleActivityAt,
          lateReplyActivities: row.lateReplyActivities,
        },
        null,
        2
      )
    );
  }

  const reportsDir = path.join(process.cwd(), "reports");
  await mkdir(reportsDir, { recursive: true });

  const baseName = `slack-daily-coverage-${options.startDate}_${options.endDate}`;
  const jsonPath = path.join(reportsDir, `${baseName}.json`);
  const tsvPath = path.join(reportsDir, `${baseName}.tsv`);
  const failedChannels = full.channels
    .filter((channel) => channel.error)
    .map((channel) => ({ channelId: channel.channelId, error: channel.error ?? "unknown" }));

  await writeFile(
    jsonPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        cwd: process.cwd(),
        timezone: options.timezone,
        options,
        lookbackDays,
        channels: SLACK_PILOT_4_5_CHANNELS,
        checkpoints: checkpointRows,
        failedChannels,
        fullCollect: full.channels.map((channel) => ({
          channelId: channel.channelId,
          kind: channel.kind,
          mappedInstructorName: channel.mappedInstructorName ?? null,
          messageCount: channel.messages.length,
          distinctUsers: Object.keys(channel.users).length,
          error: channel.error ?? null,
        })),
        rows: orderedRows,
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(tsvPath, toTsv(orderedRows), "utf8");

  const flaggedDays = orderedRows.filter((row) => row.status !== "ok" && row.status !== "empty").length;
  console.log(
    JSON.stringify(
      {
        startDate: options.startDate,
        endDate: options.endDate,
        timezone: options.timezone,
        days: orderedRows.length,
        flaggedDays,
        failedChannels: failedChannels.length,
        jsonReport: jsonPath,
        tsvReport: tsvPath,
      },
      null,
      2
    )
  );

  if (failedChannels.length > 0) {
    process.exitCode = 1;
  }
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
