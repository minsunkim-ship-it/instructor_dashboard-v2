/**
 * POST /api/admin/manual-resolve-registry?registry_key=xxx&instructor_name=xxx&basis=xxx
 *
 * 운영자 (또는 admin script) 가 명시적 증거 (계약시트 등) 기반으로
 * pending registry를 단일 강사로 강제 resolve. record 생성 + registry status=approved.
 *
 * 사용자 룰 [no_guess_matching] 준수: 계약시트/명시적 증거 source에서 강사 식별 시만 사용.
 * basis 파라미터로 증거 소스 명시.
 *
 * 인증: CRON_SECRET
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

type RawRecord = { [key: string]: unknown };
function pickString(o: RawRecord | undefined | null, ...keys: string[]): string | null {
  if (!o) return null;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return null;
}

export async function POST(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const registryKey = request.nextUrl.searchParams.get("registry_key");
  const instructorName = request.nextUrl.searchParams.get("instructor_name");
  const basis = request.nextUrl.searchParams.get("basis") ?? "manual_contract_history";

  if (!registryKey || !instructorName) {
    return NextResponse.json({ ok: false, error: "registry_key + instructor_name required" }, { status: 400 });
  }

  const inst = await prisma.instructor.findFirst({ where: { name: instructorName } });
  if (!inst) {
    return NextResponse.json({ ok: false, error: `instructor not found: ${instructorName}` }, { status: 404 });
  }

  const reg = await prisma.satisfactionReviewRegistry.findUnique({ where: { registryKey } });
  if (!reg) {
    return NextResponse.json({ ok: false, error: "registry not found" }, { status: 404 });
  }
  if (reg.matchStatus === "approved" || reg.matchStatus === "auto_accepted") {
    return NextResponse.json({ ok: false, error: "registry already resolved", status: reg.matchStatus });
  }

  // record 생성 — sourceRefs에서 첫 source_ref 가져와서 record sourceRef로
  const refs = Array.isArray(reg.sourceRefs) ? (reg.sourceRefs as RawRecord[]) : [];
  const firstRef = refs[0];
  const inner = firstRef?.source_ref as RawRecord | undefined;
  const dateStr =
    pickString(firstRef, "response_date") ??
    pickString(inner, "created_time") ??
    pickString(firstRef, "created_time");

  const responseDate = dateStr ? new Date(dateStr) : null;
  if (responseDate && Number.isNaN(responseDate.getTime())) {
    return NextResponse.json({ ok: false, error: "invalid response_date" }, { status: 422 });
  }

  const avgScore = reg.avgScore !== null ? Number(reg.avgScore) : null;
  if (avgScore === null) {
    return NextResponse.json({ ok: false, error: "registry has no avgScore" }, { status: 422 });
  }

  await prisma.satisfactionRecord.create({
    data: {
      instructorDbId: inst.id,
      sourceType: reg.sourceType,
      sourceRef: {
        registry_key: registryKey,
        source_refs: refs as unknown as object[],
        manual_resolve: true,
        basis,
        resolved_at: new Date().toISOString(),
      } as object,
      score: avgScore,
      respondentCount: reg.responseCount,
      responseDate,
      companyName: reg.companyName,
      courseName: reg.courseName,
      createdBy: `api:/api/admin/manual-resolve-registry|basis=${basis}`,
    },
  });

  await prisma.satisfactionReviewRegistry.update({
    where: { registryKey },
    data: {
      matchStatus: "approved",
      resolvedInstructorId: inst.id,
      suggestedInstructorId: inst.id,
      resolutionBasis: `manual_resolve|basis=${basis}|instructor=${instructorName}|date=${new Date().toISOString()}`,
    },
  });

  return NextResponse.json({
    ok: true,
    registry_key: registryKey,
    instructor: { id: inst.id, name: inst.name },
    score: avgScore,
    n: reg.responseCount,
    response_date: responseDate?.toISOString().slice(0, 10) ?? null,
    company: reg.companyName,
    course: reg.courseName,
    basis,
  });
}
