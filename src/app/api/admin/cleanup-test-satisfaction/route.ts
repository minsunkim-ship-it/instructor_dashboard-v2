/**
 * POST /api/admin/cleanup-test-satisfaction
 *
 * Phase α Step D2 — manual sourceType test data 정리.
 *
 * 발견: audit-satisfaction-consistency에서 `manual` sourceType 9건이
 *   companyName="test", courseName="test-score-recalc"로 잔존 중. 정백 등의
 *   `instructors.satisfaction_avg` DB 컬럼 평균에 test 데이터가 포함되어 있음.
 *
 * 안전 조건 (모든 record가 아래를 만족해야 삭제):
 *   - sourceType === "manual"
 *   - companyName === "test"
 *
 * 모드:
 *   - ?mode=dry_run (기본): 삭제 예정 record list만 반환. DB 변경 없음.
 *   - ?mode=apply: 위 조건 만족 record DELETE + 영향 강사 satisfaction_avg 재계산.
 *
 * 인증: CRON_SECRET
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";
import { refreshSatisfactionAggregates } from "@/lib/pipeline/satisfaction-applier";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

function authorize(request: NextRequest): boolean {
  const headerSecret = request.headers.get(CRON_SECRET_HEADER);
  if (isValidCronSecret(headerSecret)) return true;
  const querySecret = request.nextUrl.searchParams.get("secret");
  if (isValidCronSecret(querySecret)) return true;
  return false;
}

export async function POST(request: NextRequest) {
  if (!authorize(request)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const mode = request.nextUrl.searchParams.get("mode") ?? "dry_run";
  if (mode !== "dry_run" && mode !== "apply") {
    return NextResponse.json(
      { ok: false, error: "invalid mode (use dry_run or apply)" },
      { status: 400 }
    );
  }

  // 안전 조건으로 후보 조회 — sourceType=manual AND companyName=test
  const candidates = await prisma.satisfactionRecord.findMany({
    where: {
      sourceType: "manual",
      companyName: "test",
    },
    select: {
      id: true,
      instructorDbId: true,
      score: true,
      respondentCount: true,
      companyName: true,
      courseName: true,
      responseDate: true,
      createdAt: true,
      instructor: { select: { name: true } },
    },
  });

  // 추가 보호: courseName이 명백히 test가 아닌 케이스가 섞여있으면 중단
  const suspicious = candidates.filter(
    (r) => r.courseName !== null && !r.courseName.toLowerCase().includes("test")
  );
  if (suspicious.length > 0) {
    return NextResponse.json({
      ok: false,
      error: "safety check failed — non-test courseName detected among candidates",
      mode,
      candidate_count: candidates.length,
      suspicious_count: suspicious.length,
      suspicious_samples: suspicious.slice(0, 5).map((r) => ({
        id: r.id,
        instructor: r.instructor.name,
        company: r.companyName,
        course: r.courseName,
      })),
    });
  }

  const affectedInstructorIds = Array.from(
    new Set(candidates.map((r) => r.instructorDbId))
  );

  const candidateSummary = {
    count: candidates.length,
    affected_instructors: affectedInstructorIds.length,
    samples: candidates.slice(0, 20).map((r) => ({
      id: r.id,
      instructor: r.instructor.name,
      score: Number(r.score),
      respondentCount: r.respondentCount,
      company: r.companyName,
      course: r.courseName,
      responseDate: r.responseDate?.toISOString().slice(0, 10) ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
  };

  if (mode === "dry_run") {
    return NextResponse.json({
      ok: true,
      mode: "dry_run",
      note: "DB 변경 없음. 위 candidates가 ?mode=apply 호출 시 삭제됨.",
      ...candidateSummary,
    });
  }

  // mode === "apply"
  const idsToDelete = candidates.map((r) => r.id);
  const deletedCount = await prisma.satisfactionRecord.deleteMany({
    where: { id: { in: idsToDelete } },
  });

  // 영향 강사의 satisfaction_avg/count 재계산 (가중평균 산식, P0-5)
  if (affectedInstructorIds.length > 0) {
    await refreshSatisfactionAggregates(affectedInstructorIds);
  }

  // 재계산 결과 확인
  const refreshedInstructors = await prisma.instructor.findMany({
    where: { id: { in: affectedInstructorIds } },
    select: {
      id: true,
      name: true,
      satisfactionAvg: true,
      satisfactionCount: true,
    },
  });

  return NextResponse.json({
    ok: true,
    mode: "apply",
    deleted_count: deletedCount.count,
    affected_instructors_refreshed: refreshedInstructors.map((i) => ({
      name: i.name,
      satisfactionAvg: i.satisfactionAvg !== null ? Number(i.satisfactionAvg) : null,
      satisfactionCount: i.satisfactionCount,
    })),
    ...candidateSummary,
  });
}
