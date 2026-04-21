import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import process from "node:process";
import { exchangeGoogleUserAccessToken, googleApiGet } from "@/lib/google-user-oauth";
import { loadDotEnv } from "./lib/audit-helpers.ts";

const execFileAsync = promisify(execFile);
const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
const SHEETS_API_BASE = "https://sheets.googleapis.com/v4";
const DEFAULT_WORKSPACE_PYTHON =
  "/Users/ga/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3";

interface ListedFile {
  id: string;
  name: string | null;
  mimeType: string | null;
  modifiedTime: string | null;
  createdTime: string | null;
  owner: string | null;
  sheetTitles: string[];
}

interface ListedReport {
  generatedAt: string;
  startDate: string;
  endDate: string;
  query: string;
  count: number;
  files: ListedFile[];
}

function sanitizeTag(value: string): string {
  return value.replace(/[^0-9A-Za-z_-]+/g, "_");
}

function selectInterestingTabs(sheetTitles: string[]): string[] {
  const preferred = ["교육 개요", "강의요약", "강의관리", "운영", "캘린더"];
  const picked: string[] = [];
  for (const preferredTitle of preferred) {
    const match = sheetTitles.find((title) => title.includes(preferredTitle));
    if (match && !picked.includes(match)) picked.push(match);
  }
  for (const title of sheetTitles) {
    if (picked.length >= 3) break;
    if (!picked.includes(title)) picked.push(title);
  }
  return picked.slice(0, 3);
}

async function loadGoogleSheetPreview(
  accessToken: string,
  spreadsheetId: string,
  tabs: string[]
): Promise<Array<{ tab: string; previewRows: string[] }>> {
  const previews: Array<{ tab: string; previewRows: string[] }> = [];
  for (const tab of tabs) {
    try {
      const data = await googleApiGet<{ values?: string[][] }>(
        accessToken,
        SHEETS_API_BASE,
        `/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(`${tab}!A1:Z12`)}`,
        {},
        { timeoutMs: 12_000 }
      );
      const previewRows = (data.values ?? [])
        .slice(0, 8)
        .map((row) => row.join(" | ").trim())
        .filter(Boolean);
      previews.push({ tab, previewRows });
    } catch {
      previews.push({ tab, previewRows: [] });
    }
  }
  return previews;
}

async function downloadDriveFile(
  accessToken: string,
  fileId: string,
  destPath: string
): Promise<void> {
  const response = await fetch(
    `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );
  if (!response.ok) {
    throw new Error(`Drive download failed: ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(destPath, buffer);
}

async function loadXlsxPreview(
  pythonPath: string,
  filePath: string
): Promise<{ sheetTitles: string[]; previewRowsBySheet: Record<string, string[]> }> {
  const pythonCode = `
import json, sys
from openpyxl import load_workbook

wb = load_workbook(sys.argv[1], read_only=True, data_only=True)
out = {"sheetTitles": wb.sheetnames, "previewRowsBySheet": {}}
for ws in wb.worksheets[:3]:
    rows = []
    for row in ws.iter_rows(min_row=1, max_row=8, min_col=1, max_col=26, values_only=True):
        values = [str(v).strip() for v in row if v is not None and str(v).strip()]
        if values:
            rows.append(" | ".join(values))
    out["previewRowsBySheet"][ws.title] = rows[:8]
print(json.dumps(out, ensure_ascii=False))
`;
  const { stdout } = await execFileAsync(pythonPath, ["-c", pythonCode, filePath], {
    maxBuffer: 1024 * 1024 * 8,
  });
  return JSON.parse(stdout);
}

async function main() {
  await loadDotEnv(path.join(process.cwd(), ".env"));
  const reportPath =
    process.argv[2] ??
    path.join(process.cwd(), "reports", "drive-management-files-2026-01-01_2026-03-31.json");
  const raw = await readFile(reportPath, "utf8");
  const listed = JSON.parse(raw) as ListedReport;
  const accessToken = await exchangeGoogleUserAccessToken();
  const pythonPath =
    process.env.WORKSPACE_PYTHON?.trim() || DEFAULT_WORKSPACE_PYTHON;
  const tempDir = await mkdtemp(path.join(tmpdir(), "drive-inspect-"));

  const inspected: Array<
    ListedFile & {
      preview: Array<{ tab: string; previewRows: string[] }>;
      resolvedSheetTitles: string[];
    }
  > = [];

  try {
    for (const file of listed.files) {
      if (file.mimeType === "application/vnd.google-apps.spreadsheet") {
        const tabs = selectInterestingTabs(file.sheetTitles);
        const preview = await loadGoogleSheetPreview(accessToken, file.id, tabs);
        inspected.push({
          ...file,
          preview,
          resolvedSheetTitles: file.sheetTitles,
        });
        continue;
      }

      if (
        file.mimeType ===
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      ) {
        const downloadPath = path.join(tempDir, `${file.id}.xlsx`);
        let resolvedSheetTitles = file.sheetTitles;
        let preview: Array<{ tab: string; previewRows: string[] }> = [];
        try {
          await downloadDriveFile(accessToken, file.id, downloadPath);
          const xlsx = await loadXlsxPreview(pythonPath, downloadPath);
          resolvedSheetTitles = xlsx.sheetTitles;
          preview = Object.entries(xlsx.previewRowsBySheet).map(([tab, previewRows]) => ({
            tab,
            previewRows,
          }));
        } catch {
          preview = [];
        }
        inspected.push({
          ...file,
          preview,
          resolvedSheetTitles,
        });
        continue;
      }

      inspected.push({
        ...file,
        preview: [],
        resolvedSheetTitles: file.sheetTitles,
      });
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  const reportsDir = path.join(process.cwd(), "reports");
  await mkdir(reportsDir, { recursive: true });
  const tag = `${sanitizeTag(listed.startDate)}_${sanitizeTag(listed.endDate)}`;
  const jsonPath = path.join(reportsDir, `drive-management-files-inspected-${tag}.json`);
  await writeFile(
    jsonPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        startDate: listed.startDate,
        endDate: listed.endDate,
        count: inspected.length,
        files: inspected,
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  console.log(JSON.stringify({ count: inspected.length, jsonPath }, null, 2));
}

await main();
