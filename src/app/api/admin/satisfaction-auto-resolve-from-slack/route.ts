/**
 * GET /api/admin/satisfaction-auto-resolve-from-slack
 *
 * Phase γ-A1 — Pending Auto-Resolver (Slack 운영보고 융합).
 *
 * 알고리즘:
 *   1. SatisfactionReviewRegistry(matchStatus="pending") 전체 로드
 *   2. ActivityImportItem(sourceType="slack", channel=운영보고) 전체 로드 + 텍스트에서 회사/강사 추출
 *   3. 각 pending registry에 대해:
 *      - company alias 매칭 + ±60일 시점 매칭 슬랙 메시지 후보
 *      - 후보 메시지에서 추출된 unique 강사명 추출
 *      - 단일 강사 → strong_single (apply 시 resolved + SatisfactionRecord 생성)
 *      - 다중 강사 → multi_instructors (γ-A2 UI에 candidate 노출, pending 유지)
 *      - 없음 → no_slack_match (pending 유지)
 *
 * 모드:
 *   ?mode=dry_run (기본) — DB 변경 없음. 분류 통계 + sample 반환.
 *   ?mode=apply — strong_single만 SatisfactionRecord 생성 + registry resolved (다음 commit)
 *
 * 인증: CRON_SECRET
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

function authorize(request: NextRequest): boolean {
  const headerSecret = request.headers.get(CRON_SECRET_HEADER);
  if (isValidCronSecret(headerSecret)) return true;
  const querySecret = request.nextUrl.searchParams.get("secret");
  if (isValidCronSecret(querySecret)) return true;
  return false;
}

// 운영보고 채널 — `SLACK_PILOT_4_5_CHANNELS:48` ops_report 기준
const OPS_REPORT_CHANNEL_ID = "C015YD84VGS";
const MATCH_WINDOW_DAYS = 60;

// γ-A1 regex (probe v2와 동기화)
const INSTRUCTOR_REGEX = /([가-힣]{2,4}[A-Z]?)\s*(?:강사|대표|교수|선생)님/g;
const COMPANY_REGEX = /\(B2B\)\s*([^_\n]+?)[\s_]/;

interface RawRecord {
  [key: string]: unknown;
}

function pickString(obj: RawRecord | undefined, ...keys: string[]): string | null {
  if (!obj) return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return null;
}

function normalizeForCompanyMatch(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[\s()[\]{}.,:;'"`~!?+\-_/\\|]+/g, "");
}

function companyMatches(slackCompany: string | null, registryCompany: string | null): boolean {
  if (!slackCompany || !registryCompany) return false;
  const a = normalizeForCompanyMatch(slackCompany);
  const b = normalizeForCompanyMatch(registryCompany);
  if (a.length < 2 || b.length < 2) return false;
  return a.includes(b) || b.includes(a);
}

function withinDays(a: Date | null, b: Date | null, days: number): boolean {
  if (!a || !b) return false;
  const diff = Math.abs(a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24);
  return diff <= days;
}

interface ParsedOpsMessage {
  activityAt: Date;
  company: string | null;
  instructors: string[];
  text: string;
}

function parseOpsMessage(text: string): { company: string | null; instructors: string[] } {
  const companyMatch = text.match(COMPANY_REGEX);
  const instructors = Array.from(text.matchAll(INSTRUCTOR_REGEX)).map((m) => m[1]);
  return {
    company: companyMatch?.[1]?.trim() ?? null,
    instructors: Array.from(new Set(instructors)),
  };
}

export async function GET(request: NextRequest) {
  if (!authorize(request)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const mode = request.nextUrl.searchParams.get("mode") ?? "dry_run";
  if (mode !== "dry_run") {
    return NextResponse.json(
      { ok: false, error: "apply mode not yet implemented (separate commit)" },
      { status: 400 }
    );
  }

  // 1. 운영보고 메시지 로드 + parse
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
    const cid =
      pickString(raw, "channel_id", "channel") ??
      pickString(ref, "channel_id", "channel");
    if (cid !== OPS_REPORT_CHANNEL_ID) continue;
    const text = pickString(raw, "text", "message", "body") ?? "";
    if (!text) continue;
    const parsed = parseOpsMessage(text);
    if (!parsed.company || parsed.instructors.length === 0) continue;
    if (!it.activityAt) continue;
    opsMessages.push({
      activityAt: it.activityAt,
      company: parsed.company,
      instructors: parsed.instructors,
      text: text.slice(0, 200),
    });
  }

  // 2. pending registries 로드
  const pending = await prisma.satisfactionReviewRegistry.findMany({
    where: { matchStatus: "pending" },
    select: {
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

  // 3. Instructor lookup (name → id, fulltime/practiceCoach 제외 안 함 — 매칭만)
  const allInstructors = await prisma.instructor.findMany({
    select: { id: true, name: true },
  });
  const instructorByName = new Map<string, { id: string; name: string }>();
  for (const inst of allInstructors) instructorByName.set(inst.name, inst);

  // 4. classify
  interface Classification {
    registryKey: string;
    sourceType: string;
    companyName: string | null;
    courseName: string | null;
    candidateName: string | null;
    responseCount: number;
    status:
      | "strong_single"
      | "multi_instructors"
      | "instructor_not_in_db"
      | "no_slack_match"
      | "no_company";
    matched_instructors: string[];
    matched_instructor_id?: string | null;
    evidence_message_count?: number;
    evidence_samples?: string[];
  }

  const classifications: Classification[] = [];

  for (const reg of pending) {
    if (!reg.companyName) {
      classifications.push({
        registryKey: reg.registryKey,
        sourceType: reg.sourceType,
        companyName: null,
        courseName: reg.courseName,
        candidateName: reg.candidateName,
        responseCount: reg.responseCount,
        status: "no_company",
        matched_instructors: [],
      });
      continue;
    }

    // responseDate 추출 — sourceRefs 안의 nested response_date 또는 registry에 별도 컬럼 없음
    // sourceRefs[0].response_date 형태로 저장됨 (이전 코드 추적 결과)
    const refs = Array.isArray(reg.sourceRefs) ? (reg.sourceRefs as RawRecord[]) : [];
    const firstRef = refs[0] as RawRecord | undefined;
    const refDate = pickString(firstRef, "response_date");
    const registryDate = refDate ? new Date(refDate) : null;

    // 슬랙 메시지 후보
    const matched_msgs = opsMessages.filter((m) => {
      if (!companyMatches(m.company, reg.companyName)) return false;
      if (registryDate && !withinDays(m.activityAt, registryDate, MATCH_WINDOW_DAYS)) {
        return false;
      }
      return true;
    });

    if (matched_msgs.length === 0) {
      classifications.push({
        registryKey: reg.registryKey,
        sourceType: reg.sourceType,
        companyName: reg.companyName,
        courseName: reg.courseName,
        candidateName: reg.candidateName,
        responseCount: reg.responseCount,
        status: "no_slack_match",
        matched_instructors: [],
      });
      continue;
    }

    const uniqueInstructors = Array.from(
      new Set(matched_msgs.flatMap((m) => m.instructors))
    );

    if (uniqueInstructors.length === 1) {
      const instName = uniqueInstructors[0];
      const inst = instructorByName.get(instName);
      classifications.push({
        registryKey: reg.registryKey,
        sourceType: reg.sourceType,
        companyName: reg.companyName,
        courseName: reg.courseName,
        candidateName: reg.candidateName,
        responseCount: reg.responseCount,
        status: inst ? "strong_single" : "instructor_not_in_db",
        matched_instructors: uniqueInstructors,
        matched_instructor_id: inst?.id ?? null,
        evidence_message_count: matched_msgs.length,
        evidence_samples: matched_msgs.slice(0, 2).map((m) => m.text),
      });
    } else {
      classifications.push({
        registryKey: reg.registryKey,
        sourceType: reg.sourceType,
        companyName: reg.companyName,
        courseName: reg.courseName,
        candidateName: reg.candidateName,
        responseCount: reg.responseCount,
        status: "multi_instructors",
        matched_instructors: uniqueInstructors,
        evidence_message_count: matched_msgs.length,
        evidence_samples: matched_msgs.slice(0, 2).map((m) => m.text),
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

  return NextResponse.json({
    ok: true,
    mode: "dry_run",
    durationMs: Date.now() - startedAt,
    total_pending: pending.length,
    ops_messages_parsed: opsMessages.length,
    classification_stats: stats,
    samples: {
      strong_single: classifications.filter((c) => c.status === "strong_single").slice(0, 10),
      multi_instructors: classifications.filter((c) => c.status === "multi_instructors").slice(0, 10),
      instructor_not_in_db: classifications.filter((c) => c.status === "instructor_not_in_db").slice(0, 5),
      no_slack_match: classifications.filter((c) => c.status === "no_slack_match").slice(0, 5),
      no_company: classifications.filter((c) => c.status === "no_company").slice(0, 5),
    },
    next_action:
      (stats["strong_single"] ?? 0) > 0
        ? `dry-run 검토 → ?mode=apply로 strong_single ${stats["strong_single"]}건 자동 resolve`
        : "strong_single 0건 — 알고리즘/regex 보강 또는 #general 채널 추가 검토",
  });
}
