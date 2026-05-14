/**
 * GET /api/admin/probe-pending-deep-samples
 *
 * 남은 pending registry 대표 case 3건 dump (운영자 UI 설계용).
 *   1. drive_satisfaction multi_instructors
 *   2. drive_satisfaction no_slack_match (운영보고 없음)
 *   3. gmail_summary no_signal (회사 매칭 실패)
 *
 * 각 sample:
 *   - registry info
 *   - ImportItem rawPayload (subject/body/sourceRef)
 *   - normalizedPayload (session_label, instructor_hint 등)
 *   - 운영보고 ±14일 / 회사 alias 매칭 메시지 (후보 강사)
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

const OPS_REPORT_CHANNEL_ID = "C015YD84VGS";
const INSTRUCTOR_REGEX = /([가-힣]{2,4}[A-Z]?)\s*(?:강사|대표|교수|선생)님/g;
const COMPANY_REGEX = /\(B2B\)\s*([^_\n]+?)[\s_]/;

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

interface PendingSample {
  category: string;
  registry: {
    registryKey: string;
    sourceType: string;
    companyName: string | null;
    courseName: string | null;
    candidateName: string | null;
    avgScore: number | null;
    responseCount: number;
    responseDate: string | null;
  };
  importItem: {
    subject: string | null;
    bodyHead: string | null;
    sourceRefKeys: string[];
    file_name: string | null;
    sheet_title: string | null;
    section_title: string | null;
    session_label: string | null;
    instructor_name_in_normalized: string | null;
    rawPayloadKeys: string[];
  } | null;
  ops_evidence_candidates: Array<{
    activityAt: string;
    parsed_company: string | null;
    parsed_instructors: string[];
    text_head: string;
  }>;
}

async function getRegistryByCategory(category: string) {
  if (category === "drive_multi" || category === "drive_no_slack") {
    return prisma.satisfactionReviewRegistry.findMany({
      where: { matchStatus: "pending", sourceType: "drive_satisfaction" },
      orderBy: { responseCount: "desc" },
    });
  }
  if (category === "gmail_no_signal") {
    return prisma.satisfactionReviewRegistry.findMany({
      where: { matchStatus: "pending", sourceType: "gmail_summary" },
      orderBy: { responseCount: "desc" },
    });
  }
  return [];
}

async function findImportItemForRegistry(
  registryKey: string,
  sourceType: string
): Promise<{
  rawPayload: RawRecord;
  normalizedPayload: RawRecord;
  sourceRef: RawRecord;
} | null> {
  const items = await prisma.satisfactionImportItem.findMany({
    where: { sourceType },
    select: { rawPayload: true, normalizedPayload: true, sourceRef: true },
    take: 5000,
  });
  for (const it of items) {
    const np = (it.normalizedPayload as RawRecord | null) ?? {};
    const rk = pickString(np, "registry_key");
    if (rk === registryKey) {
      return {
        rawPayload: (it.rawPayload as RawRecord | null) ?? {},
        normalizedPayload: np,
        sourceRef: (it.sourceRef as RawRecord | null) ?? {},
      };
    }
  }
  return null;
}

export async function GET(request: NextRequest) {
  if (!authorize(request)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const startedAt = Date.now();

  // 1) ops_report 메시지
  const slackItems = await prisma.activityImportItem.findMany({
    where: { sourceType: "slack" },
    select: { rawPayload: true, sourceRef: true, activityAt: true },
    take: 5000,
    orderBy: { activityAt: "desc" },
  });
  const opsMessages = slackItems
    .filter((it) => {
      const raw = (it.rawPayload as RawRecord | null) ?? {};
      const ref = (it.sourceRef as RawRecord | null) ?? {};
      const cid =
        pickString(raw, "channel_id", "channel") ?? pickString(ref, "channel_id", "channel");
      return cid === OPS_REPORT_CHANNEL_ID;
    })
    .map((it) => {
      const raw = (it.rawPayload as RawRecord | null) ?? {};
      const text = pickString(raw, "text", "message", "body") ?? "";
      const companyMatch = text.match(COMPANY_REGEX);
      const instructors = Array.from(text.matchAll(INSTRUCTOR_REGEX)).map((m) => m[1]);
      return {
        activityAt: it.activityAt,
        company: companyMatch?.[1]?.trim() ?? null,
        instructors: Array.from(new Set(instructors)),
        text: text.slice(0, 300),
      };
    })
    .filter((m) => m.activityAt !== null);

  // 2) 카테고리별 sample 찾기
  async function buildSample(
    category: string,
    filter: (r: {
      registryKey: string;
      sourceType: string;
      companyName: string | null;
      courseName: string | null;
      candidateName: string | null;
      avgScore: import("@prisma/client").Prisma.Decimal | null;
      responseCount: number;
      sourceRefs: unknown;
    }) => Promise<boolean> | boolean
  ): Promise<PendingSample | null> {
    const candidates = await getRegistryByCategory(category);
    for (const reg of candidates) {
      const passes = await filter(reg);
      if (!passes) continue;
      const refs = Array.isArray(reg.sourceRefs) ? (reg.sourceRefs as RawRecord[]) : [];
      const firstRef = refs[0] as RawRecord | undefined;
      const responseDateStr = pickString(firstRef, "response_date");
      const item = await findImportItemForRegistry(reg.registryKey, reg.sourceType);
      const responseDate = responseDateStr ? new Date(responseDateStr) : null;
      const opsCandidates = responseDate
        ? opsMessages
            .filter((m) => {
              if (!m.activityAt) return false;
              const diff = Math.abs(m.activityAt.getTime() - responseDate.getTime()) / (1000 * 60 * 60 * 24);
              if (diff > 14) return false;
              if (reg.companyName && !companyMatches(m.company, reg.companyName)) return false;
              return true;
            })
            .slice(0, 5)
            .map((m) => ({
              activityAt: m.activityAt!.toISOString(),
              parsed_company: m.company,
              parsed_instructors: m.instructors,
              text_head: m.text,
            }))
        : [];
      return {
        category,
        registry: {
          registryKey: reg.registryKey,
          sourceType: reg.sourceType,
          companyName: reg.companyName,
          courseName: reg.courseName,
          candidateName: reg.candidateName,
          avgScore: reg.avgScore !== null ? Number(reg.avgScore) : null,
          responseCount: reg.responseCount,
          responseDate: responseDateStr,
        },
        importItem: item
          ? {
              subject: pickString(item.rawPayload, "subject"),
              bodyHead: pickString(item.rawPayload, "body_excerpt", "text", "body")?.slice(0, 500) ?? null,
              sourceRefKeys: Object.keys(item.sourceRef),
              file_name: pickString(item.sourceRef, "file_name"),
              sheet_title: pickString(item.sourceRef, "sheet_title"),
              section_title: pickString(item.rawPayload, "section_title"),
              session_label: pickString(item.normalizedPayload, "session_label"),
              instructor_name_in_normalized: pickString(item.normalizedPayload, "instructor_name"),
              rawPayloadKeys: Object.keys(item.rawPayload),
            }
          : null,
        ops_evidence_candidates: opsCandidates,
      };
    }
    return null;
  }

  // 카테고리 1: drive multi (응답수 큰 것 우선)
  const sample1 = await buildSample("drive_multi", async (r) => {
    const refs = Array.isArray(r.sourceRefs) ? (r.sourceRefs as RawRecord[]) : [];
    const firstRef = refs[0] as RawRecord | undefined;
    const responseDateStr = pickString(firstRef, "response_date");
    if (!responseDateStr || !r.companyName) return false;
    const responseDate = new Date(responseDateStr);
    const ops = opsMessages.filter((m) => {
      if (!m.activityAt) return false;
      const diff = Math.abs(m.activityAt.getTime() - responseDate.getTime()) / (1000 * 60 * 60 * 24);
      if (diff > 7) return false;
      return companyMatches(m.company, r.companyName);
    });
    const unique = new Set(ops.flatMap((m) => m.instructors));
    return unique.size >= 2 && r.responseCount >= 5; // multi + 5응답 이상
  });

  // 카테고리 2: drive no_slack_match
  const sample2 = await buildSample("drive_no_slack", async (r) => {
    const refs = Array.isArray(r.sourceRefs) ? (r.sourceRefs as RawRecord[]) : [];
    const firstRef = refs[0] as RawRecord | undefined;
    const responseDateStr = pickString(firstRef, "response_date");
    if (!responseDateStr || !r.companyName) return false;
    const responseDate = new Date(responseDateStr);
    const ops = opsMessages.filter((m) => {
      if (!m.activityAt) return false;
      const diff = Math.abs(m.activityAt.getTime() - responseDate.getTime()) / (1000 * 60 * 60 * 24);
      if (diff > 7) return false;
      return companyMatches(m.company, r.companyName);
    });
    return ops.length === 0 && r.responseCount >= 5;
  });

  // 카테고리 3: gmail no_signal (회사 매칭 실패 + 응답수 큰 것)
  const sample3 = await buildSample("gmail_no_signal", async (r) => {
    if (!r.companyName) {
      return r.responseCount >= 5;
    }
    const refs = Array.isArray(r.sourceRefs) ? (r.sourceRefs as RawRecord[]) : [];
    const firstRef = refs[0] as RawRecord | undefined;
    const responseDateStr = pickString(firstRef, "response_date");
    if (!responseDateStr) return false;
    const responseDate = new Date(responseDateStr);
    const ops = opsMessages.filter((m) => {
      if (!m.activityAt) return false;
      const diff = Math.abs(m.activityAt.getTime() - responseDate.getTime()) / (1000 * 60 * 60 * 24);
      return diff <= 7 && companyMatches(m.company, r.companyName);
    });
    return ops.length === 0 && r.responseCount >= 5;
  });

  return NextResponse.json({
    ok: true,
    durationMs: Date.now() - startedAt,
    samples: [sample1, sample2, sample3].filter((s) => s !== null),
  });
}
