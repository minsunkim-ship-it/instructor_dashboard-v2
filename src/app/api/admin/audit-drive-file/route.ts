/**
 * GET /api/admin/audit-drive-file?file_id=X
 * Drive sheet file_id로 SatisfactionImportItem / Registry / Record 매칭 상태 추적.
 * 인증: CRON_SECRET
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";

type RawRecord = { [key: string]: unknown };
function pickString(o: RawRecord | undefined | null, ...keys: string[]): string | null {
  if (!o) return null;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return null;
}

export async function GET(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const fileId = request.nextUrl.searchParams.get("file_id");
  if (!fileId) return NextResponse.json({ ok: false, error: "file_id required" }, { status: 400 });

  // ImportItem: sourceRef.file_id 또는 sourceRefKey에 file_id 포함
  const items = await prisma.satisfactionImportItem.findMany({
    where: {
      OR: [
        { sourceRefKey: { contains: fileId } },
        { sourceRef: { path: ["file_id"], equals: fileId } },
      ],
    },
    select: {
      id: true,
      sourceRefKey: true,
      sourceType: true,
      candidateName: true,
      candidateCompanyName: true,
      candidateCourseName: true,
      sourceRef: true,
      normalizedPayload: true,
    },
  });

  // Registry: sourceRefs 안에 file_id 있는 것
  const allReg = await prisma.satisfactionReviewRegistry.findMany({
    where: { sourceType: "drive_satisfaction" },
    select: {
      id: true,
      registryKey: true,
      matchStatus: true,
      companyName: true,
      courseName: true,
      candidateName: true,
      avgScore: true,
      responseCount: true,
      resolvedInstructorId: true,
      resolutionBasis: true,
      sourceRefs: true,
    },
    take: 2000,
  });
  const matchedRegs = allReg.filter((r) => {
    const refs = Array.isArray(r.sourceRefs) ? (r.sourceRefs as RawRecord[]) : [];
    return refs.some((ref) => {
      const inner = ref?.source_ref as RawRecord | undefined;
      const fid = pickString(inner, "file_id") ?? pickString(ref, "file_id");
      return fid === fileId;
    });
  });

  // Record: sourceRef.source_refs 안에 file_id
  const allRec = await prisma.satisfactionRecord.findMany({
    where: { sourceType: "drive_satisfaction" },
    select: {
      id: true,
      instructorDbId: true,
      score: true,
      respondentCount: true,
      companyName: true,
      courseName: true,
      responseDate: true,
      sourceRef: true,
      instructor: { select: { name: true } },
    },
    take: 2000,
  });
  const matchedRecs = allRec.filter((r) => {
    const sr = r.sourceRef as RawRecord | null;
    const refs = Array.isArray(sr?.source_refs) ? (sr!.source_refs as RawRecord[]) : [];
    return refs.some((ref) => {
      const inner = ref?.source_ref as RawRecord | undefined;
      const fid = pickString(inner, "file_id") ?? pickString(ref, "file_id");
      return fid === fileId;
    });
  });

  return NextResponse.json({
    ok: true,
    file_id: fileId,
    import_items: items.map((it) => ({
      id: it.id,
      sourceType: it.sourceType,
      sourceRefKey: it.sourceRefKey,
      candidate: it.candidateName,
      company: it.candidateCompanyName,
      course: it.candidateCourseName,
    })),
    registries: matchedRegs.map((r) => ({
      registryKey: r.registryKey,
      matchStatus: r.matchStatus,
      companyName: r.companyName,
      courseName: r.courseName,
      candidateName: r.candidateName,
      avgScore: r.avgScore !== null ? Number(r.avgScore) : null,
      responseCount: r.responseCount,
      resolvedInstructorId: r.resolvedInstructorId,
      resolutionBasis: r.resolutionBasis,
    })),
    records: matchedRecs.map((rec) => ({
      id: rec.id,
      instructor: rec.instructor?.name ?? null,
      score: Number(rec.score),
      n: rec.respondentCount,
      company: rec.companyName,
      course: rec.courseName?.slice(0, 60) ?? null,
      response_date: rec.responseDate?.toISOString().slice(0, 10) ?? null,
    })),
  });
}
