/**
 * POST /api/admin/fix-record-resolved-mismatch?mode=dry_run|apply
 *
 * sourceRef.source_refs[].source_ref.resolved_instructor_id가 명시되어 있고
 * record.instructorDbId와 다른 경우, sourceRef를 ground truth로 삼아 redirect.
 *
 * 안전 조건 (general — 케이스별 룰 없음):
 *   1. resolvedIds가 정확히 1개 (unique target)
 *   2. resolvedId의 instructor가 DB에 존재하고 flag !== merged_into*
 *   3. record.companyName이 resolvedInstructor의 TH companyName 중 하나와 정규화 매칭
 *      (normalizer는 schedule overlap만 보지만 회사명까지 일치하면 강력)
 *   4. resolvedInstructor.contactEmail 또는 contactPhone 존재 (strong row)
 *
 * 인증: CRON_SECRET
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";
import { refreshSatisfactionAggregates } from "@/lib/pipeline/satisfaction-applier";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

function authorize(request: NextRequest): boolean {
  const headerSecret = request.headers.get(CRON_SECRET_HEADER);
  if (isValidCronSecret(headerSecret)) return true;
  const querySecret = request.nextUrl.searchParams.get("secret");
  if (isValidCronSecret(querySecret)) return true;
  return false;
}

function normalizeCompany(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[\s()[\]{}.,:;'"`~!?+\-_/\\|]+/g, "");
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

export async function POST(request: NextRequest) {
  if (!authorize(request)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const mode = request.nextUrl.searchParams.get("mode") ?? "dry_run";
  if (mode !== "dry_run" && mode !== "apply") {
    return NextResponse.json({ ok: false, error: "invalid mode" }, { status: 400 });
  }
  const startedAt = Date.now();

  const records = await prisma.satisfactionRecord.findMany({
    select: { id: true, instructorDbId: true, companyName: true, courseName: true, sourceRef: true },
  });

  // Pre-load all TH and instructor info — small enough
  const allInstructors = await prisma.instructor.findMany({
    select: { id: true, name: true, contactEmail: true, contactPhone: true, flag: true },
  });
  const instById = new Map(allInstructors.map((i) => [i.id, i]));

  const allTHs = await prisma.teachingHistory.findMany({
    select: { instructorDbId: true, companyName: true },
  });
  const thCompanies = new Map<string, Set<string>>();
  for (const t of allTHs) {
    if (!t.companyName) continue;
    const s = thCompanies.get(t.instructorDbId) ?? new Set<string>();
    s.add(normalizeCompany(t.companyName));
    thCompanies.set(t.instructorDbId, s);
  }

  interface Plan {
    recordId: string;
    fromInstructorId: string;
    fromName: string;
    toInstructorId: string;
    toName: string;
    company: string | null;
    course: string | null;
    reason: string;
  }
  const plans: Plan[] = [];
  const skipped: { recordId: string; reason: string }[] = [];
  let evaluated = 0;

  for (const r of records) {
    const resolvedIds = extractResolvedIds(r.sourceRef);
    if (resolvedIds.length === 0) continue;
    evaluated += 1;
    if (resolvedIds.includes(r.instructorDbId)) continue; // already matched
    if (resolvedIds.length !== 1) {
      skipped.push({ recordId: r.id, reason: "multiple_resolved_ids" });
      continue;
    }
    const toId = resolvedIds[0];
    const toInst = instById.get(toId);
    if (!toInst) {
      skipped.push({ recordId: r.id, reason: "resolved_instructor_not_found" });
      continue;
    }
    if (toInst.flag && toInst.flag.startsWith("merged_into:")) {
      skipped.push({ recordId: r.id, reason: "resolved_instructor_merged" });
      continue;
    }
    if (!toInst.contactEmail && !toInst.contactPhone) {
      skipped.push({ recordId: r.id, reason: "resolved_instructor_weak_no_contact" });
      continue;
    }
    // Company guard — resolvedInstructor TH 중에 record 회사가 있어야 함
    const targetCompanies = thCompanies.get(toId) ?? new Set<string>();
    const recordCompanyNorm = normalizeCompany(r.companyName);
    if (recordCompanyNorm.length === 0) {
      skipped.push({ recordId: r.id, reason: "record_no_company" });
      continue;
    }
    const companyMatch = Array.from(targetCompanies).some(
      (c) => c.includes(recordCompanyNorm) || recordCompanyNorm.includes(c)
    );
    if (!companyMatch) {
      skipped.push({ recordId: r.id, reason: "company_not_in_target_th" });
      continue;
    }
    const fromInst = instById.get(r.instructorDbId);
    plans.push({
      recordId: r.id,
      fromInstructorId: r.instructorDbId,
      fromName: fromInst?.name ?? "(unknown)",
      toInstructorId: toId,
      toName: toInst.name,
      company: r.companyName,
      course: r.courseName,
      reason: "sourceRef.resolved_instructor_id + company in target TH",
    });
  }

  if (mode === "dry_run") {
    return NextResponse.json({
      ok: true,
      mode: "dry_run",
      durationMs: Date.now() - startedAt,
      total_records: records.length,
      records_with_resolved_id: evaluated,
      to_redirect_count: plans.length,
      skipped_count: skipped.length,
      plans,
      skipped: skipped.slice(0, 30),
    });
  }

  // apply
  const affectedFrom = new Set<string>();
  const affectedTo = new Set<string>();
  let updated = 0;
  for (const p of plans) {
    await prisma.satisfactionRecord.update({
      where: { id: p.recordId },
      data: { instructorDbId: p.toInstructorId },
    });
    affectedFrom.add(p.fromInstructorId);
    affectedTo.add(p.toInstructorId);
    updated += 1;
  }
  // refresh aggregates for both sides
  const allAffected = Array.from(new Set([...affectedFrom, ...affectedTo]));
  if (allAffected.length > 0) {
    await refreshSatisfactionAggregates(allAffected);
  }
  return NextResponse.json({
    ok: true,
    mode: "apply",
    durationMs: Date.now() - startedAt,
    updated,
    refreshed_instructors: allAffected.length,
  });
}
