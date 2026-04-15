import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import type { InstructorListItem, InstructorListResponse } from "@/types/api";

// 05_api_spec.md 5-3절: 허용된 정렬 키
const ALLOWED_SORTS = [
  "score_desc",
  "rank_asc",
  "courses_desc",
  "recent_desc",
  "fee_desc",
  "name_asc",
] as const;

type SortKey = (typeof ALLOWED_SORTS)[number];

// GET /api/instructors — 05_api_spec.md 5절
// 검색, 필터, 정렬 지원

export async function GET(request: NextRequest) {
  const requestId = `req_${crypto.randomUUID()}`;

  try {
    const { searchParams } = request.nextUrl;

    // --- 파라미터 파싱 ---
    const query = (searchParams.get("query") ?? "").trim();
    const category = searchParams.get("category") ?? "전체";
    const sort = (searchParams.get("sort") ?? "score_desc") as string;
    const limitRaw = searchParams.get("limit");
    const limit = limitRaw !== null ? Number(limitRaw) : 100;

    // --- 05_api_spec.md 5-8절: 유효성 검증 ---

    // INVALID_SORT: 허용되지 않은 정렬 키
    if (!ALLOWED_SORTS.includes(sort as SortKey)) {
      return NextResponse.json(
        {
          status: "error",
          meta: {
            request_id: requestId,
            data_mode: "live",
            is_fallback: false,
            last_updated_at: null,
          },
          errors: [
            {
              code: "INVALID_SORT",
              message: `허용되지 않은 정렬 기준입니다: ${sort}`,
            },
          ],
        },
        { status: 400 }
      );
    }

    // INVALID_LIMIT: 범위 밖 limit
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return NextResponse.json(
        {
          status: "error",
          meta: {
            request_id: requestId,
            data_mode: "live",
            is_fallback: false,
            last_updated_at: null,
          },
          errors: [
            {
              code: "INVALID_LIMIT",
              message: `limit은 1~100 사이 정수여야 합니다: ${limitRaw}`,
            },
          ],
        },
        { status: 400 }
      );
    }

    // --- DB 조회: 카테고리 필터는 Prisma에서 처리 ---
    const where =
      category !== "전체" ? { categories: { has: category } } : {};

    const instructors = await prisma.instructor.findMany({ where });

    // --- 06_implementation_spec.md Feature B: 검색 (JS 후처리) ---
    let filtered = instructors;

    if (query !== "") {
      const lowerQuery = query.toLowerCase();

      filtered = instructors.filter((inst) => {
        // name
        if (inst.name.toLowerCase().includes(lowerQuery)) return true;
        // categories array elements
        if (
          inst.categories.some((c) => c.toLowerCase().includes(lowerQuery))
        )
          return true;
        // specialties array elements
        if (
          inst.specialties.some((s) => s.toLowerCase().includes(lowerQuery))
        )
          return true;
        // affiliation
        if (
          inst.affiliation &&
          inst.affiliation.toLowerCase().includes(lowerQuery)
        )
          return true;

        return false;
      });
    }

    // 05_api_spec.md 5-7절: total_count는 query+category 필터 후, limit 적용 전
    const totalCount = filtered.length;

    // --- 06_implementation_spec.md Feature D: 정렬 ---
    const sortedKey = sort as SortKey;

    filtered.sort((a, b) => {
      // 1차 정렬
      const primary = compareBySortKey(a, b, sortedKey);
      if (primary !== 0) return primary;

      // 타이브레이커: rank ascending (nulls last)
      const rankCmp = compareNullsLast(a.rank, b.rank, "asc");
      if (rankCmp !== 0) return rankCmp;

      // 타이브레이커: name ascending
      return a.name.localeCompare(b.name, "ko");
    });

    // --- limit 적용 ---
    const limited = filtered.slice(0, limit);

    // --- 응답 매핑 ---
    const items: InstructorListItem[] = limited.map((inst) => ({
      id: inst.id,
      name: inst.name,
      affiliation: inst.affiliation,
      categories: inst.categories,
      specialties: inst.specialties,
      rank: inst.rank,
      score: inst.score !== null ? Number(inst.score) : null,
      total_courses: inst.totalCourses,
      // 05_api_spec.md 5-5절: 전임강사는 base_fee_hourly 항상 null
      base_fee_hourly: inst.isFulltime ? null : inst.baseFeeHourly,
      is_fulltime: inst.isFulltime,
      flag: inst.flag,
    }));

    // 05_api_spec.md 5-6절: 빈 결과 시 status "empty"
    const status = items.length === 0 ? "empty" : "success";

    const response: InstructorListResponse = {
      status,
      meta: {
        request_id: requestId,
        data_mode: "live",
        is_fallback: false,
        last_updated_at: new Date().toISOString(),
        total_count: totalCount,
        query,
        category,
        sort: sortedKey,
      },
      data: {
        items,
      },
    };

    return NextResponse.json(response);
  } catch {
    // 05_api_spec.md 5-7절: 500 LIST_FETCH_FAILED
    return NextResponse.json(
      {
        status: "error",
        meta: {
          request_id: requestId,
          data_mode: "live",
          is_fallback: false,
          last_updated_at: null,
        },
        errors: [
          {
            code: "LIST_FETCH_FAILED",
            message: "강사 목록 조회에 실패했습니다.",
          },
        ],
      },
      { status: 500 }
    );
  }
}

// --- 정렬 헬퍼 ---

/** null/undefined를 리스트 맨 아래로 보내는 비교 함수 */
function compareNullsLast(
  a: number | null | undefined,
  b: number | null | undefined,
  direction: "asc" | "desc"
): number {
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;

  if (aNull && bNull) return 0;
  if (aNull) return 1; // a를 뒤로
  if (bNull) return -1; // b를 뒤로

  const diff = (a as number) - (b as number);
  return direction === "asc" ? diff : -diff;
}

/** 날짜 비교 (nulls last) */
function compareDatesNullsLast(
  a: Date | null | undefined,
  b: Date | null | undefined,
  direction: "asc" | "desc"
): number {
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;

  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;

  const diff = (a as Date).getTime() - (b as Date).getTime();
  return direction === "asc" ? diff : -diff;
}

/** 정렬 키에 따른 1차 비교 */
function compareBySortKey(
  a: { score: unknown; rank: number | null; totalCourses: number; lastActivityAt: Date | null; baseFeeHourly: number | null; name: string },
  b: { score: unknown; rank: number | null; totalCourses: number; lastActivityAt: Date | null; baseFeeHourly: number | null; name: string },
  key: SortKey
): number {
  switch (key) {
    case "score_desc":
      return compareNullsLast(
        a.score !== null ? Number(a.score) : null,
        b.score !== null ? Number(b.score) : null,
        "desc"
      );
    case "rank_asc":
      return compareNullsLast(a.rank, b.rank, "asc");
    case "courses_desc":
      return compareNullsLast(a.totalCourses, b.totalCourses, "desc");
    case "recent_desc":
      return compareDatesNullsLast(a.lastActivityAt, b.lastActivityAt, "desc");
    case "fee_desc":
      return compareNullsLast(a.baseFeeHourly, b.baseFeeHourly, "desc");
    case "name_asc":
      return a.name.localeCompare(b.name, "ko");
  }
}
