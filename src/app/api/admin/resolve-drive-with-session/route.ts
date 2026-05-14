/**
 * GET /api/admin/resolve-drive-with-session
 *
 * Phase γ-A1-v2 — Drive satisfaction + 차수/날짜 매칭 자동 분배.
 *
 * 입력: SatisfactionReviewRegistry(matchStatus=pending, sourceType=drive_satisfaction).
 *
 * γ-A1과 차이:
 *   - window ±7일 (drive 응답은 강의 직후 패턴) vs γ-A1 ±60일
 *   - course "N차수" 정보가 있으면 ops_report 메시지 "N회차" / 운영보고 sessionNumber 매칭
 *   - 회사 alias normalize 동일
 *
 * 모드:
 *   ?mode=dry_run (기본) — 분류 통계 + sample 반환
 *   ?mode=apply — strong_single만 registry resolved + SatisfactionRecord upsert
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
const WINDOW_DAYS = 14; // γ-A1-v4 B: 7→14 (운영보고 비동기 등록 케이스 대응)
const INSTRUCTOR_REGEX = /([가-힣]{2,4}[A-Z]?)\s*(?:강사|대표|교수|선생)님/g;
const COMPANY_REGEX = /\(B2B\)\s*([^_\n]+?)[\s_]/;
const SESSION_REGEX_OPS = /(\d+)\s*(?:회차|차수|일차)/;
const SESSION_REGEX_COURSE = /(\d+)\s*(?:회차|차수|일차)/;
const COURSE_STOPWORDS = new Set([
  "review",
  "raw",
  "data",
  "daily",
  "final",
  "만족도",
  "조사",
  "설문",
  "응답",
  "사본",
  "ai",
]);

// γ-A1-v4 A: course 핵심 토큰 추출 (registry.courseName 또는 file_name)
// 'DT기초프로그램 Review' → ['DT기초프로그램'], '생성형 AI와 Copilot을 활용한 업무 자동화' → ['생성형', 'Copilot', '활용한', '업무', '자동화']
function extractCourseTokens(text: string | null | undefined): string[] {
  if (!text) return [];
  return text
    .split(/[\s_\-(),.]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !COURSE_STOPWORDS.has(t.toLowerCase()))
    .slice(0, 8);
}

function courseTextMatches(opsText: string, registryCourse: string | null | undefined): boolean {
  if (!registryCourse) return false;
  const tokens = extractCourseTokens(registryCourse);
  if (tokens.length === 0) return false;
  // ops 메시지에 등록 course 토큰 ≥ 1개 포함
  for (const t of tokens) {
    if (opsText.includes(t)) return true;
  }
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
  const m = text.match(SESSION_REGEX_COURSE);
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
    const sessionMatch = text.match(SESSION_REGEX_OPS);
    if (!companyMatch || instructors.length === 0 || !it.activityAt) continue;
    opsMessages.push({
      activityAt: it.activityAt,
      company: companyMatch[1].trim(),
      instructors: Array.from(new Set(instructors)),
      sessionNumber: sessionMatch ? parseInt(sessionMatch[1], 10) : null,
      text: text.slice(0, 200),
    });
  }

  // 2) Pending drive_satisfaction registries 로드
  const pending = await prisma.satisfactionReviewRegistry.findMany({
    where: { matchStatus: "pending", sourceType: "drive_satisfaction" },
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

  // 3) ImportItem join — registry → ImportItem (sourceRefKey 또는 registry_key)
  //    registry.sourceRefs에서 source_ref_key 추출 후 ImportItem 찾기
  // → drive는 file_name, sheet_title, course 등 추가 신호 필요
  // 빠른 path: registry.candidateCourseName 또는 sourceRefs[0].source_ref에 file_name 등
  // 우선 registry 자체 정보만으로 시도

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
    course_session: number | null;
    status:
      | "strong_single_by_date"
      | "strong_single_by_session"
      | "multi_instructors"
      | "no_company"
      | "no_response_date"
      | "no_slack_match";
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
    // γ-A1-v4 C: session 정보를 courseName, sheet_title, file_name 순으로 추출
    const sheetTitle = pickString(firstRef, "sheet_title");
    const fileName = pickString(firstRef, "file_name");
    const courseSession =
      extractSessionNumber(reg.courseName) ??
      extractSessionNumber(sheetTitle) ??
      extractSessionNumber(fileName);

    if (!reg.companyName) {
      classifications.push({
        registryKey: reg.registryKey,
        company: null,
        course: reg.courseName,
        candidate: reg.candidateName,
        response_count: reg.responseCount,
        response_date: responseDateStr,
        course_session: courseSession,
        status: "no_company",
        matched_instructors: [],
      });
      continue;
    }
    if (!responseDate) {
      classifications.push({
        registryKey: reg.registryKey,
        company: reg.companyName,
        course: reg.courseName,
        candidate: reg.candidateName,
        response_count: reg.responseCount,
        response_date: null,
        course_session: courseSession,
        status: "no_response_date",
        matched_instructors: [],
      });
      continue;
    }

    // 시점 ±WINDOW_DAYS 내 운영보고 메시지 + 회사 alias 매칭
    const matched = opsMessages.filter((m) => {
      if (!companyMatches(m.company, reg.companyName)) return false;
      const diff = Math.abs(m.activityAt.getTime() - responseDate.getTime()) / (1000 * 60 * 60 * 24);
      return diff <= WINDOW_DAYS;
    });

    if (matched.length === 0) {
      classifications.push({
        registryKey: reg.registryKey,
        company: reg.companyName,
        course: reg.courseName,
        candidate: reg.candidateName,
        response_count: reg.responseCount,
        response_date: responseDateStr,
        course_session: courseSession,
        status: "no_slack_match",
        matched_instructors: [],
      });
      continue;
    }

    // γ-A1-v4 A: course substring 매칭 (registry.courseName 또는 fileName 토큰이 ops 메시지에 등장)
    let filteredByCourse = matched;
    const courseRef = reg.courseName ?? fileName;
    if (courseRef) {
      const courseFiltered = matched.filter((m) => courseTextMatches(m.text, courseRef));
      if (courseFiltered.length > 0) {
        filteredByCourse = courseFiltered;
      }
    }
    // 차수 매칭 (course substring 후에 추가 좁힘)
    if (courseSession !== null) {
      const sessionFiltered = filteredByCourse.filter((m) => m.sessionNumber === courseSession);
      if (sessionFiltered.length > 0) {
        filteredByCourse = sessionFiltered;
      }
    }

    const uniqueInstructors = Array.from(
      new Set(filteredByCourse.flatMap((m) => m.instructors))
    );

    if (uniqueInstructors.length === 1) {
      const instName = uniqueInstructors[0];
      const inst = instructorByName.get(instName);
      classifications.push({
        registryKey: reg.registryKey,
        company: reg.companyName,
        course: reg.courseName,
        candidate: reg.candidateName,
        response_count: reg.responseCount,
        response_date: responseDateStr,
        course_session: courseSession,
        status: courseSession !== null ? "strong_single_by_session" : "strong_single_by_date",
        matched_instructors: uniqueInstructors,
        matched_instructor_id: inst?.id ?? null,
        matched_instructor_name: inst?.name ?? null,
        evidence_count: filteredByCourse.length,
      });
    } else {
      classifications.push({
        registryKey: reg.registryKey,
        company: reg.companyName,
        course: reg.courseName,
        candidate: reg.candidateName,
        response_count: reg.responseCount,
        response_date: responseDateStr,
        course_session: courseSession,
        status: "multi_instructors",
        matched_instructors: uniqueInstructors,
        evidence_count: filteredByCourse.length,
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

  // apply mode
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
        (c.status === "strong_single_by_date" || c.status === "strong_single_by_session") &&
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

      await prisma.satisfactionReviewRegistry.update({
        where: { id: reg.id },
        data: {
          matchStatus: "approved_by_slack_ops_report",
          resolvedInstructorId: s.matched_instructor_id!,
          suggestedInstructorId: s.matched_instructor_id!,
          resolutionBasis:
            s.status === "strong_single_by_session"
              ? "slack_ops_report_date_session_match"
              : "slack_ops_report_date_match_narrow_window",
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
          auto_resolver: "slack_ops_report_drive_v2",
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
    total_pending: pending.length,
    ops_messages_parsed: opsMessages.length,
    classification_stats: stats,
    applied_summary: appliedSummary,
    samples: {
      strong_by_session: classifications.filter((c) => c.status === "strong_single_by_session").slice(0, 8),
      strong_by_date: classifications.filter((c) => c.status === "strong_single_by_date").slice(0, 8),
      multi_instructors: classifications.filter((c) => c.status === "multi_instructors").slice(0, 5),
      no_company: classifications.filter((c) => c.status === "no_company").slice(0, 3),
      no_slack_match: classifications.filter((c) => c.status === "no_slack_match").slice(0, 5),
    },
  });
}
