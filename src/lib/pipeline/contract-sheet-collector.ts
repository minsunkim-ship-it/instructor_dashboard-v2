/**
 * Contract Sheet Collector — Pilot 4-1
 *
 * 04_data_pipeline.md 4-1절: Google Sheets API (Service Account)
 * 04_data_pipeline.md 5-1절, 5-1-1절: 헤더 매핑 계약
 * 02_system_architecture.md 11-3절: canonical env 변수
 *
 * Pilot 4-1 확정 계약:
 * - Canonical source: Google Sheets API
 * - Spreadsheet ID: GOOGLE_CONTRACTS_SPREADSHEET_ID
 * - 대상 worksheet: gid=158052384, gid=1875350219
 * - 두 worksheet는 동일 헤더 매핑을 사용한다.
 */

import { google, sheets_v4 } from "googleapis";

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

/**
 * Service Account 자격증명으로 Google Sheets client 생성.
 */
async function getSheetsClient(): Promise<sheets_v4.Sheets> {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_JSON 환경변수가 설정되지 않았습니다."
    );
  }

  let credentials: Record<string, unknown>;
  try {
    credentials = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `GOOGLE_SERVICE_ACCOUNT_JSON 파싱 실패: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });

  return google.sheets({ version: "v4", auth });
}

/**
 * gid로부터 worksheet title 조회.
 * Google Sheets API values.get은 A1 range 문자열에 worksheet title이 필요하다.
 */
async function getSheetTitleByGid(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  gid: number
): Promise<string> {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties",
  });
  const sheet = meta.data.sheets?.find(
    (s: sheets_v4.Schema$Sheet) => s.properties?.sheetId === gid
  );
  const title = sheet?.properties?.title;
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
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  gid: number
): Promise<RawContractRow[]> {
  const title = await getSheetTitleByGid(sheets, spreadsheetId, gid);

  // worksheet 전체 범위 — title만 넘기면 시트 전체를 읽는다.
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${title.replace(/'/g, "''")}'`,
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "FORMATTED_STRING",
  });

  const rawRows = res.data.values ?? [];
  if (rawRows.length === 0) return [];

  // 실제 시트 헤더에는 `\n(ex. ...)` 형태 주석이 포함되는 컬럼이 있음.
  // 문서 5-1-1의 canonical 헤더명(예: `강의 일정`, `기타-계약관련 특이사항 기재`)과
  // 매칭하기 위해 첫 개행 이전 부분만 사용하고 내부 공백을 단일 space로 정규화한다.
  const normalizeHeader = (h: string): string =>
    h.split("\n")[0].replace(/\s+/g, " ").trim();

  const headers: string[] = (rawRows[0] as unknown[]).map((h) =>
    normalizeHeader(String(h ?? ""))
  );

  // 04_data_pipeline.md 5-1-1: `세부 유형` canonical은 `계약서 유형 선택` 바로 다음 occurrence
  // 이를 헤더 인덱스 수준에서 해결한다. 다른 중복 헤더는 첫 occurrence 우선.
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
    // fallback: 첫 occurrence
    canonicalDetailTypeIdx = headers.indexOf("세부 유형");
  }

  const dataRows: RawContractRow[] = [];

  for (let i = 1; i < rawRows.length; i++) {
    const row = rawRows[i] as unknown[];
    const values: Record<string, string> = {};

    for (let j = 0; j < headers.length; j++) {
      const h = headers[j];
      if (!h) continue;

      const cell = String(row?.[j] ?? "").trim();

      if (h === "세부 유형") {
        // canonical detail_type은 특정 인덱스만 사용
        if (j === canonicalDetailTypeIdx && !("세부 유형" in values)) {
          values["세부 유형"] = cell;
        }
        continue;
      }

      // 그 외 헤더: 첫 occurrence 우선
      if (!(h in values)) {
        values[h] = cell;
      }
    }

    dataRows.push({
      spreadsheetId,
      worksheetGid: gid,
      rowNumber: i + 1, // 1-indexed: 헤더가 1행, 데이터는 2행부터
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
  const spreadsheetId = process.env.GOOGLE_CONTRACTS_SPREADSHEET_ID;
  if (!spreadsheetId) {
    throw new Error(
      "GOOGLE_CONTRACTS_SPREADSHEET_ID 환경변수가 설정되지 않았습니다."
    );
  }

  const sheets = await getSheetsClient();

  const worksheets: WorksheetCollectResult[] = [];

  for (const gid of PILOT_4_1_WORKSHEET_GIDS) {
    try {
      const rows = await fetchWorksheet(sheets, spreadsheetId, gid);
      worksheets.push({ gid, fetchedCount: rows.length, rows });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      worksheets.push({ gid, fetchedCount: 0, rows: [], error: msg });
    }
  }

  return { spreadsheetId, worksheets };
}
