"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { InstructorListItem, InstructorListResponse } from "@/types/api";

async function fetchInstructors(): Promise<InstructorListResponse> {
  const res = await fetch("/api/instructors");
  if (!res.ok) throw new Error("목록 조회 실패");
  return res.json();
}

// 06_implementation_spec.md Feature A: 점수 소수점 한 자리 반올림
function formatScore(score: number | null): string {
  if (score === null) return "-";
  return score.toFixed(1);
}

export default function InstructorList() {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["instructors"],
    queryFn: fetchInstructors,
  });

  // 06_implementation_spec.md 3절: loading 상태
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        데이터를 불러오는 중...
      </div>
    );
  }

  // 06_implementation_spec.md 3절: error 상태
  if (isError) {
    return (
      <div className="flex items-center justify-center h-full text-red-500">
        강사 목록을 불러오지 못했습니다.
      </div>
    );
  }

  const items = data?.data.items ?? [];
  const totalCount = data?.meta.total_count ?? 0;
  const lastUpdated = data?.meta.last_updated_at;

  // 06_implementation_spec.md 3절: empty 상태
  if (data?.status === "empty" || items.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        등록된 강사가 없습니다.
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Feature A: 목록 영역 상단 — 제목, 전체 강사 수, 마지막 업데이트 시각 */}
      <div className="px-4 py-3 border-b border-gray-200">
        <h1 className="text-lg font-semibold text-gray-900">강사 목록</h1>
        <div className="mt-1 flex items-center gap-2 text-sm text-gray-500">
          <span>전체 {totalCount}명</span>
          {lastUpdated && (
            <>
              <span className="text-gray-300">|</span>
              <span>
                {new Date(lastUpdated).toLocaleDateString("ko-KR")} 업데이트
              </span>
            </>
          )}
        </div>
      </div>

      {/* Feature A: 카드형 리스트 */}
      <div className="flex-1 overflow-y-auto">
        {items.map((inst) => (
          <InstructorCard
            key={inst.id}
            instructor={inst}
            isSelected={selectedId === inst.id}
            onClick={() => setSelectedId(inst.id)}
          />
        ))}
      </div>
    </div>
  );
}

function InstructorCard({
  instructor,
  isSelected,
  onClick,
}: {
  instructor: InstructorListItem;
  isSelected: boolean;
  onClick: () => void;
}) {
  const { categories, specialties } = instructor;
  const primaryCategory = categories[0] ?? null;
  // Feature A: 전문분야는 최대 2개만 표시
  const displaySpecialties = specialties.slice(0, 2);

  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left px-4 py-3 border-b border-gray-100 transition-colors cursor-pointer ${
        isSelected
          ? "bg-blue-50 border-l-2 border-l-blue-500"
          : "hover:bg-gray-50"
      }`}
    >
      <div className="flex items-start gap-3">
        {/* 좌측: 순위 배지 */}
        <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-sm font-medium text-gray-700">
          {instructor.rank !== null ? instructor.rank : "-"}
        </div>

        {/* 중앙: 이름, 카테고리, 소속, 전문분야 */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-gray-900 truncate">
              {instructor.name}
            </span>
            {/* Feature A: 전임강사 배지 */}
            {instructor.is_fulltime && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-purple-100 text-purple-700">
                전임강사
              </span>
            )}
          </div>
          <div className="mt-0.5 text-sm text-gray-500">
            {/* Feature A: 카테고리나 소속이 없으면 - */}
            <span>{primaryCategory ?? "-"}</span>
            <span className="mx-1 text-gray-300">|</span>
            <span>{instructor.affiliation ?? "-"}</span>
          </div>
          {displaySpecialties.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {displaySpecialties.map((spec) => (
                <span
                  key={spec}
                  className="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-gray-100 text-gray-600"
                >
                  {spec}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* 우측: 점수, 총 출강 횟수 */}
        <div className="flex-shrink-0 text-right">
          <div className="text-sm font-semibold text-gray-900">
            {formatScore(instructor.score)}
          </div>
          {/* Feature A: 총 출강 횟수는 N회 형식 */}
          <div className="mt-0.5 text-xs text-gray-500">
            {instructor.total_courses}회
          </div>
        </div>
      </div>
    </button>
  );
}
