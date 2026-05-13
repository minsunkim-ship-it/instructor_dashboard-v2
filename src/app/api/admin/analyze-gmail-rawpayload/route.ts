/**
 * GET /api/admin/analyze-gmail-rawpayload
 *
 * C 트랙 Step 1 — gmail satisfaction rawPayload 손실 원인 정량화 (read-only).
 *
 * 인증: CRON_SECRET (header `x-cron-secret` 또는 query `?secret=`)
 *
 * 호출 예:
 *   fetch('/api/admin/analyze-gmail-rawpayload?secret=...').then(r => r.json()).then(console.log)
 *
 * 응답:
 *   { total, extracted, notExtracted, extractionRate, rawPayloadKeys, bodyLengthBuckets,
 *     urlBuckets, subjectKeyword, failureSamples }
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const BODY_CUTOFF = 1200;

function authorize(request: NextRequest): boolean {
  const headerSecret = request.headers.get(CRON_SECRET_HEADER);
  if (isValidCronSecret(headerSecret)) return true;
  const querySecret = request.nextUrl.searchParams.get("secret");
  if (isValidCronSecret(querySecret)) return true;
  return false;
}

interface UrlBuckets {
  spreadsheetsDocs: number;
  formsDocs: number;
  driveFile: number;
  formsGle: number;
  googGl: number;
  bitLy: number;
  otherHttp: number;
}

function classifyUrls(text: string, into: UrlBuckets): void {
  if (!text) return;
  const matches = text.match(/https?:\/\/[^\s<>"'\)\]]+/g) ?? [];
  for (const url of matches) {
    if (/docs\.google\.com\/spreadsheets\/d\//.test(url)) into.spreadsheetsDocs += 1;
    else if (/docs\.google\.com\/forms\/d\//.test(url)) into.formsDocs += 1;
    else if (/drive\.google\.com\/file\/d\//.test(url)) into.driveFile += 1;
    else if (/forms\.gle\//.test(url)) into.formsGle += 1;
    else if (/goo\.gl\//.test(url)) into.googGl += 1;
    else if (/bit\.ly\//.test(url)) into.bitLy += 1;
    else into.otherHttp += 1;
  }
}

function hasSurveyKeyword(text: string | null | undefined): boolean {
  if (!text) return false;
  return /만족도|설문|평가|survey|satisfaction|feedback/i.test(text);
}

function extractSpreadsheetIds(text: string | null | undefined): string[] {
  if (!text) return [];
  const re = /spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/g;
  const ids = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) ids.add(m[1]);
  return Array.from(ids);
}

export async function GET(request: NextRequest) {
  if (!authorize(request)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const items = await prisma.satisfactionImportItem.findMany({
    where: { sourceType: { in: ["gmail_summary"] } },
    select: {
      id: true,
      candidateName: true,
      candidateCompanyName: true,
      rawPayload: true,
    },
  });

  const total = items.length;
  const keyCounts = new Map<string, number>();
  const bodyLengthBuckets = { lt100: 0, lt500: 0, lt1000: 0, lt1200: 0, eq1200: 0, gt1200: 0 };
  const urlBuckets: UrlBuckets = {
    spreadsheetsDocs: 0,
    formsDocs: 0,
    driveFile: 0,
    formsGle: 0,
    googGl: 0,
    bitLy: 0,
    otherHttp: 0,
  };
  let subjectHasKeyword = 0;
  let subjectMissing = 0;
  let extracted = 0;
  let notExtracted = 0;
  let hasAttachmentLikeKey = 0;
  const failureSamples: Array<{
    id: string;
    company: string | null;
    instructor: string | null;
    subject: string | null;
    bodyHead: string;
    rawKeys: string[];
  }> = [];

  // extracted_urls 키가 있는 record 수 (신규 normalizer 변경 적용 여부 측정)
  let withExtractedUrls = 0;
  let extractedUrlsTotal = 0;

  for (const item of items) {
    const raw = (item.rawPayload as Record<string, unknown> | null) ?? {};
    const keys = Object.keys(raw);
    for (const k of keys) keyCounts.set(k, (keyCounts.get(k) ?? 0) + 1);
    if (keys.some((k) => /attach|file|drive_sheet/i.test(k))) hasAttachmentLikeKey += 1;

    const subject = typeof raw.subject === "string" ? raw.subject : null;
    const body = typeof raw.body_excerpt === "string" ? raw.body_excerpt : "";
    const sectionTitle = typeof raw.section_title === "string" ? raw.section_title : "";
    const extractedUrls = Array.isArray(raw.extracted_urls)
      ? (raw.extracted_urls as unknown[]).filter((v): v is string => typeof v === "string")
      : null;

    const len = body.length;
    if (len < 100) bodyLengthBuckets.lt100 += 1;
    else if (len < 500) bodyLengthBuckets.lt500 += 1;
    else if (len < 1000) bodyLengthBuckets.lt1000 += 1;
    else if (len < BODY_CUTOFF) bodyLengthBuckets.lt1200 += 1;
    else if (len === BODY_CUTOFF) bodyLengthBuckets.eq1200 += 1;
    else bodyLengthBuckets.gt1200 += 1;

    // URL 분류: extracted_urls가 있으면 우선 (전체 본문 + subject에서 추출된 dedupe된 URL).
    // 없으면 fallback — body_excerpt + subject + section_title (구 데이터, 1200 cutoff).
    if (extractedUrls && extractedUrls.length > 0) {
      withExtractedUrls += 1;
      extractedUrlsTotal += extractedUrls.length;
      classifyUrls(extractedUrls.join("\n"), urlBuckets);
    } else if (extractedUrls && extractedUrls.length === 0) {
      withExtractedUrls += 1;
      // 신규 normalizer 적용된 record인데 URL 0건. fallback 안 함 (구 cutoff 데이터 섞임 방지).
    } else {
      classifyUrls([subject, body, sectionTitle].filter(Boolean).join("\n"), urlBuckets);
    }

    if (hasSurveyKeyword(subject)) subjectHasKeyword += 1;
    else subjectMissing += 1;

    const ids = new Set<string>();
    // spreadsheet ID 추출: extracted_urls 있으면 그것에서, 없으면 raw의 string fields fallback.
    if (extractedUrls && extractedUrls.length > 0) {
      for (const url of extractedUrls) extractSpreadsheetIds(url).forEach((id) => ids.add(id));
    } else {
      for (const v of Object.values(raw)) {
        if (typeof v === "string") extractSpreadsheetIds(v).forEach((id) => ids.add(id));
      }
    }
    if (ids.size > 0) {
      extracted += 1;
    } else {
      notExtracted += 1;
      if (failureSamples.length < 5) {
        failureSamples.push({
          id: item.id,
          company: item.candidateCompanyName ?? null,
          instructor: item.candidateName ?? null,
          subject,
          bodyHead: body.slice(0, 300),
          rawKeys: keys,
        });
      }
    }
  }

  const rawPayloadKeys = Array.from(keyCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => ({ key, count }));

  return NextResponse.json({
    ok: true,
    total,
    extracted,
    notExtracted,
    extractionRate: total > 0 ? `${((extracted / total) * 100).toFixed(2)}%` : "0%",
    // extracted_urls 적용 진척도 — 신규 normalizer 데이터 비율 측정
    extractedUrlsRollout: {
      withExtractedUrls,
      withoutExtractedUrls: total - withExtractedUrls,
      rolloutRate: total > 0 ? `${((withExtractedUrls / total) * 100).toFixed(2)}%` : "0%",
      avgUrlsPerRecord:
        withExtractedUrls > 0 ? (extractedUrlsTotal / withExtractedUrls).toFixed(2) : "0",
    },
    rawPayloadKeys,
    hasAttachmentLikeKey,
    bodyLengthBuckets,
    urlBuckets,
    subjectKeyword: { hasKeyword: subjectHasKeyword, missing: subjectMissing },
    failureSamples,
    nextStepGuide: {
      formsGleHeavy:
        urlBuckets.formsGle > urlBuckets.spreadsheetsDocs
          ? "Forms link 해석 추가 (forms.gle redirect)"
          : null,
      bodyCutoffHit:
        bodyLengthBuckets.eq1200 > total * 0.1
          ? `body_excerpt cut-off 도달 ${bodyLengthBuckets.eq1200}건 — cut-off 늘리기`
          : null,
      noAttachments:
        hasAttachmentLikeKey === 0 && notExtracted > total * 0.5
          ? "attachment 처리 추가 (.xlsx/.csv reader)"
          : null,
      keywordCoverage:
        subjectMissing > total * 0.3
          ? `subject keyword 누락 ${subjectMissing}건 — Gmail query 확장`
          : null,
    },
  });
}
