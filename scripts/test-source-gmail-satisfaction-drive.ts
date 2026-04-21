import {
  collectSatisfactionFromGmail,
  GMAIL_SATISFACTION_SOURCE_KEY,
} from "@/lib/pipeline/satisfaction-gmail-collector";
import {
  deriveDriveSheetSearchInputFromThread,
  searchDriveSheetCandidateFiles,
} from "@/lib/pipeline/satisfaction-gmail-normalizer";
import { exchangeGoogleUserAccessToken } from "@/lib/google-user-oauth";
import {
  addLine,
  runSingleSourceAudit,
  summarizePassFail,
  type AuditSection,
  type CheckLine,
  type SourceSyncSnapshot,
} from "./lib/audit-helpers.ts";

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

await runSingleSourceAudit(
  "gmail_satisfaction_drive",
  ["satisfaction"],
  auditGmailSatisfactionAndDrive,
  "external-source-audit-gmail-satisfaction-drive.latest.json"
);
