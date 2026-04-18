/**
 * GET /api/instructors/{id} — 05_api_spec.md 6절
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { countGroupedTeachingHistories } from "@/lib/teaching-history-display";
import { isNonTeachingCompensationItem } from "@/lib/teaching-history-kind";

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
        teachingHistories: {
          orderBy: [{ startDate: "desc" }, { createdAt: "desc" }],
        },
        satisfactionRecords: true,
        // T8: fee_histories — effectiveDate desc, createdAt desc
        feeHistories: {
          orderBy: [
            { effectiveDate: "desc" },
            { createdAt: "desc" },
          ],
        },
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

    // 6-4: total_paid = SUM(deal_fee_hourly * total_hours), 계산 가능한 행만
    let totalPaid: number | null = null;
    if (inst.teachingHistories.length > 0) {
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
    const today = new Date().toISOString().split("T")[0];
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setUTCMonth(sixMonthsAgo.getUTCMonth() - 6);

    const teachingHistoryAll = inst.teachingHistories.map((h) => ({
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
    }));

    const teachingHistory = teachingHistoryAll.filter(
      (item) => !isNonTeachingCompensationItem(item)
    );

    const totalCourses = countGroupedTeachingHistories(teachingHistory, {
      fromDate: "2025-01-01",
      untilDate: today,
    });
    const recentCourses6mo = countGroupedTeachingHistories(teachingHistory, {
      fromDate: sixMonthsAgo.toISOString().split("T")[0],
      untilDate: today,
    });

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
        total_courses: totalCourses,
        recent_courses_6mo: recentCourses6mo,
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
        // 6-4: 전임강사는 fee_history 빈 배열. T8: 비전임 강사는 fee_histories 테이블에서 조회.
        fee_history: isFulltime
          ? []
          : inst.feeHistories.map((f) => ({
              effective_date: f.effectiveDate
                ? f.effectiveDate.toISOString().split("T")[0]
                : null,
              effective_label: f.effectiveLabel,
              amount: f.amount,
              fee_kind: f.feeKind,
              context: f.context,
              source_type: f.sourceType,
              is_current: f.isCurrent,
              is_special_amount: f.isSpecialAmount,
            })),
        teaching_history: teachingHistory,
        teaching_history_remaining_count: 0,
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
