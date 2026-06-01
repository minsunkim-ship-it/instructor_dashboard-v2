/**
 * GET /api/admin/ground-truth-resolve
 *
 * 계약시트(TeachingHistory sourceType in COURSE_COUNT_SOURCE_TYPES = contract_sheet,
 * instructor_dispatch_sheet) 기반 ground truth chain으로 단일 또는 batch
 * SatisfactionRecord의 진짜 강사·회사·코스를 결정.
 *
 * 계약시트 → 코스ID → 세일즈맵 chain은 상류에서 이미 적재되어 있다
 * (`contract-sheet-store.ts` + `salesmap-applier.ts`의 course_id join).
 * 본 endpoint는 만족도 record가 이 인덱스를 활용하지 못하는 gap을 보완.
 *
 * Stages (정공법 우선):
 *   Stage A — course_id exact match (가장 강한 신호). record.sourceRef 또는
 *             query param에서 courseId 추출 가능 시 즉시 매칭.
 *   Stage B — company alias + responseDate ±N일 window (default 14).
 *   Stage C — instructor name hint + ±N일 (회사명 부재 record용 backfill).
 *             ⚠️ 일정 단독 매칭은 fallback. 반드시 cross-source(슬랙 ops_report
 *             또는 gmail 만족도 메일) 신호로 confirm되어야 "resolved" 부여.
 *             cross-source 부재 시 status = "low_confidence_stage_c" 로 분리.
 *
 * Stage C 강화 (회귀 케이스 = 소준섭 HD조선해양 문항개발):
 *   1) "문항 출제·채점·자문·평가 제작·문제 개발" 등 NON_LECTURE 키워드 가진
 *      TH는 강의 만족도 매칭 제외(blocklist).
 *   2) 일정 단독 + cross-source 부재 → confidence <= 0.5, status low_confidence_stage_c.
 *   3) 슬랙 ops_report 또는 gmail subject/snippet에 회사명 + 강사명 동시
 *      ±7d 매칭 시 cross-source confirmed → confidence boost (+0.15).
 *
 * 응답: read-only. update 없음. backoffice UI / reassign endpoint 에서 활용.
 *
 * 인증: CRON_SECRET 또는 NextAuth session.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";
import { companyMatchesWithAlias } from "@/lib/company-aliases";
import { COURSE_COUNT_SOURCE_TYPES } from "@/lib/pipeline/teaching-history-sources";
import {
  detectNonLectureReason,
  type CrossSourceSignal,
} from "@/lib/ground-truth-stage-c";
import { auth, isAuthDisabled } from "@/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Stage C cross-source check window. response_date 기준 ±7d 슬랙/지메일 raw
 * activity 에서 강사명 + 회사명 토큰 동시 등장 시 cross-source confirmed.
 */
const CROSS_SOURCE_WINDOW_DAYS = 7;

type Candidate = {
  th_id: string;
  instructor_id: string;
  instructor_name: string;
  company: string | null;
  course: string | null;
  course_id: string | null;
  start: string | null;
  end: string | null;
  days_from_response: number;
  source_type: string;
  matched_by: "course_id" | "company_window" | "instructor_window";
  confidence: number;
  /** Stage C 일정 단독 매칭 시 cross-source 확인 결과. */
  cross_source?: CrossSourceSignal;
  /** non-lecture blocklist 적용 여부 (debug). */
  non_lecture_skip_reason?: string;
};

type ResolveStatus =
  | "resolved"
  | "multiple_candidates"
  | "low_confidence"
  | "low_confidence_stage_c"
  | "no_match"
  | "no_response_date";

interface RecordResult {
  record_id: string;
  status: ResolveStatus;
  current_instructor_id: string;
  current_instructor_name: string;
  current_company: string | null;
  ground_truth_instructor: { id: string; name: string } | null;
  ground_truth_company: string | null;
  ground_truth_course: string | null;
  ground_truth_course_id: string | null;
  backfill_company: string | null;
  mismatch_with_current: boolean;
  confidence: number;
  stage: "A" | "B" | "C" | null;
  candidates: Candidate[];
  reason: string;
}

function toDateStr(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

function diffDays(respMs: number, start: Date | null, end: Date | null): number {
  const s = start?.getTime() ?? null;
  const e = end?.getTime() ?? s;
  if (s === null) return Number.POSITIVE_INFINITY;
  if (respMs >= s && respMs <= (e ?? s)) return 0;
  return Math.min(
    Math.abs(respMs - s),
    Math.abs(respMs - (e ?? s))
  ) / (24 * 60 * 60 * 1000);
}

function extractCourseIdFromSourceRef(sourceRef: unknown): string | null {
  if (!sourceRef || typeof sourceRef !== "object") return null;
  const sr = sourceRef as Record<string, unknown>;
  if (typeof sr.course_id === "string" && sr.course_id.length > 0) return sr.course_id;
  if (typeof sr.courseId === "string" && sr.courseId.length > 0) return sr.courseId;
  const refs = Array.isArray(sr.source_refs) ? sr.source_refs : [];
  for (const ref of refs) {
    if (ref && typeof ref === "object") {
      const inner = (ref as Record<string, unknown>).source_ref;
      if (inner && typeof inner === "object") {
        const x = inner as Record<string, unknown>;
        if (typeof x.course_id === "string" && x.course_id.length > 0) return x.course_id;
        if (typeof x.courseId === "string" && x.courseId.length > 0) return x.courseId;
      }
    }
  }
  return null;
}

/**
 * 슬랙 ops_report + 지메일 activity_import_items 에서 강사명·회사명 토큰이
 * 같은 thread/메시지에 ±7d 등장하는지 검사. record가 진짜 강의에서 발생한
 * 만족도라면 운영보고나 매니저 메일에 흔적이 남아 있어야 한다.
 *
 * candidate company가 매칭의 후보일 때만 호출 — non-lecture는 사전 차단.
 */
async function checkCrossSourceSignal(params: {
  instructorName: string;
  companyName: string;
  responseDate: Date;
}): Promise<CrossSourceSignal> {
  const { instructorName, companyName, responseDate } = params;
  const windowMs = CROSS_SOURCE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const fromDate = new Date(responseDate.getTime() - windowMs);
  const toDate = new Date(responseDate.getTime() + windowMs);

  const instructorToken = instructorName.trim();
  const companyToken = companyName.trim();
  if (instructorToken.length < 2 || companyToken.length < 2) {
    return { found: false, slack_hits: 0, gmail_hits: 0, sample_refs: [] };
  }

  // ActivityImportItem 의 rawPayload 안에서 강사명 + 회사명 동시 매칭 검색.
  // Prisma raw JSON contains 는 string-cast로 lower-level filter 가능.
  // Postgres JSONB ::text ilike 패턴 활용.
  const rows = await prisma.$queryRaw<
    Array<{
      id: string;
      source_type: string;
      activity_at: Date | null;
      source_ref: unknown;
      candidate_name: string | null;
    }>
  >`
    SELECT id, source_type, activity_at, source_ref, candidate_name
    FROM activity_import_items
    WHERE activity_at >= ${fromDate}
      AND activity_at <= ${toDate}
      AND source_type IN ('slack', 'gmail')
      AND (raw_payload::text ILIKE ${"%" + instructorToken + "%"})
      AND (raw_payload::text ILIKE ${"%" + companyToken + "%"})
    LIMIT 20
  `;

  let slackHits = 0;
  let gmailHits = 0;
  const sampleRefs: string[] = [];
  for (const row of rows) {
    if (row.source_type === "slack") slackHits += 1;
    else if (row.source_type === "gmail") gmailHits += 1;
    if (sampleRefs.length < 5) {
      const sr = row.source_ref as Record<string, unknown> | null;
      if (sr && typeof sr === "object") {
        const key =
          (typeof sr.thread_id === "string" && sr.thread_id) ||
          (typeof sr.ts === "string" && sr.ts) ||
          (typeof sr.message_id === "string" && sr.message_id) ||
          row.id;
        sampleRefs.push(`${row.source_type}:${key}`);
      }
    }
  }
  return {
    found: slackHits + gmailHits > 0,
    slack_hits: slackHits,
    gmail_hits: gmailHits,
    sample_refs: sampleRefs,
  };
}

export async function GET(request: NextRequest) {
  let authorized = false;
  if (isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    authorized = true;
  } else if (isAuthDisabled()) {
    authorized = true;
  } else {
    const session = await auth();
    if (session?.user?.email) authorized = true;
  }
  if (!authorized) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const sp = request.nextUrl.searchParams;
  const recordIdParam = sp.get("record_id");
  const recordIdsParam = sp.get("record_ids");
  const pendingOnly = sp.get("pending_only") === "1";
  const suspectOnly = sp.get("suspect_only") === "1";
  const limit = parseInt(sp.get("limit") ?? "100", 10);
  const windowDays = parseInt(sp.get("window_days") ?? "14", 10);
  const requireCompany = sp.get("require_company") === "1";
  /** Stage C cross-source check 비활성 (테스트/회귀 비교용). 기본 enabled. */
  const crossSourceDisabled = sp.get("disable_cross_source") === "1";

  // 1) target records 선정
  const ids: string[] = [];
  if (recordIdParam) ids.push(recordIdParam);
  if (recordIdsParam) {
    for (const id of recordIdsParam.split(",")) {
      const t = id.trim();
      if (t) ids.push(t);
    }
  }

  const where: Record<string, unknown> = {};
  if (ids.length > 0) {
    where.id = { in: ids };
  } else if (suspectOnly) {
    where.score = { lte: 2.5 };
    where.respondentCount = { lte: 2 };
  } else if (pendingOnly) {
    where.OR = [{ companyName: null }, { companyName: "" }];
  } else {
    return NextResponse.json(
      {
        ok: false,
        error:
          "either record_id / record_ids / pending_only=1 / suspect_only=1 required",
      },
      { status: 400 }
    );
  }

  const records = await prisma.satisfactionRecord.findMany({
    where: where as never,
    select: {
      id: true,
      instructorDbId: true,
      companyName: true,
      courseName: true,
      responseDate: true,
      sourceType: true,
      sourceRef: true,
      instructor: { select: { id: true, name: true } },
    },
    take: ids.length > 0 ? ids.length : Math.min(limit, 500),
    orderBy: { responseDate: "desc" },
  });

  if (records.length === 0) {
    return NextResponse.json({
      ok: true,
      summary: { total: 0 },
      results: [] as RecordResult[],
    });
  }

  // 2) 후보 contract_sheet TH pre-fetch (window 기반)
  const respMsArr = records
    .map((r) => r.responseDate?.getTime())
    .filter((m): m is number => typeof m === "number");
  const WINDOW_MS = windowDays * 24 * 60 * 60 * 1000;
  const sourceTypesArr: string[] = [...COURSE_COUNT_SOURCE_TYPES];
  let candidateTHs: Array<{
    id: string;
    instructorDbId: string;
    companyName: string | null;
    courseName: string | null;
    courseId: string | null;
    startDate: Date | null;
    endDate: Date | null;
    sourceType: string;
    contractType: string | null;
    detailType: string | null;
    specialNotes: string | null;
    totalHours: unknown;
    instructor: { id: string; name: string } | null;
  }> = [];
  if (respMsArr.length > 0) {
    const minMs = Math.min(...respMsArr);
    const maxMs = Math.max(...respMsArr);
    const minDate = new Date(minMs - WINDOW_MS - 7 * 24 * 60 * 60 * 1000);
    const maxDate = new Date(maxMs + WINDOW_MS + 7 * 24 * 60 * 60 * 1000);
    candidateTHs = await prisma.teachingHistory.findMany({
      where: {
        sourceType: { in: sourceTypesArr },
        OR: [
          { startDate: { gte: minDate, lte: maxDate } },
          { endDate: { gte: minDate, lte: maxDate } },
          {
            AND: [
              { startDate: { lte: maxDate } },
              { endDate: { gte: minDate } },
            ],
          },
        ],
      },
      select: {
        id: true,
        instructorDbId: true,
        companyName: true,
        courseName: true,
        courseId: true,
        startDate: true,
        endDate: true,
        sourceType: true,
        contractType: true,
        detailType: true,
        specialNotes: true,
        totalHours: true,
        instructor: { select: { id: true, name: true } },
      },
    });
  }

  // 3) course_id index (Stage A 용 — window 무관 lookup, but instructor 정확도 위해 같은 pool 사용)
  const courseIds = Array.from(
    new Set(
      candidateTHs
        .map((t) => t.courseId)
        .filter((c): c is string => !!c && c.length > 0)
    )
  );
  // 만약 record.sourceRef의 course_id가 candidate pool 밖이라면 별도 fetch
  const recordCourseIds = new Set<string>();
  for (const r of records) {
    const cid = extractCourseIdFromSourceRef(r.sourceRef);
    if (cid) recordCourseIds.add(cid);
  }
  const missingCids = Array.from(recordCourseIds).filter(
    (c) => !courseIds.includes(c)
  );
  let extraTHs: typeof candidateTHs = [];
  if (missingCids.length > 0) {
    extraTHs = await prisma.teachingHistory.findMany({
      where: {
        sourceType: { in: sourceTypesArr },
        courseId: { in: missingCids },
      },
      select: {
        id: true,
        instructorDbId: true,
        companyName: true,
        courseName: true,
        courseId: true,
        startDate: true,
        endDate: true,
        sourceType: true,
        contractType: true,
        detailType: true,
        specialNotes: true,
        totalHours: true,
        instructor: { select: { id: true, name: true } },
      },
    });
  }
  const allTHs = [...candidateTHs, ...extraTHs];

  const thByCourseId = new Map<string, typeof allTHs>();
  for (const t of allTHs) {
    if (!t.courseId) continue;
    const arr = thByCourseId.get(t.courseId) ?? [];
    arr.push(t);
    thByCourseId.set(t.courseId, arr);
  }

  // 4) record별 resolve (async — Stage C cross-source check 포함)
  const results: RecordResult[] = await Promise.all(
    records.map(async (r): Promise<RecordResult> => {
      const respDate = r.responseDate;
      if (!respDate) {
        return {
          record_id: r.id,
          status: "no_response_date",
          current_instructor_id: r.instructorDbId,
          current_instructor_name: r.instructor.name,
          current_company: r.companyName,
          ground_truth_instructor: null,
          ground_truth_company: null,
          ground_truth_course: null,
          ground_truth_course_id: null,
          backfill_company: null,
          mismatch_with_current: false,
          confidence: 0,
          stage: null,
          candidates: [],
          reason: "record has no responseDate — cannot anchor TH window",
        };
      }
      const respMs = respDate.getTime();
      const candidates: Candidate[] = [];

      // Stage A: course_id exact
      const recordCid = extractCourseIdFromSourceRef(r.sourceRef);
      if (recordCid) {
        const matches = thByCourseId.get(recordCid) ?? [];
        for (const t of matches) {
          const d = diffDays(respMs, t.startDate, t.endDate);
          // course_id 신호 자체가 강하므로 window는 60d 까지 허용
          if (d > 60) continue;
          const nonLectureReason = detectNonLectureReason(t);
          if (nonLectureReason) {
            // course_id 매칭이지만 non-lecture 계약이면 skip
            // (false positive 방지: 같은 course_id에 강의·문항개발이 섞일 일은 거의 없지만 안전)
            continue;
          }
          candidates.push({
            th_id: t.id,
            instructor_id: t.instructorDbId,
            instructor_name: t.instructor?.name ?? "(unknown)",
            company: t.companyName,
            course: t.courseName?.slice(0, 120) ?? null,
            course_id: t.courseId,
            start: toDateStr(t.startDate),
            end: toDateStr(t.endDate),
            days_from_response: Math.round(d),
            source_type: t.sourceType,
            matched_by: "course_id",
            confidence: d === 0 ? 0.98 : d <= 14 ? 0.92 : d <= 30 ? 0.85 : 0.75,
          });
        }
      }

      // Stage B: company alias + date window
      if (candidates.length === 0 && r.companyName && r.companyName.length >= 2) {
        for (const t of candidateTHs) {
          if (!t.companyName) continue;
          if (!companyMatchesWithAlias(t.companyName, r.companyName)) continue;
          const nonLectureReason = detectNonLectureReason(t);
          if (nonLectureReason) continue;
          const d = diffDays(respMs, t.startDate, t.endDate);
          if (d > windowDays) continue;
          // course_name 일치하면 confidence boost
          let conf = d === 0 ? 0.88 : d <= 7 ? 0.82 : 0.7;
          if (
            r.courseName &&
            t.courseName &&
            (t.courseName.includes(r.courseName) ||
              r.courseName.includes(t.courseName))
          ) {
            conf = Math.min(0.95, conf + 0.07);
          }
          candidates.push({
            th_id: t.id,
            instructor_id: t.instructorDbId,
            instructor_name: t.instructor?.name ?? "(unknown)",
            company: t.companyName,
            course: t.courseName?.slice(0, 120) ?? null,
            course_id: t.courseId,
            start: toDateStr(t.startDate),
            end: toDateStr(t.endDate),
            days_from_response: Math.round(d),
            source_type: t.sourceType,
            matched_by: "company_window",
            confidence: conf,
          });
        }
      }

      // Stage C: instructor name window (회사 부재 backfill용)
      // 일정 단독 매칭은 약한 신호. cross-source(슬랙 ops_report/지메일) 신호로 confirm 필수.
      if (
        candidates.length === 0 &&
        !requireCompany &&
        (!r.companyName || r.companyName.length < 2)
      ) {
        for (const t of candidateTHs) {
          if (t.instructorDbId !== r.instructorDbId) continue;
          if (!t.companyName) continue;
          const nonLectureReason = detectNonLectureReason(t);
          if (nonLectureReason) {
            // 회귀 케이스(소준섭 HD조선해양 문항개발) 방지 — skip
            // candidate로도 출력하지 않음. typecheck/디버그 시 별도 endpoint 사용.
            continue;
          }
          const d = diffDays(respMs, t.startDate, t.endDate);
          if (d > windowDays) continue;

          // Stage C 기본 confidence는 낮게 시작 (cross-source 부재 시 자동 low_confidence)
          let conf = d === 0 ? 0.55 : d <= 7 ? 0.5 : 0.45;
          let crossSource: CrossSourceSignal = {
            found: false,
            slack_hits: 0,
            gmail_hits: 0,
            sample_refs: [],
          };

          if (!crossSourceDisabled) {
            crossSource = await checkCrossSourceSignal({
              instructorName: t.instructor?.name ?? r.instructor.name,
              companyName: t.companyName,
              responseDate: respDate,
            });
            if (crossSource.found) {
              // cross-source confirmed: 0.55 → 0.78 / 0.5 → 0.7 / 0.45 → 0.65
              conf = Math.min(0.85, conf + 0.2);
              // slack ops_report + gmail 둘 다 있으면 추가 boost
              if (crossSource.slack_hits > 0 && crossSource.gmail_hits > 0) {
                conf = Math.min(0.9, conf + 0.05);
              }
            }
          }

          candidates.push({
            th_id: t.id,
            instructor_id: t.instructorDbId,
            instructor_name: t.instructor?.name ?? r.instructor.name,
            company: t.companyName,
            course: t.courseName?.slice(0, 120) ?? null,
            course_id: t.courseId,
            start: toDateStr(t.startDate),
            end: toDateStr(t.endDate),
            days_from_response: Math.round(d),
            source_type: t.sourceType,
            matched_by: "instructor_window",
            confidence: conf,
            cross_source: crossSource,
          });
        }
      }

      // dedupe by instructor (keep highest confidence per instructor)
      const byInst = new Map<string, Candidate>();
      for (const c of candidates) {
        const prev = byInst.get(c.instructor_id);
        if (!prev || c.confidence > prev.confidence) {
          byInst.set(c.instructor_id, c);
        }
      }
      const uniqueCandidates = Array.from(byInst.values()).sort(
        (a, b) => b.confidence - a.confidence
      );

      if (uniqueCandidates.length === 0) {
        return {
          record_id: r.id,
          status: "no_match",
          current_instructor_id: r.instructorDbId,
          current_instructor_name: r.instructor.name,
          current_company: r.companyName,
          ground_truth_instructor: null,
          ground_truth_company: null,
          ground_truth_course: null,
          ground_truth_course_id: null,
          backfill_company: null,
          mismatch_with_current: false,
          confidence: 0,
          stage: null,
          candidates: [],
          reason: `no TH in contract_sheet (window ±${windowDays}d, course_id=${
            recordCid ?? "none"
          }) — non-lecture/문항개발 candidates excluded`,
        };
      }

      const top = uniqueCandidates[0];
      const stage: "A" | "B" | "C" =
        top.matched_by === "course_id"
          ? "A"
          : top.matched_by === "company_window"
          ? "B"
          : "C";

      // Stage C: cross-source 부재 시 강제 low_confidence_stage_c
      // Stage A/B: 기존 threshold 유지
      let status: ResolveStatus;
      if (stage === "C") {
        const cs = top.cross_source;
        const confirmed = !!cs?.found;
        if (uniqueCandidates.length >= 2) {
          const second = uniqueCandidates[1];
          if (top.confidence - second.confidence < 0.05) {
            status = "multiple_candidates";
          } else if (confirmed && top.confidence >= 0.75) {
            status = "resolved";
          } else {
            status = "low_confidence_stage_c";
          }
        } else {
          status =
            confirmed && top.confidence >= 0.75
              ? "resolved"
              : "low_confidence_stage_c";
        }
      } else if (uniqueCandidates.length >= 2) {
        const second = uniqueCandidates[1];
        if (top.confidence - second.confidence < 0.05) {
          status = "multiple_candidates";
        } else if (top.confidence >= 0.75) {
          status = "resolved";
        } else {
          status = "low_confidence";
        }
      } else {
        status = top.confidence >= 0.75 ? "resolved" : "low_confidence";
      }

      const mismatch =
        status === "resolved" && top.instructor_id !== r.instructorDbId;
      const backfill =
        status === "resolved" && !r.companyName && top.company
          ? top.company
          : null;

      const stageCReasonSuffix =
        stage === "C"
          ? ` cross_source=${
              top.cross_source?.found
                ? `slack:${top.cross_source.slack_hits},gmail:${top.cross_source.gmail_hits}`
                : "none"
            }`
          : "";

      return {
        record_id: r.id,
        status,
        current_instructor_id: r.instructorDbId,
        current_instructor_name: r.instructor.name,
        current_company: r.companyName,
        ground_truth_instructor:
          status === "resolved"
            ? { id: top.instructor_id, name: top.instructor_name }
            : null,
        ground_truth_company: status === "resolved" ? top.company : null,
        ground_truth_course: status === "resolved" ? top.course : null,
        ground_truth_course_id: status === "resolved" ? top.course_id : null,
        backfill_company: backfill,
        mismatch_with_current: mismatch,
        confidence: Math.round(top.confidence * 100) / 100,
        stage,
        candidates: uniqueCandidates.slice(0, 5),
        reason:
          status === "resolved"
            ? `stage_${stage}_top_confidence=${top.confidence.toFixed(2)}${stageCReasonSuffix}`
            : status === "multiple_candidates"
            ? `top=${top.instructor_name}(${top.confidence.toFixed(
                2
              )}) vs 2nd=${uniqueCandidates[1].instructor_name}(${uniqueCandidates[1].confidence.toFixed(
                2
              )})${stageCReasonSuffix}`
            : status === "low_confidence_stage_c"
            ? `stage_C_no_cross_source — schedule-only match insufficient (confidence=${top.confidence.toFixed(2)}, cross_source=${
                top.cross_source?.found ? "found_but_below_threshold" : "absent"
              }). 슬랙 ops_report/지메일 만족도 메일 부재 — backfill 보류.`
            : `low_confidence top=${top.confidence.toFixed(2)} threshold=0.75`,
      };
    })
  );

  const summary = {
    total: results.length,
    resolved: results.filter((r) => r.status === "resolved").length,
    multiple_candidates: results.filter(
      (r) => r.status === "multiple_candidates"
    ).length,
    low_confidence: results.filter((r) => r.status === "low_confidence")
      .length,
    low_confidence_stage_c: results.filter(
      (r) => r.status === "low_confidence_stage_c"
    ).length,
    no_match: results.filter((r) => r.status === "no_match").length,
    no_response_date: results.filter((r) => r.status === "no_response_date")
      .length,
    mismatches_with_current: results.filter((r) => r.mismatch_with_current)
      .length,
    backfill_company_count: results.filter((r) => r.backfill_company !== null)
      .length,
    by_stage: {
      A: results.filter((r) => r.stage === "A").length,
      B: results.filter((r) => r.stage === "B").length,
      C: results.filter((r) => r.stage === "C").length,
    },
    cross_source_confirmed: results.filter(
      (r) =>
        r.stage === "C" &&
        r.candidates[0]?.cross_source?.found === true
    ).length,
    window_days: windowDays,
    require_company: requireCompany,
    cross_source_disabled: crossSourceDisabled,
  };

  return NextResponse.json({ ok: true, summary, results });
}
