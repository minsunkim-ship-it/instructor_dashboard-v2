/**
 * POST /api/admin/bulk-enrich-null-company?dry_run=1
 *
 * companyName=null인 record에 source_ref 또는 raw_payload에서 회사명 추출 + update.
 *
 * 추출 패턴:
 *   - drive_satisfaction: source_ref.file_name 또는 sheet_title에서 dynamic keyword 매칭
 *   - gmail_summary: SatisfactionImportItem (sourceRefKey 기준) → raw_payload.subject + normalized_payload
 *
 * 인증: CRON_SECRET
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";
import { refreshSatisfactionAggregates } from "@/lib/pipeline/satisfaction-applier";
import { COURSE_COUNT_SOURCE_TYPES } from "@/lib/pipeline/teaching-history-sources";

export const maxDuration = 90;
export const dynamic = "force-dynamic";

function safeIncludes(text: string, keyword: string): boolean {
  if (!text || !keyword) return false;
  if (keyword.length >= 4) return text.includes(keyword);
  const idx = text.indexOf(keyword);
  if (idx < 0) return false;
  const before = idx > 0 ? text[idx - 1] : "";
  const after = idx + keyword.length < text.length ? text[idx + keyword.length] : "";
  if (/^[A-Za-z]+$/.test(keyword)) {
    const isAlnum = (c: string) => /[A-Za-z0-9]/.test(c);
    if (isAlnum(before) || isAlnum(after)) return false;
  }
  return true;
}

function extractCompany(text: string | null, keywords: string[]): string | null {
  if (!text) return null;
  const sorted = [...keywords].sort((a, b) => b.length - a.length);
  for (const kw of sorted) {
    if (kw.length >= 2 && safeIncludes(text, kw)) return kw;
  }
  return null;
}

export async function POST(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const dryRun = request.nextUrl.searchParams.get("dry_run") === "1";

  // dynamic keywords from record + TH companies
  const [recCo, thCo] = await Promise.all([
    prisma.satisfactionRecord.findMany({
      where: { companyName: { not: null } },
      select: { companyName: true },
      distinct: ["companyName"],
    }),
    prisma.teachingHistory.findMany({
      where: { companyName: { not: null } },
      select: { companyName: true },
      distinct: ["companyName"],
    }),
  ]);
  const keywordSet = new Set<string>();
  for (const r of recCo) {
    const c = r.companyName?.trim();
    if (c && c.length >= 2 && c.length <= 30) keywordSet.add(c);
  }
  for (const t of thCo) {
    const c = t.companyName?.trim();
    if (c && c.length >= 2 && c.length <= 30) keywordSet.add(c);
  }
  const keywords = Array.from(keywordSet);

  // null company records
  const records = await prisma.satisfactionRecord.findMany({
    where: { OR: [{ companyName: null }, { companyName: "" }] },
    select: {
      id: true,
      instructorDbId: true,
      sourceType: true,
      sourceRef: true,
      courseName: true,
      responseDate: true,
      instructor: { select: { name: true } },
    },
  });

  // gmail raw payload lookup map
  const gmailRegistryKeys: string[] = [];
  for (const r of records) {
    if (r.sourceType !== "gmail_summary") continue;
    const sr = r.sourceRef as Record<string, unknown> | null;
    const rk = typeof sr?.registry_key === "string" ? sr.registry_key : null;
    if (rk) gmailRegistryKeys.push(rk);
  }
  const importItems =
    gmailRegistryKeys.length > 0
      ? await prisma.satisfactionImportItem.findMany({
          where: {
            sourceType: "gmail_satisfaction",
            sourceRefKey: { in: gmailRegistryKeys },
          },
          select: {
            sourceRefKey: true,
            rawPayload: true,
            normalizedPayload: true,
            candidateCompanyName: true,
          },
        })
      : [];
  const rawByKey = new Map(importItems.map((i) => [i.sourceRefKey, i]));

  // v28 ground-truth chain: 계약시트 TH lookup용 pre-fetch.
  // 본인 강사 + responseDate ±14d 매칭으로 단일 회사 backfill 가능.
  const targetInstructorIds = Array.from(
    new Set(records.map((r) => r.instructorDbId))
  );
  const respDates = records
    .map((r) => r.responseDate)
    .filter((d): d is Date => !!d);
  const sourceTypesArr: string[] = [...COURSE_COUNT_SOURCE_TYPES];
  let contractTHs: Array<{
    instructorDbId: string;
    companyName: string | null;
    startDate: Date | null;
    endDate: Date | null;
  }> = [];
  if (targetInstructorIds.length > 0 && respDates.length > 0) {
    const minMs = Math.min(...respDates.map((d) => d.getTime()));
    const maxMs = Math.max(...respDates.map((d) => d.getTime()));
    const FOURTEEN = 14 * 24 * 60 * 60 * 1000;
    const minDate = new Date(minMs - FOURTEEN);
    const maxDate = new Date(maxMs + FOURTEEN);
    contractTHs = await prisma.teachingHistory.findMany({
      where: {
        instructorDbId: { in: targetInstructorIds },
        companyName: { not: null },
        sourceType: { in: sourceTypesArr },
        OR: [
          { startDate: { gte: minDate, lte: maxDate } },
          { endDate: { gte: minDate, lte: maxDate } },
          {
            AND: [
              { startDate: { lte: maxDate } },
              { endDate: { gte: minDate } },
            ],
          },
        ],
      },
      select: {
        instructorDbId: true,
        companyName: true,
        startDate: true,
        endDate: true,
      },
    });
  }
  const contractByInst = new Map<
    string,
    Array<{ companyName: string; startDate: Date | null; endDate: Date | null }>
  >();
  for (const t of contractTHs) {
    if (!t.companyName) continue;
    const arr = contractByInst.get(t.instructorDbId) ?? [];
    arr.push({
      companyName: t.companyName,
      startDate: t.startDate,
      endDate: t.endDate,
    });
    contractByInst.set(t.instructorDbId, arr);
  }

  function findContractCompany(
    instructorDbId: string,
    responseDate: Date | null,
    windowDays: number
  ): { company: string; days_from_response: number } | null {
    if (!responseDate) return null;
    const ths = contractByInst.get(instructorDbId) ?? [];
    const respMs = responseDate.getTime();
    const WINDOW_MS = windowDays * 24 * 60 * 60 * 1000;
    const matches: Array<{ company: string; diff: number }> = [];
    for (const t of ths) {
      const start = t.startDate?.getTime() ?? null;
      const end = t.endDate?.getTime() ?? start;
      if (start === null) continue;
      const closest =
        respMs >= start && respMs <= (end ?? start)
          ? 0
          : Math.min(
              Math.abs(respMs - start),
              Math.abs(respMs - (end ?? start))
            );
      if (closest <= WINDOW_MS) {
        matches.push({ company: t.companyName, diff: closest });
      }
    }
    if (matches.length === 0) return null;
    // 단일 회사로 dedupe (정공법: 모호하면 backfill 거부)
    const uniqCo = new Set(matches.map((m) => m.company));
    if (uniqCo.size !== 1) return null;
    matches.sort((a, b) => a.diff - b.diff);
    return {
      company: matches[0].company,
      days_from_response: Math.round(matches[0].diff / (24 * 60 * 60 * 1000)),
    };
  }

  interface Plan {
    record_id: string;
    instructor: string;
    source_type: string;
    extracted_company: string;
    source_hint: string;
    extraction_basis: string;
  }
  const plans: Plan[] = [];
  const skipped: { record_id: string; instructor: string; reason: string; hint: string }[] = [];

  for (const r of records) {
    let extractedCo: string | null = null;
    let extractionBasis = "";
    let hint = "";

    if (r.sourceType === "drive_satisfaction") {
      const sr = r.sourceRef as Record<string, unknown> | null;
      const refs = Array.isArray(sr?.source_refs) ? (sr.source_refs as Record<string, unknown>[]) : [];
      const fileName = typeof refs[0]?.source_ref === "object"
        ? (refs[0].source_ref as Record<string, unknown>).file_name as string | undefined
        : undefined;
      const sheetTitle = typeof refs[0]?.source_ref === "object"
        ? (refs[0].source_ref as Record<string, unknown>).sheet_title as string | undefined
        : undefined;
      hint = `file=${fileName ?? ""} sheet=${sheetTitle ?? ""} course=${r.courseName ?? ""}`;
      const fileCo = extractCompany(fileName ?? null, keywords);
      if (fileCo) {
        extractedCo = fileCo;
        extractionBasis = "drive_file_name";
      }
      if (!extractedCo) {
        const sheetCo = extractCompany(sheetTitle ?? null, keywords);
        if (sheetCo) {
          extractedCo = sheetCo;
          extractionBasis = "drive_sheet_title";
        }
      }
      // v28: record.courseName 자체에 회사명이 박힌 케이스 (예: 한지혜 디자인씽킹 케이스
      // 처럼 stale일 수 있으나, 진짜 회사명이 박힌 케이스도 회복).
      if (!extractedCo && r.courseName) {
        const courseCo = extractCompany(r.courseName, keywords);
        if (courseCo) {
          extractedCo = courseCo;
          extractionBasis = "drive_course_name";
        }
      }
    } else if (r.sourceType === "gmail_summary") {
      const sr = r.sourceRef as Record<string, unknown> | null;
      const rk = typeof sr?.registry_key === "string" ? sr.registry_key : null;
      const item = rk ? rawByKey.get(rk) : undefined;
      const rawCo = item?.candidateCompanyName?.trim() ?? null;
      const np = item?.normalizedPayload as Record<string, unknown> | undefined;
      const subject = typeof np?.subject === "string" ? np.subject : "";
      const body = typeof np?.body_excerpt === "string" ? np.body_excerpt : "";
      hint = `subject=${subject.slice(0, 60)} course=${r.courseName ?? ""}`;
      if (rawCo) {
        extractedCo = rawCo;
        extractionBasis = "gmail_candidate_company";
      }
      if (!extractedCo) {
        const subjectCo = extractCompany(subject, keywords);
        if (subjectCo) {
          extractedCo = subjectCo;
          extractionBasis = "gmail_subject";
        }
      }
      if (!extractedCo) {
        const bodyCo = extractCompany(body, keywords);
        if (bodyCo) {
          extractedCo = bodyCo;
          extractionBasis = "gmail_body";
        }
      }
      // v28 정공법: SatisfactionImportItem이 cleanup된 case (raw_lost)도
      // record.courseName에 회사명이 박혀 있으면 즉시 회복.
      // 사용자 case 공지연 "삼성디스플레이 AI를 활용한 기업홍보과정" 등.
      if (!extractedCo && r.courseName) {
        const courseCo = extractCompany(r.courseName, keywords);
        if (courseCo) {
          extractedCo = courseCo;
          extractionBasis = "gmail_course_name";
        }
      }
    }

    // v28 ground-truth chain fallback: source 신호 전부 실패한 경우, 계약시트(TH)
    // 본인 강사 + responseDate ±14d 단일 회사 매칭 시 회복.
    if (!extractedCo) {
      const contractMatch = findContractCompany(
        r.instructorDbId,
        r.responseDate,
        14
      );
      if (contractMatch) {
        extractedCo = contractMatch.company;
        extractionBasis = `contract_th_14d(${contractMatch.days_from_response}d)`;
        hint = `${hint} | th_match=${contractMatch.company}`;
      }
    }

    if (extractedCo) {
      plans.push({
        record_id: r.id,
        instructor: r.instructor.name,
        source_type: r.sourceType,
        extracted_company: extractedCo,
        source_hint: hint.slice(0, 160),
        extraction_basis: extractionBasis,
      });
    } else {
      skipped.push({
        record_id: r.id,
        instructor: r.instructor.name,
        reason: "no_extract",
        hint: hint.slice(0, 160),
      });
    }
  }

  if (dryRun) {
    const basisCounts: Record<string, number> = {};
    for (const p of plans) {
      basisCounts[p.extraction_basis] =
        (basisCounts[p.extraction_basis] ?? 0) + 1;
    }
    return NextResponse.json({
      ok: true,
      mode: "dry_run",
      total_null: records.length,
      plan_count: plans.length,
      skipped_count: skipped.length,
      extraction_basis_counts: basisCounts,
      plans: plans.slice(0, 50),
      skipped_samples: skipped.slice(0, 15),
    });
  }

  let updated = 0;
  const affected = new Set<string>();
  for (const p of plans) {
    try {
      const rec = await prisma.satisfactionRecord.findUnique({
        where: { id: p.record_id },
        select: { instructorDbId: true },
      });
      if (!rec) continue;
      await prisma.satisfactionRecord.update({
        where: { id: p.record_id },
        data: { companyName: p.extracted_company },
      });
      affected.add(rec.instructorDbId);
      updated += 1;
    } catch {
      // skip on error
    }
  }
  if (affected.size > 0) await refreshSatisfactionAggregates(Array.from(affected));
  return NextResponse.json({
    ok: true,
    mode: "apply",
    updated,
    affected_instructors: affected.size,
  });
}
