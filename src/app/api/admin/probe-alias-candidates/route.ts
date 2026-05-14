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

type RawRecord = { [key: string]: unknown };

function pickString(obj: RawRecord | undefined, ...keys: string[]): string | null {
  if (!obj) return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return null;
}

export async function GET(request: NextRequest) {
  if (!authorize(request)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const detail = request.nextUrl.searchParams.get("detail");

  // ---------------------------------------------------------------------------
  // detail=teaching_history_source — TeachingHistory.sourceRef structure dump
  // 계약시트에 "사업자" 정보 컬럼이 있는지 확인 (γ-C1 B step 입력)
  // ---------------------------------------------------------------------------
  if (detail === "teaching_history_source") {
    const sample = await prisma.teachingHistory.findMany({
      take: 5,
      select: {
        instructor: { select: { name: true } },
        companyName: true,
        courseName: true,
        startDate: true,
        sourceType: true,
        sourceRef: true,
      },
      orderBy: { startDate: "desc" },
    });
    return NextResponse.json({
      ok: true,
      mode: "teaching_history_source",
      samples: sample.map((t) => ({
        instructor: t.instructor.name,
        company: t.companyName,
        course: t.courseName,
        startDate: t.startDate?.toISOString().slice(0, 10) ?? null,
        sourceType: t.sourceType,
        sourceRef_keys: t.sourceRef && typeof t.sourceRef === "object" && !Array.isArray(t.sourceRef)
          ? Object.keys(t.sourceRef as Record<string, unknown>)
          : null,
        sourceRef: t.sourceRef,
      })),
    });
  }

  // ---------------------------------------------------------------------------
  // detail=session_in_pending — pending registry에 차수(session) 정보가 있는지 점검
  //   사용자 인사이트(2026-05-14): 만족도 시트의 차수 ↔ 운영보고 메시지의 차수 매칭으로
  //   다중 강사 자동 분배 가능 (KT AI Campus 5회차 = 김진태)
  // ---------------------------------------------------------------------------
  if (detail === "session_in_pending") {
    const pending = await prisma.satisfactionReviewRegistry.findMany({
      where: { matchStatus: "pending" },
      select: {
        registryKey: true,
        candidateName: true,
        companyName: true,
        courseName: true,
        responseCount: true,
        sourceRefs: true,
      },
    });
    let withSessionLabel = 0;
    let withSessionInRefs = 0;
    let withResponseDate = 0;
    const sessionSamples: Array<{
      key: string;
      candidate: string | null;
      company: string | null;
      course: string | null;
      session_label: string | null;
      session_in_first_ref: unknown;
      response_date: string | null;
    }> = [];
    for (const r of pending) {
      const refs = Array.isArray(r.sourceRefs) ? (r.sourceRefs as RawRecord[]) : [];
      const firstRef = refs[0] as RawRecord | undefined;
      const sourceRef = firstRef?.source_ref as RawRecord | undefined;
      const sessionLabel = pickString(sourceRef, "session_label");
      const sessionNumber =
        sourceRef && typeof sourceRef.session_number === "number"
          ? sourceRef.session_number
          : null;
      const responseDate = pickString(firstRef, "response_date");
      if (sessionLabel) withSessionLabel += 1;
      if (sessionLabel || sessionNumber !== null) withSessionInRefs += 1;
      if (responseDate) withResponseDate += 1;
      if (sessionSamples.length < 15 && (sessionLabel || sessionNumber !== null)) {
        sessionSamples.push({
          key: r.registryKey.slice(0, 70),
          candidate: r.candidateName,
          company: r.companyName,
          course: r.courseName,
          session_label: sessionLabel,
          session_in_first_ref: sessionNumber,
          response_date: responseDate,
        });
      }
    }
    return NextResponse.json({
      ok: true,
      mode: "session_in_pending",
      total_pending: pending.length,
      with_session_label: withSessionLabel,
      with_session_info_in_refs: withSessionInRefs,
      with_response_date: withResponseDate,
      samples: sessionSamples,
      // 매칭 못한 경우 sourceRefs 구조 자체 dump (구조 다른 곳에 session 있을 가능성)
      raw_sourcerefs_samples: pending.slice(0, 5).map((r) => ({
        registryKey: r.registryKey.slice(0, 70),
        candidateName: r.candidateName,
        companyName: r.companyName,
        sourceRefs: r.sourceRefs,
      })),
    });
  }

  // ---------------------------------------------------------------------------
  // detail=corp_name_in_records — candidateName이 affiliation 법인명과 매칭되는 record 검출
  //   "스코프랩스" 또는 "스코프랩스(김지훈)" 같은 candidateName이 SatisfactionImportItem 또는
  //   SatisfactionReviewRegistry에 실제로 있는지 + 매칭 가능 영역 측정
  // ---------------------------------------------------------------------------
  if (detail === "corp_name_in_records") {
    // affiliation 그룹 → 법인명 추출 ("스코프랩스(김지훈)" → "스코프랩스")
    const all = await prisma.instructor.findMany({
      select: { id: true, name: true, affiliation: true },
    });
    const corpNameToGroup = new Map<string, { affiliation: string; instructors: string[] }>();
    const affGroupMap = new Map<string, string[]>();
    for (const i of all) {
      if (!i.affiliation) continue;
      const arr = affGroupMap.get(i.affiliation) ?? [];
      arr.push(i.name);
      affGroupMap.set(i.affiliation, arr);
    }
    for (const [aff, names] of affGroupMap.entries()) {
      // "스코프랩스(김지훈)" → 법인명 부분만
      const corpName = aff.split("(")[0].trim();
      if (corpName.length < 2) continue;
      // 한 affiliation = 한 법인. 같은 corpName이 여러 affiliation에 나타나도 그룹화
      const existing = corpNameToGroup.get(corpName);
      if (existing) {
        existing.instructors.push(...names);
      } else {
        corpNameToGroup.set(corpName, { affiliation: aff, instructors: names });
      }
    }
    const corpNames = Array.from(corpNameToGroup.keys());

    // SatisfactionImportItem.candidateName 또는 candidateCompanyName에서 법인명 매칭
    const importItems = await prisma.satisfactionImportItem.findMany({
      where: {
        OR: [
          { candidateName: { not: null } },
          { candidateCompanyName: { not: null } },
        ],
      },
      select: {
        id: true,
        candidateName: true,
        candidateCompanyName: true,
        candidateCourseName: true,
        responseDate: true,
        sourceType: true,
      },
    });

    const matchedItems: Array<{
      corpName: string;
      itemCount: number;
      affiliation: string;
      group_instructors: string[];
      samples: Array<{
        candidateName: string | null;
        candidateCompanyName: string | null;
        candidateCourseName: string | null;
        responseDate: string | null;
        sourceType: string;
      }>;
    }> = [];
    for (const [corp, group] of corpNameToGroup.entries()) {
      const matches = importItems.filter((it) => {
        const fields = [it.candidateName, it.candidateCompanyName, it.candidateCourseName]
          .filter((v): v is string => Boolean(v));
        return fields.some((f) => f.includes(corp));
      });
      if (matches.length > 0) {
        matchedItems.push({
          corpName: corp,
          affiliation: group.affiliation,
          itemCount: matches.length,
          group_instructors: group.instructors,
          samples: matches.slice(0, 5).map((m) => ({
            candidateName: m.candidateName,
            candidateCompanyName: m.candidateCompanyName,
            candidateCourseName: m.candidateCourseName,
            responseDate: m.responseDate?.toISOString().slice(0, 10) ?? null,
            sourceType: m.sourceType,
          })),
        });
      }
    }
    matchedItems.sort((a, b) => b.itemCount - a.itemCount);

    return NextResponse.json({
      ok: true,
      mode: "corp_name_in_records",
      total_corp_names_in_affiliation: corpNames.length,
      corp_names: corpNames,
      matched_corp_name_in_records: matchedItems.length,
      matches: matchedItems,
    });
  }

  // ---------------------------------------------------------------------------
  // detail=affiliation_groups — Instructor.affiliation 컬럼 분포
  //   사용자 인사이트 후속: 법인은 name보다 affiliation 컬럼에 들어있을 가능성 (예: "알자(이태화)")
  //   같은 affiliation = 같은 사업자 소속 강사 list = γ-C1 B step source
  // ---------------------------------------------------------------------------
  if (detail === "affiliation_groups") {
    const all = await prisma.instructor.findMany({
      select: {
        id: true,
        name: true,
        affiliation: true,
        contactEmail: true,
        satisfactionCount: true,
        totalCourses: true,
      },
    });
    const byAff = new Map<string, typeof all>();
    let withAff = 0;
    for (const i of all) {
      if (!i.affiliation) continue;
      const key = i.affiliation.trim();
      if (!key) continue;
      withAff += 1;
      const arr = byAff.get(key) ?? [];
      arr.push(i);
      byAff.set(key, arr);
    }
    const groups = Array.from(byAff.entries())
      .filter(([, arr]) => arr.length >= 2) // 그룹 = 같은 affiliation 2명 이상
      .map(([aff, arr]) => ({
        affiliation: aff,
        count: arr.length,
        // 그룹 내 contactEmail 유니크 수 (1이면 모두 같은 이메일 = 사업자 대표)
        unique_emails: new Set(
          arr.map((i) => i.contactEmail).filter((v): v is string => Boolean(v))
        ).size,
        instructors: arr.map((i) => ({
          name: i.name,
          contactEmail: i.contactEmail,
          totalCourses: i.totalCourses,
          satisfactionCount: i.satisfactionCount,
        })),
      }))
      .sort((a, b) => b.count - a.count);

    return NextResponse.json({
      ok: true,
      mode: "affiliation_groups",
      total_instructors: all.length,
      with_affiliation: withAff,
      affiliation_rate: all.length > 0 ? `${((withAff / all.length) * 100).toFixed(2)}%` : "0%",
      total_groups: groups.length,
      top_groups: groups.slice(0, 25),
    });
  }

  // ---------------------------------------------------------------------------
  // detail=corporate_instructors — Instructor.name이 법인/사업자 추정인 행 검출
  //   사용자 인사이트(2026-05-14): "계약시트 강사명 컬럼에 사업자/법인이 들어가 있을 가능성"
  //   → 법인 instructor + 그 contactEmail 그룹 = 사업자 소속 강사 list = γ-C1 B step의 진짜 source
  // ---------------------------------------------------------------------------
  if (detail === "corporate_instructors") {
    const instructorsAll = await prisma.instructor.findMany({
      select: {
        id: true,
        name: true,
        contactEmail: true,
        satisfactionAvg: true,
        satisfactionCount: true,
        totalCourses: true,
        affiliation: true,
        isFulltime: true,
      },
    });

    // 법인/사업자 후보 검출 patterns
    function isCorporateName(name: string): { isCorp: boolean; reason: string } {
      // 패턴 1: 한글 외 문자(영문/숫자) 포함
      if (/[a-zA-Z0-9]/.test(name)) {
        return { isCorp: true, reason: "non_korean_char" };
      }
      // 패턴 2: 명백한 법인 suffix
      const corpSuffixes = ["랩스", "랩", "주식회사", "코퍼레이션", "미디어", "컨설팅", "스튜디오", "에듀", "솔루션", "테크"];
      for (const suf of corpSuffixes) {
        if (name.endsWith(suf)) return { isCorp: true, reason: `suffix:${suf}` };
      }
      // 패턴 3: 한글 5자 초과 (개인명은 보통 2-4자)
      if (name.length > 4 && /^[가-힣]+$/.test(name)) {
        return { isCorp: true, reason: "long_korean" };
      }
      return { isCorp: false, reason: "" };
    }

    const corpCandidates = instructorsAll
      .map((i) => ({
        inst: i,
        check: isCorporateName(i.name),
      }))
      .filter((x) => x.check.isCorp);

    // 각 corp의 contactEmail 그룹 (같은 이메일의 다른 instructor list)
    const emailToInstructors = new Map<string, string[]>();
    for (const i of instructorsAll) {
      if (!i.contactEmail) continue;
      const k = i.contactEmail.toLowerCase().trim();
      const arr = emailToInstructors.get(k) ?? [];
      arr.push(i.name);
      emailToInstructors.set(k, arr);
    }

    return NextResponse.json({
      ok: true,
      mode: "corporate_instructors",
      total_instructors: instructorsAll.length,
      total_corporate_candidates: corpCandidates.length,
      samples: corpCandidates.slice(0, 30).map((x) => {
        const emailGroup = x.inst.contactEmail
          ? emailToInstructors.get(x.inst.contactEmail.toLowerCase().trim()) ?? []
          : [];
        return {
          name: x.inst.name,
          contactEmail: x.inst.contactEmail,
          satisfactionAvg: x.inst.satisfactionAvg !== null ? Number(x.inst.satisfactionAvg) : null,
          satisfactionCount: x.inst.satisfactionCount,
          totalCourses: x.inst.totalCourses,
          affiliation: x.inst.affiliation,
          isFulltime: x.inst.isFulltime,
          detection_reason: x.check.reason,
          shared_email_with: emailGroup.filter((n) => n !== x.inst.name),
        };
      }),
    });
  }

  // ---------------------------------------------------------------------------
  // detail=homonym_disambig — 동명이인 그룹별 disambig 입력 풀 (γ-C1 핵심)
  // 각 강사의 (회사 set, 시점 range, 에이전시 그룹) + ambiguous candidates 매칭 가능성
  // ---------------------------------------------------------------------------
  if (detail === "homonym_disambig") {
    const instructors = await prisma.instructor.findMany({
      select: {
        id: true,
        name: true,
        contactEmail: true,
        contactPhone: true,
        satisfactionAvg: true,
        satisfactionCount: true,
        totalCourses: true,
        isFulltime: true,
      },
    });
    const allTHs = await prisma.teachingHistory.findMany({
      select: {
        instructorDbId: true,
        companyName: true,
        startDate: true,
        endDate: true,
      },
    });
    const thByInst = new Map<
      string,
      Array<{ companyName: string | null; startDate: Date | null; endDate: Date | null }>
    >();
    for (const t of allTHs) {
      const list = thByInst.get(t.instructorDbId) ?? [];
      list.push({
        companyName: t.companyName,
        startDate: t.startDate,
        endDate: t.endDate,
      });
      thByInst.set(t.instructorDbId, list);
    }
    // 에이전시 그룹 (contactEmail 다수 등록 그룹) 만들기
    const emailGroupMap = new Map<string, string[]>();
    for (const inst of instructors) {
      if (!inst.contactEmail) continue;
      const key = inst.contactEmail.toLowerCase().trim();
      const arr = emailGroupMap.get(key) ?? [];
      arr.push(inst.id);
      emailGroupMap.set(key, arr);
    }
    function agencyGroupFor(instId: string, instContactEmail: string | null): {
      email: string | null;
      size: number;
    } {
      if (!instContactEmail) return { email: null, size: 1 };
      const key = instContactEmail.toLowerCase().trim();
      const ids = emailGroupMap.get(key);
      return { email: key, size: ids?.length ?? 1 };
    }

    // homonym 그룹 빌드
    const byBaseName = new Map<string, typeof instructors>();
    for (const inst of instructors) {
      const base = getBaseName(inst.name);
      if (base.length < 2) continue;
      const arr = byBaseName.get(base) ?? [];
      arr.push(inst);
      byBaseName.set(base, arr);
    }
    const homonyms = Array.from(byBaseName.entries())
      .filter(([, arr]) => arr.length > 1)
      .map(([base, arr]) => ({
        baseName: base,
        instructors: arr.map((i) => {
          const ths = thByInst.get(i.id) ?? [];
          const companies = Array.from(
            new Set(ths.map((t) => t.companyName).filter((v): v is string => Boolean(v)))
          );
          const dates = ths
            .map((t) => t.startDate)
            .filter((d): d is Date => d !== null)
            .map((d) => d.toISOString().slice(0, 10))
            .sort();
          return {
            name: i.name,
            isFulltime: i.isFulltime,
            satisfactionCount: i.satisfactionCount,
            totalCourses: i.totalCourses,
            agency: agencyGroupFor(i.id, i.contactEmail),
            company_set: companies,
            teaching_count: ths.length,
            earliest_teaching: dates[0] ?? null,
            latest_teaching: dates[dates.length - 1] ?? null,
          };
        }),
      }));

    // ambiguous candidate 별로 disambig 가능성 측정
    const importItems = await prisma.satisfactionImportItem.findMany({
      where: { candidateName: { not: null } },
      select: {
        candidateName: true,
        candidateCompanyName: true,
        responseDate: true,
      },
    });
    const candidateMap = new Map<
      string,
      Array<{
        company: string | null;
        date: string | null;
      }>
    >();
    for (const it of importItems) {
      if (!it.candidateName) continue;
      const arr = candidateMap.get(it.candidateName) ?? [];
      arr.push({
        company: it.candidateCompanyName,
        date: it.responseDate?.toISOString().slice(0, 10) ?? null,
      });
      candidateMap.set(it.candidateName, arr);
    }

    // 각 ambiguous candidate에 대해 → 동명이인 그룹 후보들의 회사·시점 풀과 매칭 시도
    const ambiguousResolutions: Array<{
      candidateName: string;
      homonym_base: string;
      candidate_records: number;
      candidate_companies: string[];
      possible_instructors: Array<{
        instructor_name: string;
        company_overlap: string[];
        time_overlap: boolean;
        agency_size: number;
      }>;
      resolution: "single_instructor" | "multiple_possible" | "no_match";
    }> = [];
    for (const [candName, records] of candidateMap.entries()) {
      const base = getBaseName(candName);
      const group = byBaseName.get(base);
      if (!group || group.length < 2) continue; // 동명이인 그룹 아님 — skip
      const candCompanies = Array.from(
        new Set(records.map((r) => r.company).filter((v): v is string => Boolean(v)))
      );
      const candDates = records
        .map((r) => r.date)
        .filter((v): v is string => Boolean(v))
        .sort();
      const candEarliest = candDates[0] ?? null;
      const candLatest = candDates[candDates.length - 1] ?? null;

      const possibles = group.map((inst) => {
        const ths = thByInst.get(inst.id) ?? [];
        const instCompanies = Array.from(
          new Set(ths.map((t) => t.companyName).filter((v): v is string => Boolean(v)))
        );
        const companyOverlap = candCompanies.filter((c) =>
          instCompanies.some((ic) => ic.includes(c) || c.includes(ic))
        );
        // 시점 overlap: 강사의 강의 기간 안에 candidate 응답이 들어오는지
        const instDates = ths
          .map((t) => t.startDate?.toISOString().slice(0, 10))
          .filter((v): v is string => Boolean(v));
        const instEarliest = instDates.sort()[0] ?? null;
        const instLatest = instDates.sort()[instDates.length - 1] ?? null;
        const timeOverlap =
          candEarliest !== null &&
          candLatest !== null &&
          instEarliest !== null &&
          instLatest !== null &&
          candEarliest <= instLatest &&
          candLatest >= instEarliest;
        return {
          instructor_name: inst.name,
          company_overlap: companyOverlap,
          time_overlap: timeOverlap,
          agency_size: agencyGroupFor(inst.id, inst.contactEmail).size,
        };
      });
      const matched = possibles.filter((p) => p.company_overlap.length > 0 && p.time_overlap);
      ambiguousResolutions.push({
        candidateName: candName,
        homonym_base: base,
        candidate_records: records.length,
        candidate_companies: candCompanies,
        possible_instructors: possibles,
        resolution:
          matched.length === 1
            ? "single_instructor"
            : matched.length > 1
              ? "multiple_possible"
              : "no_match",
      });
    }

    return NextResponse.json({
      ok: true,
      mode: "homonym_disambig",
      homonym_groups: homonyms,
      ambiguous_resolutions: ambiguousResolutions,
      stats: {
        homonym_groups: homonyms.length,
        ambiguous_candidates: ambiguousResolutions.length,
        single_instructor_disambig: ambiguousResolutions.filter((r) => r.resolution === "single_instructor").length,
        multiple_possible: ambiguousResolutions.filter((r) => r.resolution === "multiple_possible").length,
        no_match: ambiguousResolutions.filter((r) => r.resolution === "no_match").length,
      },
    });
  }

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
