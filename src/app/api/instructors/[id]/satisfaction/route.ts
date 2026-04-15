/**
 * POST /api/instructors/{id}/satisfaction — 05_api_spec.md 7절
 *
 * 만족도 기록 저장 → 집계 갱신 → 전체 강사 score/rank 재계산
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { recalculateAllScores } from "@/lib/score-recalculator";

interface SatisfactionBody {
  score: number;
  comment?: string;
  company_name?: string;
  course_name?: string;
  response_date?: string;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const requestId = `req_${crypto.randomUUID()}`;

  try {
    // 강사 존재 확인
    const instructor = await prisma.instructor.findUnique({
      where: { id },
    });

    if (!instructor) {
      return NextResponse.json(
        {
          status: "error",
          meta: { request_id: requestId, data_mode: "live", is_fallback: false },
          errors: [{ code: "INSTRUCTOR_NOT_FOUND", message: "강사 정보를 찾을 수 없습니다." }],
        },
        { status: 404 }
      );
    }

    const body = (await request.json()) as SatisfactionBody;

    // 7-4: score 필수, 0~5 범위
    if (body.score === undefined || body.score === null || body.score < 0 || body.score > 5) {
      return NextResponse.json(
        {
          status: "error",
          meta: { request_id: requestId, data_mode: "live", is_fallback: false },
          errors: [{ code: "INVALID_SATISFACTION_SCORE", message: "만족도 점수는 0~5 범위여야 합니다." }],
        },
        { status: 400 }
      );
    }

    // 7-6: satisfaction_records 저장 + instructors 집계 갱신 + 전체 score 재계산
    // 같은 요청 흐름 안에서 처리

    // Step 1: satisfaction_records 저장
    const record = await prisma.satisfactionRecord.create({
      data: {
        instructorDbId: id,
        score: body.score,
        comment: body.comment ?? null,
        companyName: body.company_name ?? null,
        courseName: body.course_name ?? null,
        responseDate: body.response_date ? new Date(body.response_date) : null,
        sourceType: "manual",
        createdBy: null, // 이번 버전: 로그인 사용자 모두 동일 권한, 작성자 미기록
      },
    });

    // Step 2: instructors 만족도 집계 갱신
    const allRecords = await prisma.satisfactionRecord.findMany({
      where: { instructorDbId: id },
      select: { score: true },
    });

    const count = allRecords.length;
    const avg =
      count > 0
        ? allRecords.reduce((sum, r) => sum + Number(r.score), 0) / count
        : null;

    await prisma.instructor.update({
      where: { id },
      data: {
        satisfactionAvg: avg !== null ? Math.round(avg * 100) / 100 : null,
        satisfactionCount: count,
        satisfactionIsImputed: false,
      },
    });

    // Step 3: 전체 강사 score/rank 재계산
    // 05_api_spec 7-6: 외부 소스 재조회 없이 DB canonical 값 기준
    await recalculateAllScores();

    // 갱신된 집계값 조회
    const updated = await prisma.instructor.findUnique({
      where: { id },
      select: {
        satisfactionAvg: true,
        satisfactionCount: true,
        satisfactionIsImputed: true,
      },
    });

    // 7-5: 성공 응답
    return NextResponse.json({
      status: "success",
      meta: {
        request_id: requestId,
        data_mode: "live",
        is_fallback: false,
        last_updated_at: new Date().toISOString(),
      },
      data: {
        id: record.id,
        instructor_id: id,
        score: Number(record.score),
        comment: record.comment,
        created_at: record.createdAt.toISOString(),
        updated_satisfaction: {
          avg: updated?.satisfactionAvg !== null ? Number(updated?.satisfactionAvg) : null,
          count: updated?.satisfactionCount ?? 0,
          is_imputed: updated?.satisfactionIsImputed ?? false,
        },
      },
    });
  } catch {
    // 7-7: 500 SATISFACTION_WRITE_FAILED
    return NextResponse.json(
      {
        status: "error",
        meta: { request_id: requestId, data_mode: "live", is_fallback: false, last_updated_at: null },
        errors: [{ code: "SATISFACTION_WRITE_FAILED", message: "만족도 저장에 실패했습니다." }],
      },
      { status: 500 }
    );
  }
}
