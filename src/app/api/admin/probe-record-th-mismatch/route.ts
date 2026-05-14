/**
 * GET /api/admin/probe-record-th-mismatch
 *
 * SatisfactionRecord.companyName이 record.instructor의 TH 회사 목록에 없는 경우 진단.
 * 일반 algorithm:
 *   - record.companyName 정규화 후 currentInst.TH companies에 포함되지 않으면 잘못된 매핑 의심
 *   - 모든 instructor 중 TH에 record.companyName 포함된 instructor list (after_candidates)
 *   - 정확히 1명이고 strong (contact 있음)이면 auto_safe
 *   - 0명이거나 2명 이상이면 manual review
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

function normalizeCompany(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[\s()[\]{}.,:;'"`~!?+\-_/\\|]+/g, "");
}

function companyMatches(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
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
      companyName: true,
      courseName: true,
      score: true,
      respondentCount: true,
      responseDate: true,
      sourceType: true,
      instructor: { select: { name: true } },
    },
  });

  const allInstructors = await prisma.instructor.findMany({
    select: { id: true, name: true, contactEmail: true, contactPhone: true, flag: true },
  });
  const instById = new Map(allInstructors.map((i) => [i.id, i]));

  const allTHs = await prisma.teachingHistory.findMany({
    select: { instructorDbId: true, companyName: true },
  });
  const thByInst = new Map<string, Set<string>>();
  for (const t of allTHs) {
    if (!t.companyName) continue;
    const norm = normalizeCompany(t.companyName);
    if (norm.length === 0) continue;
    const s = thByInst.get(t.instructorDbId) ?? new Set<string>();
    s.add(norm);
    thByInst.set(t.instructorDbId, s);
  }

  // base name 그룹
  const getBaseName = (n: string) => n.replace(/[A-Z]$/, "").trim();
  const byBase = new Map<string, string[]>(); // baseName → instructor ids
  for (const i of allInstructors) {
    const base = getBaseName(i.name);
    if (base.length < 2) continue;
    const arr = byBase.get(base) ?? [];
    arr.push(i.id);
    byBase.set(base, arr);
  }

  interface Mismatch {
    recordId: string;
    currentInstructorId: string;
    currentInstructorName: string;
    recordCompany: string;
    course: string | null;
    score: number;
    n: number | null;
    date: string | null;
    sourceType: string;
    currentTHHas: boolean;
    candidates_same_base: Array<{
      id: string;
      name: string;
      strong: boolean;
      flag: string | null;
      th_matched_company: string;
    }>;
    candidates_anywhere: Array<{
      id: string;
      name: string;
      strong: boolean;
      flag: string | null;
      th_matched_company: string;
    }>;
    auto_safe_target?: { id: string; name: string };
  }
  const mismatches: Mismatch[] = [];

  for (const r of records) {
    if (!r.companyName) continue;
    const recCompany = normalizeCompany(r.companyName);
    if (recCompany.length === 0) continue;
    const currentTH = thByInst.get(r.instructorDbId) ?? new Set<string>();
    const currentHas = Array.from(currentTH).some((c) => companyMatches(c, recCompany));
    if (currentHas) continue; // OK
    // mismatch — find candidates
    const baseName = getBaseName(r.instructor.name);
    const sameBaseIds = byBase.get(baseName) ?? [];

    interface Cand {
      id: string;
      name: string;
      strong: boolean;
      flag: string | null;
      th_matched_company: string;
    }
    const sameBaseCands: Cand[] = [];
    const anywhereCands: Cand[] = [];

    for (const [id, ths] of thByInst.entries()) {
      if (id === r.instructorDbId) continue;
      const matched = Array.from(ths).find((c) => companyMatches(c, recCompany));
      if (!matched) continue;
      const inst = instById.get(id);
      if (!inst) continue;
      if (inst.flag && inst.flag.startsWith("merged_into:")) continue;
      const cand: Cand = {
        id,
        name: inst.name,
        strong: !!(inst.contactEmail || inst.contactPhone),
        flag: inst.flag,
        th_matched_company: matched,
      };
      anywhereCands.push(cand);
      if (sameBaseIds.includes(id)) sameBaseCands.push(cand);
    }

    let autoSafe: { id: string; name: string } | undefined;
    // 우선순위: same base + strong + 정확히 1명
    const sameBaseStrong = sameBaseCands.filter((c) => c.strong);
    if (sameBaseStrong.length === 1) {
      autoSafe = { id: sameBaseStrong[0].id, name: sameBaseStrong[0].name };
    } else if (sameBaseStrong.length === 0) {
      // base 그룹 자체에 strong 없으면 anywhere strong 단일도 검토
      const anyStrong = anywhereCands.filter((c) => c.strong);
      // 동명이인 같은 base name 케이스가 아니므로 auto_safe로는 안 잡음
      // (다른 이름 강사로 redirect는 위험 — 매우 보수)
      void anyStrong;
    }

    mismatches.push({
      recordId: r.id,
      currentInstructorId: r.instructorDbId,
      currentInstructorName: r.instructor.name,
      recordCompany: r.companyName,
      course: r.courseName ? r.courseName.slice(0, 80) : null,
      score: Number(r.score),
      n: r.respondentCount,
      date: r.responseDate?.toISOString().slice(0, 10) ?? null,
      sourceType: r.sourceType,
      currentTHHas: false,
      candidates_same_base: sameBaseCands,
      candidates_anywhere: anywhereCands,
      auto_safe_target: autoSafe,
    });
  }

  const byInst = new Map<string, number>();
  for (const m of mismatches) {
    byInst.set(m.currentInstructorName, (byInst.get(m.currentInstructorName) ?? 0) + 1);
  }
  const autoSafeCount = mismatches.filter((m) => m.auto_safe_target).length;

  return NextResponse.json({
    ok: true,
    durationMs: Date.now() - startedAt,
    total_records: records.length,
    mismatched: mismatches.length,
    auto_safe_count: autoSafeCount,
    by_current_instructor: Array.from(byInst.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20),
    samples_auto_safe: mismatches.filter((m) => m.auto_safe_target).slice(0, 30),
    samples_manual: mismatches.filter((m) => !m.auto_safe_target).slice(0, 20),
  });
}
