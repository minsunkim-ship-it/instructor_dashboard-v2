/**
 * GET /api/admin/test-renormalize-gmail?registry_key=...&limit=20
 * GET /api/admin/test-renormalize-gmail?thread_id=...
 * GET /api/admin/test-renormalize-gmail?suspect=1  — 가장 score≤2.5+n≤2 record들의 thread를 자동 선택
 *
 * 기존 SatisfactionImportItem의 raw_payload + normalizedPayload를 v23 새 normalizer 로직(parseScoreFromText/parseCompanyHintFromCourseName/parseCompanyHintFromSubject/parseRespondentCountFromText)에 통과시켜 before vs after 비교.
 *
 * READ-ONLY (DB write 안 함). Step 2 dry_run.
 *
 * 인증: CRON_SECRET
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type RawRecord = { [key: string]: unknown };
function pickString(o: RawRecord | undefined | null, ...keys: string[]): string | null {
  if (!o) return null;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return null;
}
function pickNumber(o: RawRecord | undefined | null, ...keys: string[]): number | null {
  if (!o) return null;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const n = parseFloat(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

// ============ v23 새 normalize 로직 inline (테스트용) ============
function parseNumber(value: string): number | null {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function looksLikeKoreanPhrasePrefix(value: string): boolean {
  if (/(지난|오늘|어제|작일|금일|이번주|이번\s*주|작년|올해|내년)/.test(value)) return true;
  if (/(진행한|진행된|진행하|진행해주신|진행하였|진행됐|진행됬|보내|드립니다|드린|작성해|말씀|확인)/.test(value)) return true;
  if (/^\d{1,4}\s*[월\/\-.]\s*\d{1,2}/.test(value)) return true;
  if (/^\d{1,2}\s*월\s*\d{1,2}\s*일/.test(value)) return true;
  if (/[~]/.test(value)) return true;
  if (/^[\s\d~월일\/\-.,()]+$/.test(value)) return true;
  if (/^[\s\[\(]/.test(value)) return true;
  return false;
}

function newParseCompanyHintFromCourseName(courseName: string | null | undefined): string | null {
  const cleaned = (courseName ?? "").trim();
  if (!cleaned) return null;
  if (/(님께|요청드립니다|요청 드립니다|정산|안내|세금계산서|결과 전달|결과 공유|리마인드|발행 정보)/i.test(cleaned)) {
    return null;
  }
  if (looksLikeKoreanPhrasePrefix(cleaned)) return null;
  const dashMatch = cleaned.match(/^([^-\n]{2,30}?)\s*-\s*/);
  if (dashMatch?.[1]) {
    const c = dashMatch[1].trim();
    if (looksLikeKoreanPhrasePrefix(c)) return null;
    return c;
  }
  const underscoreMatch = cleaned.match(/^([^_\n]{2,30}?)_/);
  if (underscoreMatch?.[1]) {
    const c = underscoreMatch[1].trim();
    if (looksLikeKoreanPhrasePrefix(c)) return null;
    return c;
  }
  return null;
}

function newParseCompanyHintFromSubject(subject: string | null | undefined): string | null {
  const cleaned = (subject ?? "").trim();
  if (!cleaned) return null;
  const bracketMatch = cleaned.match(/^\[[^/\]]+\/([^\]]+)\]/);
  if (bracketMatch?.[1]) return bracketMatch[1].trim();
  const bracketDashMatch = cleaned.match(/^\[[^\]]+\]\s*([^-\n]{2,30}?)\s*-/);
  if (bracketDashMatch?.[1] && !bracketDashMatch[1].includes("님께")) {
    return bracketDashMatch[1].trim();
  }
  const directDashMatch = cleaned.match(/^([가-힣A-Za-z0-9()]{2,30})\s*[-–_]\s*/);
  if (directDashMatch?.[1] && !directDashMatch[1].includes("강사") && !directDashMatch[1].includes("님께")) {
    return directDashMatch[1].trim();
  }
  const underscoreMatch = cleaned.match(/-\s*([^_]+)_/);
  if (underscoreMatch?.[1]) return underscoreMatch[1].trim();
  const singleBracket = cleaned.match(/^\[([가-힣A-Za-z0-9()]{2,30})\]\s/);
  if (singleBracket?.[1] && !/(패스트캠퍼스|day1|Day1)/i.test(singleBracket[1])) {
    return singleBracket[1].trim();
  }
  return null;
}

function newParseScoreFromText(text: string): { score: number | null; scale: "10" | "5" | null; matched_text: string | null } {
  if (!text) return { score: null, scale: null, matched_text: null };
  const tenScalePatterns = [
    /10\s*점\s*척도[\s\S]{0,80}?(?:중|에서|기준)?\s*([6-9](?:\.\d+)?|10(?:\.0+)?)\s*점/i,
    /10\s*점\s*(?:만점|만족)[\s\S]{0,40}?(?:중|에서)?\s*([6-9](?:\.\d+)?|10(?:\.0+)?)\s*점?/i,
    /(\d+(?:\.\d+)?)\s*\/\s*10\s*점?(?!\d)/,
    /(\d+(?:\.\d+)?)\s*점\s*\/\s*10\s*점?/,
    /만족도[\s\S]{0,40}?10\s*점\s*(?:척도|만점|만족)[\s\S]{0,40}?([6-9](?:\.\d+)?|10(?:\.0+)?)\s*점/i,
  ];
  for (const pattern of tenScalePatterns) {
    const match = text.match(pattern);
    if (!match?.[1]) continue;
    const parsed = parseNumber(match[1]);
    if (parsed === null) continue;
    if (parsed > 5 && parsed <= 10) {
      return { score: Math.round((parsed / 2) * 100) / 100, scale: "10", matched_text: match[0]?.slice(0, 80) ?? null };
    }
    if (parsed >= 1 && parsed <= 5) {
      return { score: Math.round((parsed / 2) * 100) / 100, scale: "10", matched_text: match[0]?.slice(0, 80) ?? null };
    }
  }
  const fiveScalePatterns = [
    /강의\s*만족도(?:\s*평가)?[^\d]{0,10}([1-5](?:\.\d+)?)(?:\s*\/\s*5(?:\.0)?)?/i,
    /강사\s*만족도[^\d]{0,10}([1-5](?:\.\d+)?)(?:\s*\/\s*5(?:\.0)?)?/i,
    /전체\s*만족도[^\d]{0,10}([1-5](?:\.\d+)?)(?:\s*\/\s*5(?:\.0)?)?/i,
    /(?:종합\s*평균\s*만족도|평균\s*만족도|만족도\s*평균|평균\s*점수|종합\s*만족도)[^\d]{0,10}([1-5](?:\.\d+)?)/i,
  ];
  const candidateLines = text.split("\n").map((r) => r.trim()).filter(Boolean);
  for (const line of candidateLines) {
    for (const pattern of fiveScalePatterns) {
      const match = line.match(pattern);
      if (!match?.[1]) continue;
      const parsed = parseNumber(match[1]);
      if (parsed !== null && parsed >= 1 && parsed <= 5) return { score: parsed, scale: "5", matched_text: line.slice(0, 80) };
    }
  }
  return { score: null, scale: null, matched_text: null };
}

function newParseRespondentCount(text: string): number | null {
  if (!text) return null;
  const patterns = [
    /응답인원[^\d]*(\d+)명/,
    /설문\s*참여인원[^\d]*(\d+)명?/i,
    /응답\s*수[^\d]*(\d+)명?/i,
    /만족도\s*인원[^\d]*(\d+)명?/i,
    /응답자\s*수[^\d]*(\d+)명?/i,
    /응답 평균\s*\(n\s*=\s*(\d+)\)/i,
    /\(n\s*=\s*(\d+)\)[^\n]{0,80}종합 평균 만족도/i,
    /n\s*=\s*(\d+)/i,
    /참여\s*인원[^\d]*(\d+)명?/i,
    /수강\s*인원[^\d]*(\d+)명?/i,
    /응답한\s*인원[^\d]*(\d+)명?/i,
    /(\d+)\s*명\s*(?:응답|참여|수강)/i,
    /총\s*응답[^\d]*(\d+)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const n = parseInt(match[1], 10);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

// ============ END inline logic ============

export async function GET(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const registryKey = request.nextUrl.searchParams.get("registry_key");
  const threadId = request.nextUrl.searchParams.get("thread_id");
  const suspect = request.nextUrl.searchParams.get("suspect");
  const limit = parseInt(request.nextUrl.searchParams.get("limit") ?? "20", 10);

  let items: Array<{
    id: string;
    sourceRefKey: string | null;
    rawPayload: unknown;
    normalizedPayload: unknown;
    candidateName: string | null;
    candidateCompanyName: string | null;
    candidateCourseName: string | null;
  }> = [];

  if (registryKey) {
    const registry = await prisma.satisfactionReviewRegistry.findUnique({
      where: { registryKey },
      select: { sourceRefs: true },
    });
    if (registry) {
      const refs = Array.isArray(registry.sourceRefs) ? (registry.sourceRefs as RawRecord[]) : [];
      const tids = new Set<string>();
      for (const r of refs) {
        const inner = r?.source_ref as RawRecord | undefined;
        const tid = pickString(inner, "thread_id");
        if (tid) tids.add(tid);
      }
      if (tids.size > 0) {
        items = await prisma.satisfactionImportItem.findMany({
          where: {
            OR: Array.from(tids).map((tid) => ({
              sourceRefKey: { startsWith: `gmail_satisfaction:${tid}:` },
            })),
          },
          select: {
            id: true,
            sourceRefKey: true,
            rawPayload: true,
            normalizedPayload: true,
            candidateName: true,
            candidateCompanyName: true,
            candidateCourseName: true,
          },
          take: limit,
        });
      }
    }
  } else if (threadId) {
    items = await prisma.satisfactionImportItem.findMany({
      where: { sourceRefKey: { startsWith: `gmail_satisfaction:${threadId}:` } },
      select: {
        id: true,
        sourceRefKey: true,
        rawPayload: true,
        normalizedPayload: true,
        candidateName: true,
        candidateCompanyName: true,
        candidateCourseName: true,
      },
      take: limit,
    });
  } else if (suspect === "1") {
    // 가장 의심스러운 record들의 thread_id를 자동 선택
    const susRecs = await prisma.satisfactionRecord.findMany({
      where: { score: { lte: 2.5 }, respondentCount: { lte: 2 } },
      select: { sourceRef: true },
      take: 50,
    });
    const tids = new Set<string>();
    for (const r of susRecs) {
      const sr = r.sourceRef as RawRecord | null;
      const refs = Array.isArray(sr?.source_refs) ? (sr!.source_refs as RawRecord[]) : [];
      for (const ref of refs) {
        const inner = ref?.source_ref as RawRecord | undefined;
        const tid = pickString(inner, "thread_id");
        if (tid) tids.add(tid);
      }
    }
    if (tids.size > 0) {
      items = await prisma.satisfactionImportItem.findMany({
        where: {
          OR: Array.from(tids).map((tid) => ({
            sourceRefKey: { startsWith: `gmail_satisfaction:${tid}:` },
          })),
        },
        select: {
          id: true,
          sourceRefKey: true,
          rawPayload: true,
          normalizedPayload: true,
          candidateName: true,
          candidateCompanyName: true,
          candidateCourseName: true,
        },
        take: limit,
      });
    }
  } else {
    return NextResponse.json({ ok: false, error: "registry_key | thread_id | suspect=1 required" }, { status: 400 });
  }

  if (items.length === 0) {
    return NextResponse.json({ ok: true, message: "no items found", items: [] });
  }

  const result = items.map((it) => {
    const raw = (it.rawPayload as RawRecord) ?? {};
    const norm = (it.normalizedPayload as RawRecord) ?? {};
    const subject = pickString(raw, "subject");
    const snippet = pickString(raw, "snippet");
    const body = pickString(raw, "body_excerpt", "body");
    const haystack = [subject, snippet, body].filter(Boolean).join("\n");

    const oldScore = pickNumber(norm, "score_normalized", "scoreNormalized");
    const oldCompany = it.candidateCompanyName ?? pickString(norm, "company_name", "companyName");
    const oldCourse = it.candidateCourseName ?? pickString(norm, "course_name", "courseName");
    const oldRespondent = pickNumber(norm, "respondent_count", "respondentCount");

    const newScoreObj = newParseScoreFromText(haystack);
    const newCompanyFromCourse = newParseCompanyHintFromCourseName(oldCourse);
    const newCompanyFromSubject = newParseCompanyHintFromSubject(subject);
    const newRespondent = newParseRespondentCount(haystack);

    const changed = {
      score:
        oldScore !== null &&
        newScoreObj.score !== null &&
        Math.abs(oldScore - newScoreObj.score) > 0.01,
      company_from_course: oldCompany !== newCompanyFromCourse,
      respondent: oldRespondent !== newRespondent && newRespondent !== null,
    };

    return {
      source_ref_key: it.sourceRefKey,
      subject: subject?.slice(0, 120) ?? null,
      old: {
        score: oldScore,
        company: oldCompany,
        course: oldCourse?.slice(0, 80) ?? null,
        respondent: oldRespondent,
      },
      new: {
        score: newScoreObj.score,
        score_scale: newScoreObj.scale,
        score_matched: newScoreObj.matched_text,
        company_from_course: newCompanyFromCourse,
        company_from_subject: newCompanyFromSubject,
        respondent: newRespondent,
      },
      changed,
      body_head: haystack?.slice(0, 300) ?? null,
    };
  });

  const summary = {
    total: result.length,
    score_changed: result.filter((r) => r.changed.score).length,
    company_changed: result.filter((r) => r.changed.company_from_course).length,
    respondent_changed: result.filter((r) => r.changed.respondent).length,
  };

  return NextResponse.json({ ok: true, summary, items: result });
}
