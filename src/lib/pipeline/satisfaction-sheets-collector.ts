import {
  exchangeGoogleUserAccessToken,
  googleApiGet,
} from "@/lib/google-user-oauth";

const SHEETS_API_BASE = "https://sheets.googleapis.com/v4";

export interface SatisfactionSheetSourceDefinition {
  key: string;
  sourceType: "sheet_summary" | "google_forms";
  spreadsheetId: string;
  worksheetGid: number;
  title: string;
  range: string;
}

export interface SatisfactionSheetCollectResult {
  definition: SatisfactionSheetSourceDefinition;
  rows: string[][];
  error?: string;
}

export const ACCESSIBLE_SATISFACTION_SHEET_SOURCES: SatisfactionSheetSourceDefinition[] = [
  {
    key: "kt_ai_campus",
    sourceType: "sheet_summary",
    spreadsheetId: "1nXK-uXlBIYbPtRpTPSk2t9l5MJFJmCUAwYFzoDbaf3s",
    worksheetGid: 1459556567,
    title: "만족도조사 결과",
    range: "만족도조사 결과!A1:AB1000",
  },
  {
    key: "hyundai_mobis_llm",
    sourceType: "sheet_summary",
    spreadsheetId: "1hyTlx8sHf-YgqCduFG6WyUZbTW7LRKLgr-74Ug16tDo",
    worksheetGid: 0,
    title: "LLM 만족도 종합",
    range: "시트1!A1:Z1000",
  },
  {
    key: "hyundai_mobis_llm_2",
    sourceType: "google_forms",
    spreadsheetId: "1lBcnn_IiEdAYLF_-36l5McFUtRgDU-aYsFfSUpDd1gs",
    worksheetGid: 0,
    title: "LLM 2차수",
    range: "시트1!A1:Z1000",
  },
  {
    key: "hyundai_mobis_llm_3",
    sourceType: "google_forms",
    spreadsheetId: "1KNgGwYWdieFnfrz64gvz6l_oqIRSkePhy2cpdIzh1L0",
    worksheetGid: 952068825,
    title: "LLM 3차수 응답",
    range: "설문지 응답 시트1!A1:H1000",
  },
  {
    key: "hyundai_mobis_llm_4",
    sourceType: "google_forms",
    spreadsheetId: "170_wjDPSZGo6NeKDiC9CpmUwoApBBJeoeCJ5U1PHQbI",
    worksheetGid: 0,
    title: "LLM 4차수",
    range: "A1:H1000",
  },
  {
    key: "woori_ax_forms",
    sourceType: "google_forms",
    spreadsheetId: "19v7sdw0w6D1f-t91ptvUM5hzPbyngPgkgSHhVI1l9aM",
    worksheetGid: 777556001,
    title: "(공유) 설문지 응답 시트",
    range: "(공유) 설문지 응답 시트!A1:AB1000",
  },
];

async function sheetsValuesGet(
  accessToken: string,
  spreadsheetId: string,
  range: string
): Promise<string[][]> {
  const data = await googleApiGet<{ values?: string[][] }>(
    accessToken,
    SHEETS_API_BASE,
    `/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`
  );
  return data.values ?? [];
}

export async function collectSatisfactionSheets(options?: {
  includeKeys?: SatisfactionSheetSourceDefinition["key"][];
}): Promise<SatisfactionSheetCollectResult[]> {
  const accessToken = await exchangeGoogleUserAccessToken();
  const sources = options?.includeKeys?.length
    ? ACCESSIBLE_SATISFACTION_SHEET_SOURCES.filter((source) =>
        options.includeKeys?.includes(source.key)
      )
    : ACCESSIBLE_SATISFACTION_SHEET_SOURCES;

  return Promise.all(
    sources.map(async (definition) => {
      try {
        const rows = await sheetsValuesGet(
          accessToken,
          definition.spreadsheetId,
          definition.range
        );
        return { definition, rows };
      } catch (error) {
        return {
          definition,
          rows: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })
  );
}
