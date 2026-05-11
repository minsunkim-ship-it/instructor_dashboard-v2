/**
 * analyze-gmail-rawpayload.ts — Gmail satisfaction rawPayload 손실 원인 진단 (read-only)
 *
 * 배경:
 *   기존 discover-satisfaction-sheets.ts 가 gmail 454건에서 spreadsheet ID 4건만 추출.
 *   추출률 0.9%. 나머지 99.1% 손실 원인을 정량화해야 collector 강화 방향 결정 가능.
 *
 * 분석 항목:
 *   1. rawPayload 키 분포 (어떤 필드가 있는지)
 *   2. body_excerpt 길이 분포 (1200자 cut-off 도달 빈도 = 본문 잘림 의심)
 *   3. URL 패턴 카운트:
 *      - https://docs.google.com/spreadsheets/d/ID (현재 정규식 매칭)
 *      - https://docs.google.com/forms/d/ID (forms link)
 *      - https://drive.google.com/file/d/ID (drive file link)
 *      - https://forms.gle/SHORT (Google Forms short)
 *      - https://goo.gl/SHORT (Google short)
 *      - https://bit.ly/SHORT (bit.ly)
 *      - 기타 http(s):// (분류 불가)
 *   4. subject 키워드 ("만족도", "설문", "평가") 포함 여부
 *   5. 추출 실패 thread sample 5건 (subject + body 처음 300자) — 강화 패턴 발견용
 *   6. 첨부 메타 존재 여부 (rawPayload에 attachment 키 있는지)
 *
 * 산출:
 *   reports/gmail-rawpayload-analysis.md  ← 운영 인계 + 다음 단계 결정
 *   reports/gmail-rawpayload-analysis.json ← 원본 카운트
 *
 * 자기 의심:
 *   - DB write 없음 (read-only). prisma findMany만 사용.
 *   - thread 샘플은 회사명/강사명만 표시. 본문 일부 (처음 300자) 발췌만 보고서에 포함.
 *   - 실행 위치: Coolify Terminal (운영 DB 접근). 로컬에서는 DB 인증 없어 실패가 정상.
 */
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { prisma } from "@/lib/prisma";
import { loadDotEnv } from "./lib/audit-helpers.ts";

const BODY_CUTOFF = 1200;

interface UrlBuckets {
  spreadsheetsDocs: number;
  formsDocs: number;
  driveFile: number;
  formsGle: number;
  googGl: number;
  bitLy: number;
  otherHttp: number;
}

function emptyUrlBuckets(): UrlBuckets {
  return {
    spreadsheetsDocs: 0,
    formsDocs: 0,
    driveFile: 0,
    formsGle: 0,
    googGl: 0,
    bitLy: 0,
    otherHttp: 0,
  };
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

async function main() {
  await loadDotEnv(path.join(process.cwd(), ".env"));

  const items = await prisma.satisfactionImportItem.findMany({
    where: { sourceType: { in: ["gmail_summary"] } },
    select: {
      id: true,
      candidateName: true,
      candidateCompanyName: true,
      candidateCourseName: true,
      sourceRef: true,
      rawPayload: true,
    },
  });

  const total = items.length;
  console.log(`SatisfactionImportItem gmail_summary 총 ${total}건 로드`);

  // 1. rawPayload key 분포
  const keyCounts = new Map<string, number>();
  // 2. body_excerpt length 분포
  const bodyLengthBuckets = { lt100: 0, lt500: 0, lt1000: 0, lt1200: 0, eq1200: 0, gt1200: 0 };
  // 3. URL 패턴 (subject + body_excerpt + section_title 합산)
  const urlBuckets = emptyUrlBuckets();
  // 4. subject 키워드 분포
  let subjectHasKeyword = 0;
  let subjectMissing = 0;
  // 5. 추출 결과 — 현재 정규식 매칭 성공 vs 실패
  let extracted = 0;
  let notExtracted = 0;
  const failureSamples: Array<{
    id: string;
    company: string | null;
    instructor: string | null;
    subject: string | null;
    bodyHead: string;
    rawKeys: string[];
  }> = [];
  // 6. 첨부 메타 존재 여부 — gmail 첨부 키 후보
  let hasAttachmentLikeKey = 0;

  for (const item of items) {
    const raw = (item.rawPayload as Record<string, unknown> | null) ?? {};
    const keys = Object.keys(raw);
    for (const k of keys) keyCounts.set(k, (keyCounts.get(k) ?? 0) + 1);
    if (keys.some((k) => /attach|file|drive_sheet/i.test(k))) hasAttachmentLikeKey += 1;

    const subject = typeof raw.subject === "string" ? raw.subject : null;
    const body = typeof raw.body_excerpt === "string" ? raw.body_excerpt : "";
    const sectionTitle = typeof raw.section_title === "string" ? raw.section_title : "";

    // body length bucket
    const len = body.length;
    if (len < 100) bodyLengthBuckets.lt100 += 1;
    else if (len < 500) bodyLengthBuckets.lt500 += 1;
    else if (len < 1000) bodyLengthBuckets.lt1000 += 1;
    else if (len < BODY_CUTOFF) bodyLengthBuckets.lt1200 += 1;
    else if (len === BODY_CUTOFF) bodyLengthBuckets.eq1200 += 1;
    else bodyLengthBuckets.gt1200 += 1;

    // URL 분류 — subject + body + section_title 모두 검사
    const combinedText = [subject, body, sectionTitle].filter(Boolean).join("\n");
    classifyUrls(combinedText, urlBuckets);

    // subject 키워드
    if (hasSurveyKeyword(subject)) subjectHasKeyword += 1;
    else subjectMissing += 1;

    // 현재 정규식으로 추출 가능 여부
    const ids = new Set<string>();
    for (const v of Object.values(raw)) {
      if (typeof v === "string") extractSpreadsheetIds(v).forEach((id) => ids.add(id));
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

  const keyDistribution = Array.from(keyCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => ({ key: k, count: v }));

  const report = {
    total,
    extracted,
    notExtracted,
    extractionRate: total > 0 ? `${((extracted / total) * 100).toFixed(2)}%` : "0%",
    rawPayloadKeys: keyDistribution,
    hasAttachmentLikeKey,
    bodyLengthBuckets,
    urlBuckets,
    subjectKeyword: { hasKeyword: subjectHasKeyword, missing: subjectMissing },
    failureSamples,
  };

  // === markdown 보고서 ===
  const lines: string[] = [];
  lines.push(`# Gmail satisfaction rawPayload 손실 원인 진단`);
  lines.push(`Generated at: ${new Date().toISOString()}`);
  lines.push(``);
  lines.push(`## 총괄`);
  lines.push(`- 총 SatisfactionImportItem (gmail_summary): **${total}건**`);
  lines.push(`- 현재 정규식 (/spreadsheets/d/ID/) 추출 성공: **${extracted}건** (${report.extractionRate})`);
  lines.push(`- 추출 실패: **${notExtracted}건**`);
  lines.push(``);
  lines.push(`## rawPayload 키 분포`);
  lines.push(`| key | count |`);
  lines.push(`|---|---|`);
  for (const { key, count } of keyDistribution) lines.push(`| \`${key}\` | ${count} |`);
  lines.push(``);
  lines.push(`- 첨부 의심 키 (attach/file/drive_sheet) 존재: **${hasAttachmentLikeKey}건**`);
  lines.push(``);
  lines.push(`## body_excerpt 길이 분포 (cut-off=${BODY_CUTOFF})`);
  lines.push(`| 길이 | 건수 |`);
  lines.push(`|---|---|`);
  lines.push(`| <100 | ${bodyLengthBuckets.lt100} |`);
  lines.push(`| 100~499 | ${bodyLengthBuckets.lt500} |`);
  lines.push(`| 500~999 | ${bodyLengthBuckets.lt1000} |`);
  lines.push(`| 1000~1199 | ${bodyLengthBuckets.lt1200} |`);
  lines.push(`| =1200 (cut-off 도달 의심) | ${bodyLengthBuckets.eq1200} |`);
  lines.push(`| >1200 | ${bodyLengthBuckets.gt1200} |`);
  lines.push(``);
  lines.push(`## URL 패턴 분포 (subject + body_excerpt + section_title 합산)`);
  lines.push(`| 패턴 | 건수 |`);
  lines.push(`|---|---|`);
  lines.push(`| docs.google.com/spreadsheets/d/ (현재 매칭) | ${urlBuckets.spreadsheetsDocs} |`);
  lines.push(`| docs.google.com/forms/d/ | ${urlBuckets.formsDocs} |`);
  lines.push(`| drive.google.com/file/d/ | ${urlBuckets.driveFile} |`);
  lines.push(`| forms.gle/SHORT (Google Forms short) | ${urlBuckets.formsGle} |`);
  lines.push(`| goo.gl/SHORT | ${urlBuckets.googGl} |`);
  lines.push(`| bit.ly/SHORT | ${urlBuckets.bitLy} |`);
  lines.push(`| 기타 http(s):// | ${urlBuckets.otherHttp} |`);
  lines.push(``);
  lines.push(`## subject 키워드 (만족도/설문/평가/survey/satisfaction/feedback)`);
  lines.push(`- 포함: ${subjectHasKeyword}건`);
  lines.push(`- 미포함: ${subjectMissing}건`);
  lines.push(``);
  lines.push(`## 추출 실패 sample (5건)`);
  for (const s of failureSamples) {
    lines.push(``);
    lines.push(`### ${s.company ?? "(회사 미상)"} / ${s.instructor ?? "(강사 미상)"}`);
    lines.push(`- subject: ${s.subject ?? "(none)"}`);
    lines.push(`- rawPayload keys: ${s.rawKeys.join(", ")}`);
    lines.push(`- body 처음 300자:`);
    lines.push(`\`\`\``);
    lines.push(s.bodyHead);
    lines.push(`\`\`\``);
  }
  lines.push(``);
  lines.push(`## 다음 단계 결정 가이드`);
  lines.push(``);
  lines.push(`### 만약 \`docs.google.com/spreadsheets/d/\` URL이 적고 \`forms.gle\`/\`docs.google.com/forms/d/\` 가 많다면`);
  lines.push(`→ Forms link 해석 추가. forms.gle 는 redirect 해석 후 spreadsheet 연동 ID 파싱.`);
  lines.push(``);
  lines.push(`### 만약 body_excerpt 길이 =1200 도달이 많다면`);
  lines.push(`→ collector에서 body_excerpt cut-off 늘리기 (1200 → 5000) 또는 무제한.`);
  lines.push(``);
  lines.push(`### 만약 첨부 의심 키가 0건이고 추출 실패 본문에 spreadsheet link 흔적이 안 보인다면`);
  lines.push(`→ collector에 attachment 처리 추가 필요 (.xlsx/.csv reader 연동).`);
  lines.push(``);
  lines.push(`### 만약 subject 키워드 포함 비율이 낮으면`);
  lines.push(`→ 검색 키워드 확장 검토 (collector의 Gmail query 강화).`);

  const reportsDir = path.resolve(process.cwd(), "reports");
  await mkdir(reportsDir, { recursive: true });
  await writeFile(path.join(reportsDir, "gmail-rawpayload-analysis.md"), lines.join("\n"), "utf-8");
  await writeFile(
    path.join(reportsDir, "gmail-rawpayload-analysis.json"),
    JSON.stringify(report, null, 2),
    "utf-8"
  );

  console.log(`보고서 저장:`);
  console.log(`  reports/gmail-rawpayload-analysis.md`);
  console.log(`  reports/gmail-rawpayload-analysis.json`);
  console.log(``);
  console.log(`현재 추출률: ${report.extractionRate} (${extracted}/${total})`);
  console.log(`failure sample 5건 보고서에 포함됨`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
