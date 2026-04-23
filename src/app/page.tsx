"use client";

import Image from "next/image";
import { useQuery } from "@tanstack/react-query";
import { Suspense, useState, useCallback } from "react";
import InstructorList from "@/components/InstructorList";
import InstructorDetail from "@/components/InstructorDetail";
import FallbackBanner from "@/components/FallbackBanner";
import type { StatusResponse } from "@/types/api";

async function fetchStatus(): Promise<StatusResponse> {
  const res = await fetch("/api/status");
  if (!res.ok) throw new Error("상태 조회 실패");
  return res.json();
}

export default function Home() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { data: statusData } = useQuery({
    queryKey: ["status", "banner"],
    queryFn: fetchStatus,
  });

  const handleSelectInstructor = useCallback((id: string) => {
    setSelectedId(id);
  }, []);

  return (
    <div className="min-h-screen">
      <FallbackBanner isFallback={statusData?.meta.is_fallback ?? false} />
      <div className="dashboard-shell">
        <div className="dashboard-sidebar">
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center text-sm text-slate-500">
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

        <div className="dashboard-main">
          {selectedId ? (
            <InstructorDetail instructorId={selectedId} />
          ) : (
            <div className="dashboard-empty">
              <div className="flex flex-col items-center justify-center gap-4 text-center">
                <div className="empty-state-mark">
                  <Image
                    src="/favicon.ico"
                    alt="패스트캠퍼스 강사 대시보드"
                    width={36}
                    height={36}
                    className="h-9 w-9 rounded-[10px]"
                  />
                </div>
                <p className="text-sm font-medium text-slate-500">
                  좌측에서 강사를 선택하면 상세 정보가 표시됩니다.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
