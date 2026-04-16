/**
 * Config Source Applier — 04_data_pipeline.md 10절 (전임강사), 17절 (저장), 21-1절 (파이프라인 로그)
 *
 * 전임강사 JSON 또는 운영 메모 hardcoded JSON을 `instructors`에 반영하고,
 * `pipeline_runs` 1건 + `source_sync_logs` 1건을 기록한다.
 *
 * - 전임강사: exact name match로 `is_fulltime = true`만 설정. (01_core_policy.md 4절, 6절, 10절)
 *   비매칭 강사는 건드리지 않는다 (snapshot 덮어쓰기 규칙이 문서에 명시돼 있지 않음).
 * - 운영 메모: `memo_raw`를 비파괴 병합으로만 append.
 *   기존 `memo_raw`(Notion 보조 연락처 appendix 포함 가능)를 보존한다. (04_data_pipeline.md 8-3절 정책 참조)
 */

import { prisma } from "@/lib/prisma";
import type { FulltimeLoadResult } from "./fulltime-loader";
import type { OpsNotesLoadResult } from "./ops-notes-loader";

export interface SourceSyncSummary {
  sourceType: string;
  status: "success" | "partial" | "failed";
  fetchedCount: number;
  updatedCount: number;
  errorMessage: string | null;
  extra: Record<string, unknown>;
}

export interface ApplyResult {
  runId: string;
  runStatus: "success" | "partial" | "failed";
  sync: SourceSyncSummary;
}

/**
 * 전임강사 JSON 적용.
 * - pipeline_runs 1건 + source_sync_logs 1건 기록
 * - instructors.is_fulltime = true (exact name match)
 */
export async function applyFulltime(
  loaded: FulltimeLoadResult,
  triggeredBy: string | null = null
): Promise<ApplyResult> {
  const run = await prisma.pipelineRun.create({
    data: {
      runType: "manual_refresh",
      status: "running",
      triggeredBy,
      summary: {
        pipeline: "fulltime_pilot",
        source_file: loaded.sourcePath,
        json_version: loaded.version,
        json_updated_at: loaded.updatedAt,
      },
    },
  });

  const syncStartedAt = new Date();
  let updatedCount = 0;
  const unmatched: string[] = [];
  let errorMessage: string | null = null;
  let status: "success" | "partial" | "failed" = "success";

  try {
    for (const name of loaded.activeNames) {
      const existing = await prisma.instructor.findFirst({
        where: { name },
        select: { id: true, isFulltime: true },
      });

      if (!existing) {
        unmatched.push(name);
        continue;
      }

      if (!existing.isFulltime) {
        await prisma.instructor.update({
          where: { id: existing.id },
          data: { isFulltime: true },
        });
        updatedCount++;
      }
    }

    if (unmatched.length > 0) {
      status = "partial";
      errorMessage = `unmatched_names: ${unmatched.length}건`;
    }
  } catch (err) {
    status = "failed";
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  const syncFinishedAt = new Date();

  await prisma.sourceSyncLog.create({
    data: {
      runId: run.id,
      sourceType: "fulltime_json",
      status,
      fetchedCount: loaded.activeCount,
      updatedCount,
      errorMessage,
      startedAt: syncStartedAt,
      finishedAt: syncFinishedAt,
    },
  });

  await prisma.pipelineRun.update({
    where: { id: run.id },
    data: {
      status,
      finishedAt: new Date(),
      summary: {
        pipeline: "fulltime_pilot",
        source_file: loaded.sourcePath,
        json_version: loaded.version,
        json_updated_at: loaded.updatedAt,
        total_entries: loaded.totalEntries,
        active_count: loaded.activeCount,
        updated_count: updatedCount,
        unmatched_count: unmatched.length,
        unmatched_names: unmatched,
      },
    },
  });

  return {
    runId: run.id,
    runStatus: status,
    sync: {
      sourceType: "fulltime_json",
      status,
      fetchedCount: loaded.activeCount,
      updatedCount,
      errorMessage,
      extra: {
        total_entries: loaded.totalEntries,
        unmatched_count: unmatched.length,
        unmatched_names: unmatched,
      },
    },
  };
}

/**
 * 기존 memo_raw에 새 메모 라인들을 비파괴 병합한다.
 * - 기존 memo_raw를 보존 (Notion 보조 연락처 appendix 포함 가능)
 * - 이미 동일 라인이 포함돼 있으면 중복 추가하지 않는다 (줄 단위 trim 비교)
 * - 덮어쓰지 않는다
 */
export function mergeMemoNonDestructive(
  existingMemo: string | null,
  newLines: string[]
): { merged: string | null; added: number } {
  const existingLines = existingMemo
    ? existingMemo.split("\n").map((l) => l.trim()).filter(Boolean)
    : [];
  const existingSet = new Set(existingLines);

  const parts: string[] = existingMemo ? [existingMemo] : [];
  let added = 0;

  for (const line of newLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (existingSet.has(trimmed)) continue;
    parts.push(trimmed);
    existingSet.add(trimmed);
    added++;
  }

  if (parts.length === 0) return { merged: null, added: 0 };
  return { merged: parts.join("\n"), added };
}

/**
 * 운영 메모 hardcoded JSON 적용.
 * - pipeline_runs 1건 + source_sync_logs 1건 기록
 * - instructors.memo_raw 비파괴 병합
 */
export async function applyOpsNotes(
  loaded: OpsNotesLoadResult,
  triggeredBy: string | null = null
): Promise<ApplyResult> {
  const run = await prisma.pipelineRun.create({
    data: {
      runType: "manual_refresh",
      status: "running",
      triggeredBy,
      summary: {
        pipeline: "ops_notes_pilot",
        source_file: loaded.sourcePath,
        json_version: loaded.version,
        json_updated_at: loaded.updatedAt,
      },
    },
  });

  const syncStartedAt = new Date();
  let updatedCount = 0;
  const unmatched: string[] = [];
  let errorMessage: string | null = null;
  let status: "success" | "partial" | "failed" = "success";

  try {
    for (const [name, memoLines] of loaded.notesByName.entries()) {
      const existing = await prisma.instructor.findFirst({
        where: { name },
        select: { id: true, memoRaw: true },
      });

      if (!existing) {
        unmatched.push(name);
        continue;
      }

      const { merged, added } = mergeMemoNonDestructive(
        existing.memoRaw,
        memoLines
      );

      if (added > 0) {
        await prisma.instructor.update({
          where: { id: existing.id },
          data: { memoRaw: merged },
        });
        updatedCount++;
      }
    }

    if (unmatched.length > 0) {
      status = "partial";
      errorMessage = `unmatched_names: ${unmatched.length}건`;
    }
  } catch (err) {
    status = "failed";
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  const syncFinishedAt = new Date();

  await prisma.sourceSyncLog.create({
    data: {
      runId: run.id,
      sourceType: "ops_notes_hardcoded",
      status,
      fetchedCount: loaded.totalEntries,
      updatedCount,
      errorMessage,
      startedAt: syncStartedAt,
      finishedAt: syncFinishedAt,
    },
  });

  await prisma.pipelineRun.update({
    where: { id: run.id },
    data: {
      status,
      finishedAt: new Date(),
      summary: {
        pipeline: "ops_notes_pilot",
        source_file: loaded.sourcePath,
        json_version: loaded.version,
        json_updated_at: loaded.updatedAt,
        total_entries: loaded.totalEntries,
        accepted_count: loaded.acceptedCount,
        filtered_out_count: loaded.filteredOutCount,
        updated_count: updatedCount,
        unmatched_count: unmatched.length,
        unmatched_names: unmatched,
      },
    },
  });

  return {
    runId: run.id,
    runStatus: status,
    sync: {
      sourceType: "ops_notes_hardcoded",
      status,
      fetchedCount: loaded.totalEntries,
      updatedCount,
      errorMessage,
      extra: {
        accepted_count: loaded.acceptedCount,
        filtered_out_count: loaded.filteredOutCount,
        unmatched_count: unmatched.length,
        unmatched_names: unmatched,
      },
    },
  };
}
