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
import { auth, isAuthDisabled } from "@/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

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
};

type ResolveStatus =
  | "resolved"
  | "multiple_candidates"
  | "low_confidence"
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

  // 4) record별 resolve
  const results: RecordResult[] = records.map((r) => {
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
    if (
      candidates.length === 0 &&
      !requireCompany &&
      (!r.companyName || r.companyName.length < 2)
    ) {
      for (const t of candidateTHs) {
        if (t.instructorDbId !== r.instructorDbId) continue;
        if (!t.companyName) continue;
        const d = diffDays(respMs, t.startDate, t.endDate);
        if (d > windowDays) continue;
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
          confidence: d === 0 ? 0.78 : d <= 7 ? 0.7 : 0.6,
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
        })`,
      };
    }

    const top = uniqueCandidates[0];
    const stage: "A" | "B" | "C" =
      top.matched_by === "course_id"
        ? "A"
        : top.matched_by === "company_window"
        ? "B"
        : "C";

    let status: ResolveStatus;
    if (uniqueCandidates.length >= 2) {
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
          ? `stage_${stage}_top_confidence=${top.confidence.toFixed(2)}`
          : status === "multiple_candidates"
          ? `top=${top.instructor_name}(${top.confidence.toFixed(
              2
            )}) vs 2nd=${uniqueCandidates[1].instructor_name}(${uniqueCandidates[1].confidence.toFixed(
              2
            )})`
          : `low_confidence top=${top.confidence.toFixed(2)} threshold=0.75`,
    };
  });

  const summary = {
    total: results.length,
    resolved: results.filter((r) => r.status === "resolved").length,
    multiple_candidates: results.filter(
      (r) => r.status === "multiple_candidates"
    ).length,
    low_confidence: results.filter((r) => r.status === "low_confidence")
      .length,
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
    window_days: windowDays,
    require_company: requireCompany,
  };

  return NextResponse.json({ ok: true, summary, results });
}
