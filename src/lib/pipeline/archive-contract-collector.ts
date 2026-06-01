/**
 * Archive Contract Collector — Phase 1-5
 *
 * 사용자가 2026-05-26에 알려준 archive 계약시트:
 *   "★조교 계약 작성 요청_B2B교육사업본부_DT기업교육팀.xlsx"
 *   ID: 1hl6VxXYN1kJoQlRCpbpyWV2PFsu3LhFQ
 *   2024년 8월 이전 강사 강의 이력 archive.
 *
 * mimeType이 xlsx (Office file)이라 Sheets API로 직접 read 불가.
 * Drive API로 binary download → xlsx-minimal-reader로 파싱.
 *
 * 헤더가 NEW 계약시트와 유사 (강사명/강의 일정/총 강의 시수 등)이라
 * 정규화는 단순 매핑만 수행.
 */
import {
  exchangeGoogleUserAccessToken,
} from "@/lib/google-user-oauth";
import { parseXlsxBufferAllSheets } from "@/lib/xlsx-minimal-reader";

const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";

export const ARCHIVE_CONTRACT_FILE_ID = "1hl6VxXYN1kJoQlRCpbpyWV2PFsu3LhFQ";

export interface RawArchiveRow {
  fileId: string;
  sheetName: string;
  rowNumber: number;
  values: Record<string, string>;
}

export interface ArchiveSheetCollectResult {
  fileId: string;
  sheetName: string;
  fetchedCount: number;
  rows: RawArchiveRow[];
  error?: string;
}

export interface ArchiveContractCollectResult {
  fileId: string;
  sheets: ArchiveSheetCollectResult[];
}

async function downloadDriveFileBytes(
  accessToken: string,
  fileId: string
): Promise<Buffer> {
  const url = `${DRIVE_API_BASE}/files/${fileId}?alt=media&supportsAllDrives=true`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Drive download failed (${res.status}): ${text}`);
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

function normalizeHeader(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * archive 시트의 헤더 row를 자동 detect.
 * "강사명" 또는 "강의 일정"·"날짜"·"시간당 강사료" 중 2개 이상 포함된 row.
 */
function detectHeaderRowIndex(rows: string[][]): number {
  const SIGNAL = ["강사명", "강의 일정", "강의일정", "시간당 강사료", "총 강의 시수", "카테고리"];
  const limit = Math.min(rows.length, 15);
  for (let i = 0; i < limit; i++) {
    const cells = rows[i].map(normalizeHeader);
    const hits = SIGNAL.filter((s) => cells.includes(s)).length;
    if (hits >= 2) return i;
  }
  return -1;
}

export async function collectArchiveContract(): Promise<ArchiveContractCollectResult> {
  const accessToken = await exchangeGoogleUserAccessToken();
  const bytes = await downloadDriveFileBytes(accessToken, ARCHIVE_CONTRACT_FILE_ID);
  const sheets = parseXlsxBufferAllSheets(bytes);

  const out: ArchiveSheetCollectResult[] = [];
  for (const sh of sheets) {
    try {
      const headerIdx = detectHeaderRowIndex(sh.rows);
      if (headerIdx < 0) {
        out.push({
          fileId: ARCHIVE_CONTRACT_FILE_ID,
          sheetName: sh.sheetName,
          fetchedCount: 0,
          rows: [],
          error: "no_header_detected",
        });
        continue;
      }
      const headers = sh.rows[headerIdx].map(normalizeHeader);
      const rows: RawArchiveRow[] = [];
      for (let i = headerIdx + 1; i < sh.rows.length; i++) {
        const row = sh.rows[i];
        if (!row || row.length === 0) continue;
        const values: Record<string, string> = {};
        for (let j = 0; j < headers.length; j++) {
          const header = headers[j];
          if (!header) continue;
          const cell = String(row[j] ?? "").trim();
          if (!(header in values)) values[header] = cell;
        }
        const nonEmpty = Object.values(values).some((v) => v.length > 0);
        if (!nonEmpty) continue;
        rows.push({
          fileId: ARCHIVE_CONTRACT_FILE_ID,
          sheetName: sh.sheetName,
          rowNumber: i + 1,
          values,
        });
      }
      out.push({
        fileId: ARCHIVE_CONTRACT_FILE_ID,
        sheetName: sh.sheetName,
        fetchedCount: rows.length,
        rows,
      });
    } catch (err) {
      out.push({
        fileId: ARCHIVE_CONTRACT_FILE_ID,
        sheetName: sh.sheetName,
        fetchedCount: 0,
        rows: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { fileId: ARCHIVE_CONTRACT_FILE_ID, sheets: out };
}
