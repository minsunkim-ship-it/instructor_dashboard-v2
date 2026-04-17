/**
 * POST /api/instructors/{id}/satisfaction — 05_api_spec.md 7절
 *
 * 만족도 기록 저장 → 집계 갱신 → 전체 강사 score/rank 재계산
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { applySatisfactionImports } from "@/lib/pipeline/satisfaction-applier";

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
  let runId: string | null = null;

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

    // demo parity: score 필수, 1~5 범위
    if (body.score === undefined || body.score === null || body.score < 1 || body.score > 5) {
      return NextResponse.json(
        {
          status: "error",
          meta: { request_id: requestId, data_mode: "live", is_fallback: false },
          errors: [{ code: "INVALID_SATISFACTION_SCORE", message: "만족도 점수는 1~5 범위여야 합니다." }],
        },
        { status: 400 }
      );
    }

    const pipelineRun = await prisma.pipelineRun.create({
      data: {
        runType: "manual_satisfaction",
        status: "running",
        triggeredBy: "api:/api/instructors/{id}/satisfaction",
        summary: { request_id: requestId, instructor_id: id },
      },
    });
    runId = pipelineRun.id;

    const applyResult = await applySatisfactionImports({
      runId,
      recalculateScores: true,
      items: [
        {
          sourceType: "manual",
          sourceRef: {
            request_id: requestId,
            instructor_id: id,
          },
          rawPayload: {
            score: body.score,
            comment: body.comment ?? null,
            company_name: body.company_name ?? null,
            course_name: body.course_name ?? null,
            response_date: body.response_date ?? null,
          },
          normalizedPayload: {
            suggested_instructor_id: id,
            resolution_basis: "manual_route",
          },
          candidateName: instructor.name,
          candidateCompanyName: body.company_name ?? null,
          candidateCourseName: body.course_name ?? null,
          scoreRaw: String(body.score),
          scoreNormalized: body.score,
          responseDate: body.response_date ?? null,
        },
      ],
    });

    await prisma.pipelineRun.update({
      where: { id: runId },
      data: {
        status: "success",
        finishedAt: new Date(),
        summary: {
          request_id: requestId,
          instructor_id: id,
          import_items_stored: applyResult.importItemsStored,
          registries: applyResult.registries,
          affected_instructors: applyResult.affectedInstructors,
          canonical_records_upserted: applyResult.canonicalRecordsUpserted,
        },
      },
    });

    // 갱신된 집계값 조회
    const updated = await prisma.instructor.findUnique({
      where: { id },
      select: {
        satisfactionAvg: true,
        satisfactionCount: true,
        satisfactionIsImputed: true,
      },
    });
    const record = await prisma.satisfactionRecord.findFirst({
      where: {
        instructorDbId: id,
        sourceType: "manual",
      },
      orderBy: { createdAt: "desc" },
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
        id: record?.id ?? null,
        instructor_id: id,
        score: record ? Number(record.score) : body.score,
        comment: record?.comment ?? body.comment ?? null,
        created_at: record?.createdAt.toISOString() ?? new Date().toISOString(),
        updated_satisfaction: {
          avg: updated?.satisfactionAvg !== null ? Number(updated?.satisfactionAvg) : null,
          count: updated?.satisfactionCount ?? 0,
          is_imputed: updated?.satisfactionIsImputed ?? false,
        },
      },
    });
  } catch {
    if (runId) {
      await prisma.pipelineRun.update({
        where: { id: runId },
        data: {
          status: "failed",
          finishedAt: new Date(),
          summary: {
            request_id: requestId,
            error: "SATISFACTION_WRITE_FAILED",
          },
        },
      }).catch(() => undefined);
    }
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
