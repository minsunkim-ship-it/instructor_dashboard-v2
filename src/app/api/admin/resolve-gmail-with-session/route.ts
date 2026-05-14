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
    const refs = Array.isArray(reg.sourceRefs) ? (reg.sourceRefs as RawRecord[]) : [];
    const firstRef = refs[0] as RawRecord | undefined;
    const responseDateStr = pickString(firstRef, "response_date");
    const responseDate = responseDateStr ? new Date(responseDateStr) : null;

    // ImportItem 정보
    const item = itemByRegKey.get(reg.registryKey);
    const subject = item ? pickString(item.rawPayload, "subject") : null;
    const sessionLabel = item ? pickString(item.normalizedPayload, "session_label") : null;
    const body = item ? pickString(item.rawPayload, "body_excerpt") : null;

    // 신호 1: subject 강사명
    const subjectInstructorMatch = subject?.match(SUBJECT_INSTRUCTOR_REGEX);
    const subjectInstructor = subjectInstructorMatch ? subjectInstructorMatch[1] : null;

    // 신호: subject 회사명 (best-effort)
    const subjectCompanyMatch = subject?.match(SUBJECT_COMPANY_REGEX);
    const subjectCompany = subjectCompanyMatch ? subjectCompanyMatch[1].trim() : null;

    // 신호: session number — sessionLabel 또는 body에서 추출
    const sessionNumber =
      extractSessionNumber(sessionLabel) ?? extractSessionNumber(body) ?? extractSessionNumber(reg.courseName);

    const effectiveCompany = reg.companyName ?? subjectCompany;

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

    // 운영보고 ±7일 매칭
    const opsMatched = opsMessages.filter((m) => {
      if (!companyMatches(m.company, effectiveCompany)) return false;
      const diff = Math.abs(m.activityAt.getTime() - responseDate.getTime()) / (1000 * 60 * 60 * 24);
      return diff <= WINDOW_DAYS;
    });

    if (opsMatched.length === 0) {
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
