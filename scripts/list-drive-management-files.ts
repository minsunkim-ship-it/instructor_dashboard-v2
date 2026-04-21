import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import process from "node:process";
import { exchangeGoogleUserAccessToken, googleApiGet } from "@/lib/google-user-oauth";
import { loadDotEnv } from "./lib/audit-helpers.ts";

const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
const SHEETS_API_BASE = "https://sheets.googleapis.com/v4";
const NAME_FILTER = `(name contains "강의관리" or name contains "강의관리 시트" or name contains "싱크업")`;

interface DriveFile {
  id: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
  createdTime?: string;
  owners?: Array<{ displayName?: string }>;
}

function parseDateOnly(value: string): Date {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new Error(`잘못된 날짜 형식: ${value} (YYYY-MM-DD 필요)`);
  }
  const [, year, month, day] = match;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 0, 0, 0));
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function formatIso(date: Date): string {
  return date.toISOString();
}

function sanitizeTag(value: string): string {
  return value.replace(/[^0-9A-Za-z_-]+/g, "_");
}

function buildMarkdown(args: {
  startDate: string;
  endDate: string;
  query: string;
  files: Array<{
    id: string;
    name: string | null;
    mimeType: string | null;
    modifiedTime: string | null;
    createdTime: string | null;
    owner: string | null;
    sheetTitles: string[];
  }>;
}): string {
  const lines: string[] = [];
  lines.push(`# 강의관리 시트 전수 조회`);
  lines.push("");
  lines.push(`- 기간: ${args.startDate} ~ ${args.endDate}`);
  lines.push(`- 검색식: \`${args.query}\``);
  lines.push(`- 파일 수: ${args.files.length}`);
  lines.push("");
  lines.push("| 파일명 | 수정일 | MIME | 소유자 | 시트 탭 |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const file of args.files) {
    lines.push(
      `| ${file.name ?? "(no name)"} | ${file.modifiedTime ?? "-"} | ${file.mimeType ?? "-"} | ${file.owner ?? "-"} | ${
        file.sheetTitles.length > 0 ? file.sheetTitles.join(", ") : "-"
      } |`
    );
  }
  lines.push("");
  return lines.join("\n");
}

async function main() {
  await loadDotEnv(path.join(process.cwd(), ".env"));

  const startDate = process.argv[2] ?? "2026-01-01";
  const endDate = process.argv[3] ?? "2026-03-31";
  const start = parseDateOnly(startDate);
  const endExclusive = addDays(parseDateOnly(endDate), 1);
  const query = [
    NAME_FILTER,
    `modifiedTime >= '${formatIso(start)}'`,
    `modifiedTime < '${formatIso(endExclusive)}'`,
    `trashed = false`,
  ].join(" and ");

  const accessToken = await exchangeGoogleUserAccessToken();
  const files: DriveFile[] = [];
  let pageToken: string | undefined;

  do {
    const data = await googleApiGet<{ nextPageToken?: string; files?: DriveFile[] }>(
      accessToken,
      DRIVE_API_BASE,
      "/files",
      {
        q: query,
        pageSize: "100",
        fields: "nextPageToken,files(id,name,mimeType,modifiedTime,createdTime,owners(displayName))",
        corpora: "allDrives",
        includeItemsFromAllDrives: "true",
        supportsAllDrives: "true",
        ...(pageToken ? { pageToken } : {}),
      },
      { timeoutMs: 20_000 }
    );
    files.push(...(data.files ?? []));
    pageToken = data.nextPageToken;
  } while (pageToken);

  const enriched: Array<{
    id: string;
    name: string | null;
    mimeType: string | null;
    modifiedTime: string | null;
    createdTime: string | null;
    owner: string | null;
    sheetTitles: string[];
  }> = [];

  for (const file of files) {
    let sheetTitles: string[] = [];
    if (file.mimeType === "application/vnd.google-apps.spreadsheet") {
      try {
        const meta = await googleApiGet<{
          sheets?: Array<{ properties?: { title?: string } }>;
        }>(
          accessToken,
          SHEETS_API_BASE,
          `/spreadsheets/${file.id}`,
          { fields: "sheets.properties.title" },
          { timeoutMs: 10_000 }
        );
        sheetTitles = (meta.sheets ?? [])
          .map((sheet) => sheet.properties?.title?.trim() ?? "")
          .filter(Boolean);
      } catch {
        sheetTitles = [];
      }
    }

    enriched.push({
      id: file.id,
      name: file.name?.trim() ?? null,
      mimeType: file.mimeType?.trim() ?? null,
      modifiedTime: file.modifiedTime ?? null,
      createdTime: file.createdTime ?? null,
      owner: file.owners?.[0]?.displayName?.trim() ?? null,
      sheetTitles,
    });
  }

  enriched.sort((a, b) => {
    const aTime = a.modifiedTime ?? "";
    const bTime = b.modifiedTime ?? "";
    return bTime.localeCompare(aTime);
  });

  const reportsDir = path.join(process.cwd(), "reports");
  await mkdir(reportsDir, { recursive: true });
  const tag = `${sanitizeTag(startDate)}_${sanitizeTag(endDate)}`;
  const jsonPath = path.join(reportsDir, `drive-management-files-${tag}.json`);
  const mdPath = path.join(reportsDir, `drive-management-files-${tag}.md`);

  const payload = {
    generatedAt: new Date().toISOString(),
    startDate,
    endDate,
    query,
    count: enriched.length,
    files: enriched,
  };

  await writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await writeFile(
    mdPath,
    `${buildMarkdown({ startDate, endDate, query, files: enriched })}\n`,
    "utf8"
  );

  console.log(JSON.stringify({ count: enriched.length, jsonPath, mdPath }, null, 2));
}

await main();
