import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { prisma } from "@/lib/prisma";
import {
  collectFromContractSheetsWithProgress,
  PILOT_4_1_WORKSHEET_GIDS,
} from "@/lib/pipeline/contract-sheet-collector";
import {
  collectFromGmail,
  GMAIL_ACTIVITY_MAILBOX_QUERY,
  type GmailMailboxCheckpoint,
} from "@/lib/pipeline/gmail-activity-collector";
import {
  collectInstructorDispatchSheets,
  INSTRUCTOR_DISPATCH_SHEET_DEFINITIONS,
} from "@/lib/pipeline/instructor-dispatch-sheet-collector";
import {
  collectSatisfactionFromGmail,
  GMAIL_SATISFACTION_SOURCE_KEY,
} from "@/lib/pipeline/satisfaction-gmail-collector";
import {
  deriveDriveSheetSearchInputFromThread,
  searchDriveSheetCandidateFiles,
} from "@/lib/pipeline/satisfaction-gmail-normalizer";
import {
  ACCESSIBLE_SATISFACTION_SHEET_SOURCES,
  collectSatisfactionSheets,
} from "@/lib/pipeline/satisfaction-sheets-collector";
import {
  collectFromSlack,
  SLACK_PILOT_4_5_CHANNELS,
  type SlackChannelCheckpoint,
} from "@/lib/pipeline/slack-activity-collector";
import { exchangeGoogleUserAccessToken } from "@/lib/google-user-oauth";

type CheckStatus = "pass" | "warn" | "fail";

interface CheckLine {
  status: CheckStatus;
  message: string;
}

interface AuditSection<T = Record<string, unknown>> {
  name: string;
  status: CheckStatus;
  summary: string;
  lines: CheckLine[];
  data: T;
}

interface SourceSyncSnapshot {
  sourceType: string;
  lastStatus: string | null;
  lastFinishedAt: string | null;
  lastFetchedCount: number | null;
  lastUpdatedCount: number | null;
  lastErrorMessage: string | null;
}

interface SourceCheckpointSnapshot {
  sourceType: string;
  scopeKey: string;
  lastSyncedAt: string;
  checkpointJson: unknown;
}

async function safeAudit(
  name: string,
  run: () => Promise<AuditSection>
): Promise<AuditSection> {
  try {
    console.log(`[audit:start] ${name}`);
    const startedAt = Date.now();
    const result = await run();
    console.log(
      `[audit:end] ${name} status=${result.status} elapsed_ms=${Date.now() - startedAt}`
    );
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[audit:error] ${name} ${message}`);
    return {
      name,
      status: "fail",
      summary: `${name} 테스트 실행 실패`,
      lines: [{ status: "fail", message }],
      data: { error: message },
    };
  }
}

function statusRank(status: CheckStatus): number {
  switch (status) {
    case "fail":
      return 2;
    case "warn":
      return 1;
    default:
      return 0;
  }
}

function combineStatus(...statuses: CheckStatus[]): CheckStatus {
  return statuses.reduce<CheckStatus>((current, candidate) => {
    return statusRank(candidate) > statusRank(current) ? candidate : current;
  }, "pass");
}

function summarizePassFail(lines: CheckLine[]): CheckStatus {
  return combineStatus(...lines.map((line) => line.status));
}

function addLine(lines: CheckLine[], status: CheckStatus, message: string): void {
  lines.push({ status, message });
}

async function loadDotEnv(filePath: string): Promise<void> {
  const text = await readFile(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equalIndex = rawLine.indexOf("=");
    if (equalIndex === -1) continue;

    const key = rawLine.slice(0, equalIndex).trim();
    if (!key || process.env[key]) continue;

    let value = rawLine.slice(equalIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value.replace(/\\n/g, "\n");
  }
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

async function loadRecentSourceSyncs(
  sourceTypes: string[]
): Promise<Record<string, SourceSyncSnapshot>> {
  const logs = await prisma.sourceSyncLog.findMany({
    where: { sourceType: { in: sourceTypes } },
    orderBy: [{ finishedAt: "desc" }, { startedAt: "desc" }],
    select: {
      sourceType: true,
      status: true,
      finishedAt: true,
      fetchedCount: true,
      updatedCount: true,
      errorMessage: true,
    },
    take: 50,
  });

  const snapshots: Record<string, SourceSyncSnapshot> = {};
  for (const sourceType of sourceTypes) {
    const match = logs.find((log) => log.sourceType === sourceType) ?? null;
    snapshots[sourceType] = {
      sourceType,
      lastStatus: match?.status ?? null,
      lastFinishedAt: toIso(match?.finishedAt) ?? null,
      lastFetchedCount: match?.fetchedCount ?? null,
      lastUpdatedCount: match?.updatedCount ?? null,
      lastErrorMessage: match?.errorMessage ?? null,
    };
  }

  return snapshots;
}

async function loadCheckpoints(sourceType: "gmail" | "slack"): Promise<
  SourceCheckpointSnapshot[]
> {
  const rows = await prisma.sourceCheckpoint.findMany({
    where: { sourceType },
    orderBy: { scopeKey: "asc" },
    select: {
      sourceType: true,
      scopeKey: true,
      lastSyncedAt: true,
      checkpointJson: true,
    },
  });

  return rows.map((row) => ({
    sourceType: row.sourceType,
    scopeKey: row.scopeKey,
    lastSyncedAt: row.lastSyncedAt.toISOString(),
    checkpointJson: row.checkpointJson,
  }));
}

async function auditContractSheets(
  syncSnapshots: Record<string, SourceSyncSnapshot>
): Promise<AuditSection> {
  const lines: CheckLine[] = [];
  const progress: Array<{ gid: number; stage: string; fetchedCount?: number; error?: string | null }> = [];
  const collected = await collectFromContractSheetsWithProgress({
    onProgress(event) {
      progress.push({
        gid: event.gid,
        stage: event.stage,
        fetchedCount: event.fetchedCount,
        error: event.error ?? null,
      });
    },
  });

  for (const worksheet of collected.worksheets) {
    if (worksheet.error) {
      addLine(
        lines,
        "fail",
        `gid=${worksheet.gid} worksheet 수집 실패: ${worksheet.error}`
      );
      continue;
    }

    if (worksheet.fetchedCount === 0) {
      addLine(lines, "fail", `gid=${worksheet.gid} worksheet row 수집 0건`);
      continue;
    }

    const sampleHeaders = Object.keys(worksheet.rows[0]?.values ?? {});
    const hasContractType = sampleHeaders.includes("계약서 유형 선택");
    const hasDetailType = sampleHeaders.includes("세부 유형");
    addLine(
      lines,
      hasContractType && hasDetailType ? "pass" : "warn",
      `gid=${worksheet.gid} ${worksheet.fetchedCount}건, sample headers=${sampleHeaders
        .slice(0, 8)
        .join(", ")}`
    );
  }

  for (const gid of PILOT_4_1_WORKSHEET_GIDS) {
    if (!collected.worksheets.some((worksheet) => worksheet.gid === gid)) {
      addLine(lines, "fail", `필수 worksheet gid=${gid} 결과 누락`);
    }
  }

  const status = summarizePassFail(lines);
  return {
    name: "contract_sheet",
    status,
    summary: `worksheet ${collected.worksheets.length}개 중 ${collected.worksheets.filter((item) => !item.error && item.fetchedCount > 0).length}개 정상 수집`,
    lines,
    data: {
      spreadsheetId: collected.spreadsheetId,
      recentSync: syncSnapshots.contract_sheet ?? null,
      progress,
      worksheets: collected.worksheets.map((worksheet) => ({
        gid: worksheet.gid,
        fetchedCount: worksheet.fetchedCount,
        error: worksheet.error ?? null,
        sampleRowNumber: worksheet.rows[0]?.rowNumber ?? null,
        sampleHeaders: Object.keys(worksheet.rows[0]?.values ?? {}),
      })),
    },
  };
}

async function auditInstructorDispatchSheets(
  syncSnapshots: Record<string, SourceSyncSnapshot>
): Promise<AuditSection> {
  const lines: CheckLine[] = [];
  const collected = await collectInstructorDispatchSheets();

  for (const result of collected) {
    if (result.error) {
      addLine(
        lines,
        "fail",
        `${result.definition.key} (${result.definition.instructorName}) 수집 실패: ${result.error}`
      );
      continue;
    }

    if (result.fetchedCount === 0) {
      addLine(
        lines,
        "fail",
        `${result.definition.key} (${result.definition.instructorName}) row 수집 0건`
      );
      continue;
    }

    addLine(
      lines,
      "pass",
      `${result.definition.key} (${result.definition.instructorName}) ${result.fetchedCount}건`
    );
  }

  for (const definition of INSTRUCTOR_DISPATCH_SHEET_DEFINITIONS) {
    if (!collected.some((item) => item.definition.key === definition.key)) {
      addLine(lines, "fail", `${definition.key} 결과 누락`);
    }
  }

  const status = summarizePassFail(lines);
  return {
    name: "instructor_dispatch_sheet",
    status,
    summary: `${collected.length}개 출강시트 테스트`,
    lines,
    data: {
      recentSync: syncSnapshots.instructor_dispatch_sheet ?? null,
      definitions: INSTRUCTOR_DISPATCH_SHEET_DEFINITIONS,
      results: collected.map((result) => ({
        key: result.definition.key,
        instructorName: result.definition.instructorName,
        spreadsheetId: result.definition.spreadsheetId,
        worksheetGid: result.definition.worksheetGid,
        fetchedCount: result.fetchedCount,
        error: result.error ?? null,
        sampleHeaders: Object.keys(result.rows[0]?.values ?? {}),
      })),
    },
  };
}

async function auditSatisfactionSheets(
  syncSnapshots: Record<string, SourceSyncSnapshot>
): Promise<AuditSection> {
  const lines: CheckLine[] = [];
  const collected = await collectSatisfactionSheets();

  for (const result of collected) {
    if (result.error) {
      addLine(lines, "fail", `${result.definition.key} 수집 실패: ${result.error}`);
      continue;
    }

    if (result.rows.length === 0) {
      addLine(lines, "fail", `${result.definition.key} row 수집 0건`);
      continue;
    }

    addLine(
      lines,
      "pass",
      `${result.definition.key} (${result.definition.range}) ${result.rows.length}행`
    );
  }

  for (const definition of ACCESSIBLE_SATISFACTION_SHEET_SOURCES) {
    if (!collected.some((item) => item.definition.key === definition.key)) {
      addLine(lines, "fail", `${definition.key} 결과 누락`);
    }
  }

  const status = summarizePassFail(lines);
  return {
    name: "satisfaction_sheets",
    status,
    summary: `${collected.length}개 만족도 스프레드시트 테스트`,
    lines,
    data: {
      recentSync: syncSnapshots.satisfaction ?? null,
      sources: collected.map((result) => ({
        key: result.definition.key,
        sourceType: result.definition.sourceType,
        spreadsheetId: result.definition.spreadsheetId,
        worksheetGid: result.definition.worksheetGid,
        title: result.definition.title,
        range: result.definition.range,
        rowCount: result.rows.length,
        error: result.error ?? null,
        sampleRowWidth: result.rows[0]?.length ?? 0,
      })),
    },
  };
}

function checkpointToSlackOldest(
  checkpoint: SlackChannelCheckpoint | null,
  overlapSeconds: number
): string | null {
  if (!checkpoint?.lastSeenTs) return null;
  const epoch = Number.parseFloat(checkpoint.lastSeenTs);
  if (!Number.isFinite(epoch) || epoch <= 0) return null;
  return (epoch - overlapSeconds).toFixed(6);
}

async function auditSlack(
  syncSnapshots: Record<string, SourceSyncSnapshot>
): Promise<AuditSection> {
  const lines: CheckLine[] = [];
  const checkpointRows = await loadCheckpoints("slack");
  const checkpoints: SlackChannelCheckpoint[] = checkpointRows.map((row) => ({
    channelId: row.scopeKey.replace(/^slack:channel:/, ""),
    lastSeenTs:
      typeof (row.checkpointJson as Record<string, unknown>)?.last_seen_ts === "string"
        ? String((row.checkpointJson as Record<string, unknown>).last_seen_ts)
        : null,
  }));

  const full = await collectFromSlack({
    checkpoints: [],
    fullBackfillMaxPages: 15,
    perPageLimit: 200,
  });
  const incremental = await collectFromSlack({
    checkpoints,
    incrementalMaxPages: 5,
    perPageLimit: 200,
  });

  for (const channel of full.channels) {
    if (channel.error) {
      addLine(lines, "fail", `Slack ${channel.channelId} full backfill 실패: ${channel.error}`);
      continue;
    }
    if (channel.messages.length === 0) {
      addLine(lines, "fail", `Slack ${channel.channelId} full backfill 메시지 0건`);
      continue;
    }
    addLine(
      lines,
      "pass",
      `Slack ${channel.channelId} full=${channel.messages.length} / incremental=${
        incremental.channels.find((item) => item.channelId === channel.channelId)?.messages.length ?? 0
      }`
    );
  }

  if (full.channels.every((channel) => channel.error)) {
    addLine(lines, "fail", "Slack canonical channel 3개 전부 접근 실패");
  }

  const status = summarizePassFail(lines);
  return {
    name: "slack",
    status,
    summary: `full backfill ${full.channels.reduce((sum, channel) => sum + channel.messages.length, 0)}건, incremental ${incremental.channels.reduce((sum, channel) => sum + channel.messages.length, 0)}건`,
    lines,
    data: {
      recentSync: syncSnapshots.slack ?? null,
      checkpoints: checkpointRows,
      channels: SLACK_PILOT_4_5_CHANNELS,
      overlapSeconds: 600,
      full: full.channels.map((channel) => ({
        channelId: channel.channelId,
        kind: channel.kind,
        mappedInstructorName: channel.mappedInstructorName ?? null,
        messageCount: channel.messages.length,
        distinctUsers: Object.keys(channel.users).length,
        error: channel.error ?? null,
      })),
      incremental: incremental.channels.map((channel) => {
        const checkpoint = checkpoints.find((item) => item.channelId === channel.channelId) ?? null;
        return {
          channelId: channel.channelId,
          kind: channel.kind,
          mappedInstructorName: channel.mappedInstructorName ?? null,
          checkpointLastSeenTs: checkpoint?.lastSeenTs ?? null,
          oldestUsed: checkpointToSlackOldest(checkpoint, 600),
          messageCount: channel.messages.length,
          distinctUsers: Object.keys(channel.users).length,
          error: channel.error ?? null,
        };
      }),
    },
  };
}

async function loadGmailCollectorCheckpoints(): Promise<GmailMailboxCheckpoint | null> {
  const rows = await loadCheckpoints("gmail");
  const mailboxRow = rows.find((row) => row.scopeKey === "gmail:mailbox");
  if (!mailboxRow) return null;
  return {
    lastInternalDateMs:
      typeof (mailboxRow.checkpointJson as Record<string, unknown>)?.last_internal_date_ms ===
      "string"
        ? String((mailboxRow.checkpointJson as Record<string, unknown>).last_internal_date_ms)
        : null,
  };
}

async function auditGmail(
  syncSnapshots: Record<string, SourceSyncSnapshot>
): Promise<AuditSection> {
  const lines: CheckLine[] = [];
  const checkpoints = await loadGmailCollectorCheckpoints();
  const checkpointRows = await loadCheckpoints("gmail");
  const full = await collectFromGmail({
    checkpoint: null,
    maxPages: 3,
    pageSize: 50,
    requestTimeoutMs: 8_000,
    mailboxTimeoutMs: 15_000,
    threadFetchConcurrency: 6,
  });
  const incremental = await collectFromGmail({
    checkpoint: checkpoints,
    maxPages: 2,
    pageSize: 50,
    requestTimeoutMs: 8_000,
    mailboxTimeoutMs: 15_000,
    threadFetchConcurrency: 6,
  });

  if (full.threads.length === 0) {
    addLine(lines, "fail", "Gmail full backfill thread 0건");
  } else {
    addLine(
      lines,
      "pass",
      `Gmail full=${full.threads.length} / incremental=${incremental.threads.length}`
    );
  }

  const status = summarizePassFail(lines);
  return {
    name: "gmail",
    status,
    summary: `full backfill ${full.threads.length} threads, incremental ${incremental.threads.length} threads`,
    lines,
    data: {
      recentSync: syncSnapshots.gmail ?? null,
      query: GMAIL_ACTIVITY_MAILBOX_QUERY,
      checkpointRows,
      full: {
        threadCount: full.threads.length,
        samples: full.threads.slice(0, 5).map((thread) => ({
          threadId: thread.threadId,
          mailboxQuery: thread.mailboxQuery,
          subject: thread.subject,
          from: thread.from,
          to: thread.to,
          lastInternalDateMs: thread.lastInternalDateMs,
        })),
      },
      incremental: {
        threadCount: incremental.threads.length,
        mailboxQuery: incremental.mailboxQuery,
        checkpoint: checkpoints,
      },
    },
  };
}

async function auditGmailSatisfactionAndDrive(
  syncSnapshots: Record<string, SourceSyncSnapshot>
): Promise<AuditSection> {
  const lines: CheckLine[] = [];
  const collected = await collectSatisfactionFromGmail({
    maxPages: 2,
    pageSize: 25,
    detailConcurrency: 4,
    listRequestTimeoutMs: 8_000,
    detailRequestTimeoutMs: 8_000,
  });

  if (collected.threads.length === 0) {
    addLine(lines, "fail", "Gmail satisfaction thread 0건");
    return {
      name: "gmail_satisfaction_drive",
      status: summarizePassFail(lines),
      summary: "Gmail satisfaction thread 없음",
      lines,
      data: {
        recentSync: syncSnapshots.satisfaction ?? null,
        sourceKey: GMAIL_SATISFACTION_SOURCE_KEY,
        query: collected.query,
        threadCount: 0,
        driveSamples: [],
      },
    };
  }

  addLine(lines, "pass", `Gmail satisfaction ${collected.threads.length} threads`);

  const accessToken = await exchangeGoogleUserAccessToken();
  const driveSamples: Array<{
    threadId: string;
    subject: string | null;
    companyName: string | null;
    courseName: string | null;
    courseTokens: string[];
    queries: Array<{ label: string; query: string }>;
    files: Array<{ id: string; name: string | null; mimeType: string | null; sheetTitles: string[] }>;
  }> = [];
  const seenKeys = new Set<string>();

  for (const thread of collected.threads) {
    const input = deriveDriveSheetSearchInputFromThread(thread);
    if (!input.companyName || !input.courseName) continue;
    const dedupeKey = `${input.companyName}::${input.courseName}`;
    if (seenKeys.has(dedupeKey)) continue;
    seenKeys.add(dedupeKey);

    const result = await searchDriveSheetCandidateFiles({
      accessToken,
      companyName: input.companyName,
      courseName: input.courseName,
      pageSize: 5,
      includeSheetTitles: true,
    });

    driveSamples.push({
      threadId: thread.threadId,
      subject: thread.subject,
      companyName: result.input.companyName,
      courseName: result.input.courseName,
      courseTokens: result.input.courseTokens,
      queries: result.queries,
      files: result.files,
    });

    if (driveSamples.length >= 3) break;
  }

  if (driveSamples.length === 0) {
    addLine(lines, "warn", "Drive probe용 company/course를 Gmail satisfaction thread에서 추출하지 못함");
  } else {
    for (const sample of driveSamples) {
      addLine(
        lines,
        sample.files.length > 0 ? "pass" : "warn",
        `Drive probe ${sample.companyName} / ${sample.courseName}: ${sample.files.length}개 파일`
      );
    }
  }

  const status = summarizePassFail(lines);
  return {
    name: "gmail_satisfaction_drive",
    status,
    summary: `Gmail satisfaction ${collected.threads.length} threads, Drive probe ${driveSamples.length}개`,
    lines,
    data: {
      recentSync: syncSnapshots.satisfaction ?? null,
      sourceKey: GMAIL_SATISFACTION_SOURCE_KEY,
      query: collected.query,
      threadCount: collected.threads.length,
      incremental: collected.incremental,
      threadSamples: collected.threads.slice(0, 5).map((thread) => ({
        threadId: thread.threadId,
        subject: thread.subject,
        from: thread.from,
        sentAt: thread.sentAt,
      })),
      driveSamples,
    },
  };
}

function buildSummary(sections: AuditSection[]): {
  status: CheckStatus;
  passed: number;
  warned: number;
  failed: number;
} {
  let passed = 0;
  let warned = 0;
  let failed = 0;

  for (const section of sections) {
    if (section.status === "pass") passed += 1;
    if (section.status === "warn") warned += 1;
    if (section.status === "fail") failed += 1;
  }

  return {
    status: combineStatus(...sections.map((section) => section.status)),
    passed,
    warned,
    failed,
  };
}

async function main() {
  await loadDotEnv(path.join(process.cwd(), ".env"));

  const sourceTypes = [
    "contract_sheet",
    "instructor_dispatch_sheet",
    "slack",
    "gmail",
    "satisfaction",
  ];
  const syncSnapshots = await loadRecentSourceSyncs(sourceTypes);

  const sections = [
    await safeAudit("contract_sheet", () => auditContractSheets(syncSnapshots)),
    await safeAudit("instructor_dispatch_sheet", () =>
      auditInstructorDispatchSheets(syncSnapshots)
    ),
    await safeAudit("satisfaction_sheets", () =>
      auditSatisfactionSheets(syncSnapshots)
    ),
    await safeAudit("slack", () => auditSlack(syncSnapshots)),
    await safeAudit("gmail", () => auditGmail(syncSnapshots)),
    await safeAudit("gmail_satisfaction_drive", () =>
      auditGmailSatisfactionAndDrive(syncSnapshots)
    ),
  ];

  const report = {
    generatedAt: new Date().toISOString(),
    cwd: process.cwd(),
    command:
      "node --experimental-strip-types --loader ./scripts/ts-path-loader.mjs ./scripts/test-external-sources.ts",
    summary: buildSummary(sections),
    sections,
  };

  const reportsDir = path.join(process.cwd(), "reports");
  await mkdir(reportsDir, { recursive: true });
  const jsonPath = path.join(reportsDir, "external-source-audit.latest.json");
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(JSON.stringify(report.summary, null, 2));
  console.log(`JSON report written to ${jsonPath}`);

  if (report.summary.failed > 0) {
    process.exitCode = 1;
  }
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
