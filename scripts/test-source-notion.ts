import {
  collectFromNotionWithProgress,
  resolveNotionCollectorConfig,
} from "@/lib/pipeline/notion-collector";
import { normalizeNotionData } from "@/lib/pipeline/normalizer";
import { prisma } from "@/lib/prisma";
import {
  addLine,
  runSingleSourceAudit,
  summarizePassFail,
  type AuditSection,
  type CheckLine,
  type SourceSyncSnapshot,
} from "./lib/audit-helpers.ts";

async function auditNotion(
  syncSnapshots: Record<string, SourceSyncSnapshot>
): Promise<AuditSection> {
  const lines: CheckLine[] = [];
  const notionConfig = resolveNotionCollectorConfig();
  const progress: Array<{
    stage: string;
    page: number;
    fetchedPages: number;
    fetchedRows: number;
  }> = [];

  const rawData = await collectFromNotionWithProgress({
    onProgress(event) {
      progress.push({
        stage: event.stage,
        page: event.page,
        fetchedPages: event.fetchedPages,
        fetchedRows: event.fetchedRows,
      });
    },
  });

  if (rawData.length === 0) {
    addLine(lines, "fail", "Notion 수집 0건");
  } else {
    addLine(lines, "pass", `Notion raw ${rawData.length}건 수집`);
  }

  const normalized = normalizeNotionData(rawData);
  if (normalized.length === 0) {
    addLine(lines, "fail", "Notion 정규화 결과 0건");
  } else {
    addLine(lines, "pass", `Notion normalized ${normalized.length}건`);
  }

  const rawNames = rawData
    .map((row) => row.name?.trim())
    .filter((value): value is string => Boolean(value));
  const distinctNames = new Set(rawNames);
  const duplicateSourceNames = rawNames.length - distinctNames.size;
  if (duplicateSourceNames > 0) {
    addLine(lines, "warn", `Notion source duplicate names ${duplicateSourceNames}건`);
  }

  const notionLinkCount = await prisma.sourceLink.count({
    where: { sourceType: "notion" },
  });
  const notionLinkedInstructorCount = await prisma.instructor.count({
    where: {
      sourceLinks: {
        some: { sourceType: "notion" },
      },
    },
  });

  if (notionLinkCount === 0) {
    addLine(lines, "fail", "Notion source_link 0건");
  } else {
    addLine(
      lines,
      "pass",
      `Notion source_link ${notionLinkCount}건 / linked instructors ${notionLinkedInstructorCount}건`
    );
  }

  const status = summarizePassFail(lines);
  return {
    name: "notion",
    status,
    summary: `Notion raw ${rawData.length}건, normalized ${normalized.length}건`,
    lines,
    data: {
      databaseId: notionConfig.databaseId,
      recentSync: syncSnapshots.notion ?? null,
      progress,
      rawCount: rawData.length,
      normalizedCount: normalized.length,
      missingNameCount: rawData.filter((row) => !row.name?.trim()).length,
      duplicateSourceNames,
      notionLinkCount,
      notionLinkedInstructorCount,
      sampleRows: rawData.slice(0, 5).map((row) => ({
        notionPageId: row.notionPageId,
        name: row.name,
        affiliation: row.affiliation,
        categories: row.categories,
      })),
    },
  };
}

await runSingleSourceAudit(
  "notion",
  ["notion"],
  auditNotion,
  "external-source-audit-notion.latest.json"
);
