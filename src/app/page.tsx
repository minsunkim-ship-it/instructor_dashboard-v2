"use client";

import { Suspense, useState, useCallback } from "react";
import InstructorList from "@/components/InstructorList";
import InstructorDetail from "@/components/InstructorDetail";

export default function Home() {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const handleSelectInstructor = useCallback((id: string) => {
    setSelectedId(id);
  }, []);

  return (
    <div className="flex h-screen bg-gray-50">
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
  );
}
