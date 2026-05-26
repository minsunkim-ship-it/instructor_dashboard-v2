/**
 * POST /api/admin/reassign-record-instructor?record_id=xxx&instructor_name=xxx&basis=xxx
 *
 * 잘못 매칭된 satisfactionRecord의 강사를 다른 강사로 reassign.
 * 동명이인 (최진영 → 최진영B) misattribution fix용.
 *
 * 사용자 룰 [no_guess_matching] 준수: 계약시트 TH 증거 기반 reassign 시만 사용.
 *
 * 인증: CRON_SECRET
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";
import { refreshSatisfactionAggregates } from "@/lib/pipeline/satisfaction-applier";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const recordId = request.nextUrl.searchParams.get("record_id");
  const newInstructorName = request.nextUrl.searchParams.get("instructor_name");
  const basis = request.nextUrl.searchParams.get("basis") ?? "manual_reassign";

  if (!recordId || !newInstructorName) {
    return NextResponse.json({ ok: false, error: "record_id + instructor_name required" }, { status: 400 });
  }

  const rec = await prisma.satisfactionRecord.findUnique({ where: { id: recordId } });
  if (!rec) return NextResponse.json({ ok: false, error: "record not found" }, { status: 404 });

  const newInst = await prisma.instructor.findFirst({ where: { name: newInstructorName } });
  if (!newInst) return NextResponse.json({ ok: false, error: `instructor not found: ${newInstructorName}` }, { status: 404 });

  const oldInstructorId = rec.instructorDbId;

  try {
    // 단순 update — sourceRef 변동 없이 instructor만 변경
    await prisma.satisfactionRecord.update({
      where: { id: recordId },
      data: { instructorDbId: newInst.id },
    });
    await refreshSatisfactionAggregates([oldInstructorId, newInst.id]);
  } catch (e) {
    return NextResponse.json({
      ok: false,
      error: "update_failed",
      detail: e instanceof Error ? e.message : String(e),
    }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    record_id: recordId,
    from_instructor_id: oldInstructorId,
    to_instructor: { id: newInst.id, name: newInst.name },
    basis,
  });
}
