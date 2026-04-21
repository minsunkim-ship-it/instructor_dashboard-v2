import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import type { InstructorListItem, InstructorListResponse } from "@/types/api";
import { groupTeachingHistories } from "@/lib/teaching-history-display";
import {
  FALLBACK_LAST_UPDATED_AT,
  getFallbackInstructorListItems,
} from "@/lib/fallback-data";
import { readStoredFallbackSnapshot } from "@/lib/fallback-snapshot";
import { shouldIncludeInInstructorList } from "@/lib/instructor-list-visibility";
import { extractNotionPropertyTextList } from "@/lib/notion-property-utils";

// 05_api_spec.md 5-3절: 허용된 정렬 키
const ALLOWED_SORTS = [
  "score_desc",
  "rank_asc",
  "courses_desc",
  "hours_desc",
  "recent_desc",
  "fee_desc",
  "name_asc",
] as const;

type SortKey = (typeof ALLOWED_SORTS)[number];

// GET /api/instructors — 05_api_spec.md 5절
// 검색, 필터, 정렬 지원

export async function GET(request: NextRequest) {
  const requestId = `req_${crypto.randomUUID()}`;
  const { searchParams } = request.nextUrl;

  // --- 파라미터 파싱 ---
  const query = (searchParams.get("query") ?? "").trim();
  const category = searchParams.get("category") ?? "전체";
  const sort = (searchParams.get("sort") ?? "score_desc") as string;
  const limitRaw = searchParams.get("limit");
  const limit = limitRaw !== null ? Number(limitRaw) : 100;
  const sortedKey = sort as SortKey;

  try {
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

    const instructors = (await prisma.instructor.findMany({ where })).filter((inst) =>
      shouldIncludeInInstructorList(inst)
    );

    // --- 06_implementation_spec.md Feature B: 검색 (JS 후처리) ---
    let filtered = instructors;

    if (query !== "") {
      const lowerQuery = query.toLowerCase();

      filtered = instructors.filter((inst) => {
        const teachingInfo = extractNotionPropertyTextList(
          inst.notionRawProperties,
          "담당 강의 정보"
        );
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
        // notion teaching info
        if (teachingInfo.some((value) => value.toLowerCase().includes(lowerQuery))) {
          return true;
        }
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
    const today = new Date().toISOString().split("T")[0];
    const filteredIds = filtered.map((inst) => inst.id);
    const teachingHistories =
      filteredIds.length === 0
        ? []
        : await prisma.teachingHistory.findMany({
            where: {
              instructorDbId: { in: filteredIds },
            },
            select: {
              instructorDbId: true,
              companyName: true,
              courseName: true,
              courseId: true,
              detailType: true,
              feeExtra: true,
              specialNotes: true,
              startDate: true,
              endDate: true,
              dateLabel: true,
              totalSessions: true,
              totalHours: true,
            },
          });

    const historiesByInstructor = new Map<string, Array<{
      course_name: string | null;
      company_name: string | null;
      course_id: string | null;
      detail_type: string | null;
      fee_extra: string | null;
      special_notes: string | null;
      start_date: string | null;
      end_date: string | null;
      date_label: string | null;
      total_sessions: number | null;
      total_hours: number | null;
    }>>();

    for (const row of teachingHistories) {
      const bucket = historiesByInstructor.get(row.instructorDbId) ?? [];
      bucket.push({
        course_name: row.courseName,
        company_name: row.companyName,
        course_id: row.courseId,
        detail_type: row.detailType,
        fee_extra: row.feeExtra,
        special_notes: row.specialNotes,
        start_date: row.startDate?.toISOString().split("T")[0] ?? null,
        end_date: row.endDate?.toISOString().split("T")[0] ?? null,
        date_label: row.dateLabel,
        total_sessions: row.totalSessions,
        total_hours: row.totalHours !== null ? Number(row.totalHours) : null,
      });
      historiesByInstructor.set(row.instructorDbId, bucket);
    }

    const enriched = filtered.map((inst) => {
      const groupedTeaching = groupTeachingHistories(
        historiesByInstructor.get(inst.id) ?? [],
        {
          fromDate: "2025-01-01",
          untilDate: today,
        }
      );

      return {
        ...inst,
        totalCourses: groupedTeaching.length,
        totalHours: groupedTeaching.reduce(
          (sum, item) => sum + (item.total_hours ?? 0),
          0
        ),
        teachingTitles: extractNotionPropertyTextList(
          inst.notionRawProperties,
          "담당 강의 정보"
        ),
      };
    });

    // --- 06_implementation_spec.md Feature D: 정렬 ---
    enriched.sort((a, b) => {
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
    const limited = enriched.slice(0, limit);

    // --- 응답 매핑 ---
    const items: InstructorListItem[] = limited.map((inst) => ({
      id: inst.id,
      name: inst.name,
      affiliation: inst.affiliation,
      categories: inst.categories,
      teaching_titles: inst.teachingTitles,
      specialties: inst.specialties,
      rank: inst.rank,
      score: inst.score !== null ? Number(inst.score) : null,
      total_courses: inst.totalCourses,
      total_hours: inst.totalHours,
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
    const snapshot = await readStoredFallbackSnapshot();
    const fallbackItems = (
      snapshot
        ? snapshot.list_items.map((item) => ({
            ...item,
            lastActivityAt: item.last_activity_at
              ? new Date(item.last_activity_at)
              : null,
          }))
        : getFallbackInstructorListItems()
    ).filter((item) => shouldIncludeInInstructorList(item));
    let filtered = fallbackItems;

    if (query !== "") {
      const lowerQuery = query.toLowerCase();
      filtered = filtered.filter((inst) => {
        if (inst.name.toLowerCase().includes(lowerQuery)) return true;
        if (inst.categories.some((c) => c.toLowerCase().includes(lowerQuery))) {
          return true;
        }
        if (
          (inst.teaching_titles ?? []).some((title) =>
            title.toLowerCase().includes(lowerQuery)
          )
        ) {
          return true;
        }
        if (inst.specialties.some((s) => s.toLowerCase().includes(lowerQuery))) {
          return true;
        }
        if (inst.affiliation?.toLowerCase().includes(lowerQuery)) return true;
        return false;
      });
    }

    if (category !== "전체") {
      filtered = filtered.filter((inst) => inst.categories.includes(category));
    }

    filtered.sort((a, b) => {
      const primary = compareBySortKey(
        {
          score: a.score,
          rank: a.rank,
          totalCourses: a.total_courses,
          totalHours: a.total_hours ?? 0,
          lastActivityAt: a.lastActivityAt,
          baseFeeHourly: a.base_fee_hourly,
          name: a.name,
        },
        {
          score: b.score,
          rank: b.rank,
          totalCourses: b.total_courses,
          totalHours: b.total_hours ?? 0,
          lastActivityAt: b.lastActivityAt,
          baseFeeHourly: b.base_fee_hourly,
          name: b.name,
        },
        sortedKey
      );
      if (primary !== 0) return primary;
      const rankCmp = compareNullsLast(a.rank, b.rank, "asc");
      if (rankCmp !== 0) return rankCmp;
      return a.name.localeCompare(b.name, "ko");
    });

    const totalCount = filtered.length;
    const items = filtered.slice(0, limit).map<InstructorListItem>((item) => ({
      id: item.id,
      name: item.name,
      affiliation: item.affiliation,
      categories: item.categories,
      teaching_titles: item.teaching_titles ?? [],
      specialties: item.specialties,
      rank: item.rank,
      score: item.score,
      total_courses: item.total_courses,
      total_hours: item.total_hours ?? 0,
      base_fee_hourly: item.base_fee_hourly,
      is_fulltime: item.is_fulltime,
      flag: item.flag,
    }));
    const status = items.length === 0 ? "empty" : "success";

    return NextResponse.json({
      status,
      meta: {
        request_id: requestId,
        data_mode: snapshot ? "stored" : "fallback",
        is_fallback: true,
        last_updated_at: snapshot?.generated_at ?? FALLBACK_LAST_UPDATED_AT,
        total_count: totalCount,
        query,
        category,
        sort: sortedKey,
      },
      data: { items },
      errors: [
        {
          code: snapshot ? "LIST_STORED_FALLBACK" : "LIST_FALLBACK",
          message: snapshot
            ? "목록 조회 실패로 마지막 정상 스냅샷 데이터를 표시합니다."
            : "목록 조회 실패로 정적 fallback 데이터를 표시합니다.",
        },
      ],
    });
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
  a: {
    score: unknown;
    rank: number | null;
    totalCourses: number;
    totalHours: number;
    lastActivityAt: Date | null;
    baseFeeHourly: number | null;
    name: string;
  },
  b: {
    score: unknown;
    rank: number | null;
    totalCourses: number;
    totalHours: number;
    lastActivityAt: Date | null;
    baseFeeHourly: number | null;
    name: string;
  },
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
    case "hours_desc":
      return compareNullsLast(a.totalHours, b.totalHours, "desc");
    case "recent_desc":
      return compareDatesNullsLast(a.lastActivityAt, b.lastActivityAt, "desc");
    case "fee_desc":
      return compareNullsLast(a.baseFeeHourly, b.baseFeeHourly, "desc");
    case "name_asc":
      return a.name.localeCompare(b.name, "ko");
  }
}
