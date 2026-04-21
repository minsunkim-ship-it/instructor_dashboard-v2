import {
  exchangeGoogleUserAccessToken,
  googleApiGet,
} from "@/lib/google-user-oauth";

const SHEETS_API_BASE = "https://sheets.googleapis.com/v4";
const REQUIRED_HEADER_GROUPS = [
  ["기업"],
  ["과정명"],
  ["출강 일정", "교육일정"],
] as const;

export interface InstructorDispatchSheetDefinition {
  key: string;
  instructorName: string;
  spreadsheetId: string;
  worksheetGid: number;
}

export const INSTRUCTOR_DISPATCH_SHEET_DEFINITIONS: readonly InstructorDispatchSheetDefinition[] =
  [
    {
      key: "jeongbaek_2026_dispatch",
      instructorName: "정백",
      spreadsheetId: "1hInJeNY3QwA1dRT_rbhqtjUWpu6YD3XEUEarDGB8Qvs",
      worksheetGid: 2070530086,
    },
    // 공지연 정산 분기 탭들은 이 canonical 탭의 부분집합이라 중복 적재를 피하기 위해
    // 전임소진(공지연)만 수집한다.
    {
      key: "gongjiyeon_2025_2026_dispatch",
      instructorName: "공지연",
      spreadsheetId: "1TPgeSiyhJE8HBZeH9cKA4DWeh6z6dy0wW5LPfXTuM1M",
      worksheetGid: 1871999347,
    },
    {
      key: "shindongwon_2025_dispatch_h2",
      instructorName: "신동원",
      spreadsheetId: "1ktnuwuUZRxSY03sIoEBSzvD0uBwgexAjJvoRnUqnhzs",
      worksheetGid: 264274784,
    },
    {
      key: "shindongwon_2025_dispatch_h2_q4",
      instructorName: "신동원",
      spreadsheetId: "1ktnuwuUZRxSY03sIoEBSzvD0uBwgexAjJvoRnUqnhzs",
      worksheetGid: 345630814,
    },
  ] as const;

export interface RawInstructorDispatchRow {
  sourceKey: string;
  instructorName: string;
  spreadsheetId: string;
  worksheetGid: number;
  rowNumber: number;
  values: Record<string, string>;
}

export interface InstructorDispatchSheetCollectResult {
  definition: InstructorDispatchSheetDefinition;
  fetchedCount: number;
  rows: RawInstructorDispatchRow[];
  error?: string;
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
    .replace(/\s+/g, " ")
    .trim();
}

function cellToString(value: unknown): string {
  return String(value ?? "").trim();
}

function isRowEmpty(row: unknown[] | undefined): boolean {
  return !(row ?? []).some((cell) => cellToString(cell) !== "");
}

function findHeaderRowIndex(rows: unknown[][]): number {
  for (let i = 0; i < rows.length; i++) {
    const normalized = (rows[i] ?? []).map(normalizeHeader);
    const hasRequiredHeaders = REQUIRED_HEADER_GROUPS.every((group) =>
      group.some((header) => normalized.includes(header))
    );
    if (hasRequiredHeaders) {
      return i;
    }
  }

  throw new Error(
    `출강 목록 header를 찾지 못했습니다. 필요 헤더 그룹=${REQUIRED_HEADER_GROUPS.map(
      (group) => group.join("/")
    ).join(", ")}`
  );
}

async function getWorksheetTitle(
  accessToken: string,
  spreadsheetId: string,
  worksheetGid: number
): Promise<string> {
  const meta = await googleApiGet<SpreadsheetMetaResponse>(
    accessToken,
    SHEETS_API_BASE,
    `/spreadsheets/${spreadsheetId}`,
    { fields: "sheets.properties" }
  );

  const sheet = meta.sheets?.find(
    (entry) => entry.properties?.sheetId === worksheetGid
  );
  const title = sheet?.properties?.title?.trim();

  if (!title) {
    throw new Error(
      `spreadsheet ${spreadsheetId}에서 gid=${worksheetGid} worksheet를 찾지 못했습니다.`
    );
  }

  return title;
}

async function fetchWorksheetRows(
  accessToken: string,
  definition: InstructorDispatchSheetDefinition
): Promise<RawInstructorDispatchRow[]> {
  const title = await getWorksheetTitle(
    accessToken,
    definition.spreadsheetId,
    definition.worksheetGid
  );

  const values = await googleApiGet<{ values?: unknown[][] }>(
    accessToken,
    SHEETS_API_BASE,
    `/spreadsheets/${definition.spreadsheetId}/values/${encodeURIComponent(
      `'${title.replace(/'/g, "''")}'`
    )}`
  );

  const rawRows = values.values ?? [];
  if (rawRows.length === 0) return [];

  const headerRowIndex = findHeaderRowIndex(rawRows);
  const headers = (rawRows[headerRowIndex] ?? []).map(normalizeHeader);
  const rows: RawInstructorDispatchRow[] = [];

  for (let i = headerRowIndex + 1; i < rawRows.length; i++) {
    const row = rawRows[i] ?? [];
    if (isRowEmpty(row)) continue;

    const mapped: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      const header = headers[j];
      if (!header || header in mapped) continue;
      mapped[header] = cellToString(row[j]);
    }

    const rowInstructorName = cellToString(mapped["강사명"]);
    if (rowInstructorName && rowInstructorName !== definition.instructorName) {
      continue;
    }

    rows.push({
      sourceKey: definition.key,
      instructorName: definition.instructorName,
      spreadsheetId: definition.spreadsheetId,
      worksheetGid: definition.worksheetGid,
      rowNumber: i + 1,
      values: mapped,
    });
  }

  return rows;
}

export async function collectInstructorDispatchSheets(): Promise<
  InstructorDispatchSheetCollectResult[]
> {
  const accessToken = await exchangeGoogleUserAccessToken();
  return Promise.all(
    INSTRUCTOR_DISPATCH_SHEET_DEFINITIONS.map(
      async (definition): Promise<InstructorDispatchSheetCollectResult> => {
        try {
          const rows = await fetchWorksheetRows(accessToken, definition);
          return {
            definition,
            fetchedCount: rows.length,
            rows,
          };
        } catch (err) {
          return {
            definition,
            fetchedCount: 0,
            rows: [],
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }
    )
  );
}
