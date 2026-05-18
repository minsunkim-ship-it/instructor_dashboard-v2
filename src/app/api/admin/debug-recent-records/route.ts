import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const limit = parseInt(request.nextUrl.searchParams.get("limit") ?? "15", 10);
  const recs = await prisma.satisfactionRecord.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      instructorDbId: true,
      companyName: true,
      courseName: true,
      score: true,
      respondentCount: true,
      sourceType: true,
      responseDate: true,
      createdAt: true,
      instructor: { select: { name: true } },
    },
  });
  return NextResponse.json({
    ok: true,
    records: recs.map((r) => ({
      id: r.id,
      instructor: r.instructor.name,
      company: r.companyName,
      course: r.courseName?.slice(0, 60),
      score: Number(r.score),
      n: r.respondentCount,
      sourceType: r.sourceType,
      responseDate: r.responseDate?.toISOString().slice(0, 10) ?? null,
      createdAt: r.createdAt.toISOString().slice(0, 19),
    })),
  });
}
