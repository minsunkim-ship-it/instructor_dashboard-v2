/**
 * POST /api/admin/bulk-reassign-strict-suggested?dry_run=1&min_count=2
 *
 * audit-suspect-records의 has_suggested 중 (matched, suggested) 패턴이
 * min_count 이상 반복되는 경우 자동 reassign.
 *
 * 안전 조건:
 *   - matched_instructor가 record 회사 TH 자체 없음 (잘못 매칭 증거)
 *   - suggested_alternative가 record 회사 TH 있음 + strong (contact)
 *   - 같은 (matched, suggested, company) 패턴이 min_count 이상 반복
 *   - dry_run=1이면 plan만 반환
 *
 * 박상훈은 v22 메모리에 [P0 정공법] permanent_reject 가드가 있어 reassign 대신
 * cleanup이 룰. 박상훈은 skip.
 *
 * 인증: CRON_SECRET
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";
import { companyMatchesWithAlias } from "@/lib/company-aliases";
import { refreshSatisfactionAggregates } from "@/lib/pipeline/satisfaction-applier";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

const PROTECTED_NAMES = new Set(["박상훈", "유종훈", "김정수A"]);

export async function POST(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const dryRun = request.nextUrl.searchParams.get("dry_run") === "1";
  const minCount = parseInt(request.nextUrl.searchParams.get("min_count") ?? "2", 10);

  const records = await prisma.satisfactionRecord.findMany({
    select: {
      id: true,
      instructorDbId: true,
      companyName: true,
      responseDate: true,
      sourceType: true,
      instructor: { select: { name: true } },
    },
  });
  const allInstructors = await prisma.instructor.findMany({
    select: { id: true, name: true, contactEmail: true, contactPhone: true, flag: true },
  });
  const instByName = new Map(allInstructors.map((i) => [i.name, i]));
  const allTHs = await prisma.teachingHistory.findMany({
    where: { companyName: { not: null } },
    select: { instructorDbId: true, companyName: true },
  });
  const thByInst = new Map<string, string[]>();
  for (const t of allTHs) {
    if (!t.companyName) continue;
    const arr = thByInst.get(t.instructorDbId) ?? [];
    arr.push(t.companyName);
    thByInst.set(t.instructorDbId, arr);
  }

  // Stage 1: 각 record별 (matched, suggested) 후보 추출
  interface Plan {
    record_id: string;
    from: string;
    to: string;
    to_id: string;
    company: string | null;
    response_date: string | null;
    source_type: string;
  }
  const candidates: Plan[] = [];
  for (const r of records) {
    if (!r.companyName) continue;
    const currentName = r.instructor.name;
    if (PROTECTED_NAMES.has(currentName)) continue;
    const currentTHs = thByInst.get(r.instructorDbId) ?? [];
    if (currentTHs.some((c) => companyMatchesWithAlias(c, r.companyName))) continue;
    // suggested: 회사 TH 있는 다른 instructor 중 strong + 정확히 1명
    const targets = allInstructors.filter((i) => {
      if (i.id === r.instructorDbId) return false;
      if (i.flag && i.flag.startsWith("merged_into:")) return false;
      if (!(i.contactEmail || i.contactPhone)) return false;
      if (PROTECTED_NAMES.has(i.name)) return false;
      const ths = thByInst.get(i.id) ?? [];
      return ths.some((c) => companyMatchesWithAlias(c, r.companyName));
    });
    if (targets.length !== 1) continue;
    candidates.push({
      record_id: r.id,
      from: currentName,
      to: targets[0].name,
      to_id: targets[0].id,
      company: r.companyName,
      response_date: r.responseDate?.toISOString().slice(0, 10) ?? null,
      source_type: r.sourceType,
    });
  }

  // Stage 2: 패턴 카운트 (from, to, company)
  const patternCount = new Map<string, number>();
  for (const c of candidates) {
    const k = `${c.from}|${c.to}|${c.company}`;
    patternCount.set(k, (patternCount.get(k) ?? 0) + 1);
  }
  const plans = candidates.filter((c) => {
    const k = `${c.from}|${c.to}|${c.company}`;
    return (patternCount.get(k) ?? 0) >= minCount;
  });

  if (dryRun) {
    // pattern 별 group
    const grp = new Map<string, Plan[]>();
    for (const p of plans) {
      const k = `${p.from} -> ${p.to} | ${p.company}`;
      const arr = grp.get(k) ?? [];
      arr.push(p);
      grp.set(k, arr);
    }
    const summary = Array.from(grp.entries())
      .map(([k, arr]) => ({ pattern: k, count: arr.length }))
      .sort((a, b) => b.count - a.count);
    return NextResponse.json({
      ok: true,
      mode: "dry_run",
      min_count: minCount,
      plan_count: plans.length,
      pattern_summary: summary,
      sample_plans: plans.slice(0, 20),
    });
  }

  let updated = 0;
  const affectedIds = new Set<string>();
  for (const p of plans) {
    try {
      const rec = await prisma.satisfactionRecord.findUnique({ where: { id: p.record_id } });
      if (!rec) continue;
      const prevId = rec.instructorDbId;
      await prisma.satisfactionRecord.update({
        where: { id: p.record_id },
        data: { instructorDbId: p.to_id },
      });
      affectedIds.add(prevId);
      affectedIds.add(p.to_id);
      updated += 1;
    } catch {
      // skip on error
    }
  }
  if (affectedIds.size > 0) {
    await refreshSatisfactionAggregates(Array.from(affectedIds));
  }
  return NextResponse.json({
    ok: true,
    mode: "apply",
    updated,
    affected_instructors: affectedIds.size,
    min_count: minCount,
  });
}
