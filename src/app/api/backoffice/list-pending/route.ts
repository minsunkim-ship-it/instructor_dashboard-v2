/**
 * GET /api/backoffice/list-pending?offset=0&limit=50
 *
 * 운영자용 pending review registry list. NextAuth session 인증.
 * normalizer가 sourceRef에 남긴 resolved_instructor_id를 suggested로 표시.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth, isAuthDisabled } from "@/auth";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

type RawRecord = { [key: string]: unknown };
function pickString(obj: RawRecord | undefined | null, ...keys: string[]): string | null {
  if (!obj) return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return null;
}
function extractResolvedIds(sourceRefs: unknown): string[] {
  if (!Array.isArray(sourceRefs)) return [];
  const ids = new Set<string>();
  for (const item of sourceRefs as RawRecord[]) {
    const inner = item?.source_ref as RawRecord | undefined;
    const id = pickString(inner, "resolved_instructor_id");
    if (id) ids.add(id);
  }
  return Array.from(ids);
}

export async function GET(request: NextRequest) {
  // CRON_SECRET (admin/debug용) 우선 검사
  const cronOk = isValidCronSecret(request.headers.get(CRON_SECRET_HEADER));
  if (!cronOk && !isAuthDisabled()) {
    const session = await auth();
    if (!session?.user?.email) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
  }
  const sp = request.nextUrl.searchParams;
  const offset = Math.max(0, parseInt(sp.get("offset") ?? "0", 10) || 0);
  const limit = Math.min(200, Math.max(1, parseInt(sp.get("limit") ?? "50", 10) || 50));

  const totalPending = await prisma.satisfactionReviewRegistry.count({
    where: { matchStatus: "pending" },
  });
  const registries = await prisma.satisfactionReviewRegistry.findMany({
    where: { matchStatus: "pending" },
    orderBy: [{ responseCount: "desc" }, { createdAt: "desc" }],
    skip: offset,
    take: limit,
  });

  const instructorIds = new Set<string>();
  for (const r of registries) {
    if (r.suggestedInstructorId) instructorIds.add(r.suggestedInstructorId);
    for (const id of extractResolvedIds(r.sourceRefs)) instructorIds.add(id);
  }
  const instructors = await prisma.instructor.findMany({
    where: { id: { in: Array.from(instructorIds) } },
    select: { id: true, name: true, contactEmail: true },
  });
  const instById = new Map(instructors.map((i) => [i.id, i]));

  // 자동 매칭 실패 사유 분류 (휴리스틱 — resolver 없이 빠른 진단)
  const NON_INSTRUCTOR_KEYWORDS = ["사이버 연수", "사이버연수", "이러닝", "e-러닝", "온라인 자율학습", "LMS", "lms 콘텐츠"];
  function classifyReason(r: typeof registries[number], firstRef: RawRecord | undefined, suggestion: { id: string; name: string } | null): { code: string; label: string; severity: "blocker" | "review" | "info" } {
    const co = (r.companyName ?? "").toLowerCase();
    const cr = (r.courseName ?? "").toLowerCase();
    if (NON_INSTRUCTOR_KEYWORDS.some((k) => co.includes(k.toLowerCase()) || cr.includes(k.toLowerCase()))) {
      return { code: "non_instructor_course", label: "강사 무관 (사이버연수/이러닝 등)", severity: "info" };
    }
    if (!r.companyName || r.companyName.trim().length === 0) {
      return { code: "no_company", label: "회사명 추출 실패", severity: "blocker" };
    }
    const respDateStr = pickString(firstRef, "response_date") ?? pickString((firstRef as RawRecord)?.source_ref as RawRecord, "created_time");
    if (!respDateStr) {
      return { code: "no_response_date", label: "응답일자 추출 실패", severity: "blocker" };
    }
    if (r.responseCount <= 1 && !suggestion) {
      return { code: "low_evidence", label: "응답 수 ≤1 + 추천 없음", severity: "review" };
    }
    if (suggestion) {
      return { code: "has_suggestion", label: "자동 추천 있음 — 검토 후 승인", severity: "review" };
    }
    if (r.sourceType === "gmail_summary") {
      return { code: "gmail_no_signal", label: "메일에 강사/회사 신호 부족", severity: "review" };
    }
    return { code: "no_slack_match", label: "그날 슬랙(운영보고/일반)에 매칭 없음", severity: "review" };
  }

  const rows = registries.map((r) => {
    const resolvedIds = extractResolvedIds(r.sourceRefs);
    const suggestion =
      r.suggestedInstructorId && instById.has(r.suggestedInstructorId)
        ? instById.get(r.suggestedInstructorId)!
        : resolvedIds.length === 1 && instById.has(resolvedIds[0])
          ? instById.get(resolvedIds[0])!
          : null;
    const firstRef = (Array.isArray(r.sourceRefs) ? (r.sourceRefs as RawRecord[]) : [])[0];
    const inner = firstRef?.source_ref as RawRecord | undefined;
    const reason = classifyReason(r, firstRef, suggestion ? { id: suggestion.id, name: suggestion.name } : null);
    return {
      id: r.id,
      registryKey: r.registryKey,
      sourceType: r.sourceType,
      company: r.companyName,
      course: r.courseName,
      candidate: r.candidateName,
      avgScore: r.avgScore !== null ? Number(r.avgScore) : null,
      responseCount: r.responseCount,
      responseDate: pickString(firstRef, "response_date"),
      sessionLabel: pickString(inner, "session_label"),
      sourceKey: pickString(inner, "source_key"),
      fileName: pickString(inner, "file_name"),
      sheetTitle: pickString(inner, "sheet_title"),
      subject: pickString(inner, "subject"),
      resolutionBasis: pickString(inner, "resolution_basis"),
      resolutionLevel: pickString(inner, "resolution_level"),
      suggestion: suggestion
        ? { id: suggestion.id, name: suggestion.name, contactEmail: suggestion.contactEmail }
        : null,
      resolvedCandidates: resolvedIds.map((id) => instById.get(id)).filter(Boolean),
      sourceRefs: r.sourceRefs,
      createdAt: r.createdAt.toISOString(),
      reason,
    };
  });

  // reason 분포 — 사용자가 한눈에 보게
  const byReason = new Map<string, { code: string; label: string; severity: string; count: number }>();
  for (const r of rows) {
    const k = r.reason.code;
    const e = byReason.get(k) ?? { ...r.reason, count: 0 };
    e.count += 1;
    byReason.set(k, e);
  }

  return NextResponse.json({
    ok: true,
    total: totalPending,
    offset,
    limit,
    rows,
    reason_distribution: Array.from(byReason.values()).sort((a, b) => b.count - a.count),
  });
}
