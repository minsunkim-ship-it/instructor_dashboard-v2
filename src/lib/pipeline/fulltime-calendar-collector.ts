/**
 * Fulltime Calendar Collector — Phase 1-2
 *
 * 전임강사 전용 출강 캘린더 시트에서 raw 행을 수집한다.
 * 일반 contract-sheet collector와 분리:
 *   - 시트가 강사별로 다른 schema(전임관리 캘린더 vs 정백 출강목록)
 *   - 헤더 자동 detect + 진행확정여부(O) 필터링
 *
 * 인증: Google user OAuth refresh token (GMAIL_REFRESH_TOKEN 재사용)
 */
import {
  exchangeGoogleUserAccessToken,
  googleApiGet,
} from "@/lib/google-user-oauth";

const SHEETS_API_BASE = "https://sheets.googleapis.com/v4";
const GOOGLE_SHEETS_REQUEST_TIMEOUT_MS = 30_000;

export const FULLTIME_CALENDAR_SHEET_ID =
  "1TPgeSiyhJE8HBZeH9cKA4DWeh6z6dy0wW5LPfXTuM1M";
export const JEONGBAEK_SHEET_ID =
  "1hInJeNY3QwA1dRT_rbhqtjUWpu6YD3XEUEarDGB8Qvs";

/**
 * Sheet schema kind. row_with_instructor: 행에 강사명 컬럼 있음 (전임관리 캘린더).
 * fixed_instructor: 시트 전체가 한 강사 (정백 출강목록).
 */
export type FulltimeSheetKind = "row_with_instructor" | "fixed_instructor";

export interface FulltimeTabSpec {
  spreadsheetId: string;
  tabTitleIncludes: string; // 탭 제목 부분일치 (예: "전임소진" → 전임소진(...) 매칭)
  kind: FulltimeSheetKind;
  fixedInstructorName?: string; // kind=fixed_instructor일 때 사용
}

export const FULLTIME_TAB_SPECS: FulltimeTabSpec[] = [
  {
    spreadsheetId: FULLTIME_CALENDAR_SHEET_ID,
    tabTitleIncludes: "전임소진",
    kind: "row_with_instructor",
  },
  {
    spreadsheetId: JEONGBAEK_SHEET_ID,
    tabTitleIncludes: "출강 목록",
    kind: "fixed_instructor",
    fixedInstructorName: "정백",
  },
];

export interface RawFulltimeRow {
  spreadsheetId: string;
  tabTitle: string;
  rowNumber: number;
  values: Record<string, string>;
  kind: FulltimeSheetKind;
  fixedInstructorName?: string;
}

export interface TabCollectResult {
  spreadsheetId: string;
  tabTitle: string;
  kind: FulltimeSheetKind;
  fixedInstructorName?: string;
  fetchedCount: number;
  rows: RawFulltimeRow[];
  error?: string;
}

interface SpreadsheetMeta {
  sheets?: Array<{ properties?: { sheetId?: number; title?: string } }>;
}

function normalizeHeader(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 헤더 row를 자동 detect한다. 시트 상단 max 8행 스캔.
 * "강사명"·"교육일정"·"출강 일정"·"기업"·"과정명" 중 2개 이상 포함하는 row.
 */
function detectHeaderRowIndex(rawRows: unknown[][]): number {
  const SIGNAL = ["강사명", "교육일정", "출강 일정", "기업", "과정명"];
  const limit = Math.min(rawRows.length, 8);
  for (let i = 0; i < limit; i++) {
    const cells = (rawRows[i] as unknown[]).map(normalizeHeader);
    const hits = SIGNAL.filter((s) => cells.includes(s)).length;
    if (hits >= 2) return i;
  }
  return -1;
}

async function getTabsList(
  accessToken: string,
  spreadsheetId: string
): Promise<Array<{ title: string }>> {
  const meta = await googleApiGet<SpreadsheetMeta>(
    accessToken,
    SHEETS_API_BASE,
    `/spreadsheets/${spreadsheetId}`,
    { fields: "sheets.properties" },
    { timeoutMs: GOOGLE_SHEETS_REQUEST_TIMEOUT_MS }
  );
  return (meta.sheets ?? [])
    .map((s) => ({ title: s.properties?.title?.trim() ?? "" }))
    .filter((s) => s.title.length > 0);
}

async function fetchTab(
  accessToken: string,
  spreadsheetId: string,
  tabTitle: string,
  kind: FulltimeSheetKind,
  fixedInstructorName?: string
): Promise<RawFulltimeRow[]> {
  const data = await googleApiGet<{ values?: unknown[][] }>(
    accessToken,
    SHEETS_API_BASE,
    `/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(
      `'${tabTitle.replace(/'/g, "''")}'`
    )}`,
    {
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "FORMATTED_STRING",
    },
    { timeoutMs: GOOGLE_SHEETS_REQUEST_TIMEOUT_MS }
  );

  const rawRows = data.values ?? [];
  if (rawRows.length === 0) return [];

  const headerIdx = detectHeaderRowIndex(rawRows);
  if (headerIdx < 0) return [];

  const headers = (rawRows[headerIdx] as unknown[]).map(normalizeHeader);
  const rows: RawFulltimeRow[] = [];

  for (let i = headerIdx + 1; i < rawRows.length; i++) {
    const row = rawRows[i] as unknown[];
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
      spreadsheetId,
      tabTitle,
      rowNumber: i + 1, // 1-indexed spreadsheet row
      values,
      kind,
      fixedInstructorName,
    });
  }

  return rows;
}

export interface FulltimeCalendarCollectResult {
  tabs: TabCollectResult[];
}

export async function collectFromFulltimeCalendars(): Promise<FulltimeCalendarCollectResult> {
  const accessToken = await exchangeGoogleUserAccessToken();
  const tabs: TabCollectResult[] = [];

  for (const spec of FULLTIME_TAB_SPECS) {
    let allTabs: Array<{ title: string }>;
    try {
      allTabs = await getTabsList(accessToken, spec.spreadsheetId);
    } catch (err) {
      tabs.push({
        spreadsheetId: spec.spreadsheetId,
        tabTitle: "(meta_failed)",
        kind: spec.kind,
        fixedInstructorName: spec.fixedInstructorName,
        fetchedCount: 0,
        rows: [],
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    const matched = allTabs.filter((t) =>
      t.title.includes(spec.tabTitleIncludes)
    );
    if (matched.length === 0) {
      tabs.push({
        spreadsheetId: spec.spreadsheetId,
        tabTitle: `(no_match:${spec.tabTitleIncludes})`,
        kind: spec.kind,
        fixedInstructorName: spec.fixedInstructorName,
        fetchedCount: 0,
        rows: [],
        error: `no tab matches '${spec.tabTitleIncludes}'`,
      });
      continue;
    }
    for (const t of matched) {
      try {
        const rows = await fetchTab(
          accessToken,
          spec.spreadsheetId,
          t.title,
          spec.kind,
          spec.fixedInstructorName
        );
        tabs.push({
          spreadsheetId: spec.spreadsheetId,
          tabTitle: t.title,
          kind: spec.kind,
          fixedInstructorName: spec.fixedInstructorName,
          fetchedCount: rows.length,
          rows,
        });
      } catch (err) {
        tabs.push({
          spreadsheetId: spec.spreadsheetId,
          tabTitle: t.title,
          kind: spec.kind,
          fixedInstructorName: spec.fixedInstructorName,
          fetchedCount: 0,
          rows: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return { tabs };
}
