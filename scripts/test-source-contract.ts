import {
  collectFromContractSheetsWithProgress,
  PILOT_4_1_WORKSHEET_GIDS,
} from "@/lib/pipeline/contract-sheet-collector";
import {
  addLine,
  runSingleSourceAudit,
  summarizePassFail,
  type AuditSection,
  type CheckLine,
  type SourceSyncSnapshot,
} from "./lib/audit-helpers.ts";

async function auditContractSheets(
  syncSnapshots: Record<string, SourceSyncSnapshot>
): Promise<AuditSection> {
  const lines: CheckLine[] = [];
  const progress: Array<{
    gid: number;
    stage: string;
    fetchedCount?: number;
    error?: string | null;
  }> = [];
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

await runSingleSourceAudit(
  "contract_sheet",
  ["contract_sheet"],
  auditContractSheets,
  "external-source-audit-contract.latest.json"
);
