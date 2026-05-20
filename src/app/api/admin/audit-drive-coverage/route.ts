/**
 * GET /api/admin/audit-drive-coverage?startDate=2024-01-01
 * Drive에서 'name contains 만족도' 검색 (sheets content fetch 안 함, 빠름).
 * 검색 결과 file_id list를 SatisfactionImportItem과 cross-check → 누락 file 식별.
 * 인증: CRON_SECRET
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";
import { exchangeGoogleUserAccessToken, googleApiGet } from "@/lib/google-user-oauth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface DriveFile {
  id: string;
  name: string;
  mimeType?: string;
  createdTime?: string;
  modifiedTime?: string;
}

interface ListResp {
  files?: DriveFile[];
  nextPageToken?: string;
}

export async function GET(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const startDate = request.nextUrl.searchParams.get("startDate") ?? "2024-01-01";
  const endDate = request.nextUrl.searchParams.get("endDate") ?? new Date().toISOString().slice(0, 10);
  const includeXlsx = request.nextUrl.searchParams.get("xlsx") === "1";
  const startedAt = Date.now();

  const token = await exchangeGoogleUserAccessToken();
  const mimeFilter = includeXlsx
    ? "(mimeType = 'application/vnd.google-apps.spreadsheet' or mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')"
    : "mimeType = 'application/vnd.google-apps.spreadsheet'";
  const q = [
    "name contains '만족도'",
    "trashed = false",
    mimeFilter,
    `createdTime >= '${startDate}T00:00:00'`,
    `createdTime <= '${endDate}T23:59:59'`,
  ].join(" and ");

  const allDriveFiles: DriveFile[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 50; page += 1) {
    const params: Record<string, string> = {
      q,
      pageSize: "100",
      fields: "nextPageToken,files(id,name,mimeType,createdTime,modifiedTime)",
      orderBy: "createdTime desc",
      corpora: "allDrives",
      includeItemsFromAllDrives: "true",
      supportsAllDrives: "true",
    };
    if (pageToken) params.pageToken = pageToken;
    const resp = await googleApiGet<ListResp>(token, "https://www.googleapis.com/drive/v3", "/files", params);
    for (const f of resp.files ?? []) allDriveFiles.push(f);
    if (!resp.nextPageToken) break;
    pageToken = resp.nextPageToken;
  }

  // DB에 있는 drive_satisfaction ImportItem의 file_id list
  const dbItems = await prisma.satisfactionImportItem.findMany({
    where: { sourceType: "drive_satisfaction" },
    select: { sourceRef: true },
  });
  const dbFileIds = new Set<string>();
  for (const it of dbItems) {
    const sr = it.sourceRef as { file_id?: string } | null;
    if (sr?.file_id) dbFileIds.add(sr.file_id);
  }

  // 분류
  const inDb: DriveFile[] = [];
  const notInDb: DriveFile[] = [];
  const xlsxFiles: DriveFile[] = [];
  for (const f of allDriveFiles) {
    if (f.mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
      xlsxFiles.push(f);
      continue;
    }
    if (dbFileIds.has(f.id)) inDb.push(f);
    else notInDb.push(f);
  }

  return NextResponse.json({
    ok: true,
    durationMs: Date.now() - startedAt,
    startDate,
    endDate,
    drive_total: allDriveFiles.length,
    google_sheets_in_db: inDb.length,
    google_sheets_missed: notInDb.length,
    xlsx_unsupported_count: xlsxFiles.length,
    db_total_drive_items: dbItems.length,
    sample_missed: notInDb.slice(0, 20).map((f) => ({
      id: f.id,
      name: f.name,
      created: f.createdTime,
      modified: f.modifiedTime,
    })),
    sample_xlsx: xlsxFiles.slice(0, 10).map((f) => ({
      id: f.id,
      name: f.name,
    })),
  });
}
