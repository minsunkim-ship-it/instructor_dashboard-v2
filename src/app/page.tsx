"use client";

import { Suspense, useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import InstructorList from "@/components/InstructorList";
import InstructorDetail from "@/components/InstructorDetail";
import FallbackBanner from "@/components/FallbackBanner";

async function fetchStatus(): Promise<{ meta?: { is_fallback?: boolean } }> {
  const res = await fetch("/api/status");
  if (!res.ok) throw new Error("상태 조회 실패");
  return res.json();
}

export default function Home() {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const handleSelectInstructor = useCallback((id: string) => {
    setSelectedId(id);
  }, []);

  const { data: statusData } = useQuery({
    queryKey: ["status"],
    queryFn: fetchStatus,
  });
  const isFallback = statusData?.meta?.is_fallback ?? false;

  return (
    <div className="flex flex-col h-screen">
      <FallbackBanner isFallback={isFallback} />
      <div className="flex flex-1 bg-gray-50 min-h-0">
      {/* 좌측 목록 영역 */}
      <div className="w-[420px] border-r border-gray-200 bg-white flex flex-col shrink-0">
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
      <div className="flex-1 min-w-0">
        {selectedId ? (
          <InstructorDetail instructorId={selectedId} />
        ) : (
          <div className="flex items-center justify-center h-full text-gray-400">
            강사를 선택하면 상세 정보가 표시됩니다.
          </div>
        )}
      </div>
      </div>
    </div>
  );
}
