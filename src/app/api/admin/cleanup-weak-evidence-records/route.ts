/**
 * POST /api/admin/cleanup-weak-evidence-records?mode=dry_run|apply
 *
 * G2 (minimum evidence) general rule retroactive cleanup.
 *
 * 안전 조건 (ALL must be true):
 *   - sourceType ∈ {gmail_summary, drive_satisfaction}
 *   - respondentCount = 1
 *   - companyName IS NULL
 *   - sourceRef.auto_resolver IS NOT NULL (자동 resolver가 만든 record만)
 *
 * 즉 운영자가 manually 입력한 1응답 record는 보호. 우리 algorithm이 약한
 * evidence로 추가한 record만 삭제 + 영향 강사 refreshSatisfactionAggregates.
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
    return NextResponse.json({ ok: false, error: "invalid mode" }, { status: 400 });
  }

  // 안전 조건 적용 — G2 위반 record (auto-resolver가 추가한 weak evidence)
  const candidates = await prisma.satisfactionRecord.findMany({
    where: {
      sourceType: { in: ["gmail_summary", "drive_satisfaction"] },
      respondentCount: 1,
      companyName: null,
    },
    select: {
      id: true,
      instructorDbId: true,
      score: true,
      respondentCount: true,
      courseName: true,
      responseDate: true,
      createdAt: true,
      sourceType: true,
      sourceRef: true,
      instructor: { select: { name: true } },
    },
  });

  // 추가 가드: auto_resolver 표식이 있는 record만 (운영자 manual은 보호)
  const filtered = candidates.filter((r) => {
    const ref = r.sourceRef as Record<string, unknown> | null;
    if (!ref || typeof ref !== "object") return false;
    const resolver = ref.auto_resolver;
    return typeof resolver === "string" && resolver.length > 0;
  });

  const affectedIds = new Set(filtered.map((r) => r.instructorDbId));

  const summary = {
    candidates_total: candidates.length,
    cleanup_target: filtered.length,
    affected_instructors: affectedIds.size,
    samples: filtered.slice(0, 15).map((r) => ({
      id: r.id,
      instructor: r.instructor.name,
      score: Number(r.score),
      course: r.courseName,
      responseDate: r.responseDate?.toISOString().slice(0, 10) ?? null,
      sourceType: r.sourceType,
      resolver: (r.sourceRef as Record<string, unknown>)?.auto_resolver,
    })),
  };

  if (mode === "dry_run") {
    return NextResponse.json({ ok: true, mode: "dry_run", ...summary });
  }

  const ids = filtered.map((r) => r.id);
  const del = await prisma.satisfactionRecord.deleteMany({
    where: { id: { in: ids } },
  });

  if (affectedIds.size > 0) {
    await refreshSatisfactionAggregates(Array.from(affectedIds));
  }

  const refreshed = await prisma.instructor.findMany({
    where: { id: { in: Array.from(affectedIds) } },
    select: { id: true, name: true, satisfactionAvg: true, satisfactionCount: true },
  });

  return NextResponse.json({
    ok: true,
    mode: "apply",
    deleted_count: del.count,
    ...summary,
    instructor_avg_after: refreshed.map((i) => ({
      name: i.name,
      satisfactionAvg: i.satisfactionAvg !== null ? Number(i.satisfactionAvg) : null,
      satisfactionCount: i.satisfactionCount,
    })),
  });
}
