/**
 * POST /api/admin/bulk-reject-non-instructor?mode=dry_run|apply
 *
 * 사이버연수/이러닝/온라인 자율학습 등 강사 무관 콘텐츠 record를 일괄 reject.
 * - registry.matchStatus = "rejected_non_instructor"
 * - resolutionBasis = "bulk_auto_reject|kw:<matched_keyword>|at:<iso>"
 *
 * 인증: CRON_SECRET
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const KEYWORDS = [
  "사이버 연수",
  "사이버연수",
  "이러닝",
  "e-러닝",
  "e러닝",
  "온라인 자율학습",
  "LMS 콘텐츠",
  "lms 콘텐츠",
];

function matchKeyword(text: string | null | undefined): string | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const k of KEYWORDS) {
    if (lower.includes(k.toLowerCase())) return k;
  }
  return null;
}

export async function POST(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const mode = request.nextUrl.searchParams.get("mode") ?? "dry_run";
  if (mode !== "dry_run" && mode !== "apply") {
    return NextResponse.json({ ok: false, error: "invalid mode" }, { status: 400 });
  }

  const pending = await prisma.satisfactionReviewRegistry.findMany({
    where: { matchStatus: "pending" },
    select: { id: true, companyName: true, courseName: true, responseCount: true, registryKey: true },
  });

  interface Hit {
    id: string;
    company: string | null;
    course: string | null;
    responseCount: number;
    matchedKeyword: string;
  }
  const hits: Hit[] = [];
  for (const r of pending) {
    const k =
      matchKeyword(r.companyName) ?? matchKeyword(r.courseName);
    if (k) {
      hits.push({
        id: r.id,
        company: r.companyName,
        course: r.courseName,
        responseCount: r.responseCount,
        matchedKeyword: k,
      });
    }
  }

  if (mode === "dry_run") {
    return NextResponse.json({
      ok: true,
      mode,
      total_pending: pending.length,
      to_reject_count: hits.length,
      samples: hits.slice(0, 30),
    });
  }

  const nowIso = new Date().toISOString();
  let updated = 0;
  for (const h of hits) {
    await prisma.satisfactionReviewRegistry.update({
      where: { id: h.id },
      data: {
        matchStatus: "rejected_non_instructor",
        resolutionBasis: `bulk_auto_reject|kw:${h.matchedKeyword}|at:${nowIso}`,
      },
    });
    updated += 1;
  }
  return NextResponse.json({ ok: true, mode, updated });
}
