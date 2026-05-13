/**
 * GET /api/admin/probe-alias-candidates
 *
 * Phase γ-C1 Step 0 — Alias auto-resolver 데이터 진단 (read-only).
 *
 * 점검 항목:
 *  1. Instructor 자체 duplicate contact:
 *     - 동일 contactEmail 다른 name (별칭 또는 중복 등록 후보)
 *     - 동일 contactPhone 다른 name
 *  2. Instructor name 동명이인 그룹:
 *     - base name이 같지만 suffix(A/B/C) 다른 case (정민수 / 정민수A / 정민수B)
 *     - suffix 없는 동명이인 case
 *  3. ambiguous candidate name (Instructor multiple match):
 *     - SatisfactionImportItem.candidateName이 Instructor.name 정확 일치 다수
 *     - ActivityImportItem.candidateName 동일 패턴
 *  4. 각 동명이인 그룹의 데이터 분포:
 *     - SatisfactionRecord count
 *     - TeachingHistory count
 *     - contactEmail/Phone 채움 여부
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

// 동명이인 그룹: base name 추출 (suffix A/B/C/D 제거)
function getBaseName(name: string): string {
  return name.replace(/[A-Z]$/, "").trim();
}

export async function GET(request: NextRequest) {
  if (!authorize(request)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();

  // 1) 모든 instructor with TeachingHistory / SatisfactionRecord 카운트
  const instructors = await prisma.instructor.findMany({
    select: {
      id: true,
      name: true,
      contactEmail: true,
      contactPhone: true,
      satisfactionAvg: true,
      satisfactionCount: true,
      totalCourses: true,
      isPracticeCoach: true,
      isFulltime: true,
    },
  });

  // 강사별 TeachingHistory 회사 list (sample 5건)
  const allTHs = await prisma.teachingHistory.findMany({
    select: { instructorDbId: true, companyName: true, startDate: true },
  });
  const thByInst = new Map<string, Array<{ companyName: string | null; startDate: Date | null }>>();
  for (const t of allTHs) {
    const list = thByInst.get(t.instructorDbId) ?? [];
    list.push({ companyName: t.companyName, startDate: t.startDate });
    thByInst.set(t.instructorDbId, list);
  }

  // 2) duplicate contactEmail 그룹
  const byEmail = new Map<string, typeof instructors>();
  for (const inst of instructors) {
    if (!inst.contactEmail) continue;
    const key = inst.contactEmail.toLowerCase().trim();
    const arr = byEmail.get(key) ?? [];
    arr.push(inst);
    byEmail.set(key, arr);
  }
  const duplicateEmailGroups = Array.from(byEmail.entries())
    .filter(([, arr]) => arr.length > 1)
    .map(([email, arr]) => ({
      contactEmail: email,
      count: arr.length,
      instructors: arr.map((i) => ({
        id: i.id,
        name: i.name,
        contactPhone: i.contactPhone,
        satisfactionAvg: i.satisfactionAvg !== null ? Number(i.satisfactionAvg) : null,
        satisfactionCount: i.satisfactionCount,
        totalCourses: i.totalCourses,
        isFulltime: i.isFulltime,
        sample_companies: (thByInst.get(i.id) ?? [])
          .slice(0, 5)
          .map((t) => t.companyName)
          .filter(Boolean),
      })),
    }))
    .sort((a, b) => b.count - a.count);

  // 3) duplicate contactPhone 그룹
  const byPhone = new Map<string, typeof instructors>();
  for (const inst of instructors) {
    if (!inst.contactPhone) continue;
    const key = inst.contactPhone.replace(/\D/g, ""); // 숫자만 비교
    if (!key) continue;
    const arr = byPhone.get(key) ?? [];
    arr.push(inst);
    byPhone.set(key, arr);
  }
  const duplicatePhoneGroups = Array.from(byPhone.entries())
    .filter(([, arr]) => arr.length > 1)
    .map(([phone, arr]) => ({
      contactPhone: phone,
      count: arr.length,
      instructors: arr.map((i) => ({
        id: i.id,
        name: i.name,
        contactEmail: i.contactEmail,
        satisfactionCount: i.satisfactionCount,
        totalCourses: i.totalCourses,
      })),
    }))
    .sort((a, b) => b.count - a.count);

  // 4) base name 동명이인 그룹 (정민수 / 정민수A / 정민수B)
  const byBaseName = new Map<string, typeof instructors>();
  for (const inst of instructors) {
    const base = getBaseName(inst.name);
    if (base.length < 2) continue;
    const arr = byBaseName.get(base) ?? [];
    arr.push(inst);
    byBaseName.set(base, arr);
  }
  const homonymGroups = Array.from(byBaseName.entries())
    .filter(([, arr]) => arr.length > 1)
    .map(([base, arr]) => ({
      baseName: base,
      count: arr.length,
      instructors: arr.map((i) => ({
        name: i.name,
        contactEmail: i.contactEmail,
        contactPhone: i.contactPhone ? i.contactPhone.slice(-4) : null, // 끝 4자리만
        satisfactionAvg: i.satisfactionAvg !== null ? Number(i.satisfactionAvg) : null,
        satisfactionCount: i.satisfactionCount,
        totalCourses: i.totalCourses,
        isFulltime: i.isFulltime,
        isPracticeCoach: i.isPracticeCoach,
        sample_companies: (thByInst.get(i.id) ?? [])
          .slice(0, 5)
          .map((t) => t.companyName)
          .filter(Boolean),
      })),
    }))
    .sort((a, b) => b.count - a.count);

  // 5) SatisfactionImportItem.candidateName이 Instructor.name 정확 일치 다수인 경우
  const importItems = await prisma.satisfactionImportItem.findMany({
    where: { candidateName: { not: null } },
    select: { candidateName: true },
  });
  const instructorNameSet = new Map<string, number>();
  for (const inst of instructors) {
    instructorNameSet.set(inst.name, (instructorNameSet.get(inst.name) ?? 0) + 1);
  }
  // candidateName 별 발생 횟수
  const candidateNameCount = new Map<string, number>();
  for (const it of importItems) {
    if (!it.candidateName) continue;
    candidateNameCount.set(
      it.candidateName,
      (candidateNameCount.get(it.candidateName) ?? 0) + 1
    );
  }

  // ambiguous = candidateName이 Instructor 다수 매칭
  const ambiguousCandidates: Array<{
    candidateName: string;
    import_item_count: number;
    instructor_matches: number;
    matched_instructor_names: string[];
  }> = [];
  for (const [candName, count] of candidateNameCount.entries()) {
    // base 일치 강사들 (동명이인 그룹)
    const base = getBaseName(candName);
    const matchingInstructors = instructors
      .filter((i) => i.name === candName || getBaseName(i.name) === base)
      .map((i) => i.name);
    if (matchingInstructors.length > 1) {
      ambiguousCandidates.push({
        candidateName: candName,
        import_item_count: count,
        instructor_matches: matchingInstructors.length,
        matched_instructor_names: matchingInstructors,
      });
    }
  }
  ambiguousCandidates.sort((a, b) => b.import_item_count - a.import_item_count);

  return NextResponse.json({
    ok: true,
    durationMs: Date.now() - startedAt,
    stats: {
      total_instructors: instructors.length,
      duplicate_email_groups: duplicateEmailGroups.length,
      duplicate_phone_groups: duplicatePhoneGroups.length,
      base_name_homonym_groups: homonymGroups.length,
      ambiguous_candidate_names: ambiguousCandidates.length,
    },
    duplicate_email_groups: duplicateEmailGroups.slice(0, 20),
    duplicate_phone_groups: duplicatePhoneGroups.slice(0, 20),
    homonym_groups: homonymGroups.slice(0, 25),
    ambiguous_candidates: ambiguousCandidates.slice(0, 20),
  });
}
