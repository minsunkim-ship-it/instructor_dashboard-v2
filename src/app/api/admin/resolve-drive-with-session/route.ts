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
import { getAllSatisfactionSheetSources } from "@/lib/pipeline/satisfaction-sheets-collector";

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
const GENERAL_CHANNEL_ID = "C79GDLS3A"; // γ-A1-v14: #general 메시지도 같은 패턴 ((B2B) 회사_과정_강사 강사님_N회차_총M명)
const ALLOWED_RESOLVER_CHANNEL_IDS = new Set<string>([
  OPS_REPORT_CHANNEL_ID,
  GENERAL_CHANNEL_ID,
]);
const WINDOW_DAYS = 14; // γ-A1-v5b: 30→14 rollback (30 너무 넓어 multi 증가. v4 안전 가치 회복)
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

function normalizeText(value: string): string {
  let v = value.toLowerCase().replace(/[\s()[\]{}.,:;'"`~!?+\-_/\\|]+/g, "");
  // γ-A1-v17: 모듈명/차수명 한영 통합. Module6 ↔ 모듈6, M6 ↔ 모듈6 등
  // 7개 한글 모듈명을 영문 form으로 통일
  for (const m of ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]) {
    v = v.split(`모듈${m}`).join(`module${m}`);
    v = v.split(`m${m}`).join(`module${m}`);
  }
  return v;
}

function courseTextMatches(opsText: string, registryCourse: string | null | undefined): boolean {
  if (!registryCourse) return false;
  const tokens = extractCourseTokens(registryCourse);
  if (tokens.length === 0) return false;
  // γ-A1-v5: normalize 후 substring — "DT기초프로그램" ↔ "DT 기초프로그램(1)" 같은 공백 차이 흡수
  const normalizedOps = normalizeText(opsText);
  for (const t of tokens) {
    const nt = normalizeText(t);
    if (nt.length >= 2 && normalizedOps.includes(nt)) return true;
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

  // G1 (general safety): catalog satisfactionLevel="course" 또는
  // instructorMappingMode="course_level"인 source_key는 자동 매칭 차단.
  // β-1 D3 fix를 모든 resolver에 일반 적용. dongkuk Basic 6/7차수 등 다중 강사
  // 책임 차수 source에서 어떤 신호로도 단일 강사 auto_accept 금지.
  const catalogSources = await getAllSatisfactionSheetSources();
  const courseLevelSourceKeys = new Set(
    catalogSources
      .filter(
        (s) =>
          s.satisfactionLevel === "course" ||
          s.instructorMappingMode === "course_level"
      )
      .map((s) => s.key)
  );

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
    if (!cid || !ALLOWED_RESOLVER_CHANNEL_IDS.has(cid)) continue;
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
  // γ-A1-v12 (Korean unicode fix): NFC + NFD 둘 다 키로 등록 — Slack ops 메시지의 강사명이
  // NFD로 들어오는 케이스가 있어 직접 비교 시 매칭 실패 ('민경주' 등)
  const instructorByName = new Map<string, { id: string; name: string }>();
  for (const i of allInstructors) {
    instructorByName.set(i.name, i);
    instructorByName.set(i.name.normalize("NFC"), i);
    instructorByName.set(i.name.normalize("NFD"), i);
  }
  const lookupInstructor = (n: string): { id: string; name: string } | undefined =>
    instructorByName.get(n) ??
    instructorByName.get(n.normalize("NFC")) ??
    instructorByName.get(n.normalize("NFD"));

  // γ-A1-v6: TeachingHistory 직접 매칭용 — 운영보고 매칭 0건 시 fallback
  const allTHs = await prisma.teachingHistory.findMany({
    select: {
      instructorDbId: true,
      companyName: true,
      courseName: true,
      startDate: true,
      endDate: true,
    },
  });
  const instructorById = new Map(allInstructors.map((i) => [i.id, i]));

  // γ-A1-v9 (general): 비정형 companyName 검출 + 알려진 회사명 재추출
  // 결함 사례: '롯데웰푸드_ 25년 AI·Data Ops...' (underscore overrun)
  //          '25/7/25' (날짜를 회사로 파싱) — file_name 첫 토큰이 날짜인 경우
  const thCompaniesRaw = await prisma.teachingHistory.findMany({
    select: { companyName: true },
    distinct: ["companyName"],
  });
  const knownCompanies = thCompaniesRaw
    .map((t) => t.companyName)
    .filter((c): c is string => c !== null && c.length >= 2)
    .sort((a, b) => b.length - a.length);

  function looksUnparsedCompany(c: string | null | undefined): boolean {
    if (!c) return true;
    if (c.length > 25) return true;
    // 날짜 패턴 (25/7/25, 2025-07-25 등)
    if (/^\d{1,4}[/.\-]\d{1,2}([/.\-]\d{1,2})?$/.test(c.trim())) return true;
    // underscore overrun (회사명에 _ 포함은 정상이지만 5개 이상 또는 한국어 어구는 비정형)
    if ((c.match(/_/g) ?? []).length >= 1 && c.length > 20) return true;
    return false;
  }
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

    // G1 guard — catalog course-level source는 자동 매칭 차단
    const innerRef = firstRef?.source_ref as RawRecord | undefined;
    const sourceKey = pickString(innerRef, "source_key") ?? pickString(firstRef, "source_key");
    if (sourceKey && courseLevelSourceKeys.has(sourceKey)) {
      classifications.push({
        registryKey: reg.registryKey,
        company: reg.companyName,
        course: reg.courseName,
        candidate: reg.candidateName,
        response_count: reg.responseCount,
        response_date: pickString(firstRef, "response_date"),
        course_session: null,
        status: "no_company", // catalog course-level은 강사별 매칭 자체 금지 — 운영자 분배 결정 영역
        matched_instructors: [],
      });
      continue;
    }

    // γ-A1-v4 C: session 정보를 courseName, sheet_title, file_name 순으로 추출
    const sheetTitle = pickString(firstRef, "sheet_title");
    const fileName = pickString(firstRef, "file_name");
    // γ-A1-v14: response_date null이면 created_time fallback (drive 파일 생성 시점 = 강의 시작 직후 추정)
    const innerForDate = firstRef && (firstRef as RawRecord).source_ref as RawRecord | undefined;
    let responseDateStr =
      pickString(firstRef, "response_date") ??
      pickString(innerForDate, "created_time") ??
      pickString(firstRef, "created_time");
    // γ-A1-v15 (general): file_name 끝의 `_MMDD` 또는 `_YYYYMMDD` = 강의 일자 (현대자동차_0731 패턴).
    // response_date보다 정확한 강의 시점이므로 file_name 날짜 있으면 우선.
    const fileDateMatch = fileName?.match(/_(\d{4})(\d{2})(\d{2})|_(\d{2})(\d{2})(?:\(|\)|_|$)/);
    if (fileDateMatch) {
      let y: string, m: string, d: string;
      if (fileDateMatch[1]) {
        // YYYYMMDD
        y = fileDateMatch[1];
        m = fileDateMatch[2];
        d = fileDateMatch[3];
      } else {
        // MMDD — year 추정: response_date or created_time year, 없으면 currentYear
        const ref = responseDateStr ? new Date(responseDateStr) : new Date();
        y = String(ref.getFullYear());
        m = fileDateMatch[4];
        d = fileDateMatch[5];
      }
      const candidate = `${y}-${m}-${d}T00:00:00Z`;
      const candDate = new Date(candidate);
      if (!Number.isNaN(candDate.getTime())) {
        responseDateStr = candidate;
      }
    }
    const responseDate = responseDateStr ? new Date(responseDateStr) : null;

    // γ-A1-v9 (general): 비정형 companyName 검출 + 재추출
    let effectiveCompany = reg.companyName;
    if (looksUnparsedCompany(effectiveCompany)) {
      const fromFile = findKnownCompanyInText(fileName);
      const fromSheet = findKnownCompanyInText(sheetTitle);
      const fromCourse = findKnownCompanyInText(reg.courseName);
      effectiveCompany = fromFile ?? fromSheet ?? fromCourse ?? effectiveCompany;
    }
    const courseSession =
      extractSessionNumber(reg.courseName) ??
      extractSessionNumber(sheetTitle) ??
      extractSessionNumber(fileName);

    // γ-A1-v8 (general): sheet_title 또는 file_name에 강사명 직접 명시된 케이스
    // "주한나강사님 만족도" 같은 패턴 — 강사 본인이 sheet 만든 경우 또는 운영자가 강사명 라벨
    const titleInstructorRegex = /([가-힣]{2,4}[A-Z]?)\s*(?:강사|대표|교수|선생)/;
    const sheetInstructorMatch = sheetTitle?.match(titleInstructorRegex);
    const fileInstructorMatch = fileName?.match(titleInstructorRegex);
    const titleInstructorName = sheetInstructorMatch?.[1] ?? fileInstructorMatch?.[1] ?? null;

    // γ-A1-v8 신호 0: title에 강사명 명시 → 즉시 단일 강사 매칭 (가장 강한 신호)
    if (titleInstructorName) {
      const inst = lookupInstructor(titleInstructorName);
      if (inst) {
        classifications.push({
          registryKey: reg.registryKey,
          company: reg.companyName,
          course: reg.courseName,
          candidate: reg.candidateName,
          response_count: reg.responseCount,
          response_date: responseDateStr,
          course_session: courseSession,
          status: "strong_single_by_date",
          matched_instructors: [inst.name],
          matched_instructor_id: inst.id,
          matched_instructor_name: inst.name,
          evidence_count: 1,
        });
        continue;
      }
    }

    if (!effectiveCompany) {
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

    // 시점 ±WINDOW_DAYS 내 운영보고 메시지 + 회사 alias 매칭 (effectiveCompany)
    let matched = opsMessages.filter((m) => {
      if (!companyMatches(m.company, effectiveCompany)) return false;
      const diff = Math.abs(m.activityAt.getTime() - responseDate.getTime()) / (1000 * 60 * 60 * 24);
      return diff <= WINDOW_DAYS;
    });

    // γ-A1-v16: narrow window 0건이면 ±60일 wide window + TH 강의기간 cross-check.
    // 사용자 의도: ops 메시지(강의 시작) + 만족도 응답일자가 TH 강의 기간 안 ± 14일이면 그 강사로 매칭.
    if (matched.length === 0) {
      const WIDE_WINDOW_DAYS = 60;
      const wideOps = opsMessages.filter((m) => {
        if (!companyMatches(m.company, effectiveCompany)) return false;
        const diff = Math.abs(m.activityAt.getTime() - responseDate.getTime()) / (1000 * 60 * 60 * 24);
        return diff <= WIDE_WINDOW_DAYS;
      });
      if (wideOps.length > 0) {
        // wide ops에서 강사 후보 모음 → TH 강의 기간 cross-check
        const candidateInstructorNames = new Set<string>();
        for (const m of wideOps) for (const n of m.instructors) candidateInstructorNames.add(n);
        const verifiedByTh = wideOps.filter((m) => {
          // 각 ops 메시지마다 그 강사들의 TH가 응답일자 포함하는지
          for (const instName of m.instructors) {
            const inst = lookupInstructor(instName);
            if (!inst) continue;
            const ths = allTHs.filter(
              (t) => t.instructorDbId === inst.id && companyMatches(t.companyName, effectiveCompany)
            );
            for (const t of ths) {
              const start = t.startDate?.getTime() ?? null;
              const end = t.endDate?.getTime() ?? null;
              const respMs = responseDate.getTime();
              const FOURTEEN = 14 * 24 * 60 * 60 * 1000;
              if (start !== null && end !== null) {
                if (respMs >= start - FOURTEEN && respMs <= end + FOURTEEN) return true;
              } else if (start !== null) {
                // endDate null이면 startDate ±60일 (강의 끝 unknown — soft fallback)
                if (Math.abs(respMs - start) <= 60 * 24 * 60 * 60 * 1000) return true;
              }
            }
          }
          return false;
        });
        if (verifiedByTh.length > 0) {
          matched = verifiedByTh;
        }
      }
    }

    if (matched.length === 0) {
      // γ-A1-v6: TeachingHistory fallback — ops_report 매칭 0건이면 계약시트로 직접 매칭
      const thMatched = allTHs.filter((t) => {
        if (!companyMatches(t.companyName, effectiveCompany)) return false;
        // 강의 기간이 responseDate 포함 ±14일
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
        classifications.push({
          registryKey: reg.registryKey,
          company: reg.companyName,
          course: reg.courseName,
          candidate: reg.candidateName,
          response_count: reg.responseCount,
          response_date: responseDateStr,
          course_session: courseSession,
          status: "strong_single_by_date", // TH match도 같은 카테고리 (slot reuse)
          matched_instructors: inst ? [inst.name] : [],
          matched_instructor_id: inst?.id ?? null,
          matched_instructor_name: inst?.name ?? null,
          evidence_count: thMatched.length,
        });
        continue;
      }
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

    // γ-A1-v16: TH 강의기간 cross-check filter — 강사 후보 중 TH 기간이 응답일자를 cover하는 강사만
    // 사용자 의도: ops 메시지(강의 시작) + 계약 강의 기간 안에 만족도 응답이 있어야 진짜 매칭.
    {
      const candidateNames = new Set<string>();
      for (const m of filteredByCourse) for (const n of m.instructors) candidateNames.add(n);
      if (candidateNames.size >= 2) {
        const FOURTEEN = 14 * 24 * 60 * 60 * 1000;
        const verifiedNames = new Set<string>();
        for (const n of candidateNames) {
          const inst = lookupInstructor(n);
          if (!inst) continue;
          const ths = allTHs.filter(
            (t) =>
              t.instructorDbId === inst.id &&
              companyMatches(t.companyName, effectiveCompany) &&
              t.startDate !== null
          );
          for (const t of ths) {
            const start = t.startDate!.getTime();
            const end = t.endDate?.getTime() ?? start;
            const respMs = responseDate.getTime();
            if (respMs >= start - FOURTEEN && respMs <= end + FOURTEEN) {
              verifiedNames.add(n);
              break;
            }
          }
        }
        if (verifiedNames.size === 1) {
          // TH 강의기간으로 단일화 성공
          filteredByCourse = filteredByCourse.filter((m) =>
            m.instructors.some((n) => verifiedNames.has(n))
          );
        }
      }
    }

    const uniqueInstructors = Array.from(
      new Set(filteredByCourse.flatMap((m) => m.instructors))
    );

    if (uniqueInstructors.length === 1) {
      const instName = uniqueInstructors[0];
      const inst = lookupInstructor(instName);
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
      // γ-A1-v14/v15: response_date null fallback + file_name _MMDD/_YYYYMMDD 우선
      const innerForDate = firstRef && (firstRef as RawRecord).source_ref as RawRecord | undefined;
      let responseDateStr =
        pickString(firstRef, "response_date") ??
        pickString(innerForDate, "created_time") ??
        pickString(firstRef, "created_time");
      const fnameApply = pickString(firstRef, "file_name");
      const fdm = fnameApply?.match(/_(\d{4})(\d{2})(\d{2})|_(\d{2})(\d{2})(?:\(|\)|_|$)/);
      if (fdm) {
        let y: string, m: string, d: string;
        if (fdm[1]) {
          y = fdm[1]; m = fdm[2]; d = fdm[3];
        } else {
          const ref = responseDateStr ? new Date(responseDateStr) : new Date();
          y = String(ref.getFullYear()); m = fdm[4]; d = fdm[5];
        }
        const cand = `${y}-${m}-${d}T00:00:00Z`;
        if (!Number.isNaN(new Date(cand).getTime())) responseDateStr = cand;
      }
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
      // ?full=1 로 호출 시 전체, 기본 slice
      strong_by_session: (request.nextUrl.searchParams.get("full") === "1"
        ? classifications.filter((c) => c.status === "strong_single_by_session")
        : classifications.filter((c) => c.status === "strong_single_by_session").slice(0, 8)),
      strong_by_date: (request.nextUrl.searchParams.get("full") === "1"
        ? classifications.filter((c) => c.status === "strong_single_by_date")
        : classifications.filter((c) => c.status === "strong_single_by_date").slice(0, 8)),
      multi_instructors: (request.nextUrl.searchParams.get("full") === "1"
        ? classifications.filter((c) => c.status === "multi_instructors")
        : classifications.filter((c) => c.status === "multi_instructors").slice(0, 5)),
      no_company: (request.nextUrl.searchParams.get("full") === "1"
        ? classifications.filter((c) => c.status === "no_company")
        : classifications.filter((c) => c.status === "no_company").slice(0, 3)),
      no_slack_match: (request.nextUrl.searchParams.get("full") === "1"
        ? classifications.filter((c) => c.status === "no_slack_match")
        : classifications.filter((c) => c.status === "no_slack_match").slice(0, 5)),
    },
  });
}
