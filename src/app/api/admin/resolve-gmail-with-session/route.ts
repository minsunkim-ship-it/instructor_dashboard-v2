/**
 * GET /api/admin/resolve-gmail-with-session
 *
 * Phase γ-A1-v3 — Gmail satisfaction 다중 신호 자동 분배.
 *
 * 입력: SatisfactionReviewRegistry(matchStatus=pending, sourceType="gmail_summary").
 *
 * 신호 우선순위 (가장 강한 것부터):
 *   1. subject 강사명 (`{이름} 강사님께`) — 단일 명시
 *   2. ImportItem.normalizedPayload.session_label + 운영보고 차수 매칭
 *   3. body_excerpt 차수 regex + 운영보고 차수 매칭
 *   4. sent_at + 회사 alias + 운영보고 ±7일 단일 강사
 *
 * 회사 신호:
 *   - subject 파싱 (parseCompanyHintFromSubject regex 인라인)
 *   - candidateCompanyName fallback
 *
 * 모드:
 *   ?mode=dry_run / ?mode=apply
 *
 * 인증: CRON_SECRET
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";
import { refreshSatisfactionAggregates } from "@/lib/pipeline/satisfaction-applier";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

function authorize(request: NextRequest): boolean {
  const headerSecret = request.headers.get(CRON_SECRET_HEADER);
  if (isValidCronSecret(headerSecret)) return true;
  const querySecret = request.nextUrl.searchParams.get("secret");
  if (isValidCronSecret(querySecret)) return true;
  return false;
}

const OPS_REPORT_CHANNEL_ID = "C015YD84VGS";
const WINDOW_DAYS = 7;
const INSTRUCTOR_REGEX = /([가-힣]{2,4}[A-Z]?)\s*(?:강사|대표|교수|선생)님/g;
const SUBJECT_INSTRUCTOR_REGEX = /([가-힣]{2,4}[A-Z]?)\s*(?:강사|대표|교수|선생)님께/;
const COMPANY_REGEX = /\(B2B\)\s*([^_\n]+?)[\s_]/;
const SUBJECT_COMPANY_REGEX = /[-_]\s*([가-힣A-Za-z0-9()][^_\-\n]{1,30}?)[_\s]/;
const SESSION_REGEX = /(\d+)\s*(?:회차|차수|일차)/;

type RawRecord = { [key: string]: unknown };

function pickString(obj: RawRecord | undefined, ...keys: string[]): string | null {
  if (!obj) return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return null;
}

function normalizeCompany(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[\s()[\]{}.,:;'"`~!?+\-_/\\|]+/g, "");
}

function companyMatches(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const na = normalizeCompany(a);
  const nb = normalizeCompany(b);
  if (na.length < 2 || nb.length < 2) return false;
  return na.includes(nb) || nb.includes(na);
}

function extractSessionNumber(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = text.match(SESSION_REGEX);
  return m ? parseInt(m[1], 10) : null;
}

interface ParsedOpsMessage {
  activityAt: Date;
  company: string | null;
  instructors: string[];
  sessionNumber: number | null;
  text: string;
}

export async function GET(request: NextRequest) {
  if (!authorize(request)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const mode = request.nextUrl.searchParams.get("mode") ?? "dry_run";
  if (mode !== "dry_run" && mode !== "apply") {
    return NextResponse.json({ ok: false, error: "invalid mode" }, { status: 400 });
  }

  const startedAt = Date.now();

  // 1) 운영보고 메시지 parse
  const slackItems = await prisma.activityImportItem.findMany({
    where: { sourceType: "slack" },
    select: { rawPayload: true, sourceRef: true, activityAt: true },
    take: 5000,
    orderBy: { activityAt: "desc" },
  });
  const opsMessages: ParsedOpsMessage[] = [];
  for (const it of slackItems) {
    const raw = (it.rawPayload as RawRecord | null) ?? {};
    const ref = (it.sourceRef as RawRecord | null) ?? {};
    const cid = pickString(raw, "channel_id", "channel") ?? pickString(ref, "channel_id", "channel");
    if (cid !== OPS_REPORT_CHANNEL_ID) continue;
    const text = pickString(raw, "text", "message", "body") ?? "";
    if (!text) continue;
    const companyMatch = text.match(COMPANY_REGEX);
    const instructors = Array.from(text.matchAll(INSTRUCTOR_REGEX)).map((m) => m[1]);
    const sessionMatch = text.match(SESSION_REGEX);
    if (!companyMatch || instructors.length === 0 || !it.activityAt) continue;
    opsMessages.push({
      activityAt: it.activityAt,
      company: companyMatch[1].trim(),
      instructors: Array.from(new Set(instructors)),
      sessionNumber: sessionMatch ? parseInt(sessionMatch[1], 10) : null,
      text: text.slice(0, 200),
    });
  }

  // 2) Pending gmail registries
  const pending = await prisma.satisfactionReviewRegistry.findMany({
    where: { matchStatus: "pending", sourceType: "gmail_summary" },
    select: {
      id: true,
      registryKey: true,
      sourceType: true,
      candidateName: true,
      companyName: true,
      courseName: true,
      avgScore: true,
      responseCount: true,
      sourceRefs: true,
    },
  });

  // 3) ImportItem join — registryKey 기준
  const regKeys = pending.map((r) => r.registryKey);
  const importItems = await prisma.satisfactionImportItem.findMany({
    where: {
      sourceType: "gmail_summary",
    },
    select: {
      rawPayload: true,
      normalizedPayload: true,
      sourceRef: true,
    },
    take: 5000,
  });
  const itemByRegKey = new Map<
    string,
    {
      rawPayload: RawRecord;
      normalizedPayload: RawRecord;
      sourceRef: RawRecord;
    }
  >();
  for (const it of importItems) {
    const np = (it.normalizedPayload as RawRecord | null) ?? {};
    const rk = pickString(np, "registry_key");
    if (rk && regKeys.includes(rk)) {
      itemByRegKey.set(rk, {
        rawPayload: (it.rawPayload as RawRecord | null) ?? {},
        normalizedPayload: np,
        sourceRef: (it.sourceRef as RawRecord | null) ?? {},
      });
    }
  }

  // 4) Instructor lookup
  const allInstructors = await prisma.instructor.findMany({
    select: { id: true, name: true },
  });
  const instructorByName = new Map(allInstructors.map((i) => [i.name, i]));
  const instructorById = new Map(allInstructors.map((i) => [i.id, i]));

  // γ-A1-v6: TeachingHistory fallback
  const allTHs = await prisma.teachingHistory.findMany({
    select: {
      instructorDbId: true,
      companyName: true,
      startDate: true,
      endDate: true,
    },
  });

  // γ-A1-v4 D: 알려진 회사명 set (TeachingHistory.companyName distinct)
  // gmail subject/body의 비정형 companyName을 진짜 회사명으로 재추출하는 anchor
  const thCompaniesRaw = await prisma.teachingHistory.findMany({
    select: { companyName: true },
    distinct: ["companyName"],
  });
  const knownCompanies = thCompaniesRaw
    .map((t) => t.companyName)
    .filter((c): c is string => c !== null && c.length >= 2)
    .sort((a, b) => b.length - a.length); // 긴 회사명 우선

  function findKnownCompanyInText(text: string | null | undefined): string | null {
    if (!text) return null;
    for (const c of knownCompanies) {
      if (text.includes(c)) return c;
    }
    return null;
  }

  // 5) 분류
  interface Classification {
    registryKey: string;
    company: string | null;
    course: string | null;
    candidate: string | null;
    response_count: number;
    response_date: string | null;
    subject_instructor: string | null;
    subject_company: string | null;
    session_label: string | null;
    session_number: number | null;
    status:
      | "strong_by_subject_instructor"
      | "strong_by_session_match"
      | "strong_by_date_only"
      | "multi_instructors"
      | "no_signal"
      | "no_response_date";
    matched_instructors: string[];
    matched_instructor_id?: string | null;
    matched_instructor_name?: string | null;
    evidence_count?: number;
  }
  const classifications: Classification[] = [];

  for (const reg of pending) {
    // G2 (general safety rule): respondentCount=1 + companyName=null 은
    // evidence가 약해 자동 매칭 위험. β-1 D3 같은 정직화 결과를 손상시킬 수 있어
    // 모든 신호를 무시하고 pending_review 유지.
    if (reg.responseCount <= 1 && !reg.companyName) {
      const refs = Array.isArray(reg.sourceRefs) ? (reg.sourceRefs as RawRecord[]) : [];
      const firstRef = refs[0] as RawRecord | undefined;
      classifications.push({
        registryKey: reg.registryKey,
        company: reg.companyName,
        course: reg.courseName,
        candidate: reg.candidateName,
        response_count: reg.responseCount,
        response_date: pickString(firstRef, "response_date"),
        subject_instructor: null,
        subject_company: null,
        session_label: null,
        session_number: null,
        status: "no_signal",
        matched_instructors: [],
      });
      continue;
    }

    const refs = Array.isArray(reg.sourceRefs) ? (reg.sourceRefs as RawRecord[]) : [];
    const firstRef = refs[0] as RawRecord | undefined;
    const responseDateStr = pickString(firstRef, "response_date");
    const responseDate = responseDateStr ? new Date(responseDateStr) : null;

    // ImportItem 정보
    const item = itemByRegKey.get(reg.registryKey);
    const subject = item ? pickString(item.rawPayload, "subject") : null;
    const sessionLabel = item ? pickString(item.normalizedPayload, "session_label") : null;
    const body = item ? pickString(item.rawPayload, "body_excerpt") : null;

    // γ-A1-v4 D: companyName이 비정형(긴 문장)이면 body에서 알려진 TeachingHistory 회사명 재추출
    // 예: registry.companyName = "금일 말씀주신 원데이 AI 실습 과정"
    //     body = "...KB국민은행..." → 진짜 회사 = KB국민은행
    function looksUnparsedCompany(c: string | null | undefined): boolean {
      if (!c) return true;
      // 한국어 어구·문장 (말씀 / 금일 / 했던 등) 포함 또는 너무 김 → 정상 회사명 아님
      return c.length > 20 || /(말씀|금일|어제|진행|관련|드린|좋은|확인)/.test(c);
    }

    // 신호 1: subject 강사명
    const subjectInstructorMatch = subject?.match(SUBJECT_INSTRUCTOR_REGEX);
    const subjectInstructor = subjectInstructorMatch ? subjectInstructorMatch[1] : null;

    // γ-A1-v5: body 강사명 직접 추출 (body에 "정백 강사" 같이 명시된 케이스)
    // subject가 "강호신 대리님께" 같이 강사 아닌 수신인이면 body가 진짜 정보원
    let bodyInstructor: string | null = null;
    if (body) {
      // {이름}\s?(강사|대표|교수|선생) — 강사님께 패턴이 아니어도 OK
      const bodyMatches = Array.from(body.matchAll(INSTRUCTOR_REGEX));
      // 추가: "강사:" 또는 ": 강사" 패턴도 매칭 ("A반: 정백 강사")
      const altRegex = /([가-힣]{2,4}[A-Z]?)\s*(?:강사|대표|교수|선생)(?:\s|$|[\s.,:;])/g;
      const altMatches = Array.from(body.matchAll(altRegex));
      const allCandidates = [...bodyMatches, ...altMatches].map((m) => m[1]);
      // 가장 자주 등장한 강사 이름 (Instructor 정확 일치하는 것 중)
      const counts = new Map<string, number>();
      for (const c of allCandidates) {
        if (instructorByName.has(c)) {
          counts.set(c, (counts.get(c) ?? 0) + 1);
        }
      }
      // 단일 후보가 있으면 그것. 동률이면 첫 매칭.
      let best: { name: string; count: number } | null = null;
      for (const [name, count] of counts) {
        if (!best || count > best.count) best = { name, count };
      }
      bodyInstructor = best?.name ?? null;
    }

    // 신호: subject 회사명 (best-effort)
    const subjectCompanyMatch = subject?.match(SUBJECT_COMPANY_REGEX);
    const subjectCompany = subjectCompanyMatch ? subjectCompanyMatch[1].trim() : null;

    // 신호: session number — sessionLabel 또는 body에서 추출
    const sessionNumber =
      extractSessionNumber(sessionLabel) ?? extractSessionNumber(body) ?? extractSessionNumber(reg.courseName);

    // γ-A1-v4 D: companyName이 비정형이면 subject/body에서 known company 재추출
    let effectiveCompany = reg.companyName ?? subjectCompany;
    if (looksUnparsedCompany(effectiveCompany)) {
      const fromBody = findKnownCompanyInText(body);
      const fromSubject = findKnownCompanyInText(subject);
      effectiveCompany = fromBody ?? fromSubject ?? subjectCompany ?? effectiveCompany;
    }

    if (!responseDate) {
      classifications.push({
        registryKey: reg.registryKey,
        company: effectiveCompany,
        course: reg.courseName,
        candidate: reg.candidateName,
        response_count: reg.responseCount,
        response_date: null,
        subject_instructor: subjectInstructor,
        subject_company: subjectCompany,
        session_label: sessionLabel,
        session_number: sessionNumber,
        status: "no_response_date",
        matched_instructors: [],
      });
      continue;
    }

    // ★ 신호 1: subject 강사명이 instructor 정확 일치 → 즉시 확정
    if (subjectInstructor) {
      const inst = instructorByName.get(subjectInstructor);
      if (inst) {
        classifications.push({
          registryKey: reg.registryKey,
          company: effectiveCompany,
          course: reg.courseName,
          candidate: reg.candidateName,
          response_count: reg.responseCount,
          response_date: responseDateStr,
          subject_instructor: subjectInstructor,
          subject_company: subjectCompany,
          session_label: sessionLabel,
          session_number: sessionNumber,
          status: "strong_by_subject_instructor",
          matched_instructors: [subjectInstructor],
          matched_instructor_id: inst.id,
          matched_instructor_name: inst.name,
        });
        continue;
      }
    }

    // ★ 신호 1b: body 강사명 (subject parser 실패 시) — γ-A1-v5
    if (bodyInstructor) {
      const inst = instructorByName.get(bodyInstructor);
      if (inst) {
        classifications.push({
          registryKey: reg.registryKey,
          company: effectiveCompany,
          course: reg.courseName,
          candidate: reg.candidateName,
          response_count: reg.responseCount,
          response_date: responseDateStr,
          subject_instructor: subjectInstructor,
          subject_company: subjectCompany,
          session_label: sessionLabel,
          session_number: sessionNumber,
          status: "strong_by_subject_instructor", // body도 같은 status 카테고리 (운영자 검수 동등 안전)
          matched_instructors: [bodyInstructor],
          matched_instructor_id: inst.id,
          matched_instructor_name: inst.name,
        });
        continue;
      }
    }

    // 운영보고 ±7일 매칭
    const opsMatched = opsMessages.filter((m) => {
      if (!companyMatches(m.company, effectiveCompany)) return false;
      const diff = Math.abs(m.activityAt.getTime() - responseDate.getTime()) / (1000 * 60 * 60 * 24);
      return diff <= WINDOW_DAYS;
    });

    if (opsMatched.length === 0) {
      // γ-A1-v6: TeachingHistory fallback (effectiveCompany 사용)
      if (effectiveCompany) {
        const thMatched = allTHs.filter((t) => {
          if (!companyMatches(t.companyName, effectiveCompany)) return false;
          const start = t.startDate?.getTime() ?? null;
          const end = t.endDate?.getTime() ?? null;
          const respMs = responseDate.getTime();
          if (start !== null && end !== null) {
            return respMs >= start - 14 * 24 * 60 * 60 * 1000 && respMs <= end + 14 * 24 * 60 * 60 * 1000;
          }
          if (start !== null) {
            return Math.abs(respMs - start) <= 30 * 24 * 60 * 60 * 1000;
          }
          return false;
        });
        const thInstructorIds = Array.from(new Set(thMatched.map((t) => t.instructorDbId)));
        if (thInstructorIds.length === 1) {
          const inst = instructorById.get(thInstructorIds[0]);
          if (inst) {
            classifications.push({
              registryKey: reg.registryKey,
              company: effectiveCompany,
              course: reg.courseName,
              candidate: reg.candidateName,
              response_count: reg.responseCount,
              response_date: responseDateStr,
              subject_instructor: subjectInstructor,
              subject_company: subjectCompany,
              session_label: sessionLabel,
              session_number: sessionNumber,
              status: "strong_by_date_only", // TH 직접 매칭도 같은 분류 (운영자 검수 동등)
              matched_instructors: [inst.name],
              matched_instructor_id: inst.id,
              matched_instructor_name: inst.name,
              evidence_count: thMatched.length,
            });
            continue;
          }
        }
      }
      classifications.push({
        registryKey: reg.registryKey,
        company: effectiveCompany,
        course: reg.courseName,
        candidate: reg.candidateName,
        response_count: reg.responseCount,
        response_date: responseDateStr,
        subject_instructor: subjectInstructor,
        subject_company: subjectCompany,
        session_label: sessionLabel,
        session_number: sessionNumber,
        status: "no_signal",
        matched_instructors: [],
      });
      continue;
    }

    // 신호 2: session 일치 필터
    let filtered = opsMatched;
    let usedSession = false;
    if (sessionNumber !== null) {
      const sessionFiltered = opsMatched.filter((m) => m.sessionNumber === sessionNumber);
      if (sessionFiltered.length > 0) {
        filtered = sessionFiltered;
        usedSession = true;
      }
    }

    const uniqueInstructors = Array.from(new Set(filtered.flatMap((m) => m.instructors)));

    if (uniqueInstructors.length === 1) {
      const instName = uniqueInstructors[0];
      const inst = instructorByName.get(instName);
      classifications.push({
        registryKey: reg.registryKey,
        company: effectiveCompany,
        course: reg.courseName,
        candidate: reg.candidateName,
        response_count: reg.responseCount,
        response_date: responseDateStr,
        subject_instructor: subjectInstructor,
        subject_company: subjectCompany,
        session_label: sessionLabel,
        session_number: sessionNumber,
        status: usedSession ? "strong_by_session_match" : "strong_by_date_only",
        matched_instructors: uniqueInstructors,
        matched_instructor_id: inst?.id ?? null,
        matched_instructor_name: inst?.name ?? null,
        evidence_count: filtered.length,
      });
    } else {
      classifications.push({
        registryKey: reg.registryKey,
        company: effectiveCompany,
        course: reg.courseName,
        candidate: reg.candidateName,
        response_count: reg.responseCount,
        response_date: responseDateStr,
        subject_instructor: subjectInstructor,
        subject_company: subjectCompany,
        session_label: sessionLabel,
        session_number: sessionNumber,
        status: "multi_instructors",
        matched_instructors: uniqueInstructors,
        evidence_count: filtered.length,
      });
    }
  }

  const stats = classifications.reduce(
    (acc, c) => {
      acc[c.status] = (acc[c.status] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  let appliedSummary:
    | {
        registries_resolved: number;
        records_upserted: number;
        affected_instructors: number;
        instructor_avg_after: Array<{ name: string; satisfactionAvg: number | null; satisfactionCount: number }>;
      }
    | null = null;
  if (mode === "apply") {
    const strongs = classifications.filter(
      (c) =>
        (c.status === "strong_by_subject_instructor" ||
          c.status === "strong_by_session_match" ||
          c.status === "strong_by_date_only") &&
        c.matched_instructor_id
    );
    const regKeySet = new Set(strongs.map((s) => s.registryKey));
    const fullRegs = await prisma.satisfactionReviewRegistry.findMany({
      where: { registryKey: { in: Array.from(regKeySet) } },
    });
    const fullRegByKey = new Map(fullRegs.map((r) => [r.registryKey, r]));
    const affectedInstructorIds = new Set<string>();
    let registriesResolved = 0;
    let recordsUpserted = 0;
    for (const s of strongs) {
      const reg = fullRegByKey.get(s.registryKey);
      if (!reg || reg.avgScore === null) continue;
      const refs = Array.isArray(reg.sourceRefs) ? (reg.sourceRefs as RawRecord[]) : [];
      const firstRef = refs[0] as RawRecord | undefined;
      const responseDateStr = pickString(firstRef, "response_date");
      if (!responseDateStr) continue;
      const responseDate = new Date(responseDateStr);
      if (Number.isNaN(responseDate.getTime())) continue;

      const basis =
        s.status === "strong_by_subject_instructor"
          ? "gmail_subject_instructor"
          : s.status === "strong_by_session_match"
            ? "gmail_session_ops_match"
            : "gmail_date_ops_match_narrow_window";

      await prisma.satisfactionReviewRegistry.update({
        where: { id: reg.id },
        data: {
          matchStatus: "approved_by_slack_ops_report",
          resolvedInstructorId: s.matched_instructor_id!,
          suggestedInstructorId: s.matched_instructor_id!,
          resolutionBasis: basis,
        },
      });
      registriesResolved += 1;
      const existing = await prisma.satisfactionRecord.findFirst({
        where: {
          instructorDbId: s.matched_instructor_id!,
          sourceRef: { path: ["registry_key"], equals: reg.registryKey },
        },
      });
      const recordData = {
        instructorDbId: s.matched_instructor_id!,
        score: reg.avgScore,
        companyName: reg.companyName,
        courseName: reg.courseName,
        responseDate,
        respondentCount: reg.responseCount,
        sourceType: reg.sourceType,
        sourceRef: {
          source_refs: refs,
          registry_key: reg.registryKey,
          auto_resolver: "slack_ops_report_gmail_v3",
        } as unknown as Prisma.InputJsonObject,
      };
      if (existing) {
        await prisma.satisfactionRecord.update({ where: { id: existing.id }, data: recordData });
      } else {
        await prisma.satisfactionRecord.create({ data: recordData });
      }
      recordsUpserted += 1;
      affectedInstructorIds.add(s.matched_instructor_id!);
    }
    if (affectedInstructorIds.size > 0) {
      await refreshSatisfactionAggregates(Array.from(affectedInstructorIds));
    }
    const refreshed = await prisma.instructor.findMany({
      where: { id: { in: Array.from(affectedInstructorIds) } },
      select: { id: true, name: true, satisfactionAvg: true, satisfactionCount: true },
    });
    appliedSummary = {
      registries_resolved: registriesResolved,
      records_upserted: recordsUpserted,
      affected_instructors: affectedInstructorIds.size,
      instructor_avg_after: refreshed.map((i) => ({
        name: i.name,
        satisfactionAvg: i.satisfactionAvg !== null ? Number(i.satisfactionAvg) : null,
        satisfactionCount: i.satisfactionCount,
      })),
    };
  }

  return NextResponse.json({
    ok: true,
    mode,
    durationMs: Date.now() - startedAt,
    total_pending_gmail: pending.length,
    ops_messages_parsed: opsMessages.length,
    classification_stats: stats,
    applied_summary: appliedSummary,
    samples: {
      strong_by_subject: classifications.filter((c) => c.status === "strong_by_subject_instructor").slice(0, 6),
      strong_by_session: classifications.filter((c) => c.status === "strong_by_session_match").slice(0, 5),
      strong_by_date: classifications.filter((c) => c.status === "strong_by_date_only").slice(0, 5),
      multi_instructors: classifications.filter((c) => c.status === "multi_instructors").slice(0, 5),
      no_signal: classifications.filter((c) => c.status === "no_signal").slice(0, 3),
    },
  });
}
