import {
  ACCESSIBLE_SATISFACTION_SHEET_SOURCES,
  collectSatisfactionSheets,
} from "@/lib/pipeline/satisfaction-sheets-collector";
import {
  addLine,
  runSingleSourceAudit,
  summarizePassFail,
  type AuditSection,
  type CheckLine,
  type SourceSyncSnapshot,
} from "./lib/audit-helpers.ts";

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

await runSingleSourceAudit(
  "satisfaction_sheets",
  ["satisfaction"],
  auditSatisfactionSheets,
  "external-source-audit-satisfaction-sheets.latest.json"
);
