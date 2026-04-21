"use client";

import { Suspense, useState, useCallback } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import InstructorList from "@/components/InstructorList";
import InstructorDetail from "@/components/InstructorDetail";
import FallbackBanner from "@/components/FallbackBanner";
import DataStatusPanel from "@/components/DataStatusPanel";
import type { RefreshResponse, StatusResponse } from "@/types/api";

async function fetchStatus(): Promise<StatusResponse> {
  const res = await fetch("/api/status");
  if (!res.ok) throw new Error("상태 조회 실패");
  return res.json();
}

type RefreshScope = "lightweight" | "teaching_history" | "postprocess";

interface CombinedRefreshResult {
  refreshStatus: "success" | "partial" | "failed";
  recordsUpdated: number;
  partialSources: number;
  failedSources: number;
}

async function postRefresh(scope: RefreshScope): Promise<RefreshResponse> {
  const res = await fetch(`/api/refresh?scope=${scope}`, { method: "POST" });
  const payload = (await res.json().catch(() => null)) as
    | RefreshResponse
    | null;

  if (!res.ok) {
    throw new Error(
      payload?.errors?.[0]?.message ?? "데이터 새로고침에 실패했습니다."
    );
  }

  if (!payload) {
    throw new Error("새로고침 응답을 읽지 못했습니다.");
  }

  return payload;
}

function combineRefreshResults(
  results: RefreshResponse[]
): CombinedRefreshResult {
  const refreshStatuses = results.map(
    (result) => result.data?.refresh_status ?? "failed"
  );
  const refreshStatus = refreshStatuses.includes("failed")
    ? "failed"
    : refreshStatuses.includes("partial")
      ? "partial"
      : "success";

  return {
    refreshStatus,
    recordsUpdated: results.reduce(
      (sum, result) => sum + (result.data?.summary.records_updated ?? 0),
      0
    ),
    partialSources: results.reduce(
      (sum, result) => sum + (result.data?.summary.sources_partial ?? 0),
      0
    ),
    failedSources: results.reduce(
      (sum, result) => sum + (result.data?.summary.sources_failed ?? 0),
      0
    ),
  };
}

export default function Home() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const handleSelectInstructor = useCallback((id: string) => {
    setSelectedId(id);
  }, []);

  const {
    data: statusData,
    isLoading: statusLoading,
    isError: statusIsError,
    error: statusError,
  } = useQuery({
    queryKey: ["status"],
    queryFn: fetchStatus,
    refetchInterval: ({ state }) =>
      state.data?.data.current_run ? 5_000 : false,
  });
  const isFallback = statusData?.meta?.is_fallback ?? false;

  const refreshMutation = useMutation({
    mutationFn: async (): Promise<CombinedRefreshResult> => {
      setRefreshMessage("1/3 새로고침 중 · 일반 source 동기화");
      const lightweight = await postRefresh("lightweight");
      setRefreshMessage("2/3 새로고침 중 · 출강시트 동기화");
      const teachingHistory = await postRefresh("teaching_history");
      const sourceStepResults = [lightweight, teachingHistory];
      const hasSourceFailures = sourceStepResults.some(
        (result) => (result.data?.summary.sources_failed ?? 0) > 0
      );
      const hasHardFailure = sourceStepResults.some(
        (result) => (result.data?.refresh_status ?? "failed") === "failed"
      );

      if (hasSourceFailures || hasHardFailure) {
        return combineRefreshResults(sourceStepResults);
      }

      setRefreshMessage("3/3 새로고침 중 · 후처리 실행");
      const postprocess = await postRefresh("postprocess");
      return combineRefreshResults([...sourceStepResults, postprocess]);
    },
    onSuccess: async (result) => {
      setRefreshMessage(
        result.refreshStatus === "partial"
          ? result.partialSources === 0 && result.failedSources === 0
            ? `새로고침 부분 완료 · ${result.recordsUpdated}건 반영 · 후처리 일부 미완료`
            : `새로고침 부분 완료 · ${result.recordsUpdated}건 반영 · partial ${result.partialSources} / failed ${result.failedSources}`
          : `새로고침 완료 · ${result.recordsUpdated}건 반영`
      );

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["status"] }),
        queryClient.invalidateQueries({ queryKey: ["instructors"] }),
        queryClient.invalidateQueries({ queryKey: ["instructor"] }),
      ]);
    },
    onError: (error) => {
      setRefreshMessage(
        error instanceof Error ? error.message : "새로고침에 실패했습니다."
      );
    },
  });

  const handleRefresh = useCallback(() => {
    setRefreshMessage(null);
    refreshMutation.mutate();
  }, [refreshMutation]);

  return (
    <div className="flex flex-col min-h-screen">
      <FallbackBanner isFallback={isFallback} />
      <div className="flex bg-gray-50">
      {/* 좌측 목록 영역 */}
      <div className="sticky top-0 self-start h-screen w-[420px] border-r border-gray-200 bg-white flex flex-col shrink-0 overflow-hidden">
        <DataStatusPanel
          statusData={statusData}
          statusLoading={statusLoading}
          statusErrorMessage={
            statusIsError
              ? statusError instanceof Error
                ? statusError.message
                : "상태 조회 실패"
              : null
          }
          refreshPending={refreshMutation.isPending}
          refreshMessage={refreshMessage}
          onRefresh={handleRefresh}
        />
        <Suspense
          fallback={
            <div className="flex items-center justify-center h-full text-gray-500">
              데이터를 불러오는 중...
            </div>
          }
        >
          <InstructorList
            onSelectInstructor={handleSelectInstructor}
            selectedInstructorId={selectedId}
          />
        </Suspense>
      </div>

      {/* 우측 상세 패널 */}
      <div className="flex-1 min-w-0 bg-gray-50">
        {selectedId ? (
          <InstructorDetail instructorId={selectedId} />
        ) : (
          <div className="flex items-center justify-center min-h-screen text-gray-400">
            강사를 선택하면 상세 정보가 표시됩니다.
          </div>
        )}
      </div>
      </div>
    </div>
  );
}
