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
  { label: "출강횟수순", value: "courses_desc" },
  { label: "강의시간순", value: "hours_desc" },
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

function getScorePercent(score: number | null): number {
  if (score === null || Number.isNaN(score)) return 0;
  return Math.max(0, Math.min(100, score));
}

function getScoreBarClass(score: number | null): string {
  const percent = getScorePercent(score);
  if (percent >= 85) return "bg-emerald-500";
  if (percent >= 70) return "bg-lime-500";
  if (percent >= 50) return "bg-amber-400";
  if (percent > 0) return "bg-rose-400";
  return "bg-gray-200";
}

function formatHours(hours: number): string {
  if (hours === Math.floor(hours)) return `${hours}시간`;
  return `${hours.toFixed(1)}시간`;
}

function formatCourses(courses: number): string {
  return `${courses}회`;
}

function formatFeeLabel(won: number | null, isFulltime: boolean): string {
  if (isFulltime) return "전임강사";
  if (won === null) return "-";
  const man = won / 10000;
  if (man === Math.floor(man)) return `${Math.floor(man)}만원`;
  return `${man.toFixed(1)}만원`;
}

function normalizeTagComparableText(value: string): string {
  return value.replace(/\s+/g, "").trim().toLowerCase();
}

function dedupeTagValues(values: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = normalizeTagComparableText(trimmed);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(trimmed);
  }

  return deduped;
}

function formatListTagLabel(value: string): string {
  const trimmed = value.trim();
  const maxLength = 16;
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}…`;
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
  const visibleCount = items.length;
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
      <div className="border-b border-slate-200 bg-gradient-to-b from-white via-white to-slate-50/70 px-4 py-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-[22px] font-semibold tracking-tight text-slate-900">
              강사 목록
            </h1>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <span className="inline-flex items-center rounded-full border border-slate-200 bg-white px-2.5 py-1 font-medium text-slate-700">
                현재 {visibleCount}명
              </span>
              {lastUpdated && (
                <span className="inline-flex items-center rounded-full border border-slate-200 bg-white px-2.5 py-1">
                  {new Date(lastUpdated).toLocaleDateString("ko-KR")} 업데이트
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="mt-4 rounded-2xl border border-slate-200 bg-white/95 p-3 shadow-sm">
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">
              <svg viewBox="0 0 20 20" aria-hidden="true" className="h-4 w-4 fill-current">
                <path d="M8.5 3a5.5 5.5 0 1 0 3.48 9.76l3.63 3.63 1.06-1.06-3.63-3.63A5.5 5.5 0 0 0 8.5 3Zm0 1.5a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z" />
              </svg>
            </span>
            <input
              type="text"
              value={searchInput}
              onChange={handleSearchChange}
              placeholder="강사명, 담당 강의 정보, 전문분야 검색..."
              className="w-full rounded-xl border border-slate-200 bg-slate-50/70 py-3 pl-10 pr-3 text-sm text-slate-800 placeholder:text-slate-400 focus:border-sky-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-sky-100"
            />
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <select
              value={categoryParam}
              onChange={handleCategoryChange}
              className="rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-2.5 text-sm font-medium text-slate-700 focus:border-sky-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-sky-100"
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
              className="rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-2.5 text-sm font-medium text-slate-700 focus:border-sky-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-sky-100"
            >
              {SORT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Feature A: 카드형 리스트 */}
      <div className="flex-1 overflow-y-auto bg-slate-50/60 px-3 py-3">
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
  const teachingTitles = dedupeTagValues(instructor.teaching_titles);
  const specialties = dedupeTagValues(instructor.specialties);
  const tagClass =
    "inline-flex h-7 min-w-0 items-center rounded-full px-3 text-[12px] leading-none font-medium align-middle";
  const tagItems = [
    ...teachingTitles.map((title) => ({
      key: `teaching-${title}`,
      label: title,
      className: "bg-sky-50 text-sky-700",
    })),
    ...specialties
      .filter(
        (spec) =>
          !teachingTitles.some(
            (title) => normalizeTagComparableText(title) === normalizeTagComparableText(spec)
          )
      )
      .map((spec) => ({
        key: `specialty-${spec}`,
        label: spec,
        className: "bg-slate-100 text-slate-700",
      })),
  ];
  const visibleTagItems = tagItems.slice(0, 2);
  const hiddenTagCount = Math.max(0, tagItems.length - visibleTagItems.length);

  return (
    <button
      type="button"
      onClick={onClick}
      className={`mb-2.5 w-full rounded-2xl border px-4 py-3.5 text-left shadow-sm transition-all cursor-pointer ${
        isSelected
          ? "border-sky-300 bg-white ring-2 ring-sky-100"
          : "border-slate-200 bg-white hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-[22px] leading-none tracking-tight font-semibold text-slate-900 truncate">
                {instructor.name}
              </div>
              {visibleTagItems.length > 0 && (
                <div className="mt-3 flex items-center gap-1.5 whitespace-nowrap">
                  {visibleTagItems.map((tag) => (
                    <span
                      key={tag.key}
                      className={`${tagClass} shrink-0 ${tag.className}`}
                      title={tag.label}
                    >
                      {formatListTagLabel(tag.label)}
                    </span>
                  ))}
                  {hiddenTagCount > 0 && (
                    <span
                      className={`${tagClass} shrink-0 bg-sky-100 text-sky-600`}
                    >
                      외 {hiddenTagCount}개
                    </span>
                  )}
                </div>
              )}
            </div>

            <div className="flex-shrink-0 pt-1">
              <div className="flex flex-col items-end gap-2">
                <div
                  className="h-1.5 w-20 overflow-hidden rounded-full bg-slate-100"
                  aria-label={
                    instructor.score === null
                      ? "점수 없음"
                      : `점수 ${formatScore(instructor.score)}`
                  }
                  role="img"
                >
                  <div
                    className={`h-full rounded-full ${getScoreBarClass(
                      instructor.score
                    )}`}
                    style={{ width: `${getScorePercent(instructor.score)}%` }}
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
            <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-1 font-medium text-slate-700">
              {formatHours(instructor.total_hours)}
            </span>
            <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-1 font-medium text-slate-700">
              {formatCourses(instructor.total_courses)}
            </span>
            <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-1 font-medium text-slate-700">
              {formatFeeLabel(
                instructor.base_fee_hourly,
                instructor.is_fulltime
              )}
            </span>
          </div>
        </div>
      </div>
    </button>
  );
}
