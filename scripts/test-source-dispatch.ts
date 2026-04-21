import {
  collectInstructorDispatchSheets,
  INSTRUCTOR_DISPATCH_SHEET_DEFINITIONS,
} from "@/lib/pipeline/instructor-dispatch-sheet-collector";
import {
  addLine,
  runSingleSourceAudit,
  summarizePassFail,
  type AuditSection,
  type CheckLine,
  type SourceSyncSnapshot,
} from "./lib/audit-helpers.ts";

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

await runSingleSourceAudit(
  "instructor_dispatch_sheet",
  ["instructor_dispatch_sheet"],
  auditInstructorDispatchSheets,
  "external-source-audit-dispatch.latest.json"
);
