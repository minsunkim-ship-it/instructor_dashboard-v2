/**
 * GET /api/admin/probe-instructor-detail?ids=id1,id2,...
 *
 * 여러 instructor의 TH 회사/과정과 satisfaction records 회사/과정을 한 번에 dump.
 * mismatch 검증용.
 *
 * 인증: CRON_SECRET
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

function authorize(request: NextRequest): boolean {
  const headerSecret = request.headers.get(CRON_SECRET_HEADER);
  if (isValidCronSecret(headerSecret)) return true;
  const querySecret = request.nextUrl.searchParams.get("secret");
  if (isValidCronSecret(querySecret)) return true;
  return false;
}

export async function GET(request: NextRequest) {
  if (!authorize(request)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const idsParam = request.nextUrl.searchParams.get("ids");
  if (!idsParam) {
    return NextResponse.json({ ok: false, error: "ids required" }, { status: 400 });
  }
  const ids = idsParam.split(",").map((s) => s.trim()).filter((s) => s.length > 0);

  const out = [];
  for (const id of ids) {
    const inst = await prisma.instructor.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        contactEmail: true,
        contactPhone: true,
        affiliation: true,
        flag: true,
        satisfactionAvg: true,
        satisfactionCount: true,
        satisfactionIsImputed: true,
        totalCourses: true,
        contractSheetRows: true,
        salesmapDealCount: true,
        salesmapLastDealAt: true,
        score: true,
        scoreBreakdown: true,
        scoreCalculatedAt: true,
        rank: true,
        isPracticeCoach: true,
      },
    });
    const ths = await prisma.teachingHistory.findMany({
      where: { instructorDbId: id },
      select: { companyName: true, courseName: true, startDate: true, endDate: true },
      orderBy: { startDate: "desc" },
      take: 20,
    });
    const records = await prisma.satisfactionRecord.findMany({
      where: { instructorDbId: id },
      select: {
        id: true,
        companyName: true,
        courseName: true,
        score: true,
        respondentCount: true,
        responseDate: true,
        sourceType: true,
      },
      orderBy: { responseDate: "desc" },
    });
    out.push({
      instructor: inst
        ? {
            ...inst,
            satisfactionAvg: inst.satisfactionAvg !== null ? Number(inst.satisfactionAvg) : null,
            score: inst.score !== null ? Number(inst.score) : null,
          }
        : null,
      teaching_histories: ths.map((t) => ({
        company: t.companyName,
        course: t.courseName,
        start: t.startDate?.toISOString().slice(0, 10) ?? null,
        end: t.endDate?.toISOString().slice(0, 10) ?? null,
      })),
      satisfaction_records: records.map((r) => ({
        id: r.id,
        company: r.companyName,
        course: r.courseName,
        score: Number(r.score),
        n: r.respondentCount,
        date: r.responseDate?.toISOString().slice(0, 10) ?? null,
        sourceType: r.sourceType,
      })),
    });
  }

  return NextResponse.json({ ok: true, results: out });
}
