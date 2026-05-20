/**
 * POST /api/admin/force-drive-resync
 *
 * mode=list (dry_run, fast): Drive 검색 list만, sheets content fetch 안 함
 * mode=fetch&file_ids=id1,id2: 특정 file_id 만 collect (sheets read + normalize + apply)
 * mode=full_apply&startDate=...&endDate=...: 전체 재수집 (느림, Cloudflare timeout 위험)
 *
 * 인증: CRON_SECRET
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";
import { collectSatisfactionFromDrive } from "@/lib/pipeline/satisfaction-drive-collector";
import { normalizeSatisfactionDriveResults } from "@/lib/pipeline/satisfaction-drive-normalizer";
import { applySatisfactionImports } from "@/lib/pipeline/satisfaction-applier";
import { exchangeGoogleUserAccessToken, googleApiGet } from "@/lib/google-user-oauth";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

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

async function listDriveFiles(token: string, q: string, maxPages = 50): Promise<DriveFile[]> {
  const all: DriveFile[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < maxPages; i += 1) {
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
    for (const f of resp.files ?? []) all.push(f);
    if (!resp.nextPageToken) break;
    pageToken = resp.nextPageToken;
  }
  return all;
}

export async function POST(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const mode = request.nextUrl.searchParams.get("mode") ?? "list";
  const startDate = request.nextUrl.searchParams.get("startDate") ?? "2024-01-01";
  const endDate = request.nextUrl.searchParams.get("endDate") ?? new Date().toISOString().slice(0, 10);
  const fileIdsParam = request.nextUrl.searchParams.get("file_ids") ?? "";
  const startedAt = Date.now();

  if (mode === "list") {
    const token = await exchangeGoogleUserAccessToken();
    const q = [
      "name contains '만족도'",
      "trashed = false",
      "mimeType = 'application/vnd.google-apps.spreadsheet'",
      `createdTime >= '${startDate}T00:00:00'`,
      `createdTime <= '${endDate}T23:59:59'`,
    ].join(" and ");
    const files = await listDriveFiles(token, q);
    return NextResponse.json({
      ok: true,
      mode: "list",
      durationMs: Date.now() - startedAt,
      startDate,
      endDate,
      total_files: files.length,
      sample: files.slice(0, 20).map((f) => ({ id: f.id, name: f.name, created: f.createdTime })),
    });
  }

  if (mode === "fetch" || mode === "fetch_dryrun") {
    const fileIds = fileIdsParam.split(",").map((s) => s.trim()).filter(Boolean);
    if (fileIds.length === 0) {
      return NextResponse.json({ ok: false, error: "file_ids required" }, { status: 400 });
    }
    if (fileIds.length > 30) {
      return NextResponse.json({ ok: false, error: "max 30 file_ids per call" }, { status: 400 });
    }
    try {
      const collected = await collectSatisfactionFromDrive({ fileIds });
      const filteredFiles = collected.files;
      const normalized = await normalizeSatisfactionDriveResults({
        ...collected,
        files: filteredFiles,
      });

      if (mode === "fetch_dryrun") {
        // normalize only — DB write 없음, normalize 결과 확인
        const debug = request.nextUrl.searchParams.get("debug") === "1";
        const debugInfo = debug
          ? filteredFiles.map((f) => ({
              file_id: f.fileId,
              file_name: f.fileName,
              sheet_count: f.sheets.length,
              sheets: f.sheets.slice(0, 5).map((s) => ({
                title: s.title,
                row_count: s.rows.length,
                header: s.rows[0]?.slice(0, 10) ?? [],
                sample_row1: s.rows[1]?.slice(0, 10) ?? [],
              })),
            }))
          : undefined;
        return NextResponse.json({
          ok: true,
          mode: "fetch_dryrun",
          durationMs: Date.now() - startedAt,
          file_ids_requested: fileIds,
          file_ids_found_in_drive: filteredFiles.length,
          normalized_items: normalized.items.length,
          sample_items: normalized.items.slice(0, 3).map((it) => ({
            sourceRefKey: it.sourceRefKey,
            candidateCompanyName: it.candidateCompanyName,
            candidateCourseName: it.candidateCourseName,
            scoreNormalized: it.scoreNormalized,
            respondentCount: it.respondentCount,
            responseDate: it.responseDate,
          })),
          debug_files: debugInfo,
        });
      }

      // v23: PipelineRun row 먼저 생성 (runId FK 만족 위해)
      const run = await prisma.pipelineRun.create({
        data: {
          runType: "force_drive_resync_satisfaction",
          status: "running",
          triggeredBy: "api:/api/admin/force-drive-resync",
        },
      });
      const importApplyResult = await applySatisfactionImports({ runId: run.id, items: normalized.items });
      await prisma.pipelineRun.update({
        where: { id: run.id },
        data: { status: "succeeded", finishedAt: new Date() },
      });
      return NextResponse.json({
        ok: true,
        mode: "fetch",
        durationMs: Date.now() - startedAt,
        file_ids_requested: fileIds,
        file_ids_found_in_drive: filteredFiles.length,
        normalized_items: normalized.items.length,
        apply_summary: importApplyResult,
      });
    } catch (err) {
      // 500 원인 surface
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack?.split("\n").slice(0, 8).join("\n") : null;
      return NextResponse.json(
        {
          ok: false,
          error: "fetch_or_apply_failed",
          message,
          stack,
          file_ids_requested: fileIds,
        },
        { status: 500 }
      );
    }
  }

  if (mode === "full_apply") {
    const collected = await collectSatisfactionFromDrive({
      startDate,
      endDate,
      maxPages: 100,
      pageSize: 100,
    });
    const normalized = await normalizeSatisfactionDriveResults(collected);
    const runId = `force-drive-resync-${Date.now()}`;
    const importApplyResult = await applySatisfactionImports({ runId, items: normalized.items });
    return NextResponse.json({
      ok: true,
      mode: "full_apply",
      durationMs: Date.now() - startedAt,
      files_found: collected.totalFilesFound,
      files_normalized: collected.files.length,
      normalized_items: normalized.items.length,
      apply_summary: importApplyResult,
    });
  }

  return NextResponse.json({ ok: false, error: `unknown mode: ${mode}` }, { status: 400 });
}
