/**
 * GET /api/admin/probe-auto-resolver-sources
 *
 * Phase γ Step 0 — Pending/Alias auto-resolver 설계 입력 점검 (read-only).
 *
 * 점검 항목:
 *  1. ActivityImportItem(sourceType="slack") 채널 분포 + #general 샘플 — γ-A1 매칭 source
 *  2. SatisfactionReviewRegistry(matchStatus="pending") 전체 list — γ-A1 매칭 대상
 *  3. Instructor.contactEmail/contactPhone 채움 비율 — γ-C1 strong signal source
 *  4. ActivityImportItem.candidateEmail 채움 비율 — γ-C1 cross-check source
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

export async function GET(request: NextRequest) {
  if (!authorize(request)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();

  // γ-A1 매칭 알고리즘 후보 정규식 — 운영보고 메시지 패턴
  // 예: "*<URL|(B2B) KB금융그룹(국민은행)_Agent 기획·설계·구현_이한준 강사님_5회차/5회차 강의 내용 공유드립니다>*"
  // 1) (B2B) 다음 회사명: _ 또는 "(" 까지
  // 2) 마지막에 등장하는 "{이름} 강사님" — backward 추출
  // 3) 강사명: 한글 2~4자 + 선택적 영문 1자 (동명이인 suffix A/B 등)
  const OPS_REPORT_INSTRUCTOR_REGEX = /([가-힣]{2,4}[A-Z]?)\s*강사님/g;
  const OPS_REPORT_COMPANY_REGEX = /\(B2B\)\s*([^_\n]+?)_/;
  const OPS_REPORT_SESSION_REGEX = /_(\d+)\s*(?:회차|차수|일차)(?:\s*\/\s*\d+\s*(?:회차|차수|일차))?/;

  function parseOpsReportText(text: string | null | undefined): {
    company: string | null;
    instructors: string[];
    sessionNumber: number | null;
    hasB2BPrefix: boolean;
  } {
    if (!text) return { company: null, instructors: [], sessionNumber: null, hasB2BPrefix: false };
    const companyMatch = text.match(OPS_REPORT_COMPANY_REGEX);
    const instructors = Array.from(text.matchAll(OPS_REPORT_INSTRUCTOR_REGEX)).map((m) => m[1]);
    const sessionMatch = text.match(OPS_REPORT_SESSION_REGEX);
    return {
      company: companyMatch?.[1]?.trim() ?? null,
      instructors: Array.from(new Set(instructors)),
      sessionNumber: sessionMatch ? parseInt(sessionMatch[1], 10) : null,
      hasB2BPrefix: /\(B2B\)/i.test(text),
    };
  }

  // detail mode — 채널별 메시지 sample 깊이 dump (γ-A1 패턴 분석)
  const detail = request.nextUrl.searchParams.get("detail");

  // detail=ops_report_pattern_test — 운영보고 채널 전체에 패턴 정규식 적용해서 추출 성공/실패 측정
  if (detail === "ops_report_pattern_test") {
    const channelId = request.nextUrl.searchParams.get("channel_id") ?? "C015YD84VGS";
    const items = await prisma.activityImportItem.findMany({
      where: { sourceType: "slack" },
      select: {
        rawPayload: true,
        sourceRef: true,
        activityAt: true,
      },
      take: 5000,
      orderBy: { activityAt: "desc" },
    });
    const inChannel = items.filter((it) => {
      const raw = (it.rawPayload as RawRecord | null) ?? {};
      const ref = (it.sourceRef as RawRecord | null) ?? {};
      const cid =
        pickString(raw, "channel_id", "channel") ??
        pickString(ref, "channel_id", "channel");
      return cid === channelId;
    });

    let withB2B = 0;
    let companyExtracted = 0;
    let instructorExtracted = 0;
    let bothExtracted = 0;
    let multipleInstructors = 0;
    const companyDist = new Map<string, number>();
    const instructorDist = new Map<string, number>();
    const sampleSuccesses: Array<{ text: string; parsed: ReturnType<typeof parseOpsReportText> }> = [];
    const sampleFailures: Array<{ text: string; parsed: ReturnType<typeof parseOpsReportText> }> = [];

    for (const it of inChannel) {
      const raw = (it.rawPayload as RawRecord | null) ?? {};
      const text = pickString(raw, "text", "message", "body") ?? "";
      const parsed = parseOpsReportText(text);
      if (parsed.hasB2BPrefix) withB2B += 1;
      if (parsed.company) {
        companyExtracted += 1;
        companyDist.set(parsed.company, (companyDist.get(parsed.company) ?? 0) + 1);
      }
      if (parsed.instructors.length > 0) {
        instructorExtracted += 1;
        for (const i of parsed.instructors) instructorDist.set(i, (instructorDist.get(i) ?? 0) + 1);
      }
      if (parsed.instructors.length > 1) multipleInstructors += 1;
      if (parsed.company && parsed.instructors.length > 0) bothExtracted += 1;

      if (parsed.company && parsed.instructors.length === 1 && sampleSuccesses.length < 8) {
        sampleSuccesses.push({ text: text.slice(0, 250), parsed });
      }
      if (parsed.hasB2BPrefix && (!parsed.company || parsed.instructors.length === 0) && sampleFailures.length < 8) {
        sampleFailures.push({ text: text.slice(0, 250), parsed });
      }
    }

    return NextResponse.json({
      ok: true,
      mode: "ops_report_pattern_test",
      channel_id: channelId,
      stats: {
        total: inChannel.length,
        with_b2b_prefix: withB2B,
        company_extracted: companyExtracted,
        instructor_extracted: instructorExtracted,
        both_extracted: bothExtracted,
        multiple_instructors: multipleInstructors,
        extraction_rate_company: inChannel.length > 0 ? `${((companyExtracted / inChannel.length) * 100).toFixed(2)}%` : "0%",
        extraction_rate_both: inChannel.length > 0 ? `${((bothExtracted / inChannel.length) * 100).toFixed(2)}%` : "0%",
      },
      top_companies: Array.from(companyDist.entries()).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => ({ company: k, count: v })),
      top_instructors: Array.from(instructorDist.entries()).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => ({ instructor: k, count: v })),
      sample_successes: sampleSuccesses,
      sample_failures: sampleFailures,
    });
  }
  if (detail === "channel_messages") {
    const channelId = request.nextUrl.searchParams.get("channel_id");
    const limitRaw = request.nextUrl.searchParams.get("limit");
    const limit = limitRaw ? Math.min(Math.max(parseInt(limitRaw, 10), 1), 200) : 50;
    if (!channelId) {
      return NextResponse.json({ ok: false, error: "channel_id required" }, { status: 400 });
    }
    const items = await prisma.activityImportItem.findMany({
      where: {
        sourceType: "slack",
      },
      select: {
        candidateName: true,
        candidateEmail: true,
        activityAt: true,
        isOpsReport: true,
        isDispatchRequest: true,
        rawPayload: true,
        sourceRef: true,
      },
      take: 2000,
      orderBy: { activityAt: "desc" },
    });
    const filtered = items.filter((it) => {
      const raw = (it.rawPayload as RawRecord | null) ?? {};
      const ref = (it.sourceRef as RawRecord | null) ?? {};
      const cid =
        pickString(raw, "channel_id", "channel") ??
        pickString(ref, "channel_id", "channel");
      return cid === channelId;
    });
    return NextResponse.json({
      ok: true,
      mode: "channel_messages",
      channel_id: channelId,
      sample_count: Math.min(filtered.length, limit),
      total_matched_in_window: filtered.length,
      messages: filtered.slice(0, limit).map((it) => {
        const raw = (it.rawPayload as RawRecord | null) ?? {};
        return {
          activityAt: it.activityAt?.toISOString() ?? null,
          author_real_name: pickString(raw, "author_real_name") ?? null,
          author_display_name: pickString(raw, "author_display_name") ?? null,
          is_bot: raw.is_bot ?? null,
          reply_count: raw.reply_count ?? null,
          isOpsReport: it.isOpsReport,
          isDispatchRequest: it.isDispatchRequest,
          candidateName: it.candidateName,
          candidateEmail: it.candidateEmail,
          text: pickString(raw, "text", "message", "body")?.slice(0, 600) ?? null,
        };
      }),
    });
  }

  // 1) Slack activity items — 채널 분포 + sample (rawPayload structure 파악)
  const slackItems = await prisma.activityImportItem.findMany({
    where: { sourceType: "slack" },
    select: {
      id: true,
      candidateName: true,
      candidateEmail: true,
      activityAt: true,
      isOpsReport: true,
      isDispatchRequest: true,
      matchStatus: true,
      matchedInstructorId: true,
      rawPayload: true,
      sourceRef: true,
    },
    take: 1000,
    orderBy: { activityAt: "desc" },
  });

  const channelCounts = new Map<string, number>();
  for (const it of slackItems) {
    const raw = (it.rawPayload as RawRecord | null) ?? {};
    const ref = (it.sourceRef as RawRecord | null) ?? {};
    const channel =
      pickString(raw, "channel", "channel_name", "channel_id") ??
      pickString(ref, "channel", "channel_name", "channel_id") ??
      "(unknown)";
    channelCounts.set(channel, (channelCounts.get(channel) ?? 0) + 1);
  }
  const channelDistribution = Array.from(channelCounts.entries())
    .map(([channel, count]) => ({ channel, count }))
    .sort((a, b) => b.count - a.count);

  // #general 또는 general 포함 채널 sample 5건
  const generalSamples = slackItems
    .filter((it) => {
      const raw = (it.rawPayload as RawRecord | null) ?? {};
      const ref = (it.sourceRef as RawRecord | null) ?? {};
      const channel =
        pickString(raw, "channel", "channel_name", "channel_id") ??
        pickString(ref, "channel", "channel_name", "channel_id") ??
        "";
      return /general/i.test(channel);
    })
    .slice(0, 5)
    .map((it) => {
      const raw = (it.rawPayload as RawRecord | null) ?? {};
      const text =
        pickString(raw, "text", "message", "body", "content")?.slice(0, 500) ?? null;
      return {
        candidateName: it.candidateName,
        activityAt: it.activityAt?.toISOString() ?? null,
        isOpsReport: it.isOpsReport,
        isDispatchRequest: it.isDispatchRequest,
        matchStatus: it.matchStatus,
        rawKeys: Object.keys(raw),
        sourceRefKeys: Object.keys((it.sourceRef as RawRecord | null) ?? {}),
        textHead: text,
      };
    });

  // 전체 sourceType=slack 의 sample 1건 (구조 파악)
  const slackSample = slackItems[0]
    ? {
        candidateName: slackItems[0].candidateName,
        candidateEmail: slackItems[0].candidateEmail,
        activityAt: slackItems[0].activityAt?.toISOString() ?? null,
        isOpsReport: slackItems[0].isOpsReport,
        rawPayload: slackItems[0].rawPayload,
        sourceRef: slackItems[0].sourceRef,
      }
    : null;

  // 2) Pending registry — 전체 list (dump)
  const pendingRegistries = await prisma.satisfactionReviewRegistry.findMany({
    where: { matchStatus: "pending" },
    select: {
      registryKey: true,
      sourceType: true,
      candidateName: true,
      companyName: true,
      courseName: true,
      avgScore: true,
      responseCount: true,
      suggestedInstructorId: true,
      sourceRefs: true,
      updatedAt: true,
    },
    orderBy: { updatedAt: "desc" },
  });

  const pendingSummary = {
    total: pendingRegistries.length,
    by_company: Array.from(
      pendingRegistries.reduce((map, r) => {
        const key = r.companyName ?? "(null)";
        map.set(key, (map.get(key) ?? 0) + 1);
        return map;
      }, new Map<string, number>())
    )
      .map(([company, count]) => ({ company, count }))
      .sort((a, b) => b.count - a.count),
    by_course: Array.from(
      pendingRegistries.reduce((map, r) => {
        const key = r.courseName ?? "(null)";
        map.set(key, (map.get(key) ?? 0) + 1);
        return map;
      }, new Map<string, number>())
    )
      .map(([course, count]) => ({ course, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 15),
    samples_first_10: pendingRegistries.slice(0, 10).map((r) => ({
      registryKey: r.registryKey,
      sourceType: r.sourceType,
      candidateName: r.candidateName,
      companyName: r.companyName,
      courseName: r.courseName,
      avg: r.avgScore !== null ? Number(r.avgScore) : null,
      count: r.responseCount,
    })),
  };

  // 3) Instructor.contactEmail/contactPhone 채움 비율
  const totalInstructors = await prisma.instructor.count();
  const withEmail = await prisma.instructor.count({
    where: { contactEmail: { not: null } },
  });
  const withPhone = await prisma.instructor.count({
    where: { contactPhone: { not: null } },
  });
  const withBoth = await prisma.instructor.count({
    where: {
      AND: [
        { contactEmail: { not: null } },
        { contactPhone: { not: null } },
      ],
    },
  });

  // 4) ActivityImportItem.candidateEmail 채움 비율 (gmail + slack)
  const allActivity = await prisma.activityImportItem.count();
  const activityWithEmail = await prisma.activityImportItem.count({
    where: { candidateEmail: { not: null } },
  });

  // 5) activity sourceType 분포
  const activityBySource = await prisma.activityImportItem.groupBy({
    by: ["sourceType"],
    _count: { _all: true },
  });

  return NextResponse.json({
    ok: true,
    durationMs: Date.now() - startedAt,
    slack_probe: {
      total_slack_items: slackItems.length,
      channel_distribution: channelDistribution,
      general_channel_samples: generalSamples,
      first_slack_sample: slackSample,
    },
    pending_registry: pendingSummary,
    instructor_contact_coverage: {
      total: totalInstructors,
      with_email: withEmail,
      with_phone: withPhone,
      with_both: withBoth,
      email_rate: totalInstructors > 0 ? `${((withEmail / totalInstructors) * 100).toFixed(2)}%` : "0%",
      phone_rate: totalInstructors > 0 ? `${((withPhone / totalInstructors) * 100).toFixed(2)}%` : "0%",
    },
    activity_candidate_email_coverage: {
      total: allActivity,
      with_email: activityWithEmail,
      rate: allActivity > 0 ? `${((activityWithEmail / allActivity) * 100).toFixed(2)}%` : "0%",
      by_source_type: activityBySource.map((row) => ({
        sourceType: row.sourceType,
        count: row._count._all,
      })),
    },
  });
}
