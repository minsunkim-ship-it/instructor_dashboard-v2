/**
 * POST /api/backoffice/cleanup-record
 * Body: { recordId: string }
 *
 * NextAuth session 인증. 잘못 매칭된 record 삭제 + registry pending 복원.
 * 운영자 UI(/admin/review 의심 record 섹션)에서 1-click 사용.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth, isAuthDisabled } from "@/auth";
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
  const headerSecret = request.headers.get(CRON_SECRET_HEADER);
  let isAuthed = false;
  if (isValidCronSecret(headerSecret)) isAuthed = true;
  else if (isAuthDisabled()) isAuthed = true;
  else {
    const session = await auth();
    if (session?.user) isAuthed = true;
  }
  if (!isAuthed) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => null)) as { recordId?: string } | null;
  const recordId = body?.recordId;
  if (!recordId) return NextResponse.json({ ok: false, error: "recordId required" }, { status: 400 });

  const rec = await prisma.satisfactionRecord.findUnique({ where: { id: recordId } });
  if (!rec) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

  const sourceRef = rec.sourceRef as RawRecord | null;
  const registryKey = pickString(sourceRef, "registry_key");
  await prisma.satisfactionRecord.delete({ where: { id: rec.id } });
  if (registryKey) {
    await prisma.satisfactionReviewRegistry.update({
      where: { registryKey },
      data: {
        matchStatus: "pending",
        resolvedInstructorId: null,
        resolutionBasis: `rollback_misattributed|cleared:${new Date().toISOString()}`,
      },
    });
  }
  await refreshSatisfactionAggregates([rec.instructorDbId]);
  return NextResponse.json({
    ok: true,
    deleted_record: rec.id,
    registry_key: registryKey,
    affected_instructor_id: rec.instructorDbId,
  });
}
