"use client";

import { useMemo, useState } from "react";
import type {
  StatusCurrentRun,
  StatusResponse,
  StatusSourceItem,
} from "@/types/api";

const SOURCE_LABELS: Record<string, string> = {
  notion: "노션",
  contract_sheet: "계약시트",
  instructor_dispatch_sheet: "강사 출강시트",
  salesmap: "세일즈맵",
  slack: "슬랙",
  gmail: "Gmail",
  satisfaction: "최근 6개월 만족도 조사 결과",
  fulltime: "전임강사",
  ops_notes: "운영 메모",
};

const STATUS_LABELS: Record<StatusSourceItem["status"], string> = {
  success: "정상",
  partial: "부분 반영",
  failed: "실패",
  never_synced: "미실행",
  running: "실행 중",
};

function getSourceLabel(sourceType: string): string {
  return SOURCE_LABELS[sourceType] ?? sourceType;
}

function formatStageLabel(stage: string | null): string | null {
  if (!stage) return null;
  if (stage.startsWith("source:")) {
    const [, sourceType, ...detailParts] = stage.split(":");
    const sourceLabel = getSourceLabel(sourceType ?? "unknown");
    const detailStage = detailParts.join(":");

    if (!detailStage) {
      return `${sourceLabel} 동기화`;
    }

    const detailLabelMap: Record<string, string> = {
      collect: "수집",
      normalize_store: "정규화 및 저장",
      aggregate_recompute: "집계 재계산",
      sheet_collect: "시트 수집",
      sheet_normalize: "시트 정규화",
      gmail_collect: "Gmail 수집",
      gmail_normalize: "Gmail 정규화",
      apply: "적용",
      "apply:import_items": "적용 준비",
      "apply:load_items": "기존 항목 조회",
      "apply:build_registries": "레지스트리 구성",
      "apply:upsert_registries": "레지스트리 저장",
      "apply:sync_canonical": "정식 만족도 반영",
      "apply:refresh_aggregates": "만족도 집계 갱신",
      "apply:recalculate_scores": "점수 재계산",
    };

    return `${sourceLabel} · ${
      detailLabelMap[detailStage] ?? detailStage
    }`;
  }
  if (stage === "post:practice_coach") return "실습코치 판정";
  if (stage === "post:fee_resolver") return "기본 단가 계산";
  if (stage === "post:fee_history") return "단가 이력 생성";
  if (stage === "post:score_recalc") return "점수 재계산";
  if (stage === "post:operational_intelligence") {
    return "운영 인텔리전스 생성";
  }
  return stage;
}

function summarizeSourceNote(source: StatusSourceItem): string | null {
  const note = source.note?.trim();
  if (!note) {
    switch (source.status) {
      case "partial":
        return "일부 데이터만 반영되었습니다.";
      case "failed":
        return "최근 동기화가 실패했습니다.";
      case "never_synced":
        return "아직 한 번도 실행하지 않았습니다.";
      default:
        return null;
    }
  }

  if (note.includes("failed_channels=")) {
    const channels = note
      .split("failed_channels=")[1]
      ?.split(";")[0]
      ?.split(",")
      .filter(Boolean).length;
    return `일부 채널 수집 실패${channels ? ` (${channels}개)` : ""}`;
  }

  if (note.includes("target_errors=")) {
    const targets = note
      .split("target_errors=")[1]
      ?.split(";")[0]
      ?.split(",")
      .filter(Boolean).length;
    return `일부 대상 메일 수집 실패${targets ? ` (${targets}개)` : ""}`;
  }

  if (note.includes("filtered_invalid_items=")) {
    const count = Number.parseInt(
      note.split("filtered_invalid_items=")[1]?.split(";")[0] ?? "0",
      10
    );
    return `조건에 맞지 않는 메일만 수집되어 정상적으로 제외되었습니다${
      Number.isFinite(count) && count > 0 ? ` (${count}건)` : ""
    }.`;
  }

  if (note.includes("invalid_items:")) {
    const count = Number.parseInt(
      note.split("invalid_items:")[1]?.split(";")[0] ?? "0",
      10
    );
    return `현재 필터 기준에 맞지 않는 항목이 제외되었습니다${
      Number.isFinite(count) && count > 0 ? ` (${count}건)` : ""
    }.`;
  }

  if (note.includes("reflected_instructors=0")) {
    return "수집은 됐지만 강사 데이터에 반영된 항목이 없습니다.";
  }

  if (note.includes("읽지 못했습니다")) {
    return note;
  }

  if (note.includes("Google OAuth token refresh 실패")) {
    return "Google OAuth 토큰 갱신에 실패했습니다.";
  }

  if (note.includes("timeout after")) {
    return "실행 시간이 초과되어 중단되었습니다.";
  }

  if (note.includes("operator does not exist: uuid = text")) {
    const instructorCount =
      note.match(/instructors=(\d+)/)?.[1] ??
      note.match(/affected_instructors=(\d+)/)?.[1] ??
      null;
    return instructorCount
      ? `만족도 집계 갱신 단계에서 DB 타입 불일치 오류가 발생했습니다. 영향 강사 ${instructorCount}명입니다.`
      : "만족도 집계 갱신 단계에서 DB 타입 불일치 오류가 발생했습니다.";
  }

  if (note.includes("prisma.$executeRaw")) {
    return "DB raw query 실행 중 오류가 발생했습니다.";
  }

  if (note.includes("HTTP 4")) {
    return "외부 API 인증 또는 권한 오류가 발생했습니다.";
  }

  if (note.includes("HTTP 5")) {
    return "외부 API가 일시적으로 실패했습니다.";
  }

  return note;
}

function formatDateTime(value: string | null): string {
  if (!value) return "-";
  return new Date(value).toLocaleString("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function buildOverallState(
  statusData: StatusResponse | undefined
): {
  label: string;
  tone: "green" | "amber" | "blue" | "gray" | "red";
  detail: string;
} {
  if (!statusData) {
    return {
      label: "상태 확인 중",
      tone: "gray",
      detail: "최근 실행 상태를 불러오는 중입니다.",
    };
  }

  if (statusData.meta.is_fallback) {
    return {
      label:
        statusData.meta.data_mode === "stored"
          ? "저장 스냅샷 표시 중"
          : "fallback 데이터 표시 중",
      tone: "amber",
      detail:
        statusData.meta.data_mode === "stored"
          ? "실시간 상태 조회에 실패해 마지막 정상 스냅샷 데이터를 표시하고 있습니다."
          : "실시간 상태 조회에 실패해 정적 기준 데이터를 표시하고 있습니다.",
    };
  }

  const currentRun = statusData.data.current_run;
  if (currentRun) {
    const stageLabel = formatStageLabel(currentRun.stage);
    return {
      label: "새로고침 실행 중",
      tone: "blue",
      detail:
        stageLabel !== null
          ? `현재 단계: ${stageLabel}`
          : "현재 실행 단계 정보를 확인하는 중입니다.",
    };
  }

  const failedCount = statusData.data.sources.filter(
    (source) => source.status === "failed"
  ).length;
  const partialCount = statusData.data.sources.filter(
    (source) => source.status === "partial"
  ).length;
  const neverSyncedCount = statusData.data.sources.filter(
    (source) => source.status === "never_synced"
  ).length;

  if (failedCount > 0) {
    return {
      label: "일부 source 실패",
      tone: "red",
      detail: `${failedCount}개 source 실패, ${partialCount}개 source 부분 반영 상태입니다. 현재 화면 데이터가 일부 오래됐을 수 있습니다.`,
    };
  }

  if (partialCount > 0) {
    return {
      label: "부분 반영 상태",
      tone: "amber",
      detail: `${partialCount}개 source가 부분 반영 상태입니다. source 상태 보기에서 원인을 확인할 수 있습니다.`,
    };
  }

  if (neverSyncedCount === statusData.data.sources.length) {
    return {
      label: "초기 동기화 필요",
      tone: "gray",
      detail: "아직 어떤 source도 동기화되지 않았습니다.",
    };
  }

  if (statusData.data.latest_run_status === "partial") {
    return {
      label: "현재 데이터 정상",
      tone: "green",
      detail:
        "최근 전체 refresh는 일부 단계에서 부분 완료였지만, source별 최신 상태 기준으로는 현재 사용 가능한 데이터가 정상입니다.",
    };
  }

  return {
    label: "정상",
    tone: "green",
    detail:
      statusData.data.latest_run_status === "success"
        ? "최근 refresh가 정상 완료되었습니다."
        : "최근 상태 기준으로 사용 가능한 데이터를 표시 중입니다.",
  };
}

function toneClassName(tone: "green" | "amber" | "blue" | "gray" | "red"): string {
  switch (tone) {
    case "green":
      return "border-emerald-200 bg-emerald-50 text-emerald-800";
    case "amber":
      return "border-amber-200 bg-amber-50 text-amber-800";
    case "blue":
      return "border-blue-200 bg-blue-50 text-blue-800";
    case "red":
      return "border-rose-200 bg-rose-50 text-rose-800";
    case "gray":
    default:
      return "border-gray-200 bg-gray-50 text-gray-700";
  }
}

function sourceToneClassName(source: StatusSourceItem): string {
  switch (source.status) {
    case "success":
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    case "partial":
      return "border-amber-200 bg-amber-50 text-amber-700";
    case "failed":
      return "border-rose-200 bg-rose-50 text-rose-700";
    case "running":
      return "border-blue-200 bg-blue-50 text-blue-700";
    case "never_synced":
    default:
      return "border-gray-200 bg-gray-50 text-gray-600";
  }
}

function formatRunProgress(currentRun: StatusCurrentRun | null): string | null {
  if (!currentRun?.stage_progress) return null;

  const processed = currentRun.stage_progress.processed;
  const total = currentRun.stage_progress.total;

  if (typeof processed === "number" && typeof total === "number" && total > 0) {
    return `${processed}/${total}`;
  }

  return null;
}

export interface DataStatusPanelProps {
  statusData?: StatusResponse;
  statusLoading: boolean;
  statusErrorMessage?: string | null;
  refreshPending: boolean;
  refreshMessage?: string | null;
  onRefresh: () => void;
}

export default function DataStatusPanel({
  statusData,
  statusLoading,
  statusErrorMessage,
  refreshPending,
  refreshMessage,
  onRefresh,
}: DataStatusPanelProps) {
  const [showSources, setShowSources] = useState(false);

  const overall = useMemo(() => buildOverallState(statusData), [statusData]);
  const sources = statusData?.data.sources ?? [];
  const issueSources = sources.filter(
    (source) => source.status === "failed" || source.status === "partial"
  );
  const currentRun = statusData?.data.current_run ?? null;
  const progressText = formatRunProgress(currentRun);
  const refreshDisabled =
    refreshPending || statusLoading || statusData?.data.refresh_available === false;

  return (
    <section className="border-b border-gray-200 bg-white px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${toneClassName(
                overall.tone
              )}`}
            >
              {overall.label}
            </span>
            <span className="text-xs text-gray-500">
              최근 업데이트 {formatDateTime(statusData?.data.last_updated_at ?? null)}
            </span>
            {!statusLoading && statusData && statusData.data.fallback_ready && (
              <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs text-emerald-700">
                fallback 준비됨
              </span>
            )}
            {!statusLoading && statusData && !statusData.data.fallback_ready && (
              <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-2.5 py-1 text-xs text-gray-600">
                fallback 스냅샷 없음
              </span>
            )}
          </div>

          <p className="text-sm text-gray-700">{overall.detail}</p>

          {currentRun && (
            <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
              <div className="font-medium">
                실행 중: {currentRun.run_type}
                {currentRun.stage
                  ? ` · ${
                      formatStageLabel(currentRun.stage) ?? currentRun.stage
                    }`
                  : ""}
                {progressText ? ` · ${progressText}` : ""}
              </div>
              <div className="mt-1 text-blue-700">
                시작 {formatDateTime(currentRun.started_at)}
                {currentRun.stage_started_at
                  ? ` · 단계 시작 ${formatDateTime(currentRun.stage_started_at)}`
                  : ""}
              </div>
            </div>
          )}

          {issueSources.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              <div className="font-medium">신뢰도 경고</div>
              <ul className="mt-1 space-y-1">
                {issueSources.slice(0, 3).map((source) => (
                  <li key={source.source_type}>
                    {getSourceLabel(source.source_type)}:{" "}
                    {summarizeSourceNote(source) ?? STATUS_LABELS[source.status]}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {!statusLoading && statusData && !statusData.data.fallback_ready && (
            <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-700">
              fallback 경로는 구현되어 있지만, 아직 사용할 저장 스냅샷이 없습니다.
            </div>
          )}
          {!statusLoading &&
            statusData &&
            !statusData.meta.is_fallback &&
            statusData.data.fallback_ready && (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
                실시간 상태 조회가 실패하면 마지막 정상 스냅샷으로 자동 전환할 수 있습니다.
              </div>
            )}
          {!statusLoading &&
            statusData &&
            statusData.meta.is_fallback &&
            statusData.meta.data_mode === "stored" && (
              <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
                마지막 정상 스냅샷 데이터를 사용 중입니다. 최신 상태와 일부 차이가 있을 수 있습니다.
              </div>
            )}

          {statusErrorMessage && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
              상태 조회 실패: {statusErrorMessage}
            </div>
          )}

          {refreshMessage && (
            <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-700">
              {refreshMessage}
            </div>
          )}
        </div>

        <div className="shrink-0">
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshDisabled}
            className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-800 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {refreshPending || currentRun ? "새로고침 중..." : "지금 새로고침"}
          </button>
        </div>
      </div>

      <div className="mt-3 space-y-2">
        <button
          type="button"
          onClick={() => setShowSources((value) => !value)}
          className="text-xs font-medium text-gray-600 hover:text-gray-900"
        >
          {showSources ? "source 상태 숨기기" : "source 상태 보기"}
        </button>

        {showSources && (
          <div className="grid gap-2">
            {sources.map((source) => (
              <div
                key={source.source_type}
                className={`rounded-lg border px-3 py-2 ${sourceToneClassName(
                  source
                )}`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs font-semibold">
                      {getSourceLabel(source.source_type)}
                    </div>
                    <div className="mt-0.5 text-[11px] opacity-80">
                      최근 동기화 {formatDateTime(source.last_synced_at)}
                    </div>
                  </div>
                  <div className="shrink-0 text-right text-[11px]">
                    <div>{STATUS_LABELS[source.status]}</div>
                    <div>
                      fetched {source.fetched_count} / updated {source.updated_count}
                    </div>
                  </div>
                </div>
                {summarizeSourceNote(source) && (
                  <div className="mt-2 text-[11px] leading-5 opacity-90">
                    {summarizeSourceNote(source)}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
