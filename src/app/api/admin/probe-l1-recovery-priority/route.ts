/**
 * GET /api/admin/probe-l1-recovery-priority
 *
 * L1 강사들(강의 있는데 record 0 + catalog 매칭 없음)의 TH 회사·과정 분포를 분석.
 * 어떤 회사의 satisfaction sheet을 catalog에 추가하면 최대 영향이 나오는지
 * 자동 우선순위 list 생성.
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

function normalize(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .toLowerCase()
    .replace(/[\s()[\]{}.,:;'"`~!?+\-_/\\|]+/g, "")
    .trim();
}

export async function GET(request: NextRequest) {
  if (!authorize(request)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const startedAt = Date.now();

  const instructors = await prisma.instructor.findMany({
    where: { isPracticeCoach: false, isFulltime: false },
    select: { id: true, name: true, flag: true },
  });

  const allThs = await prisma.teachingHistory.findMany({
    select: {
      instructorDbId: true,
      companyName: true,
      courseName: true,
      startDate: true,
      endDate: true,
    },
  });
  const thsByInst = new Map<string, typeof allThs>();
  for (const t of allThs) {
    const list = thsByInst.get(t.instructorDbId) ?? [];
    list.push(t);
    thsByInst.set(t.instructorDbId, list);
  }

  const recordCounts = await prisma.satisfactionRecord.groupBy({
    by: ["instructorDbId"],
    _count: { _all: true },
  });
  const recordById = new Map<string, number>(
    recordCounts.map((r) => [r.instructorDbId, r._count._all])
  );

  // L1 정의: TH ≥1 + record 0 (catalog 매칭 별도 — 여기서는 record 기준)
  const l1Instructors: Array<{
    id: string;
    name: string;
    th_count: number;
    companies: string[];
    courses: Array<{ company: string | null; course: string | null }>;
  }> = [];

  for (const inst of instructors) {
    if (inst.flag && inst.flag.startsWith("merged_into:")) continue;
    const ths = thsByInst.get(inst.id) ?? [];
    if (ths.length === 0) continue; // L0
    if ((recordById.get(inst.id) ?? 0) > 0) continue; // L4

    const companies = Array.from(
      new Set(ths.map((t) => t.companyName).filter((v): v is string => Boolean(v)))
    );
    const courses = ths.map((t) => ({ company: t.companyName, course: t.courseName }));
    l1Instructors.push({
      id: inst.id,
      name: inst.name,
      th_count: ths.length,
      companies,
      courses,
    });
  }

  // 회사별 영향 강사 수
  const byCompany = new Map<
    string,
    { company: string; instructor_count: number; instructors: string[]; course_examples: Set<string> }
  >();
  for (const li of l1Instructors) {
    for (const co of li.companies) {
      const key = normalize(co);
      if (key.length === 0) continue;
      const e = byCompany.get(key) ?? {
        company: co,
        instructor_count: 0,
        instructors: [],
        course_examples: new Set<string>(),
      };
      if (!e.instructors.includes(li.name)) {
        e.instructors.push(li.name);
        e.instructor_count += 1;
      }
      for (const c of li.courses) {
        if (normalize(c.company) === key && c.course) {
          e.course_examples.add(c.course.slice(0, 60));
        }
      }
      byCompany.set(key, e);
    }
  }

  const companyRanking = Array.from(byCompany.values())
    .map((e) => ({
      company: e.company,
      instructor_count: e.instructor_count,
      sample_instructors: e.instructors.slice(0, 8),
      course_examples: Array.from(e.course_examples).slice(0, 5),
    }))
    .sort((a, b) => b.instructor_count - a.instructor_count);

  // 강사 수 단일 (1명) 영역과 다중 (2+명) 영역 분리
  const concentrated = companyRanking.filter((c) => c.instructor_count >= 2);
  const singleInstructor = companyRanking.filter((c) => c.instructor_count === 1);

  return NextResponse.json({
    ok: true,
    durationMs: Date.now() - startedAt,
    total_instructors_scanned: instructors.length,
    l1_instructors_total: l1Instructors.length,
    distinct_companies: companyRanking.length,
    concentrated_count: concentrated.length, // 2명+ 영향
    single_count: singleInstructor.length, // 1명 영향
    concentrated_top: concentrated.slice(0, 20),
    single_sample: singleInstructor.slice(0, 10),
  });
}
