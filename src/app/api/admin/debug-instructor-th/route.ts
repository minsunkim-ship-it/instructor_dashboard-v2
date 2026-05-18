/**
 * GET /api/admin/debug-instructor-th?name=박인영&company=웰컴
 * 특정 강사+회사 키워드의 TH 전체 listing.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const name = request.nextUrl.searchParams.get("name");
  const companyKw = request.nextUrl.searchParams.get("company");
  if (!name) {
    return NextResponse.json({ ok: false, error: "name required" }, { status: 400 });
  }
  const instructors = await prisma.instructor.findMany({ where: { name }, select: { id: true, name: true } });
  const ids = instructors.map((i) => i.id);
  if (ids.length === 0) return NextResponse.json({ ok: true, name, instructors: [], ths: [] });
  const ths = await prisma.teachingHistory.findMany({
    where: {
      instructorDbId: { in: ids },
      ...(companyKw ? { companyName: { contains: companyKw } } : {}),
    },
    orderBy: [{ startDate: "asc" }, { endDate: "asc" }],
    select: {
      id: true,
      instructorDbId: true,
      companyName: true,
      courseName: true,
      startDate: true,
      endDate: true,
      createdAt: true,
      sourceRef: true,
    },
  });
  return NextResponse.json({
    ok: true,
    name,
    instructors,
    th_count: ths.length,
    ths: ths.map((t) => ({
      id: t.id,
      company: t.companyName,
      course: t.courseName,
      start: t.startDate?.toISOString().slice(0, 10) ?? null,
      end: t.endDate?.toISOString().slice(0, 10) ?? null,
      created_at: t.createdAt?.toISOString().slice(0, 19),
      source: t.sourceRef,
    })),
  });
}
