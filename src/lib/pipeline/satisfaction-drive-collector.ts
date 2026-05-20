import {
  exchangeGoogleUserAccessToken,
  googleApiGet,
} from "@/lib/google-user-oauth";

const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
const SHEETS_API_BASE = "https://sheets.googleapis.com/v4";
const DRIVE_API_TIMEOUT_MS = 15_000;
const SHEETS_API_TIMEOUT_MS = 20_000;
const BATCH_DELAY_MS = 1_000;
const RATE_LIMIT_RETRY_DELAY_MS = 5_000;
const MAX_RETRIES = 3;

export const DRIVE_SATISFACTION_SOURCE_KEY = "drive_satisfaction" as const;

interface DriveFileListItem {
  id: string;
  name: string;
  mimeType: string;
  createdTime: string;
  modifiedTime: string;
}

export interface DriveSatisfactionFile {
  fileId: string;
  fileName: string;
  mimeType: string;
  createdTime: string;
  modifiedTime: string;
  sheets: Array<{
    title: string;
    rows: string[][];
  }>;
}

export interface DriveSatisfactionCollectResult {
  sourceKey: typeof DRIVE_SATISFACTION_SOURCE_KEY;
  files: DriveSatisfactionFile[];
  totalFilesFound: number;
  readErrors: number;
  incremental: boolean;
}

export interface DriveSatisfactionCheckpoint {
  lastModifiedTime: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("429");
}

async function apiGetWithRetry<T>(
  accessToken: string,
  baseUrl: string,
  path: string,
  params: Record<string, string> = {},
  timeoutMs: number = DRIVE_API_TIMEOUT_MS
): Promise<T> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      return await googleApiGet<T>(accessToken, baseUrl, path, params, {
        timeoutMs,
      });
    } catch (error) {
      if (isRateLimitError(error) && attempt < MAX_RETRIES) {
        await sleep(RATE_LIMIT_RETRY_DELAY_MS * attempt);
        continue;
      }
      throw error;
    }
  }
  throw new Error("unreachable");
}

export async function collectSatisfactionFromDrive(options?: {
  startDate?: string;
  endDate?: string;
  checkpoint?: DriveSatisfactionCheckpoint | null;
  maxPages?: number;
  pageSize?: number;
  readConcurrency?: number;
  /** v23: 특정 file_id list만 fetch (listing 단계 skip). 다른 옵션 무시됨 */
  fileIds?: string[];
}): Promise<DriveSatisfactionCollectResult> {
  const accessToken = await exchangeGoogleUserAccessToken();
  const pageSize = Math.min(options?.pageSize ?? 100, 100);
  const maxPages = options?.maxPages ?? 20;
  const readConcurrency = Math.max(1, Math.min(options?.readConcurrency ?? 2, 5));

  const allFiles: DriveFileListItem[] = [];

  if (options?.fileIds && options.fileIds.length > 0) {
    // v23: 특정 file_id list 모드 — Drive files.get으로 metadata만 가져옴
    for (const fid of options.fileIds) {
      try {
        const file = await apiGetWithRetry<DriveFileListItem>(
          accessToken,
          DRIVE_API_BASE,
          `/files/${encodeURIComponent(fid)}`,
          {
            supportsAllDrives: "true",
            fields: "id,name,mimeType,createdTime,modifiedTime",
          }
        );
        allFiles.push(file);
      } catch {
        // skip unreadable
      }
    }
  } else {
    const queryParts = [
      "name contains '만족도'",
      "trashed = false",
      "mimeType = 'application/vnd.google-apps.spreadsheet'",
    ];

    if (options?.startDate) {
      queryParts.push(`createdTime >= '${options.startDate}T00:00:00'`);
    }
    if (options?.endDate) {
      queryParts.push(`createdTime <= '${options.endDate}T23:59:59'`);
    }
    if (
      !options?.startDate &&
      !options?.endDate &&
      options?.checkpoint?.lastModifiedTime
    ) {
      queryParts.push(`modifiedTime > '${options.checkpoint.lastModifiedTime}'`);
    }

    const query = queryParts.join(" and ");
    let pageToken: string | undefined;

    for (let page = 0; page < maxPages; page += 1) {
      const params: Record<string, string> = {
        q: query,
        pageSize: String(pageSize),
        fields:
          "nextPageToken,files(id,name,mimeType,createdTime,modifiedTime)",
        orderBy: "createdTime desc",
        corpora: "allDrives",
        includeItemsFromAllDrives: "true",
        supportsAllDrives: "true",
      };
      if (pageToken) params.pageToken = pageToken;

      const data = await apiGetWithRetry<{
        files?: DriveFileListItem[];
        nextPageToken?: string;
      }>(accessToken, DRIVE_API_BASE, "/files", params);

      for (const file of data.files ?? []) {
        allFiles.push(file);
      }

      if (!data.nextPageToken) break;
      pageToken = data.nextPageToken;
    }
  }

  const results: DriveSatisfactionFile[] = [];
  let readErrors = 0;

  for (let i = 0; i < allFiles.length; i += readConcurrency) {
    if (i > 0) await sleep(BATCH_DELAY_MS);

    const batch = allFiles.slice(i, i + readConcurrency);
    const batchResults = await Promise.all(
      batch.map(async (file) => {
        try {
          const meta = await apiGetWithRetry<{
            sheets?: Array<{ properties?: { title?: string } }>;
          }>(
            accessToken,
            SHEETS_API_BASE,
            `/spreadsheets/${file.id}`,
            { fields: "sheets.properties.title" }
          );

          const sheetTitles = (meta.sheets ?? [])
            .map((s) => s.properties?.title?.trim() ?? "")
            .filter(Boolean)
            .slice(0, 3);

          const sheets: Array<{ title: string; rows: string[][] }> = [];
          for (const title of sheetTitles) {
            try {
              const data = await apiGetWithRetry<{ values?: string[][] }>(
                accessToken,
                SHEETS_API_BASE,
                `/spreadsheets/${file.id}/values/${encodeURIComponent(`${title}!A1:AZ1000`)}`,
                {},
                SHEETS_API_TIMEOUT_MS
              );
              if ((data.values ?? []).length > 0) {
                sheets.push({ title, rows: data.values ?? [] });
              }
            } catch {
              // skip unreadable sheets
            }
          }

          if (sheets.length === 0) return null;

          return {
            fileId: file.id,
            fileName: file.name,
            mimeType: file.mimeType,
            createdTime: file.createdTime,
            modifiedTime: file.modifiedTime,
            sheets,
          } satisfies DriveSatisfactionFile;
        } catch {
          readErrors += 1;
          return null;
        }
      })
    );

    for (const result of batchResults) {
      if (result) results.push(result);
    }
  }

  return {
    sourceKey: DRIVE_SATISFACTION_SOURCE_KEY,
    files: results,
    totalFilesFound: allFiles.length,
    readErrors,
    incremental:
      !options?.startDate &&
      !options?.endDate &&
      Boolean(options?.checkpoint?.lastModifiedTime),
  };
}
