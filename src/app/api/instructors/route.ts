import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import type { InstructorListItem, InstructorListResponse } from "@/types/api";

// GET /api/instructors — 05_api_spec.md 5절
// 파일럿: 정렬/필터/검색 없이 전체 목록만 반환

export async function GET() {
  const requestId = `req_${crypto.randomUUID()}`;

  try {
    // 05_api_spec.md 5-7절: total_count는 limit 적용 전 전체 매칭 건수
    const [instructors, totalCount] = await Promise.all([
      prisma.instructor.findMany({ take: 100 }),
      prisma.instructor.count(),
    ]);

    const items: InstructorListItem[] = instructors.map((inst) => ({
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
        query: "",
        category: "전체",
        sort: "score_desc",
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
