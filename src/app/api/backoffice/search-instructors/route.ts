/**
 * GET /api/backoffice/search-instructors?q=name
 * 운영자가 manual instructor 선택 시 검색.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth, isAuthDisabled } from "@/auth";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isAuthDisabled()) {
    const session = await auth();
    if (!session?.user?.email) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
  }
  const q = (request.nextUrl.searchParams.get("q") ?? "").trim();
  if (q.length < 1) {
    return NextResponse.json({ ok: true, results: [] });
  }
  // contains 검색 (NFC/NFD 자동 매칭은 DB collation에 의존)
  const results = await prisma.instructor.findMany({
    where: {
      name: { contains: q },
      OR: [{ flag: null }, { flag: { not: { startsWith: "merged_into:" } } }],
    },
    select: {
      id: true,
      name: true,
      contactEmail: true,
      contactPhone: true,
      satisfactionAvg: true,
      satisfactionCount: true,
      totalCourses: true,
      affiliation: true,
    },
    take: 30,
    orderBy: { name: "asc" },
  });
  return NextResponse.json({
    ok: true,
    results: results.map((r) => ({
      id: r.id,
      name: r.name,
      contactEmail: r.contactEmail,
      contactPhone: r.contactPhone,
      satisfactionAvg: r.satisfactionAvg !== null ? Number(r.satisfactionAvg) : null,
      satisfactionCount: r.satisfactionCount,
      totalCourses: r.totalCourses,
      affiliation: r.affiliation,
    })),
  });
}
