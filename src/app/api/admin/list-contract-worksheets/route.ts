/**
 * GET /api/admin/list-contract-worksheets
 * GOOGLE_CONTRACTS_SPREADSHEET_ID에서 모든 worksheet (sheetId, title) 조회.
 * 히스토리 탭이 어디 있는지 확인용.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";
import { exchangeGoogleUserAccessToken, googleApiGet } from "@/lib/google-user-oauth";

export const dynamic = "force-dynamic";

interface SpreadsheetMeta {
  properties?: { title?: string };
  sheets?: Array<{
    properties?: {
      sheetId?: number;
      title?: string;
      gridProperties?: { rowCount?: number; columnCount?: number };
    };
  }>;
}

export async function GET(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const spreadsheetId = process.env.GOOGLE_CONTRACTS_SPREADSHEET_ID;
  if (!spreadsheetId) {
    return NextResponse.json({ ok: false, error: "GOOGLE_CONTRACTS_SPREADSHEET_ID 미설정" }, { status: 500 });
  }
  const token = await exchangeGoogleUserAccessToken();
  const meta = await googleApiGet<SpreadsheetMeta>(
    token,
    "https://sheets.googleapis.com/v4",
    `/spreadsheets/${spreadsheetId}?fields=properties.title,sheets.properties(sheetId,title,gridProperties)`
  );
  const sheets = (meta.sheets ?? []).map((s) => ({
    sheetId: s.properties?.sheetId,
    title: s.properties?.title,
    rows: s.properties?.gridProperties?.rowCount,
    cols: s.properties?.gridProperties?.columnCount,
  }));
  return NextResponse.json({
    ok: true,
    spreadsheetTitle: meta.properties?.title,
    sheetCount: sheets.length,
    sheets,
  });
}
