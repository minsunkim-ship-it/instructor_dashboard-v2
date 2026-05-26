/**
 * GET /api/admin/probe-instructor-th-full?names=정백,신동원&company_filter=삼성
 *
 * 강사별 TeachingHistory row 전체 list. 회사명 keyword로 filter 가능.
 * 검색 false positive 진단용 (TH read-only).
 *
 * 만족도·TH 가드레일: read-only. 변경 0건.
 *
 * 인증: CRON_SECRET
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const namesParam = request.nextUrl.searchParams.get("names") ?? "";
  const companyFilter = request.nextUrl.searchParams.get("company_filter") ?? "";
  const names = namesParam.split(",").map((s) => s.trim()).filter(Boolean);
  if (names.length === 0) {
    return NextResponse.json({ ok: false, error: "names param required" });
  }

  const instructors = await prisma.instructor.findMany({
    where: { name: { in: names } },
    select: {
      id: true,
      name: true,
      teachingHistories: {
        select: {
          id: true,
          companyName: true,
          courseName: true,
          courseId: true,
          startDate: true,
          endDate: true,
          dateLabel: true,
          sourceType: true,
          contractType: true,
          detailType: true,
          totalSessions: true,
          totalHours: true,
        },
        orderBy: [{ startDate: "desc" }, { createdAt: "desc" }],
      },
    },
  });

  const results = instructors.map((inst) => {
    const all = inst.teachingHistories;
    const filtered = companyFilter
      ? all.filter((th) =>
          (th.companyName ?? "").toLowerCase().includes(companyFilter.toLowerCase())
        )
      : all;
    return {
      id: inst.id,
      name: inst.name,
      total_th_rows: all.length,
      filtered_count: filtered.length,
      filter_keyword: companyFilter || null,
      rows: filtered.slice(0, 30).map((th) => ({
        id: th.id,
        company: th.companyName,
        course: th.courseName,
        course_id: th.courseId,
        start: th.startDate?.toISOString().slice(0, 10) ?? null,
        end: th.endDate?.toISOString().slice(0, 10) ?? null,
        date_label: th.dateLabel,
        source_type: th.sourceType,
        contract_type: th.contractType,
        detail_type: th.detailType,
        sessions: th.totalSessions,
        hours: th.totalHours !== null ? Number(th.totalHours) : null,
      })),
    };
  });

  return NextResponse.json({
    ok: true,
    generated_at: new Date().toISOString(),
    instructors: results,
  });
}
