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
      {/*
        STAGE_2_SLOT: FallbackBanner (Wave 1 T9)
        ------------------------------------------------------------------
        Status: deferred (awaits Group 2 T9 artifact merge).
        Owner for merge: Group 1 (this group).

        Current state:
        - FallbackBanner.tsx lives at `src/components/FallbackBanner.tsx`
          and is owned by Group 2 per docs/12 §5-2. This worktree must
          not edit it (docs/12 §4-3).
        - InstructorList.tsx already renders `<FallbackBanner isFallback=
          {meta.is_fallback} />` at the top of the left column (see
          src/components/InstructorList.tsx line 14 + line 201), so the
          *list-side* fallback signal is already wired.
        - page.tsx intentionally does NOT re-render FallbackBanner here
          to avoid duplication while Group 2 finalizes its T9 deliverable.

        Post-merge 2-step checklist (Group 1 performs after Group 2 T9
        artifact merge lands on main):
          1. Decide whether a *page-level* (global) banner is additionally
             required beyond the list-side banner.
               - If list-side coverage is sufficient (list + detail both
                 share `meta.is_fallback`), leave this slot as-is and
                 delete this comment block.
               - If a full-width banner above both columns is required,
                 proceed to step 2.
          2. Wire the page-level banner:
               import FallbackBanner from "@/components/FallbackBanner";
               // Expected props (from Group 2 T9):
               //   isFallback: boolean  — set from latest API meta.is_fallback.
               //   Suggested source: status or detail query's meta.
               // Render position: insert as a sibling ABOVE this
               //   `<div className="flex h-screen ...">` and wrap both in
               //   `<div className="flex flex-col h-screen">`.
               // Render condition: `data.meta?.is_fallback === true`
               //   (FallbackBanner already short-circuits when false).
        ------------------------------------------------------------------
      */}
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
