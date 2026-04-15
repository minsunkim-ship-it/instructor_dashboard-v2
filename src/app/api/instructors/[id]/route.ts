/**
 * GET /api/instructors/{id} — 05_api_spec.md 6절
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const requestId = `req_${crypto.randomUUID()}`;

  try {
    const inst = await prisma.instructor.findUnique({
      where: { id },
      include: {
        // 6-4: teaching_history는 최신순 최대 30건
        teachingHistories: {
          orderBy: { startDate: "desc" },
          take: 30,
        },
        satisfactionRecords: true,
      },
    });

    if (!inst) {
      // 6-6: 404 INSTRUCTOR_NOT_FOUND
      return NextResponse.json(
        {
          status: "error",
          meta: { request_id: requestId, data_mode: "live", is_fallback: false },
          errors: [{ code: "INSTRUCTOR_NOT_FOUND", message: "강사 정보를 찾을 수 없습니다." }],
        },
        { status: 404 }
      );
    }

    // 6-4: teaching_history 초과 건수
    const totalTeachingCount = await prisma.teachingHistory.count({
      where: { instructorDbId: id },
    });
    const remainingCount = Math.max(0, totalTeachingCount - 30);

    // 6-4: total_paid = SUM(deal_fee_hourly * total_hours), 계산 가능한 행만
    let totalPaid: number | null = null;
    // 30건 제한이 아닌 전체 이력에서 계산해야 하므로 별도 조회
    if (totalTeachingCount > 0) {
      const allPayable = await prisma.teachingHistory.findMany({
        where: {
          instructorDbId: id,
          dealFeeHourly: { not: null },
          totalHours: { not: null },
        },
        select: { dealFeeHourly: true, totalHours: true },
      });
      if (allPayable.length > 0) {
        totalPaid = allPayable.reduce(
          (sum, h) => sum + h.dealFeeHourly! * Number(h.totalHours!),
          0
        );
      }
    }

    // 6-4: 전임강사 규칙
    const isFulltime = inst.isFulltime;

    const response = {
      status: "success",
      meta: {
        request_id: requestId,
        data_mode: "live",
        is_fallback: false,
        last_updated_at: inst.updatedAt.toISOString(),
      },
      data: {
        id: inst.id,
        name: inst.name,
        affiliation: inst.affiliation,
        categories: inst.categories,
        contact: {
          email: inst.contactEmail,
          phone: inst.contactPhone,
        },
        specialties: inst.specialties,
        profile_summary: inst.profileSummary,
        memo: inst.memoRaw,
        is_fulltime: isFulltime,
        is_practice_coach: inst.isPracticeCoach,
        total_courses: inst.totalCourses,
        recent_courses_6mo: inst.recentCourses6mo,
        // 6-4: total_paid — teaching_histories 기반 추정 누적 지급액
        total_paid: totalPaid,
        // 6-4: 전임강사는 base_fee_hourly = null
        base_fee_hourly: isFulltime ? null : inst.baseFeeHourly,
        score: inst.score !== null ? Number(inst.score) : null,
        score_breakdown: inst.scoreBreakdown,
        satisfaction: {
          avg: inst.satisfactionAvg !== null ? Number(inst.satisfactionAvg) : null,
          count: inst.satisfactionCount,
          is_imputed: inst.satisfactionIsImputed,
        },
        // 6-4: 추천/지양/리스크 — instructor_intelligence 기준 (파일럿 범위 밖이므로 null/빈값)
        recommended_for: [],
        avoid_for: [],
        risk_notes: [],
        ops_check_note: null,
        // 6-4: 전임강사는 fee_history 빈 배열. 파일럿 범위 밖이므로 항상 빈 배열.
        fee_history: [],
        // teaching_history: 최신순 30건
        teaching_history: inst.teachingHistories.map((h) => ({
          id: h.id,
          company_name: h.companyName,
          course_name: h.courseName,
          course_id: h.courseId,
          start_date: h.startDate?.toISOString().split("T")[0] ?? null,
          end_date: h.endDate?.toISOString().split("T")[0] ?? null,
          date_label: h.dateLabel,
          deal_fee_hourly: h.dealFeeHourly,
          fee_extra: h.feeExtra,
          total_hours: h.totalHours !== null ? Number(h.totalHours) : null,
          total_sessions: h.totalSessions,
          contract_type: h.contractType,
          detail_type: h.detailType,
          special_notes: h.specialNotes,
          source_type: h.sourceType,
        })),
        teaching_history_remaining_count: remainingCount,
      },
    };

    return NextResponse.json(response);
  } catch {
    // 6-6: 500 DETAIL_FETCH_FAILED
    return NextResponse.json(
      {
        status: "error",
        meta: { request_id: requestId, data_mode: "live", is_fallback: false, last_updated_at: null },
        errors: [{ code: "DETAIL_FETCH_FAILED", message: "강사 상세 조회에 실패했습니다." }],
      },
      { status: 500 }
    );
  }
}
