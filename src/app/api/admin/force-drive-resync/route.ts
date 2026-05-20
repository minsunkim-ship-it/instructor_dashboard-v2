/**
 * POST /api/admin/force-drive-resync?startDate=2024-01-01&endDate=2026-12-31
 * Drive satisfaction collector를 명시 기간으로 강제 호출 → normalize → applySatisfactionImports.
 * Incremental checkpoint 무시 — full re-collect.
 *
 * 인증: CRON_SECRET
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";
import { collectSatisfactionFromDrive } from "@/lib/pipeline/satisfaction-drive-collector";
import { normalizeSatisfactionDriveResults } from "@/lib/pipeline/satisfaction-drive-normalizer";
import { applySatisfactionImports } from "@/lib/pipeline/satisfaction-applier";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const startDate = request.nextUrl.searchParams.get("startDate") ?? "2024-01-01";
  const endDate = request.nextUrl.searchParams.get("endDate") ?? new Date().toISOString().slice(0, 10);
  const applyMode = request.nextUrl.searchParams.get("apply") === "1";
  const startedAt = Date.now();

  const collected = await collectSatisfactionFromDrive({
    startDate,
    endDate,
    maxPages: 100,
    pageSize: 100,
  });

  const filesFound = collected.totalFilesFound;
  const filesNormalized = collected.files.length;

  if (!applyMode) {
    return NextResponse.json({
      ok: true,
      mode: "dry_run",
      durationMs: Date.now() - startedAt,
      startDate,
      endDate,
      files_found_in_drive: filesFound,
      files_normalized_candidate: filesNormalized,
      sample_files: collected.files.slice(0, 10).map((f) => ({
        id: f.fileId,
        name: f.fileName,
      })),
      note: "dry_run — apply=1 로 호출하면 normalize + applySatisfactionImports 실행됨",
    });
  }

  const normalized = await normalizeSatisfactionDriveResults(collected);
  const runId = `force-drive-resync-${Date.now()}`;
  const importApplyResult = await applySatisfactionImports({ runId, items: normalized.items });

  return NextResponse.json({
    ok: true,
    mode: "apply",
    durationMs: Date.now() - startedAt,
    startDate,
    endDate,
    files_found_in_drive: filesFound,
    files_normalized: filesNormalized,
    normalized_items: normalized.items.length,
    apply_summary: importApplyResult,
  });
}
