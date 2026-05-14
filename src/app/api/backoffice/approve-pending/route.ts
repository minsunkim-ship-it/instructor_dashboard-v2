/**
 * POST /api/backoffice/approve-pending
 * Body: { registryId: string, instructorId: string }
 *
 * registry를 운영자가 선택한 instructor로 approve. SatisfactionRecord upsert 후
 * aggregates refresh.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { auth, isAuthDisabled } from "@/auth";
import { refreshSatisfactionAggregates } from "@/lib/pipeline/satisfaction-applier";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

type RawRecord = { [key: string]: unknown };
function pickString(obj: RawRecord | undefined | null, ...keys: string[]): string | null {
  if (!obj) return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return null;
}

export async function POST(request: NextRequest) {
  let operatorEmail = "(auth_disabled)";
  if (!isAuthDisabled()) {
    const session = await auth();
    if (!session?.user?.email) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
    operatorEmail = session.user.email;
  }

  let body: { registryId?: string; instructorId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const registryId = body.registryId;
  const instructorId = body.instructorId;
  if (!registryId || !instructorId) {
    return NextResponse.json(
      { ok: false, error: "registryId and instructorId required" },
      { status: 400 }
    );
  }

  const registry = await prisma.satisfactionReviewRegistry.findUnique({
    where: { id: registryId },
  });
  if (!registry) {
    return NextResponse.json({ ok: false, error: "registry_not_found" }, { status: 404 });
  }
  if (registry.matchStatus !== "pending") {
    return NextResponse.json(
      { ok: false, error: "registry_already_resolved", current: registry.matchStatus },
      { status: 409 }
    );
  }
  const instructor = await prisma.instructor.findUnique({
    where: { id: instructorId },
    select: { id: true, name: true, flag: true },
  });
  if (!instructor) {
    return NextResponse.json({ ok: false, error: "instructor_not_found" }, { status: 404 });
  }
  if (instructor.flag && instructor.flag.startsWith("merged_into:")) {
    return NextResponse.json(
      { ok: false, error: "instructor_merged", flag: instructor.flag },
      { status: 409 }
    );
  }
  if (registry.avgScore === null) {
    return NextResponse.json({ ok: false, error: "registry_has_no_score" }, { status: 422 });
  }
  const refs = Array.isArray(registry.sourceRefs) ? (registry.sourceRefs as RawRecord[]) : [];
  const firstRef = refs[0];
  const responseDateStr = pickString(firstRef, "response_date");
  if (!responseDateStr) {
    return NextResponse.json({ ok: false, error: "registry_has_no_response_date" }, { status: 422 });
  }
  const responseDate = new Date(responseDateStr);
  if (Number.isNaN(responseDate.getTime())) {
    return NextResponse.json({ ok: false, error: "invalid_response_date" }, { status: 422 });
  }

  const nowIso = new Date().toISOString();
  const basis = `operator_approve|by:${operatorEmail}|at:${nowIso}`;

  await prisma.satisfactionReviewRegistry.update({
    where: { id: registryId },
    data: {
      matchStatus: "approved_by_operator",
      resolvedInstructorId: instructorId,
      suggestedInstructorId: instructorId,
      resolutionBasis: basis,
    },
  });

  const existing = await prisma.satisfactionRecord.findFirst({
    where: {
      instructorDbId: instructorId,
      sourceRef: { path: ["registry_key"], equals: registry.registryKey },
    },
  });
  const recordData = {
    instructorDbId: instructorId,
    score: registry.avgScore,
    companyName: registry.companyName,
    courseName: registry.courseName,
    responseDate,
    respondentCount: registry.responseCount,
    sourceType: registry.sourceType,
    sourceRef: {
      source_refs: refs,
      registry_key: registry.registryKey,
      operator_approve: { by: operatorEmail, at: nowIso },
    } as unknown as Prisma.InputJsonObject,
  };
  if (existing) {
    await prisma.satisfactionRecord.update({ where: { id: existing.id }, data: recordData });
  } else {
    await prisma.satisfactionRecord.create({ data: recordData });
  }
  await refreshSatisfactionAggregates([instructorId]);
  const after = await prisma.instructor.findUnique({
    where: { id: instructorId },
    select: { satisfactionAvg: true, satisfactionCount: true, name: true },
  });
  return NextResponse.json({
    ok: true,
    instructor: after
      ? {
          name: after.name,
          satisfactionAvg: after.satisfactionAvg !== null ? Number(after.satisfactionAvg) : null,
          satisfactionCount: after.satisfactionCount,
        }
      : null,
    operator: operatorEmail,
  });
}
