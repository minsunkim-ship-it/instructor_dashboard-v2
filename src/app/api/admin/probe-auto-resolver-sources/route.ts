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
