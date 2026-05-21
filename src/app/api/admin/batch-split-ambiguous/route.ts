/**
 * POST /api/admin/batch-split-ambiguous?mode=dry_run|apply&limit=N
 *
 * pending registry 중 drive_satisfaction sourceType + 후보 2명+ 인 케이스를
 * 일괄 split (응답 timestamp + ops 매칭).
 *
 * 사용자 룰 [no_guess_matching] 준수: row별 ±1일 ops 단일 강사 매칭만 record 생성.
 *
 * 인증: CRON_SECRET
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";
import { collectSatisfactionFromDrive } from "@/lib/pipeline/satisfaction-drive-collector";
import { normalizeCompanyWithAlias } from "@/lib/company-aliases";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

type RawRecord = { [key: string]: unknown };
function pickString(o: RawRecord | undefined | null, ...keys: string[]): string | null {
  if (!o) return null;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return null;
}

const OPS_REPORT = "C015YD84VGS";
const GENERAL = "C79GDLS3A";
const ALLOWED = new Set([OPS_REPORT, GENERAL]);
const INSTRUCTOR_REGEX = /([가-힣]{2,4}[A-Z]?)\s*(?:강사|대표|교수|선생)님/g;
const ONE_DAY = 86400 * 1000;

const P0_NULL_PROTECTED = new Set(["박상훈"]);
const P0_HIGH_AVG_PROTECTED = new Set(["유종훈", "김정수A"]);

const GENERIC_COMPANY_BLOCKLIST = new Set([
  "원데이", "GenAI 활용과정", "디자인씽킹", "파이썬", "엑셀",
  "AI", "생성형 AI", "프롬프트 엔지니어링", "데이터 분석",
  "프로그래밍", "코딩", "마케팅", "기획", "보고서",
  "공개형 교육", "공개교육", "특강", "워크숍",
]);
function isGenericCompany(name: string | null | undefined): boolean {
  if (!name) return true;
  const trimmed = name.trim();
  if (GENERIC_COMPANY_BLOCKLIST.has(trimmed)) return true;
  if (trimmed.length < 3) return true;
  return false;
}

function parseRowTimestamp(value: string | null | undefined): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  const koMatch = trimmed.match(
    /(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\s*(오전|오후)?\s*(\d{1,2}):(\d{2}):?(\d{2})?/
  );
  if (koMatch) {
    const [, year, month, day, ampm, hourRaw, minute] = koMatch;
    let hour = Number(hourRaw);
    if (ampm === "오후" && hour < 12) hour += 12;
    if (ampm === "오전" && hour === 12) hour = 0;
    return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), hour, Number(minute)));
  }
  const isoMatch = trimmed.match(/(\d{4})[./-](\d{1,2})[./-](\d{1,2})/);
  if (isoMatch) {
    return new Date(Date.UTC(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3])));
  }
  return null;
}
function findScoreColumnIndex(headerRow: string[]): number {
  for (let i = 0; i < headerRow.length; i += 1) {
    if (/강사.*만족/.test(headerRow[i] ?? "")) return i;
  }
  for (let i = 0; i < headerRow.length; i += 1) {
    if (/전반적|전체|만족하/.test(headerRow[i] ?? "")) return i;
  }
  for (let i = 0; i < headerRow.length; i += 1) {
    if (/만족/.test(headerRow[i] ?? "")) return i;
  }
  return -1;
}
function parseScore(raw: string): number | null {
  const trimmed = raw.trim();
  let n = Number(trimmed);
  if (!Number.isFinite(n)) {
    const m = trimmed.match(/^(\d+(?:\.\d+)?)/);
    if (m) n = Number(m[1]);
  }
  if (!Number.isFinite(n)) {
    const cleaned = trimmed.replace(/\s+/g, "");
    const likert: Record<string, number> = {
      "매우만족": 5, "만족": 4, "보통": 3, "불만족": 2, "매우불만족": 1,
    };
    if (likert[cleaned] !== undefined) n = likert[cleaned];
  }
  if (!Number.isFinite(n) || n < 1) return null;
  return n > 5 ? Math.round((n / 2) * 100) / 100 : n;
}

export async function POST(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const mode = request.nextUrl.searchParams.get("mode") ?? "dry_run";
  const limit = parseInt(request.nextUrl.searchParams.get("limit") ?? "30", 10);
  const offset = parseInt(request.nextUrl.searchParams.get("offset") ?? "0", 10);
  const startedAt = Date.now();

  // drive_satisfaction pending registry
  const pending = await prisma.satisfactionReviewRegistry.findMany({
    where: { matchStatus: "pending", sourceType: "drive_satisfaction" },
    select: { id: true, registryKey: true, companyName: true, courseName: true, sourceRefs: true },
    take: limit,
    skip: offset,
    orderBy: { createdAt: "desc" },
  });

  // slack ops 전체 미리 fetch
  const slackItems = await prisma.activityImportItem.findMany({
    where: { sourceType: "slack" },
    select: { rawPayload: true, sourceRef: true, activityAt: true },
    take: 50000,
  });
  interface OpsMsg { ts: Date; instructors: string[]; text: string }
  const opsAll: OpsMsg[] = [];
  for (const it of slackItems) {
    const raw = (it.rawPayload as RawRecord | null) ?? {};
    const ref = (it.sourceRef as RawRecord | null) ?? {};
    const cid = pickString(raw, "channel_id", "channel") ?? pickString(ref, "channel_id", "channel");
    if (!cid || !ALLOWED.has(cid)) continue;
    const text = pickString(raw, "text", "message", "body") ?? "";
    if (!text || !it.activityAt) continue;
    const names = Array.from(new Set(Array.from(text.matchAll(INSTRUCTOR_REGEX)).map((m) => m[1])));
    if (names.length === 0) continue;
    opsAll.push({ ts: it.activityAt, instructors: names, text });
  }

  const allInstructors = await prisma.instructor.findMany({ select: { id: true, name: true } });
  const instByName = new Map(allInstructors.map((i) => [i.name, i]));

  interface Plan {
    registry_key: string;
    file_id: string;
    file_name: string;
    company: string;
    total_responses: number;
    matched: number;
    unmatched_no_ops: number;
    ambiguous_row: number;
    instructor_splits: Array<{
      instructor_name: string;
      instructor_id: string;
      respondent_count: number;
      avg_score: number;
      response_date_min: string;
      response_date_max: string;
    }>;
  }
  const plans: Plan[] = [];
  const skipped: Array<{ registry_key: string; reason: string }> = [];

  for (const reg of pending) {
    const refs = Array.isArray(reg.sourceRefs) ? (reg.sourceRefs as RawRecord[]) : [];
    const inner = refs[0]?.source_ref as RawRecord | undefined;
    const fileId = pickString(inner, "file_id");
    if (!fileId) {
      skipped.push({ registry_key: reg.registryKey, reason: "no_file_id" });
      continue;
    }
    if (!reg.companyName || isGenericCompany(reg.companyName)) {
      skipped.push({ registry_key: reg.registryKey, reason: "generic_company" });
      continue;
    }
    const effectiveCompany = normalizeCompanyWithAlias(reg.companyName);
    if (effectiveCompany.length < 2) {
      skipped.push({ registry_key: reg.registryKey, reason: "company_too_short" });
      continue;
    }

    let collected;
    try {
      collected = await collectSatisfactionFromDrive({ fileIds: [fileId] });
    } catch {
      skipped.push({ registry_key: reg.registryKey, reason: "collect_failed" });
      continue;
    }
    const file = collected.files[0];
    if (!file) {
      skipped.push({ registry_key: reg.registryKey, reason: "file_not_found" });
      continue;
    }
    const sheet = file.sheets.find((s) => s.rows.length >= 2);
    if (!sheet) {
      skipped.push({ registry_key: reg.registryKey, reason: "no_response_sheet" });
      continue;
    }
    const header = sheet.rows[0];
    const scoreIdx = findScoreColumnIndex(header);
    if (scoreIdx === -1) {
      skipped.push({ registry_key: reg.registryKey, reason: "no_score_column" });
      continue;
    }

    interface Resp { ts: Date; score: number }
    const responses: Resp[] = [];
    for (let i = 1; i < sheet.rows.length; i += 1) {
      const row = sheet.rows[i];
      if (!row) continue;
      const ts = parseRowTimestamp(row[0]);
      if (!ts) continue;
      const score = parseScore(row[scoreIdx] ?? "");
      if (score === null) continue;
      responses.push({ ts, score });
    }
    if (responses.length === 0) {
      skipped.push({ registry_key: reg.registryKey, reason: "no_valid_responses" });
      continue;
    }

    const byInstructor = new Map<string, { instructor_id: string; scores: number[]; min_ts: Date; max_ts: Date }>();
    let unmatched = 0;
    let ambiguousRow = 0;
    for (const r of responses) {
      const candidates = new Set<string>();
      for (const op of opsAll) {
        if (Math.abs(op.ts.getTime() - r.ts.getTime()) > ONE_DAY) continue;
        const normText = normalizeCompanyWithAlias(op.text);
        if (!normText.includes(effectiveCompany)) continue;
        for (const n of op.instructors) {
          if (!instByName.has(n)) continue;
          if (P0_NULL_PROTECTED.has(n)) continue;
          candidates.add(n);
        }
      }
      if (candidates.size === 0) {
        unmatched += 1;
        continue;
      }
      if (candidates.size > 1) {
        ambiguousRow += 1;
        continue;
      }
      const name = Array.from(candidates)[0];
      const inst = instByName.get(name)!;
      const entry = byInstructor.get(name) ?? {
        instructor_id: inst.id,
        scores: [],
        min_ts: r.ts,
        max_ts: r.ts,
      };
      entry.scores.push(r.score);
      if (r.ts < entry.min_ts) entry.min_ts = r.ts;
      if (r.ts > entry.max_ts) entry.max_ts = r.ts;
      byInstructor.set(name, entry);
    }
    if (byInstructor.size === 0) {
      skipped.push({ registry_key: reg.registryKey, reason: "no_instructor_matched_any_row" });
      continue;
    }
    const splits = Array.from(byInstructor.entries()).map(([name, e]) => ({
      instructor_name: name,
      instructor_id: e.instructor_id,
      respondent_count: e.scores.length,
      avg_score: Math.round((e.scores.reduce((a, b) => a + b, 0) / e.scores.length) * 100) / 100,
      response_date_min: e.min_ts.toISOString().slice(0, 10),
      response_date_max: e.max_ts.toISOString().slice(0, 10),
    }));
    splits.sort((a, b) => b.respondent_count - a.respondent_count);
    plans.push({
      registry_key: reg.registryKey,
      file_id: fileId,
      file_name: file.fileName,
      company: reg.companyName,
      total_responses: responses.length,
      matched: responses.length - unmatched - ambiguousRow,
      unmatched_no_ops: unmatched,
      ambiguous_row: ambiguousRow,
      instructor_splits: splits,
    });
  }

  if (mode === "dry_run") {
    const totalNewRecords = plans.reduce((acc, p) => acc + p.instructor_splits.length, 0);
    return NextResponse.json({
      ok: true,
      mode,
      durationMs: Date.now() - startedAt,
      pending_audited: pending.length,
      splittable: plans.length,
      skipped_buckets: skipped.reduce((acc: Record<string, number>, s) => {
        acc[s.reason] = (acc[s.reason] ?? 0) + 1;
        return acc;
      }, {}),
      total_new_records: totalNewRecords,
      plans,
    });
  }

  // apply
  let createdRecords = 0;
  let processedRegistries = 0;
  const run = await prisma.pipelineRun.create({
    data: {
      runType: "batch_split_ambiguous",
      status: "running",
      triggeredBy: "api:/api/admin/batch-split-ambiguous",
    },
  });
  for (const p of plans) {
    for (const s of p.instructor_splits) {
      // P0 high_avg 가드: avg<5면 reject (유종훈/김정수A)
      if (P0_HIGH_AVG_PROTECTED.has(s.instructor_name) && s.avg_score < 5) continue;
      const recordKey = `split:${p.file_id}:${s.instructor_id}`;
      await prisma.satisfactionRecord.create({
        data: {
          instructorDbId: s.instructor_id,
          sourceType: "drive_satisfaction",
          sourceRef: {
            file_id: p.file_id,
            file_name: p.file_name,
            source_ref_key: recordKey,
            split_from_registry: p.registry_key,
            method: "batch_response_timestamp_ops_match",
            run_id: run.id,
          },
          score: s.avg_score,
          respondentCount: s.respondent_count,
          responseDate: new Date(s.response_date_min),
          companyName: p.company,
          courseName: null,
          createdBy: "api:/api/admin/batch-split-ambiguous",
        },
      });
      createdRecords += 1;
    }
    await prisma.satisfactionReviewRegistry.update({
      where: { registryKey: p.registry_key },
      data: {
        matchStatus: "split_by_timestamp",
        resolutionBasis: `batch_split|file=${p.file_id}|splits=${p.instructor_splits.length}|date=${new Date().toISOString()}`,
      },
    });
    processedRegistries += 1;
  }
  await prisma.pipelineRun.update({
    where: { id: run.id },
    data: { status: "succeeded", finishedAt: new Date() },
  });

  return NextResponse.json({
    ok: true,
    mode,
    durationMs: Date.now() - startedAt,
    processed_registries: processedRegistries,
    created_records: createdRecords,
  });
}
