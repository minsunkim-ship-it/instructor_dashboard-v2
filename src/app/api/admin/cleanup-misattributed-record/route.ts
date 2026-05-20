/**
 * POST /api/admin/cleanup-misattributed-record?record_id=xxx
 * 잘못 매칭된 SatisfactionRecord 1건을 삭제하고 registry를 pending으로 되돌림.
 * 인증: CRON_SECRET
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";
import { refreshSatisfactionAggregates } from "@/lib/pipeline/satisfaction-applier";

export const dynamic = "force-dynamic";

type RawRecord = { [key: string]: unknown };
function pickString(o: RawRecord | undefined | null, key: string): string | null {
  if (!o) return null;
  const v = o[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

export async function POST(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const recordId = request.nextUrl.searchParams.get("record_id");
  if (!recordId) return NextResponse.json({ ok: false, error: "record_id required" }, { status: 400 });
  const rec = await prisma.satisfactionRecord.findUnique({ where: { id: recordId } });
  if (!rec) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const sourceRef = rec.sourceRef as RawRecord | null;
  const registryKey = pickString(sourceRef, "registry_key");
  await prisma.satisfactionRecord.delete({ where: { id: rec.id } });
  if (registryKey) {
    // v24-5: rejected status로 영구 차단 (resolver가 재매칭 시도 안 함)
    // 운영자가 backoffice에서 수동 검토 가능
    const permanentReject = request.nextUrl.searchParams.get("permanent_reject") === "1";
    await prisma.satisfactionReviewRegistry.update({
      where: { registryKey },
      data: {
        matchStatus: permanentReject ? "rejected" : "pending",
        resolvedInstructorId: null,
        resolutionBasis: `rollback_misattributed|cleared:${new Date().toISOString()}|permanent_reject=${permanentReject}`,
      },
    });
  }
  await refreshSatisfactionAggregates([rec.instructorDbId]);
  return NextResponse.json({ ok: true, deleted_record: rec.id, registry_key: registryKey });
}
