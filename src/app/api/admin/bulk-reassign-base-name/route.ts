/**
 * POST /api/admin/bulk-reassign-base-name?dry_run=1
 *
 * audit-suspect-records의 has_suggested 중 base name 동일 인격으로
 * redirect되는 케이스 자동 reassign.
 *
 * 예: 박은정 → 박은정A (신세계프라퍼티 record 3건),
 *     최진영 → 최진영B (BGF리테일 record 6건).
 *
 * 안전 조건:
 *   - matched_instructor의 base name == suggested_alternative의 base name
 *   - suggested_alternative가 strong (contact 있음)
 *   - record의 회사가 suggested의 TH 회사 매칭
 *   - dry_run=1이면 plan만 반환
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

/**
 * base name 정규화:
 *   1. 괄호 suffix 제거: "곽소영 (소속강사)" → "곽소영", "박봉주(포레스트 소프트)" → "박봉주"
 *   2. 공백/줄바꿈 normalize
 *   3. 끝 단일 대문자 제거: "박은정A" → "박은정", "최진영B" → "최진영"
 */
function baseName(n: string): string {
  let s = n.split("\n")[0].trim();
  // 괄호 안 모두 제거 (전체 + 한쪽만 열린 경우)
  s = s.replace(/\s*\([^)]*\)/g, "").trim();
  s = s.replace(/\s*\([^)]*$/g, "").trim(); // 닫힘 없는 괄호도 cut
  // 공백 정규화
  s = s.replace(/\s+/g, "");
  // 끝 단일 대문자 (인격 표기)
  s = s.replace(/[A-Z]$/, "");
  return s;
}

export async function POST(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const dryRun = request.nextUrl.searchParams.get("dry_run") === "1";

  // 모든 records + instructors + TH 한 번 fetch
  const records = await prisma.satisfactionRecord.findMany({
    select: {
      id: true,
      instructorDbId: true,
      companyName: true,
      responseDate: true,
      instructor: { select: { name: true } },
    },
  });
  const allInstructors = await prisma.instructor.findMany({
    select: { id: true, name: true, contactEmail: true, contactPhone: true, flag: true },
  });
  const instByName = new Map(allInstructors.map((i) => [i.name, i]));
  const byBase = new Map<string, typeof allInstructors>();
  for (const i of allInstructors) {
    const b = baseName(i.name);
    if (b.length < 2) continue;
    const arr = byBase.get(b) ?? [];
    arr.push(i);
    byBase.set(b, arr);
  }
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

  const plans: Array<{
    record_id: string;
    from: string;
    to: string;
    to_id: string;
    company: string | null;
    response_date: string | null;
  }> = [];

  for (const r of records) {
    if (!r.companyName) continue;
    const currentName = r.instructor.name;
    const currentBase = baseName(currentName);
    const currentInst = instByName.get(currentName);
    if (!currentInst) continue;

    // current instructor에 회사 TH 있으면 skip (이미 정상 매칭)
    const currentTHs = thByInst.get(r.instructorDbId) ?? [];
    if (currentTHs.some((co) => companyMatchesWithAlias(co, r.companyName))) continue;

    // same base 후보 중 다른 인격 (contact 없어도 인정 — 소속강사는 개인 contact 없음)
    const candidates = (byBase.get(currentBase) ?? []).filter(
      (c) =>
        c.id !== r.instructorDbId &&
        !(c.flag && c.flag.startsWith("merged_into:"))
    );
    const targets = candidates.filter((c) => {
      const ths = thByInst.get(c.id) ?? [];
      return ths.some((co) => companyMatchesWithAlias(co, r.companyName));
    });
    if (targets.length !== 1) continue; // 정확히 1명만

    plans.push({
      record_id: r.id,
      from: currentName,
      to: targets[0].name,
      to_id: targets[0].id,
      company: r.companyName,
      response_date: r.responseDate?.toISOString().slice(0, 10) ?? null,
    });
  }

  if (dryRun) {
    return NextResponse.json({ ok: true, mode: "dry_run", plan_count: plans.length, plans });
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
    plans,
  });
}
