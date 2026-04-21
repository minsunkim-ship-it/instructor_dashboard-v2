import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { prisma } from "@/lib/prisma";

export type CheckStatus = "pass" | "warn" | "fail";

export interface CheckLine {
  status: CheckStatus;
  message: string;
}

export interface AuditSection<T = Record<string, unknown>> {
  name: string;
  status: CheckStatus;
  summary: string;
  lines: CheckLine[];
  data: T;
}

export interface SourceSyncSnapshot {
  sourceType: string;
  lastStatus: string | null;
  lastFinishedAt: string | null;
  lastFetchedCount: number | null;
  lastUpdatedCount: number | null;
  lastErrorMessage: string | null;
}

export interface SourceCheckpointSnapshot {
  sourceType: string;
  scopeKey: string;
  lastSyncedAt: string;
  checkpointJson: unknown;
}

export async function safeAudit(
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

export function statusRank(status: CheckStatus): number {
  switch (status) {
    case "fail":
      return 2;
    case "warn":
      return 1;
    default:
      return 0;
  }
}

export function combineStatus(...statuses: CheckStatus[]): CheckStatus {
  return statuses.reduce<CheckStatus>((current, candidate) => {
    return statusRank(candidate) > statusRank(current) ? candidate : current;
  }, "pass");
}

export function summarizePassFail(lines: CheckLine[]): CheckStatus {
  return combineStatus(...lines.map((line) => line.status));
}

export function addLine(
  lines: CheckLine[],
  status: CheckStatus,
  message: string
): void {
  lines.push({ status, message });
}

export async function loadDotEnv(filePath: string): Promise<void> {
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

export function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

export async function loadRecentSourceSyncs(
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

export async function loadCheckpoints(
  sourceType: "gmail" | "slack"
): Promise<SourceCheckpointSnapshot[]> {
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

export async function writeSectionReport(
  section: AuditSection,
  filename: string
): Promise<string> {
  const reportsDir = path.join(process.cwd(), "reports");
  await mkdir(reportsDir, { recursive: true });
  const jsonPath = path.join(reportsDir, filename);
  const report = {
    generatedAt: new Date().toISOString(),
    cwd: process.cwd(),
    section,
  };
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return jsonPath;
}

export async function runSingleSourceAudit(
  sourceName: string,
  syncSourceTypes: string[],
  auditFn: (
    syncSnapshots: Record<string, SourceSyncSnapshot>
  ) => Promise<AuditSection>,
  reportFilename: string
): Promise<void> {
  await loadDotEnv(path.join(process.cwd(), ".env"));
  try {
    const syncSnapshots = await loadRecentSourceSyncs(syncSourceTypes);
    const section = await safeAudit(sourceName, () => auditFn(syncSnapshots));
    const jsonPath = await writeSectionReport(section, reportFilename);

    console.log(JSON.stringify({ name: section.name, status: section.status, summary: section.summary }, null, 2));
    console.log(`JSON report written to ${jsonPath}`);

    if (section.status === "fail") {
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}
