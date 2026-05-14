/**
 * GET /api/admin/probe-record-resolved-mismatch
 *
 * SatisfactionRecord.instructorDbId vs sourceRef.source_refs[].source_ref.resolved_instructor_id
 * mismatch case 진단. normalizer가 매칭했다고 기록한 instructor와 실제 SatisfactionRecord가
 * 매핑된 instructor가 다른 case = record-level alias 결함.
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

type RawRecord = { [key: string]: unknown };

function pickString(obj: RawRecord | undefined, ...keys: string[]): string | null {
  if (!obj) return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return null;
}

function extractResolvedIds(sourceRef: unknown): string[] {
  if (!sourceRef || typeof sourceRef !== "object") return [];
  const ref = sourceRef as RawRecord;
  const refs = Array.isArray(ref.source_refs) ? (ref.source_refs as RawRecord[]) : [];
  const ids = new Set<string>();
  for (const item of refs) {
    if (!item || typeof item !== "object") continue;
    const inner = (item as RawRecord).source_ref as RawRecord | undefined;
    const id = pickString(inner, "resolved_instructor_id");
    if (id) ids.add(id);
  }
  return Array.from(ids);
}

export async function GET(request: NextRequest) {
  if (!authorize(request)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const startedAt = Date.now();

  const records = await prisma.satisfactionRecord.findMany({
    select: {
      id: true,
      instructorDbId: true,
      score: true,
      respondentCount: true,
      companyName: true,
      courseName: true,
      responseDate: true,
      sourceType: true,
      sourceRef: true,
      instructor: { select: { name: true } },
    },
  });

  const allInstructors = await prisma.instructor.findMany({
    select: { id: true, name: true },
  });
  const instructorById = new Map(allInstructors.map((i) => [i.id, i]));

  interface Mismatch {
    recordId: string;
    currentInstructorId: string;
    currentInstructorName: string;
    resolvedIds: string[];
    resolvedNames: string[];
    company: string | null;
    course: string | null;
    score: number;
    responseCount: number | null;
    responseDate: string | null;
    sourceType: string;
    sourceRefRaw?: unknown;
  }
  const mismatches: Mismatch[] = [];
  let totalWithResolved = 0;
  let matchedCount = 0;

  for (const r of records) {
    const resolvedIds = extractResolvedIds(r.sourceRef);
    if (resolvedIds.length === 0) continue;
    totalWithResolved += 1;
    // record.instructorDbId가 resolvedIds 중 하나면 OK
    if (resolvedIds.includes(r.instructorDbId)) {
      matchedCount += 1;
      continue;
    }
    // mismatch
    mismatches.push({
      recordId: r.id,
      currentInstructorId: r.instructorDbId,
      currentInstructorName: r.instructor.name,
      resolvedIds,
      resolvedNames: resolvedIds.map(
        (id) => instructorById.get(id)?.name ?? `(unknown:${id.slice(0, 8)})`
      ),
      company: r.companyName,
      course: r.courseName,
      score: Number(r.score),
      responseCount: r.respondentCount,
      responseDate: r.responseDate?.toISOString().slice(0, 10) ?? null,
      sourceType: r.sourceType,
      sourceRefRaw: r.sourceRef,
    });
  }

  // 영향 강사 group
  const byCurrentInstructor = new Map<string, number>();
  for (const m of mismatches) {
    byCurrentInstructor.set(m.currentInstructorName, (byCurrentInstructor.get(m.currentInstructorName) ?? 0) + 1);
  }

  return NextResponse.json({
    ok: true,
    durationMs: Date.now() - startedAt,
    total_records: records.length,
    records_with_resolved_id: totalWithResolved,
    matched: matchedCount,
    mismatched: mismatches.length,
    by_current_instructor: Array.from(byCurrentInstructor.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 15),
    samples: mismatches.slice(0, 20),
  });
}
