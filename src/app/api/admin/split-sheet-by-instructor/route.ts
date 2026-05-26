/**
 * POST /api/admin/split-sheet-by-instructor?mode=dry_run|apply&file_id=xxx
 *
 * Drive sheet 1개의 응답 row를 timestamp 기준으로 ops_report 강사에 매칭.
 * 각 응답 row의 ±1일 ops 메시지에서 강사 단일 식별 시 그 강사로 분배.
 * 결과: 1 sheet → N records (강사별).
 *
 * 사용자 룰 [no_guess_matching] 준수: row별 ±1일 ops 명시 강사만 매칭.
 *
 * 인증: CRON_SECRET
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";
import { collectSatisfactionFromDrive } from "@/lib/pipeline/satisfaction-drive-collector";
import { normalizeCompanyWithAlias } from "@/lib/company-aliases";

export const maxDuration = 120;
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

// row timestamp parse (한국 형식: 2026. 2. 23 오후 4:55:10)
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
  // 강사 만족도 우선
  for (let i = 0; i < headerRow.length; i += 1) {
    if (/강사.*만족/.test(headerRow[i] ?? "")) return i;
  }
  // 전반적 만족도
  for (let i = 0; i < headerRow.length; i += 1) {
    if (/전반적|전체|만족하/.test(headerRow[i] ?? "")) return i;
  }
  // generic 만족
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
  const fileId = request.nextUrl.searchParams.get("file_id");
  const registryKey = request.nextUrl.searchParams.get("registry_key");
  if (!fileId && !registryKey) {
    return NextResponse.json({ ok: false, error: "file_id or registry_key required" }, { status: 400 });
  }

  // registry → file_id 추출
  let resolvedFileId = fileId;
  let registry: { id: string; registryKey: string; companyName: string | null; courseName: string | null; sourceRefs: unknown; avgScore: unknown } | null = null;
  if (!resolvedFileId && registryKey) {
    const reg = await prisma.satisfactionReviewRegistry.findUnique({
      where: { registryKey },
      select: { id: true, registryKey: true, companyName: true, courseName: true, sourceRefs: true, avgScore: true },
    });
    if (!reg) return NextResponse.json({ ok: false, error: "registry_not_found" }, { status: 404 });
    registry = reg;
    const refs = Array.isArray(reg.sourceRefs) ? (reg.sourceRefs as RawRecord[]) : [];
    const inner = refs[0]?.source_ref as RawRecord | undefined;
    resolvedFileId = pickString(inner, "file_id");
    if (!resolvedFileId) {
      return NextResponse.json({ ok: false, error: "no_file_id_in_registry" }, { status: 422 });
    }
  }

  // collector로 sheet content fetch
  const collected = await collectSatisfactionFromDrive({ fileIds: [resolvedFileId!] });
  const file = collected.files[0];
  if (!file) {
    return NextResponse.json({ ok: false, error: "file_not_found" }, { status: 404 });
  }

  // v24-23: 모든 valid sheet (회차별 sub-sheet 포함)
  const debugFlag = request.nextUrl.searchParams.get("debug") === "1";
  const validSheets = file.sheets.filter((s) => s.rows.length >= 2);
  const debugSheets: Array<{ title: string; row_count: number; score_idx: number; header_first: string[]; ts_first: string | null; row1_score: string | null; row1_parsed_ts: boolean; row1_parsed_score: number | null; pushed: number }> = [];
  if (validSheets.length === 0) {
    return NextResponse.json({ ok: false, error: "no_response_sheet", total_sheets_in_file: file.sheets.length, debug: file.sheets.map((s) => ({ title: s.title, rows: s.rows.length })) }, { status: 422 });
  }

  interface Resp { ts: Date; score: number }
  const responses: Resp[] = [];
  for (const sheet of validSheets) {
    const header = sheet.rows[0];
    const scoreIdx = findScoreColumnIndex(header);
    let pushed = 0;
    let row1ParsedTs = false;
    let row1ParsedScore: number | null = null;
    if (scoreIdx !== -1) {
      for (let i = 1; i < sheet.rows.length; i += 1) {
        const row = sheet.rows[i];
        if (!row) continue;
        const ts = parseRowTimestamp(row[0]);
        if (i === 1) {
          row1ParsedTs = ts !== null;
          row1ParsedScore = parseScore(row[scoreIdx] ?? "");
        }
        if (!ts) continue;
        const score = parseScore(row[scoreIdx] ?? "");
        if (score === null) continue;
        responses.push({ ts, score });
        pushed += 1;
      }
    }
    if (debugFlag) {
      debugSheets.push({
        title: sheet.title,
        row_count: sheet.rows.length,
        score_idx: scoreIdx,
        header_first: header.slice(0, 10),
        ts_first: sheet.rows[1]?.[0] ?? null,
        row1_score: scoreIdx !== -1 ? (sheet.rows[1]?.[scoreIdx] ?? null) : null,
        row1_parsed_ts: row1ParsedTs,
        row1_parsed_score: row1ParsedScore,
        pushed,
      });
    }
  }
  if (responses.length === 0) {
    return NextResponse.json({
      ok: false,
      error: "no_valid_responses",
      file_name: file.fileName,
      total_sheets_in_file: file.sheets.length,
      valid_sheets: validSheets.length,
      debug_sheets: debugFlag ? debugSheets : undefined,
    }, { status: 422 });
  }

  // ops_report messages — 회사 매칭만 사전 filter (response range에 한정)
  const company = registry?.companyName ?? null;
  if (!company) {
    return NextResponse.json({ ok: false, error: "no_company_in_registry" }, { status: 422 });
  }
  const effectiveCompany = normalizeCompanyWithAlias(company);
  if (effectiveCompany.length < 2) {
    return NextResponse.json({ ok: false, error: "company_too_short" }, { status: 422 });
  }

  const respTimes = responses.map((r) => r.ts.getTime());
  const minResp = Math.min(...respTimes);
  const maxResp = Math.max(...respTimes);
  const lo = new Date(minResp - 14 * 86400 * 1000);
  const hi = new Date(maxResp + 14 * 86400 * 1000);

  const slackItems = await prisma.activityImportItem.findMany({
    where: {
      sourceType: "slack",
      activityAt: { gte: lo, lte: hi },
    },
    select: { rawPayload: true, sourceRef: true, activityAt: true },
    take: 5000,
  });

  interface OpsMsg { ts: Date; instructors: string[]; text: string }
  const opsList: OpsMsg[] = [];
  for (const it of slackItems) {
    const raw = (it.rawPayload as RawRecord | null) ?? {};
    const ref = (it.sourceRef as RawRecord | null) ?? {};
    const cid = pickString(raw, "channel_id", "channel") ?? pickString(ref, "channel_id", "channel");
    if (!cid || !ALLOWED.has(cid)) continue;
    const text = pickString(raw, "text", "message", "body") ?? "";
    if (!text || !it.activityAt) continue;
    const normText = normalizeCompanyWithAlias(text);
    if (!normText.includes(effectiveCompany)) continue;
    const names = Array.from(new Set(Array.from(text.matchAll(INSTRUCTOR_REGEX)).map((m) => m[1])));
    if (names.length === 0) continue;
    opsList.push({ ts: it.activityAt, instructors: names, text });
  }

  const allInstructors = await prisma.instructor.findMany({ select: { id: true, name: true } });
  const instByName = new Map(allInstructors.map((i) => [i.name, i]));

  // 각 응답 row → ±1일 ops 메시지 강사 매칭
  const ONE_DAY = 86400 * 1000;
  const byInstructor = new Map<string, { instructor_id: string; scores: number[]; min_ts: Date; max_ts: Date }>();
  let unmatched = 0;
  let ambiguousRow = 0;
  for (const r of responses) {
    const candidates = new Map<string, number>();
    for (const op of opsList) {
      if (Math.abs(op.ts.getTime() - r.ts.getTime()) > ONE_DAY) continue;
      for (const n of op.instructors) {
        if (!instByName.has(n)) continue;
        candidates.set(n, (candidates.get(n) ?? 0) + 1);
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
    const name = Array.from(candidates.keys())[0];
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

  interface SplitPlan {
    instructor_name: string;
    instructor_id: string;
    respondent_count: number;
    avg_score: number;
    response_date_min: string;
    response_date_max: string;
  }
  const plans: SplitPlan[] = [];
  for (const [name, e] of byInstructor.entries()) {
    const avg = e.scores.reduce((a, b) => a + b, 0) / e.scores.length;
    plans.push({
      instructor_name: name,
      instructor_id: e.instructor_id,
      respondent_count: e.scores.length,
      avg_score: Math.round(avg * 100) / 100,
      response_date_min: e.min_ts.toISOString().slice(0, 10),
      response_date_max: e.max_ts.toISOString().slice(0, 10),
    });
  }
  plans.sort((a, b) => b.respondent_count - a.respondent_count);

  if (mode === "dry_run") {
    return NextResponse.json({
      ok: true,
      mode,
      file_id: resolvedFileId,
      file_name: file.fileName,
      registry_key: registry?.registryKey ?? null,
      company,
      total_responses: responses.length,
      matched: responses.length - unmatched - ambiguousRow,
      unmatched_no_ops: unmatched,
      ambiguous_row: ambiguousRow,
      plans,
    });
  }

  // apply mode: 기존 registry 삭제 (또는 status=split) + 강사별 record 생성
  if (!registry) {
    return NextResponse.json({ ok: false, error: "apply_requires_registry_key" }, { status: 400 });
  }
  const run = await prisma.pipelineRun.create({
    data: {
      runType: "split_sheet_by_instructor",
      status: "running",
      triggeredBy: "api:/api/admin/split-sheet-by-instructor",
    },
  });
  let created = 0;
  for (const p of plans) {
    const recordKey = `split:${resolvedFileId}:${p.instructor_id}`;
    // record 직접 생성 (기존 record는 사용자가 cleanup)
    await prisma.satisfactionRecord.create({
      data: {
        instructorDbId: p.instructor_id,
        sourceType: "drive_satisfaction",
        sourceRef: {
          file_id: resolvedFileId,
          file_name: file.fileName,
          source_ref_key: recordKey,
          split_from_registry: registry.registryKey,
          method: "response_timestamp_ops_match",
          run_id: run.id,
        },
        score: p.avg_score,
        respondentCount: p.respondent_count,
        responseDate: new Date(p.response_date_min),
        companyName: company,
        courseName: registry.courseName,
        createdBy: "api:/api/admin/split-sheet-by-instructor",
      },
    });
    created += 1;
  }
  // registry는 split 처리됨 → status 변경
  await prisma.satisfactionReviewRegistry.update({
    where: { registryKey: registry.registryKey },
    data: {
      matchStatus: "split_by_timestamp",
      resolutionBasis: `split_sheet|file=${resolvedFileId}|created=${created}|date=${new Date().toISOString()}`,
    },
  });
  await prisma.pipelineRun.update({
    where: { id: run.id },
    data: { status: "succeeded", finishedAt: new Date() },
  });

  return NextResponse.json({
    ok: true,
    mode,
    created,
    file_id: resolvedFileId,
    file_name: file.fileName,
  });
}
