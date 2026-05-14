/**
 * POST /api/admin/merge-homonym-instructor
 *
 * 동명이인 그룹의 weak row를 strong row로 merge.
 *
 * 필수 query:
 *   weak_id  — record/TH를 redirect할 source instructor.id
 *   strong_id — record/TH의 target instructor.id (contact 있는 row)
 *   mode = dry_run | apply
 *
 * 동작 (apply):
 *   1. SatisfactionRecord.instructorDbId weak → strong (updateMany)
 *   2. TeachingHistory.instructorDbId weak → strong (updateMany)
 *   3. SatisfactionReviewRegistry.resolvedInstructorId weak → strong (updateMany)
 *   4. Weak instructor.flag = "merged_into:{strong_id}" (record/TH redirect 후 비활성 표시)
 *   5. refreshSatisfactionAggregates([strong_id])
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
  const weakId = request.nextUrl.searchParams.get("weak_id");
  const strongId = request.nextUrl.searchParams.get("strong_id");
  const mode = request.nextUrl.searchParams.get("mode") ?? "dry_run";

  if (!weakId || !strongId) {
    return NextResponse.json(
      { ok: false, error: "weak_id and strong_id required" },
      { status: 400 }
    );
  }
  if (mode !== "dry_run" && mode !== "apply") {
    return NextResponse.json({ ok: false, error: "invalid mode" }, { status: 400 });
  }

  const weak = await prisma.instructor.findUnique({
    where: { id: weakId },
    select: {
      id: true,
      name: true,
      contactEmail: true,
      contactPhone: true,
      flag: true,
      satisfactionAvg: true,
      satisfactionCount: true,
      totalCourses: true,
    },
  });
  const strong = await prisma.instructor.findUnique({
    where: { id: strongId },
    select: {
      id: true,
      name: true,
      contactEmail: true,
      contactPhone: true,
      flag: true,
      satisfactionAvg: true,
      satisfactionCount: true,
      totalCourses: true,
    },
  });
  if (!weak || !strong) {
    return NextResponse.json({ ok: false, error: "weak_id or strong_id not found" }, { status: 404 });
  }

  // Safety guard — same base name
  const baseName = (n: string) => n.replace(/[A-Z]$/, "").trim();
  if (baseName(weak.name) !== baseName(strong.name)) {
    return NextResponse.json(
      {
        ok: false,
        error: "base name mismatch — refusing merge across distinct base names",
        weak_name: weak.name,
        strong_name: strong.name,
      },
      { status: 400 }
    );
  }

  // 영향 통계
  const recordCount = await prisma.satisfactionRecord.count({
    where: { instructorDbId: weakId },
  });
  const thCount = await prisma.teachingHistory.count({
    where: { instructorDbId: weakId },
  });
  const registryCount = await prisma.satisfactionReviewRegistry.count({
    where: { resolvedInstructorId: weakId },
  });

  if (mode === "dry_run") {
    return NextResponse.json({
      ok: true,
      mode: "dry_run",
      weak: {
        id: weak.id,
        name: weak.name,
        contactEmail: weak.contactEmail,
        contactPhone: weak.contactPhone,
        satisfactionAvg: weak.satisfactionAvg !== null ? Number(weak.satisfactionAvg) : null,
        satisfactionCount: weak.satisfactionCount,
        totalCourses: weak.totalCourses,
      },
      strong: {
        id: strong.id,
        name: strong.name,
        contactEmail: strong.contactEmail,
        contactPhone: strong.contactPhone,
        satisfactionAvg: strong.satisfactionAvg !== null ? Number(strong.satisfactionAvg) : null,
        satisfactionCount: strong.satisfactionCount,
        totalCourses: strong.totalCourses,
      },
      to_redirect: {
        satisfaction_records: recordCount,
        teaching_histories: thCount,
        review_registries_resolved: registryCount,
      },
    });
  }

  // apply
  const recordResult = await prisma.satisfactionRecord.updateMany({
    where: { instructorDbId: weakId },
    data: { instructorDbId: strongId },
  });
  const thResult = await prisma.teachingHistory.updateMany({
    where: { instructorDbId: weakId },
    data: { instructorDbId: strongId },
  });
  const registryResult = await prisma.satisfactionReviewRegistry.updateMany({
    where: { resolvedInstructorId: weakId },
    data: { resolvedInstructorId: strongId },
  });

  // weak instructor 비활성 표시 (flag 사용 — 기존 '실습코치' 같이 운영 표시 컨벤션)
  const newFlag = `merged_into:${strongId}`;
  await prisma.instructor.update({
    where: { id: weakId },
    data: { flag: newFlag },
  });

  await refreshSatisfactionAggregates([strongId]);

  const strongAfter = await prisma.instructor.findUnique({
    where: { id: strongId },
    select: { id: true, name: true, satisfactionAvg: true, satisfactionCount: true, totalCourses: true },
  });

  return NextResponse.json({
    ok: true,
    mode: "apply",
    redirected: {
      satisfaction_records: recordResult.count,
      teaching_histories: thResult.count,
      review_registries: registryResult.count,
    },
    weak_flagged: newFlag,
    strong_after: strongAfter
      ? {
          name: strongAfter.name,
          satisfactionAvg:
            strongAfter.satisfactionAvg !== null ? Number(strongAfter.satisfactionAvg) : null,
          satisfactionCount: strongAfter.satisfactionCount,
          totalCourses: strongAfter.totalCourses,
        }
      : null,
  });
}
