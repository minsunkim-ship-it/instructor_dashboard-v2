/**
 * POST /api/admin/fix-homonym-th-mismatch?mode=dry_run|apply
 *
 * 동명이인 그룹 내에서 record.companyName이 currentInst.TH에 없고
 * 같은 base name 그룹의 다른 instructor TH에 정확히 1명만 매칭되면 redirect.
 *
 * 일반 룰 (contact 조건 X — base name 그룹 안 단일 회사 매칭 자체가 강력):
 *   1. record.instructorDbId의 TH 회사에 record.companyName 없음
 *   2. base name 같은 다른 instructor 중 TH 회사 매칭 instructor 검색
 *   3. 정확히 1명 매칭 → redirect 후보
 *   4. 매칭 instructor가 flag merged_into:* 아닌지 확인
 *
 * 안전 가드: base name이 같지 않으면 절대 redirect (다른 이름 강사로 옮기는 건 위험)
 *
 * 인증: CRON_SECRET
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";
import { refreshSatisfactionAggregates } from "@/lib/pipeline/satisfaction-applier";
import { normalizeCompanyWithAlias } from "@/lib/company-aliases";

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
  return normalizeCompanyWithAlias(value);
}
function companyMatches(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a.length < 2 || b.length < 2) return false;
  return a === b || a.includes(b) || b.includes(a);
}
function getBaseName(name: string): string {
  return name.replace(/[A-Z]$/, "").trim();
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
    select: {
      id: true,
      instructorDbId: true,
      companyName: true,
      courseName: true,
      score: true,
      respondentCount: true,
      instructor: { select: { name: true } },
    },
  });
  const allInstructors = await prisma.instructor.findMany({
    select: { id: true, name: true, flag: true },
  });
  const instById = new Map(allInstructors.map((i) => [i.id, i]));

  const allTHs = await prisma.teachingHistory.findMany({
    select: { instructorDbId: true, companyName: true },
  });
  const thByInst = new Map<string, Set<string>>();
  for (const t of allTHs) {
    if (!t.companyName) continue;
    const n = normalizeCompany(t.companyName);
    if (n.length === 0) continue;
    const s = thByInst.get(t.instructorDbId) ?? new Set<string>();
    s.add(n);
    thByInst.set(t.instructorDbId, s);
  }

  // base name 그룹
  const byBase = new Map<string, string[]>();
  for (const i of allInstructors) {
    if (i.flag && i.flag.startsWith("merged_into:")) continue;
    const base = getBaseName(i.name);
    if (base.length < 2) continue;
    const arr = byBase.get(base) ?? [];
    arr.push(i.id);
    byBase.set(base, arr);
  }

  interface Plan {
    recordId: string;
    fromId: string;
    fromName: string;
    toId: string;
    toName: string;
    company: string;
    course: string | null;
    score: number;
    n: number | null;
  }
  const plans: Plan[] = [];
  const skipped: { recordId: string; reason: string; details?: unknown }[] = [];

  for (const r of records) {
    if (!r.companyName) continue;
    const recCo = normalizeCompany(r.companyName);
    if (recCo.length < 2) continue;
    const currentTH = thByInst.get(r.instructorDbId) ?? new Set<string>();
    const currentHas = Array.from(currentTH).some((c) => companyMatches(c, recCo));
    if (currentHas) continue;

    const baseName = getBaseName(r.instructor.name);
    const sameBaseIds = (byBase.get(baseName) ?? []).filter((id) => id !== r.instructorDbId);
    if (sameBaseIds.length === 0) {
      // 동명이인 그룹 없음 — TH 부족이 원인이지 mismatch 아님
      continue;
    }
    // 같은 base 그룹 중 회사 매칭 instructor
    const matches: string[] = [];
    for (const id of sameBaseIds) {
      const ths = thByInst.get(id) ?? new Set<string>();
      if (Array.from(ths).some((c) => companyMatches(c, recCo))) {
        matches.push(id);
      }
    }
    if (matches.length === 0) {
      skipped.push({ recordId: r.id, reason: "no_homonym_th_match" });
      continue;
    }
    if (matches.length > 1) {
      skipped.push({
        recordId: r.id,
        reason: "multiple_homonym_matches",
        details: matches.map((id) => instById.get(id)?.name),
      });
      continue;
    }
    const toId = matches[0];
    const toInst = instById.get(toId);
    if (!toInst) continue;
    plans.push({
      recordId: r.id,
      fromId: r.instructorDbId,
      fromName: r.instructor.name,
      toId,
      toName: toInst.name,
      company: r.companyName,
      course: r.courseName ? r.courseName.slice(0, 60) : null,
      score: Number(r.score),
      n: r.respondentCount,
    });
  }

  if (mode === "dry_run") {
    return NextResponse.json({
      ok: true,
      mode: "dry_run",
      durationMs: Date.now() - startedAt,
      total_records: records.length,
      to_redirect_count: plans.length,
      skipped_count: skipped.length,
      plans,
      skipped_samples: skipped.slice(0, 15),
    });
  }
  // apply
  const affected = new Set<string>();
  let updated = 0;
  for (const p of plans) {
    await prisma.satisfactionRecord.update({
      where: { id: p.recordId },
      data: { instructorDbId: p.toId },
    });
    affected.add(p.fromId);
    affected.add(p.toId);
    updated += 1;
  }
  const refreshIds = Array.from(affected);
  if (refreshIds.length > 0) {
    await refreshSatisfactionAggregates(refreshIds);
  }
  return NextResponse.json({
    ok: true,
    mode: "apply",
    durationMs: Date.now() - startedAt,
    updated,
    refreshed_instructors: refreshIds.length,
  });
}
