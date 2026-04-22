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
const MAX_VISIBLE_INSTRUCTORS = 100;

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
    (category: string) => {
      updateParams({ category });
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

  const allItems = data?.data.items ?? [];
  const items = allItems.slice(0, MAX_VISIBLE_INSTRUCTORS);
  const lastUpdated = data?.meta.last_updated_at;

  // 검색/필터 결과가 비어있을 때
  const hasActiveFilter =
    debouncedQuery !== "" || categoryParam !== "전체";
  const isEmpty = data?.status === "empty" || allItems.length === 0;

  if (isEmpty && !hasActiveFilter) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        등록된 강사가 없습니다.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-[var(--border)] bg-white">
        <div className="border-b border-[var(--border)] px-5 py-4">
          <div className="mb-2 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="truncate text-[16px] font-bold tracking-[-0.015em] text-[var(--text-primary)]">
                패스트캠퍼스 강사 대시보드
              </h1>
            </div>
          </div>

          <div className="text-[11px] text-[var(--text-muted)]">
            {lastUpdated
              ? `마지막 업데이트 ${new Date(lastUpdated).toLocaleString("ko-KR")}`
              : "마지막 업데이트 정보 없음"}
          </div>
        </div>

        <div className="border-b border-[var(--border-light)] px-5 py-3">
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[11px] font-semibold text-[var(--text-muted)]">
              Q
            </span>
            <input
              type="text"
              value={searchInput}
              onChange={handleSearchChange}
              placeholder="강사명, 담당 강의 정보, 전문분야 검색..."
              className="w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 pl-9 text-[12px] leading-5 text-[var(--text-primary)] outline-none transition placeholder:text-[12px] placeholder:text-[var(--text-muted)] focus:border-[var(--primary-light)]"
            />
          </div>
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)_110px] gap-2 border-b border-[var(--border-light)] px-5 py-2">
          <div className="relative">
            <select
              value={categoryParam}
              onChange={(e) => handleCategoryChange(e.target.value)}
              className="h-8 w-full appearance-none rounded-[var(--radius-xs)] border border-[var(--border)] bg-white px-3 pr-8 text-[9px] leading-none font-normal text-[var(--text-secondary)] outline-none"
            >
              <option value="전체">전체 카테고리</option>
              {categoryOptions.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </select>
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[8px] text-[var(--text-muted)]">
              ▾
            </span>
          </div>
          <div className="relative">
            <select
              value={sortParam}
              onChange={handleSortChange}
              className="h-8 w-full appearance-none rounded-[var(--radius-xs)] border border-[var(--border)] bg-white px-3 pr-7 text-[9px] leading-none font-normal text-[var(--text-secondary)] outline-none"
            >
              {SORT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[8px] text-[var(--text-muted)]">
              ▾
            </span>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto bg-white px-2.5 py-2">
        {isEmpty ? (
          <div className="flex flex-col items-center justify-center px-5 py-10 text-center text-[13px] text-[var(--text-muted)]">
            <div className="mb-2 text-2xl opacity-40">Q</div>
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
  const tagItems = [
    ...teachingTitles.map((title) => ({
      key: `teaching-${title}`,
      label: title,
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
      })),
  ];
  const visibleTagItems = tagItems.slice(0, 2);
  const primaryCategory = instructor.categories[0]?.trim() || null;
  const visibleSubtitleTags = visibleTagItems.filter(
    (tag) =>
      !primaryCategory ||
      normalizeTagComparableText(tag.label) !== normalizeTagComparableText(primaryCategory)
  );
  const hiddenTagCount = Math.max(0, tagItems.length - visibleTagItems.length);
  const subtitleParts = [
    primaryCategory,
    visibleSubtitleTags.length > 0
      ? visibleSubtitleTags.map((tag) => tag.label).join(", ")
      : null,
    hiddenTagCount > 0 ? `외 ${hiddenTagCount}개` : null,
  ].filter((value): value is string => Boolean(value && value.trim()));
  const rankClass =
    instructor.rank !== null && instructor.rank <= 3
      ? "bg-gradient-to-br from-amber-500 to-orange-500 text-white"
      : instructor.rank !== null && instructor.rank <= 10
        ? "bg-[var(--primary)] text-white"
        : "bg-[var(--border-light)] text-[var(--text-secondary)]";

  return (
    <button
      type="button"
      onClick={onClick}
      className={`mb-0.5 flex w-full items-center gap-3 rounded-[var(--radius-sm)] border px-3 py-3 text-left transition-all ${
        isSelected
          ? "border-[var(--primary-light)] bg-[var(--primary-50)]"
          : "border-transparent bg-white hover:bg-[var(--border-light)]"
      }`}
    >
      <div
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${rankClass}`}
      >
        {instructor.rank ?? "-"}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 truncate text-[14px] font-semibold leading-5 text-[var(--text-primary)]">
          <span className="truncate">{instructor.name}</span>
          {instructor.flag && (
            <span className="rounded-[4px] bg-[var(--danger)] px-1.5 py-0.5 text-[10px] font-semibold text-white">
              {instructor.flag}
            </span>
          )}
        </div>

        {subtitleParts.length > 0 && (
          <div className="mt-1 truncate text-[11px] text-[var(--text-muted)]">
            {subtitleParts.join(" · ")}
          </div>
        )}
      </div>

      <div className="shrink-0 text-right">
        <div
          className="mb-1 ml-auto h-[5px] w-12 overflow-hidden rounded-sm bg-[var(--border-light)]"
          aria-label={
            instructor.score === null
              ? "점수 없음"
              : `점수 ${formatScore(instructor.score)}`
          }
          role="img"
        >
          <div
            className={`h-full rounded-sm ${getScoreBarClass(instructor.score)}`}
            style={{ width: `${getScorePercent(instructor.score)}%` }}
          />
        </div>

        <div className="text-[11px] text-[var(--text-muted)]">
          {formatCourses(instructor.total_courses)} ·{" "}
          {formatFeeLabel(instructor.base_fee_hourly, instructor.is_fulltime)}
        </div>
      </div>
    </button>
  );
}
