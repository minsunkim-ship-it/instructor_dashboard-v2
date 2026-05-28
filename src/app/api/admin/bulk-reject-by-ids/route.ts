/**
 * POST /api/admin/bulk-reject-by-ids
 * Body: { ids: string[], reason?: string, status?: "rejected_non_instructor" | "rejected_by_operator" }
 *
 * 명시적 registry id 목록을 일괄 reject. 내부 행사, 패캠 자체 세미나, 회사 추출 실패 후 운영자 판단으로 거부할 때.
 * 인증: CRON_SECRET (x-cron-secret)
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const ALLOWED_STATUSES = new Set([
  "rejected_non_instructor",
  "rejected_by_operator",
]);

export async function POST(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  let body: { ids?: unknown; reason?: unknown; status?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === "string") : [];
  if (ids.length === 0) {
    return NextResponse.json({ ok: false, error: "ids required" }, { status: 400 });
  }
  const reason = typeof body.reason === "string" ? body.reason.slice(0, 200) : "";
  const status = typeof body.status === "string" && ALLOWED_STATUSES.has(body.status)
    ? body.status
    : "rejected_by_operator";

  const nowIso = new Date().toISOString();
  const basis = `bulk_reject_by_ids|status:${status}|at:${nowIso}${reason ? `|reason:${reason}` : ""}`;

  const existing = await prisma.satisfactionReviewRegistry.findMany({
    where: { id: { in: ids } },
    select: { id: true, matchStatus: true, companyName: true, courseName: true },
  });
  const existingById = new Map(existing.map((r) => [r.id, r]));

  const results: Array<{
    id: string;
    ok: boolean;
    skipped?: string;
    previous?: string;
    company?: string | null;
    course?: string | null;
  }> = [];
  let updated = 0;
  for (const id of ids) {
    const cur = existingById.get(id);
    if (!cur) {
      results.push({ id, ok: false, skipped: "not_found" });
      continue;
    }
    if (cur.matchStatus !== "pending") {
      results.push({ id, ok: false, skipped: "already_resolved", previous: cur.matchStatus });
      continue;
    }
    await prisma.satisfactionReviewRegistry.update({
      where: { id },
      data: { matchStatus: status, resolutionBasis: basis },
    });
    updated += 1;
    results.push({ id, ok: true, company: cur.companyName, course: cur.courseName });
  }
  return NextResponse.json({ ok: true, updated, total: ids.length, status, results });
}
