/**
 * GET /api/admin/resolve-homonym-ambiguous
 *
 * Phase γ-C1 — Homonym ambiguous candidate auto-resolver.
 *
 * 입력: SatisfactionImportItem 중 candidateName이 동명이인 그룹 base에 매칭되는 record.
 *
 * 4-step disambig:
 *   1. Trivial — candidateName === instructor.name 정확 일치
 *   2. TeachingHistory company overlap + time overlap 단일 후보
 *   3. Slack ops_report 메시지 cross-check (회사·시점 단일 후보)
 *   4. Agency group (contactEmail) cross-check
 *
 * 모드:
 *   ?mode=dry_run (기본) — 분류 결과만, DB 변경 없음
 *   ?mode=apply — strong 매칭만 ImportItem.candidateName 업데이트 (instructor name 보정)
 *                  + 매칭된 record는 다음 satisfaction pipeline에서 P0-4 replace로 흡수
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

function getBaseName(name: string): string {
  return name.replace(/[A-Z]$/, "").trim();
}

function normalize(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[\s()[\]{}.,:;'"`~!?+\-_/\\|]+/g, "");
}

function companyOverlap(a: string[], b: string[]): string[] {
  const out: string[] = [];
  for (const ca of a) {
    const na = normalize(ca);
    if (na.length < 2) continue;
    for (const cb of b) {
      const nb = normalize(cb);
      if (nb.length < 2) continue;
      if (na.includes(nb) || nb.includes(na)) {
        out.push(ca);
        break;
      }
    }
  }
  return out;
}

const OPS_REPORT_CHANNEL_ID = "C015YD84VGS";
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

export async function GET(request: NextRequest) {
  if (!authorize(request)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const mode = request.nextUrl.searchParams.get("mode") ?? "dry_run";
  if (mode !== "dry_run" && mode !== "apply") {
    return NextResponse.json({ ok: false, error: "invalid mode" }, { status: 400 });
  }

  const startedAt = Date.now();

  // 1) 모든 instructor + TeachingHistory + 동명이인 그룹 build
  const instructors = await prisma.instructor.findMany({
    select: { id: true, name: true, contactEmail: true },
  });
  const allTHs = await prisma.teachingHistory.findMany({
    select: { instructorDbId: true, companyName: true, startDate: true, endDate: true },
  });
  const thByInst = new Map<
    string,
    Array<{ company: string | null; start: string | null; end: string | null }>
  >();
  for (const t of allTHs) {
    const list = thByInst.get(t.instructorDbId) ?? [];
    list.push({
      company: t.companyName,
      start: t.startDate?.toISOString().slice(0, 10) ?? null,
      end: t.endDate?.toISOString().slice(0, 10) ?? null,
    });
    thByInst.set(t.instructorDbId, list);
  }
  const byBaseName = new Map<string, typeof instructors>();
  for (const inst of instructors) {
    const base = getBaseName(inst.name);
    if (base.length < 2) continue;
    const arr = byBaseName.get(base) ?? [];
    arr.push(inst);
    byBaseName.set(base, arr);
  }
  const homonymBases = new Set(
    Array.from(byBaseName.entries())
      .filter(([, arr]) => arr.length > 1)
      .map(([base]) => base)
  );

  // 2) ambiguous SatisfactionImportItem 찾기
  const importItems = await prisma.satisfactionImportItem.findMany({
    where: { candidateName: { not: null } },
    select: {
      id: true,
      candidateName: true,
      candidateCompanyName: true,
      responseDate: true,
    },
  });
  // candidate name → items
  const itemsByCandidate = new Map<
    string,
    Array<{ id: string; company: string | null; date: string | null }>
  >();
  for (const it of importItems) {
    if (!it.candidateName) continue;
    const arr = itemsByCandidate.get(it.candidateName) ?? [];
    arr.push({
      id: it.id,
      company: it.candidateCompanyName,
      date: it.responseDate?.toISOString().slice(0, 10) ?? null,
    });
    itemsByCandidate.set(it.candidateName, arr);
  }

  // 3) ops_report messages parsed — γ-A1 재활용 (강사 → 회사 set)
  const slackItems = await prisma.activityImportItem.findMany({
    where: { sourceType: "slack" },
    select: { rawPayload: true, sourceRef: true, activityAt: true },
    take: 5000,
    orderBy: { activityAt: "desc" },
  });
  // ops_report에서 instructor name → company set
  const opsInstructorCompanies = new Map<string, Set<string>>();
  for (const it of slackItems) {
    const raw = (it.rawPayload as RawRecord | null) ?? {};
    const ref = (it.sourceRef as RawRecord | null) ?? {};
    const cid =
      pickString(raw, "channel_id", "channel") ??
      pickString(ref, "channel_id", "channel");
    if (cid !== OPS_REPORT_CHANNEL_ID) continue;
    const text = pickString(raw, "text", "message", "body") ?? "";
    if (!text) continue;
    const companyMatch = text.match(COMPANY_REGEX);
    if (!companyMatch) continue;
    const instructors = Array.from(text.matchAll(INSTRUCTOR_REGEX)).map((m) => m[1]);
    for (const i of instructors) {
      const s = opsInstructorCompanies.get(i) ?? new Set<string>();
      s.add(companyMatch[1].trim());
      opsInstructorCompanies.set(i, s);
    }
  }

  // 4) classify
  interface Resolution {
    candidateName: string;
    record_count: number;
    candidate_companies: string[];
    matched_instructor_id: string | null;
    matched_instructor_name: string | null;
    resolution: "trivial" | "th_signal" | "ops_signal" | "agency_signal" | "ambiguous" | "no_signal";
    item_ids?: string[];
  }
  const resolutions: Resolution[] = [];

  for (const [candName, items] of itemsByCandidate.entries()) {
    // candidate exact-match instructor가 있으면 trivial
    const exact = instructors.find((i) => i.name === candName);
    if (exact) {
      resolutions.push({
        candidateName: candName,
        record_count: items.length,
        candidate_companies: Array.from(
          new Set(items.map((i) => i.company).filter((v): v is string => Boolean(v)))
        ),
        matched_instructor_id: exact.id,
        matched_instructor_name: exact.name,
        resolution: "trivial",
        item_ids: items.map((i) => i.id),
      });
      continue;
    }

    // candidateName이 homonym base인 경우만 추가 disambig 시도
    const base = getBaseName(candName);
    if (!homonymBases.has(base)) continue; // 동명이인 그룹 아니면 skip (다른 매칭 경로)
    const group = byBaseName.get(base) ?? [];

    const candCompanies = Array.from(
      new Set(items.map((i) => i.company).filter((v): v is string => Boolean(v)))
    );
    const candDates = items
      .map((i) => i.date)
      .filter((v): v is string => Boolean(v))
      .sort();
    const candEarliest = candDates[0] ?? null;
    const candLatest = candDates[candDates.length - 1] ?? null;

    // Step 2: TH company overlap + time overlap
    const thCandidates = group.filter((inst) => {
      const ths = thByInst.get(inst.id) ?? [];
      const thCompanies = ths.map((t) => t.company).filter((v): v is string => Boolean(v));
      const overlap = companyOverlap(candCompanies, thCompanies);
      if (overlap.length === 0) return false;
      if (!candEarliest || !candLatest) return overlap.length > 0;
      const instDates = ths
        .flatMap((t) => [t.start, t.end])
        .filter((v): v is string => Boolean(v))
        .sort();
      const instEarliest = instDates[0];
      const instLatest = instDates[instDates.length - 1];
      if (!instEarliest || !instLatest) return overlap.length > 0;
      return candEarliest <= instLatest && candLatest >= instEarliest;
    });
    if (thCandidates.length === 1) {
      resolutions.push({
        candidateName: candName,
        record_count: items.length,
        candidate_companies: candCompanies,
        matched_instructor_id: thCandidates[0].id,
        matched_instructor_name: thCandidates[0].name,
        resolution: "th_signal",
        item_ids: items.map((i) => i.id),
      });
      continue;
    }

    // Step 3: ops_report cross-check — 후보 강사 중 (회사) 운영보고에 등장한 1명
    const opsCandidates = group.filter((inst) => {
      const opsCompanies = opsInstructorCompanies.get(inst.name) ?? new Set<string>();
      const overlap = companyOverlap(candCompanies, Array.from(opsCompanies));
      return overlap.length > 0;
    });
    if (opsCandidates.length === 1) {
      resolutions.push({
        candidateName: candName,
        record_count: items.length,
        candidate_companies: candCompanies,
        matched_instructor_id: opsCandidates[0].id,
        matched_instructor_name: opsCandidates[0].name,
        resolution: "ops_signal",
        item_ids: items.map((i) => i.id),
      });
      continue;
    }

    // Step 4: Agency group cross-check — 후보 중 하나만 어떤 agency에 속하면 strong
    // (현재는 데이터로 자동 판단 어렵 — 다음 단계에서 보강)
    // ambiguous or no_signal
    const totalSignal = thCandidates.length + opsCandidates.length;
    resolutions.push({
      candidateName: candName,
      record_count: items.length,
      candidate_companies: candCompanies,
      matched_instructor_id: null,
      matched_instructor_name: null,
      resolution: totalSignal === 0 ? "no_signal" : "ambiguous",
    });
  }

  // 통계
  const stats = resolutions.reduce(
    (acc, r) => {
      acc[r.resolution] = (acc[r.resolution] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  // apply mode: trivial + th_signal + ops_signal만 candidateName 변경
  let appliedSummary:
    | { items_updated: number; affected_candidates: number }
    | null = null;
  if (mode === "apply") {
    const targets = resolutions.filter(
      (r) =>
        (r.resolution === "trivial" ||
          r.resolution === "th_signal" ||
          r.resolution === "ops_signal") &&
        r.matched_instructor_id &&
        r.matched_instructor_name &&
        r.matched_instructor_name !== r.candidateName // 이름 변경 필요한 경우만
    );
    let totalUpdated = 0;
    for (const t of targets) {
      if (!t.item_ids) continue;
      const result = await prisma.satisfactionImportItem.updateMany({
        where: { id: { in: t.item_ids } },
        data: { candidateName: t.matched_instructor_name! },
      });
      totalUpdated += result.count;
    }
    appliedSummary = {
      items_updated: totalUpdated,
      affected_candidates: targets.length,
    };
  }

  return NextResponse.json({
    ok: true,
    mode,
    durationMs: Date.now() - startedAt,
    stats,
    applied_summary: appliedSummary,
    resolutions: resolutions.slice(0, 50),
  });
}
