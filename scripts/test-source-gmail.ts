import {
  collectFromGmail,
  GMAIL_ACTIVITY_MAILBOX_QUERY,
  type GmailMailboxCheckpoint,
} from "@/lib/pipeline/gmail-activity-collector";
import {
  addLine,
  loadCheckpoints,
  runSingleSourceAudit,
  summarizePassFail,
  type AuditSection,
  type CheckLine,
  type SourceSyncSnapshot,
} from "./lib/audit-helpers.ts";

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

await runSingleSourceAudit(
  "gmail",
  ["gmail"],
  auditGmail,
  "external-source-audit-gmail.latest.json"
);
