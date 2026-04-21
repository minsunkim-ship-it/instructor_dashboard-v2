/**
 * Contract Sheet Collector — Pilot 4-1
 *
 * 04_data_pipeline.md 4-1절: Google Sheets API
 * 04_data_pipeline.md 5-1절, 5-1-1절: 헤더 매핑 계약
 *
 * 현재 구현:
 * - 계약시트 접근은 Google user OAuth refresh token 경로를 사용한다.
 * - 인증 helper는 `src/lib/google-user-oauth.ts`를 따른다.
 *
 * Pilot 4-1 확정 계약:
 * - Canonical source: Google Sheets API
 * - Spreadsheet ID: GOOGLE_CONTRACTS_SPREADSHEET_ID
 * - 대상 worksheet: gid=158052384, gid=1875350219
 * - 두 worksheet는 동일 헤더 매핑을 사용한다.
 */

import {
  exchangeGoogleUserAccessToken,
  googleApiGet,
} from "@/lib/google-user-oauth";

const SHEETS_API_BASE = "https://sheets.googleapis.com/v4";
const GOOGLE_SHEETS_REQUEST_TIMEOUT_MS = 20_000;

// Pilot 4-1 대상 worksheet gid 목록
export const PILOT_4_1_WORKSHEET_GIDS = [158052384, 1875350219] as const;

/**
 * 계약시트 1행에 대응하는 원문 수집 결과.
 * source_ref dedupe 식별자(spreadsheetId, worksheetGid, rowNumber)를 포함한다.
 */
export interface RawContractRow {
  spreadsheetId: string;
  worksheetGid: number;
  /** 스프레드시트 1-indexed 행 번호 (헤더는 1행, 데이터는 2행부터) */
  rowNumber: number;
  /** 헤더명 → 셀 값 */
  values: Record<string, string>;
}

export interface WorksheetCollectResult {
  gid: number;
  fetchedCount: number;
  rows: RawContractRow[];
  error?: string;
}

export interface CollectResult {
  spreadsheetId: string;
  worksheets: WorksheetCollectResult[];
}

export interface ContractSheetCollectProgressEvent {
  gid: number;
  stage: "collect_start" | "collect_complete";
  fetchedCount?: number;
  error?: string | null;
}

interface SpreadsheetMetaResponse {
  sheets?: Array<{
    properties?: {
      sheetId?: number;
      title?: string;
    };
  }>;
}

function normalizeHeader(value: unknown): string {
  return String(value ?? "")
    .split("\n")[0]
    .replace(/\s+/g, " ")
    .trim();
}

const NON_MEANINGFUL_FALSE_HEADERS = new Set([
  "계약",
  "계약 백오피스",
  "계약서작성",
  "최종완료",
  "신규강사 여부",
]);

function isNonMeaningfulCell(header: string, value: string): boolean {
  if (!value) return true;
  if (/^#(?:REF|N\/A|VALUE|ERROR|NAME\?|DIV\/0)!/i.test(value)) {
    return true;
  }
  if (
    NON_MEANINGFUL_FALSE_HEADERS.has(header) &&
    value.toLowerCase() === "false"
  ) {
    return true;
  }
  return false;
}

function isPlaceholderContractRow(values: Record<string, string>): boolean {
  const entries = Object.entries(values);
  if (entries.length === 0) return true;
  return entries.every(([header, value]) => isNonMeaningfulCell(header, value));
}

async function getSheetTitleByGid(
  accessToken: string,
  spreadsheetId: string,
  gid: number
): Promise<string> {
  const meta = await googleApiGet<SpreadsheetMetaResponse>(
    accessToken,
    SHEETS_API_BASE,
    `/spreadsheets/${spreadsheetId}`,
    { fields: "sheets.properties" },
    { timeoutMs: GOOGLE_SHEETS_REQUEST_TIMEOUT_MS }
  );

  const sheet = meta.sheets?.find(
    (entry) => entry.properties?.sheetId === gid
  );
  const title = sheet?.properties?.title?.trim();

  if (!title) {
    throw new Error(
      `spreadsheet ${spreadsheetId}에서 gid=${gid} worksheet를 찾을 수 없습니다.`
    );
  }

  return title;
}

/**
 * 단일 worksheet에서 모든 행을 수집한다.
 *
 * - 1행(헤더)을 키로 사용해 각 데이터 행을 `Record<header, cell>`로 변환한다.
 * - 동일 헤더명이 중복 등장하는 경우 첫 번째 occurrence를 canonical로 사용한다.
 *   (04_data_pipeline.md 5-1-1: `세부 유형`은 `계약서 유형 선택` 바로 다음의 첫 번째 occurrence)
 * - 헤더가 빈 문자열인 열은 건너뛴다.
 */
async function fetchWorksheet(
  accessToken: string,
  spreadsheetId: string,
  gid: number
): Promise<RawContractRow[]> {
  const title = await getSheetTitleByGid(accessToken, spreadsheetId, gid);
  const data = await googleApiGet<{ values?: unknown[][] }>(
    accessToken,
    SHEETS_API_BASE,
    `/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(
      `'${title.replace(/'/g, "''")}'`
    )}`,
    {
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "FORMATTED_STRING",
    },
    { timeoutMs: GOOGLE_SHEETS_REQUEST_TIMEOUT_MS }
  );

  const rawRows = data.values ?? [];
  if (rawRows.length === 0) return [];

  const headers: string[] = (rawRows[0] as unknown[]).map(normalizeHeader);

  const contractTypeIdx = headers.indexOf("계약서 유형 선택");
  let canonicalDetailTypeIdx = -1;
  if (contractTypeIdx >= 0) {
    for (let i = contractTypeIdx + 1; i < headers.length; i++) {
      if (headers[i] === "세부 유형") {
        canonicalDetailTypeIdx = i;
        break;
      }
    }
  }
  if (canonicalDetailTypeIdx === -1) {
    canonicalDetailTypeIdx = headers.indexOf("세부 유형");
  }

  const dataRows: RawContractRow[] = [];

  for (let i = 1; i < rawRows.length; i++) {
    const row = rawRows[i] as unknown[];
    const values: Record<string, string> = {};

    for (let j = 0; j < headers.length; j++) {
      const header = headers[j];
      if (!header) continue;

      const cell = String(row?.[j] ?? "").trim();

      if (header === "세부 유형") {
        if (j === canonicalDetailTypeIdx && !("세부 유형" in values)) {
          values["세부 유형"] = cell;
        }
        continue;
      }

      if (!(header in values)) {
        values[header] = cell;
      }
    }

    if (isPlaceholderContractRow(values)) {
      continue;
    }

    dataRows.push({
      spreadsheetId,
      worksheetGid: gid,
      rowNumber: i + 1,
      values,
    });
  }

  return dataRows;
}

/**
 * Pilot 4-1 대상 두 worksheet에서 모든 데이터를 수집한다.
 * worksheet별 결과를 분리 반환해 source_sync_logs에 per-worksheet로 기록할 수 있도록 한다.
 */
export async function collectFromContractSheets(): Promise<CollectResult> {
  return collectFromContractSheetsWithProgress();
}

export async function collectFromContractSheetsWithProgress(options?: {
  onProgress?: (
    event: ContractSheetCollectProgressEvent
  ) => Promise<void> | void;
}): Promise<CollectResult> {
  const spreadsheetId = process.env.GOOGLE_CONTRACTS_SPREADSHEET_ID;
  if (!spreadsheetId) {
    throw new Error(
      "GOOGLE_CONTRACTS_SPREADSHEET_ID 환경변수가 설정되지 않았습니다."
    );
  }

  const accessToken = await exchangeGoogleUserAccessToken();
  // worksheet fetch는 병렬로 실행된다. onProgress 이벤트는 worksheet 간에
  // interleave될 수 있으며, gid별 진행 상태는 event.gid로 구분해야 한다.
  // (정확성 영향 없음, 관찰성 트레이드오프)
  const worksheets = await Promise.all(
    PILOT_4_1_WORKSHEET_GIDS.map(async (gid): Promise<WorksheetCollectResult> => {
      await options?.onProgress?.({
        gid,
        stage: "collect_start",
      });

      try {
        const rows = await fetchWorksheet(accessToken, spreadsheetId, gid);
        await options?.onProgress?.({
          gid,
          stage: "collect_complete",
          fetchedCount: rows.length,
          error: null,
        });
        return { gid, fetchedCount: rows.length, rows };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await options?.onProgress?.({
          gid,
          stage: "collect_complete",
          fetchedCount: 0,
          error: message,
        });
        return {
          gid,
          fetchedCount: 0,
          rows: [],
          error: message,
        };
      }
    })
  );

  return { spreadsheetId, worksheets };
}
