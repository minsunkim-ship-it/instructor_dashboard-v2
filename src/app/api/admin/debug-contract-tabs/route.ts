/**
 * GET /api/admin/debug-contract-tabs
 * 계약시트(spreadsheetId in env)의 모든 worksheet metadata.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";
import { exchangeGoogleUserAccessToken, googleApiGet } from "@/lib/google-user-oauth";

export const dynamic = "force-dynamic";

interface SheetProp {
  properties?: { sheetId?: number; title?: string; gridProperties?: { rowCount?: number; columnCount?: number } };
}

export async function GET(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const spreadsheetId = process.env.GOOGLE_CONTRACTS_SPREADSHEET_ID;
  if (!spreadsheetId) {
    return NextResponse.json({ ok: false, error: "missing GOOGLE_CONTRACTS_SPREADSHEET_ID" }, { status: 500 });
  }
  try {
    const accessToken = await exchangeGoogleUserAccessToken();
    const data = await googleApiGet<{ sheets?: SheetProp[]; properties?: { title?: string } }>(
      accessToken,
      "https://sheets.googleapis.com/v4",
      `/spreadsheets/${spreadsheetId}?fields=properties.title,sheets.properties(sheetId,title,gridProperties)`
    );
    const tabs = (data.sheets ?? []).map((s) => ({
      gid: s.properties?.sheetId ?? null,
      title: s.properties?.title ?? null,
      rows: s.properties?.gridProperties?.rowCount ?? null,
      cols: s.properties?.gridProperties?.columnCount ?? null,
    }));
    return NextResponse.json({
      ok: true,
      file_title: data.properties?.title ?? null,
      tabs,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
