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
// v24-22: 1순위 채널 (운영보고 + general). 못 찾으면 fallback (강사별/제안 채널)
const PRIMARY_CHANNELS = new Set([OPS_REPORT, GENERAL]);
const FALLBACK_CHANNELS = new Set([
  "C04MTRMSW5P", // #b2b_1팀_견적제안
  "C096A5Z7S0Y", // #b2b_2팀_견적제안
  "C08EEAJ347J", // #스코프랩스-강사님-협업
  "C099UH7ACGG", // #b2b_정백님_출강요청
  "C0AS2VDUXQ8", // #b2b_신동원님_출강요청
]);
const ALL_CHANNELS = new Set([...PRIMARY_CHANNELS, ...FALLBACK_CHANNELS]);
const INSTRUCTOR_REGEX = /([가-힣]{2,4}[A-Z]?)\s*(?:강사|대표|교수|선생)님/g;
// v24-22: 차수 추출 — "_3차수", "3차수-2/5회차", "3차수 2회차" 등
const SESSION_REGEX = /(\d{1,2})\s*차수/g;
const ONE_DAY = 86400 * 1000;

function extractSessions(text: string): Set<string> {
  const sessions = new Set<string>();
  let m: RegExpExecArray | null;
  const re = new RegExp(SESSION_REGEX.source, "g");
  while ((m = re.exec(text)) !== null) sessions.add(m[1]);
  return sessions;
}

// v24-20: P0 가드 제거 — row별 ±1d ops 명시 단독 매칭은 정확. 데이터 왜곡 금지.

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
function findTimestampColumnIndex(headerRow: string[]): number {
  for (let i = 0; i < headerRow.length; i += 1) {
    const cell = headerRow[i]?.trim() ?? "";
    if (/(타임스탬프|Timestamp|시작\s*시간|Start\s*time|완료\s*시간|Completion\s*time)/i.test(cell)) {
      return i;
    }
  }
  return 0;
}
// v24-24: drive-normalizer의 정확한 패턴 + SUB_CATEGORY 차단
const INSTRUCTOR_SAT_PATTERNS = [
  /강사.*만족도/,
  /강사.*만족하/,
  /강의.*강사.*만족/,
  /강사.*강의.*만족/,
];
const OVERALL_SAT_PATTERNS = [
  /전체\s*만족도/,
  /전반적인?\s*(강의\s*)?만족도/,
  /전반적인?\s*(세미나\s*)?만족도/,
  /전반적으로\s*만족/,
  /^\d+\.\s*(강의\s*)?만족도\s*평가/,
  /^강의\s*만족도\s*평가/,
  /^만족도\s*평가/,
  /^\d+\.\s*전체\s*강의\s*만족도/,
];
const SATISFACTION_KEY = /만족(도|하|스|합)/;
const SUB_CATEGORY = /\[커리큘럼\]|\[인사이트\]|\[이론.*실습\]|\[현업적용\]|\[교수법\]|\[추천지수\]|난이도|속도|추천|어려운|이유/;

function findScoreColumnIndex(headerRow: string[]): number {
  for (const p of INSTRUCTOR_SAT_PATTERNS) {
    for (let i = 0; i < headerRow.length; i += 1) {
      const cell = headerRow[i]?.trim() ?? "";
      if (p.test(cell) && !SUB_CATEGORY.test(cell)) return i;
    }
  }
  for (const p of OVERALL_SAT_PATTERNS) {
    for (let i = 0; i < headerRow.length; i += 1) {
      const cell = headerRow[i]?.trim() ?? "";
      if (p.test(cell) && !SUB_CATEGORY.test(cell)) return i;
    }
  }
  for (let i = 0; i < headerRow.length; i += 1) {
    const cell = headerRow[i]?.trim() ?? "";
    if (SATISFACTION_KEY.test(cell) && !SUB_CATEGORY.test(cell)) return i;
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
  interface OpsMsg { ts: Date; instructors: string[]; text: string; sessions: Set<string>; tier: "primary" | "fallback" }
  const opsAll: OpsMsg[] = [];
  for (const it of slackItems) {
    const raw = (it.rawPayload as RawRecord | null) ?? {};
    const ref = (it.sourceRef as RawRecord | null) ?? {};
    const cid = pickString(raw, "channel_id", "channel") ?? pickString(ref, "channel_id", "channel");
    if (!cid || !ALL_CHANNELS.has(cid)) continue;
    const text = pickString(raw, "text", "message", "body") ?? "";
    if (!text || !it.activityAt) continue;
    const names = Array.from(new Set(Array.from(text.matchAll(INSTRUCTOR_REGEX)).map((m) => m[1])));
    if (names.length === 0) continue;
    opsAll.push({
      ts: it.activityAt,
      instructors: names,
      text,
      sessions: extractSessions(text),
      tier: PRIMARY_CHANNELS.has(cid) ? "primary" : "fallback",
    });
  }

  const allInstructors = await prisma.instructor.findMany({ select: { id: true, name: true } });
  const instByName = new Map(allInstructors.map((i) => [i.name, i]));

  // v24-26: TH course token 매칭용 — 강사 TH 전체 fetch (course token substring 매칭)
  const allTHsRaw = await prisma.teachingHistory.findMany({
    where: { courseName: { not: null } },
    select: { instructorDbId: true, courseName: true, startDate: true, endDate: true },
    take: 30000,
  });
  // instructorDbId → name 매핑
  const instById = new Map(allInstructors.map((i) => [i.id, i.name]));
  const allTHs = allTHsRaw.map((th) => ({
    ...th,
    instructorName: instById.get(th.instructorDbId) ?? null,
  })).filter((th) => th.instructorName !== null);

  // course에서 의미있는 token 추출 (회사명/일반 단어 제외)
  function extractCourseTokens(course: string): string[] {
    return course
      .replace(/_/g, " ")
      .replace(/[\(\)\[\]<>]/g, " ")
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 4 && !/^\d/.test(t) && !/^(과정|교육|만족도|평가|응답|차수|회차|특강|워크숍|아카데미)$/.test(t));
  }

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
    // v24-23: 모든 sheet 처리 (회차별 sub-sheet 포함)
    const validSheets = file.sheets.filter((s) => s.rows.length >= 2);
    if (validSheets.length === 0) {
      skipped.push({ registry_key: reg.registryKey, reason: "no_response_sheet" });
      continue;
    }

    interface Resp { ts: Date; score: number }
    const responses: Resp[] = [];
    for (const sheet of validSheets) {
      const header = sheet.rows[0];
      const scoreIdx = findScoreColumnIndex(header);
      if (scoreIdx === -1) continue;
      const tsIdx = findTimestampColumnIndex(header);
      for (let i = 1; i < sheet.rows.length; i += 1) {
        const row = sheet.rows[i];
        if (!row) continue;
        let ts = parseRowTimestamp(row[tsIdx]);
        if (!ts) {
          for (let j = 0; j < row.length; j += 1) {
            if (j === tsIdx) continue;
            ts = parseRowTimestamp(row[j]);
            if (ts) break;
          }
        }
        if (!ts) continue;
        const score = parseScore(row[scoreIdx] ?? "");
        if (score === null) continue;
        responses.push({ ts, score });
      }
    }
    if (responses.length === 0) {
      skipped.push({ registry_key: reg.registryKey, reason: "no_valid_responses" });
      continue;
    }

    // v24-22: registry course에서 차수(session) 추출
    const regSessions = extractSessions(reg.courseName ?? "");

    const byInstructor = new Map<string, { instructor_id: string; scores: number[]; min_ts: Date; max_ts: Date }>();
    let unmatched = 0;
    let ambiguousRow = 0;

    // v24-22: 매칭 strategy — single candidate 찾을 때까지 escalation
    // Tier 1 (primary, session match, ±3d) → Tier 2 (primary, session match, ±14d)
    //   → Tier 3 (primary, no session, ±7d) → Tier 4 (fallback, session match, ±14d) → 포기
    function tryFind(
      r: { ts: Date; score: number },
      opts: { tier: "primary" | "fallback" | "any"; sessionMatch: boolean; windowDays: number }
    ): Set<string> {
      const candidates = new Set<string>();
      const wMs = opts.windowDays * ONE_DAY;
      for (const op of opsAll) {
        if (opts.tier !== "any" && op.tier !== opts.tier) continue;
        if (Math.abs(op.ts.getTime() - r.ts.getTime()) > wMs) continue;
        const normText = normalizeCompanyWithAlias(op.text);
        if (!normText.includes(effectiveCompany)) continue;
        if (opts.sessionMatch && regSessions.size > 0) {
          // 차수 cross-check — registry 차수와 op 차수 교집합 있어야
          const intersect = Array.from(regSessions).some((s) => op.sessions.has(s));
          if (!intersect) continue;
        }
        for (const n of op.instructors) {
          if (!instByName.has(n)) continue;
          candidates.add(n);
        }
      }
      return candidates;
    }

    for (const r of responses) {
      // Tier 1: primary + session match + ±3d (가장 강한 신호)
      let candidates = regSessions.size > 0
        ? tryFind(r, { tier: "primary", sessionMatch: true, windowDays: 3 })
        : new Set<string>();
      // Tier 2: primary + session match + ±14d (session 매칭이 있으면 wide 안전)
      if (candidates.size !== 1 && regSessions.size > 0) {
        candidates = tryFind(r, { tier: "primary", sessionMatch: true, windowDays: 14 });
      }
      // Tier 3: primary + ±7d (session 매칭 없을 때 / session 매칭 후보 다중)
      if (candidates.size !== 1) {
        candidates = tryFind(r, { tier: "primary", sessionMatch: false, windowDays: 7 });
      }
      // Tier 4 fallback: 강사별/제안 채널 + session match + ±14d (1순위 못 찾을 때만)
      if (candidates.size === 0 && regSessions.size > 0) {
        candidates = tryFind(r, { tier: "fallback", sessionMatch: true, windowDays: 14 });
      }
      // Tier 5 fallback: 강사별/제안 채널 + ±7d
      if (candidates.size === 0) {
        candidates = tryFind(r, { tier: "fallback", sessionMatch: false, windowDays: 7 });
      }
      // Tier 6 (v24-26): 사용자 룰 "기업명 막히면 과정명 융합 검색"
      // 회사 매칭 ops 없을 때 TH course token 매칭으로 강사 후보 찾기
      // response_date ±60d window TH 중 registry course token 1개 이상 substring 매칭
      if (candidates.size === 0) {
        const regCourseStr = (reg.courseName ?? "").toLowerCase();
        const regTokens = extractCourseTokens(regCourseStr);
        if (regTokens.length > 0) {
          const window60 = 60 * ONE_DAY;
          const thCandidates = new Set<string>();
          for (const th of allTHs) {
            if (!th.instructorName || !instByName.has(th.instructorName)) continue;
            // response_date가 TH startDate~endDate 안 or ±60d window
            if (th.startDate && th.endDate) {
              const sd = th.startDate.getTime();
              const ed = th.endDate.getTime();
              const rs = r.ts.getTime();
              if (rs < sd - window60 || rs > ed + window60) continue;
            }
            const thCourseStr = (th.courseName ?? "").toLowerCase();
            const hits = regTokens.filter((t) => thCourseStr.includes(t));
            if (hits.length >= 1) {
              thCandidates.add(th.instructorName);
            }
          }
          if (thCandidates.size === 1) {
            candidates = thCandidates;
          }
          // size > 1 ambiguous면 skip (Tier 6 trigger 안 함)
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
