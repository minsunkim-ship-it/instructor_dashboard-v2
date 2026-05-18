/**
 * GET /api/admin/debug-multi-rows
 * resolve-drive-with-session의 multi_instructors 전수 list + TH cross-check 결과
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  // resolver dry_run 호출
  const secret = request.headers.get(CRON_SECRET_HEADER)!;
  const origin = request.nextUrl.origin;
  const res = await fetch(`${origin}/api/admin/resolve-drive-with-session?mode=dry_run`, {
    headers: { [CRON_SECRET_HEADER]: secret },
  });
  const data = await res.json();
  const multi = (data?.samples?.multi_instructors ?? []) as Array<{
    company: string | null;
    course: string | null;
    response_date: string | null;
    course_session: number | null;
    matched_instructors: string[];
    evidence_count: number;
  }>;
  return NextResponse.json({
    ok: true,
    total: multi.length,
    classification_stats: data.classification_stats,
    multi: multi.map((m) => ({
      company: m.company,
      course: m.course?.slice(0, 50),
      response_date: m.response_date,
      session: m.course_session,
      candidates: m.matched_instructors,
      evidence: m.evidence_count,
    })),
  });
}
