"use client";

import { useQuery } from "@tanstack/react-query";
import {
  useState,
  useCallback,
  useEffect,
  useRef,
  useMemo,
  Suspense,
} from "react";
import { useSearchParams, useRouter } from "next/navigation";
import type { InstructorListItem, InstructorListResponse } from "@/types/api";

// 정렬 옵션 — 06_implementation_spec.md Feature D
const SORT_OPTIONS = [
  { label: "점수순", value: "score_desc" },
  { label: "순위순", value: "rank_asc" },
  { label: "출강순", value: "courses_desc" },
  { label: "최근 활동순", value: "recent_desc" },
  { label: "단가순", value: "fee_desc" },
  { label: "이름순", value: "name_asc" },
] as const;

const DEFAULT_SORT = "score_desc";

// 디바운스 훅 — 검색 입력 300ms 지연
function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debouncedValue;
}

async function fetchInstructors(
  query: string,
  category: string,
  sort: string
): Promise<InstructorListResponse> {
  const params = new URLSearchParams();
  if (query) params.set("query", query);
  if (category && category !== "전체") params.set("category", category);
  if (sort) params.set("sort", sort);

  const qs = params.toString();
  const url = `/api/instructors${qs ? `?${qs}` : ""}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("목록 조회 실패");
  return res.json();
}

// 06_implementation_spec.md Feature A: 점수 소수점 한 자리 반올림
function formatScore(score: number | null): string {
  if (score === null) return "-";
  return score.toFixed(1);
}

interface InstructorListInnerProps {
  onSelectInstructor?: (id: string) => void;
  selectedInstructorId?: string | null;
}

function InstructorListInner({ onSelectInstructor, selectedInstructorId }: InstructorListInnerProps) {
  const searchParams = useSearchParams();
  const router = useRouter();

  // URL 파라미터에서 상태 읽기
  const queryParam = searchParams.get("query") ?? "";
  const categoryParam = searchParams.get("category") ?? "전체";
  const sortParam = searchParams.get("sort") ?? DEFAULT_SORT;

  // 로컬 검색 입력 (디바운스 전 원본)
  const [searchInput, setSearchInput] = useState(queryParam);
  const debouncedQuery = useDebounce(searchInput, 300);

  // 선택된 강사 ID — 외부에서 제어 가능, 없으면 로컬 상태 사용
  const [localSelectedId, setLocalSelectedId] = useState<string | null>(null);
  const selectedId = selectedInstructorId !== undefined ? selectedInstructorId : localSelectedId;

  // 카테고리 목록 캐시 — 필터링된 결과에서 카테고리가 사라지지 않도록 보존
  const categoryCacheRef = useRef<string[]>([]);

  // URL 파라미터 업데이트 헬퍼
  const updateParams = useCallback(
    (updates: Record<string, string>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (
          !value ||
          (key === "category" && value === "전체") ||
          (key === "sort" && value === DEFAULT_SORT) ||
          (key === "query" && value === "")
        ) {
          next.delete(key);
        } else {
          next.set(key, value);
        }
      }
      const qs = next.toString();
      router.replace(qs ? `?${qs}` : "/", { scroll: false });
    },
    [searchParams, router]
  );

  // 디바운스된 검색어가 변경되면 URL 업데이트
  useEffect(() => {
    updateParams({ query: debouncedQuery });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery]);

  // API fetch — 디바운스된 query, category, sort 사용
  const { data, isLoading, isError } = useQuery({
    queryKey: ["instructors", debouncedQuery, categoryParam, sortParam],
    queryFn: () => fetchInstructors(debouncedQuery, categoryParam, sortParam),
  });

  // 카테고리 목록: 첫 전체 데이터에서 추출 후 캐시
  const categoryOptions = useMemo(() => {
    const items = data?.data.items ?? [];
    if (items.length > 0) {
      const cats = new Set<string>();
      for (const item of items) {
        for (const cat of item.categories) {
          cats.add(cat);
        }
      }
      const sorted = Array.from(cats).sort();
      if (sorted.length > 0) {
        categoryCacheRef.current = sorted;
      }
    }
    return categoryCacheRef.current;
  }, [data]);

  // 이벤트 핸들러
  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearchInput(e.target.value);
    },
    []
  );

  const handleCategoryChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      updateParams({ category: e.target.value });
    },
    [updateParams]
  );

  const handleSortChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      updateParams({ sort: e.target.value });
    },
    [updateParams]
  );

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

  // 검색/필터 결과가 비어있을 때
  const hasActiveFilter =
    debouncedQuery !== "" || categoryParam !== "전체";
  const isEmpty = data?.status === "empty" || items.length === 0;

  if (isEmpty && !hasActiveFilter) {
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

        {/* Feature B: 검색 입력 */}
        <div className="mt-3">
          <input
            type="text"
            value={searchInput}
            onChange={handleSearchChange}
            placeholder="강사명, 소속, 전문분야 검색..."
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>

        {/* Feature C: 카테고리 필터 + Feature D: 정렬 드롭다운 */}
        <div className="mt-2 flex gap-2">
          <select
            value={categoryParam}
            onChange={handleCategoryChange}
            className="flex-1 px-3 py-1.5 text-sm border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
          >
            <option value="전체">전체</option>
            {categoryOptions.map((cat) => (
              <option key={cat} value={cat}>
                {cat}
              </option>
            ))}
          </select>

          <select
            value={sortParam}
            onChange={handleSortChange}
            className="flex-1 px-3 py-1.5 text-sm border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Feature A: 카드형 리스트 */}
      <div className="flex-1 overflow-y-auto">
        {isEmpty ? (
          <div className="flex items-center justify-center h-32 text-gray-500 text-sm">
            검색 결과가 없습니다
          </div>
        ) : (
          items.map((inst) => (
            <InstructorCard
              key={inst.id}
              instructor={inst}
              isSelected={selectedId === inst.id}
              onClick={() => {
                setLocalSelectedId(inst.id);
                onSelectInstructor?.(inst.id);
              }}
            />
          ))
        )}
      </div>
    </div>
  );
}

// Suspense 래핑된 default export
export interface InstructorListProps {
  onSelectInstructor?: (id: string) => void;
  selectedInstructorId?: string | null;
}

export default function InstructorList({ onSelectInstructor, selectedInstructorId }: InstructorListProps) {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-full text-gray-500">
          데이터를 불러오는 중...
        </div>
      }
    >
      <InstructorListInner
        onSelectInstructor={onSelectInstructor}
        selectedInstructorId={selectedInstructorId}
      />
    </Suspense>
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
