/**
 * GET /api/admin/search-contract-sheet?gid=1875350219&q=박인영&limit=50
 * 라이브 계약시트 특정 worksheet에서 키워드 substring 매칭 행 반환.
 * TH refresh 누락 진단용.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";
import { exchangeGoogleUserAccessToken, googleApiGet } from "@/lib/google-user-oauth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface SpreadsheetMeta {
  sheets?: Array<{ properties?: { sheetId?: number; title?: string } }>;
}
interface ValuesResp {
  values?: string[][];
}

export async function GET(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const gidStr = request.nextUrl.searchParams.get("gid");
  const q = request.nextUrl.searchParams.get("q") ?? "";
  const limit = parseInt(request.nextUrl.searchParams.get("limit") ?? "50", 10);
  if (!gidStr || !q) {
    return NextResponse.json({ ok: false, error: "gid and q required" }, { status: 400 });
  }
  const gid = parseInt(gidStr, 10);
  const spreadsheetId = process.env.GOOGLE_CONTRACTS_SPREADSHEET_ID;
  if (!spreadsheetId) {
    return NextResponse.json({ ok: false, error: "GOOGLE_CONTRACTS_SPREADSHEET_ID 미설정" }, { status: 500 });
  }
  const token = await exchangeGoogleUserAccessToken();
  const meta = await googleApiGet<SpreadsheetMeta>(
    token,
    "https://sheets.googleapis.com/v4",
    `/spreadsheets/${spreadsheetId}?fields=sheets.properties(sheetId,title)`
  );
  const sheet = (meta.sheets ?? []).find((s) => s.properties?.sheetId === gid);
  if (!sheet?.properties?.title) {
    return NextResponse.json({ ok: false, error: `gid=${gid} not found` }, { status: 404 });
  }
  const title = sheet.properties.title;
  const values = await googleApiGet<ValuesResp>(
    token,
    "https://sheets.googleapis.com/v4",
    `/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(title)}?valueRenderOption=FORMATTED_VALUE`
  );
  const rows = values.values ?? [];
  const matched: Array<{ rowIndex: number; cells: string[] }> = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const joined = (row ?? []).join(" | ");
    if (joined.includes(q)) {
      matched.push({ rowIndex: i + 1, cells: row });
      if (matched.length >= limit) break;
    }
  }
  return NextResponse.json({
    ok: true,
    spreadsheetId,
    gid,
    worksheet_title: title,
    total_rows: rows.length,
    matched_count: matched.length,
    matched,
  });
}
