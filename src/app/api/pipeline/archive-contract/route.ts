/**
 * POST /api/pipeline/archive-contract
 *
 * 사용자가 2026-05-26에 알려준 archive 계약시트 (xlsx)
 *   "★조교 계약 작성 요청_B2B교육사업본부_DT기업교육팀.xlsx"
 *   ID: 1hl6VxXYN1kJoQlRCpbpyWV2PFsu3LhFQ
 *   2024-08 이전 강사 강의 이력
 *
 * 흐름: Drive binary download → xlsx 파싱 → 헤더 매핑 → TeachingHistory upsert.
 * 인증: CRON_SECRET
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";
import { collectArchiveContract } from "@/lib/pipeline/archive-contract-collector";
import { normalizeArchiveRows } from "@/lib/pipeline/archive-contract-normalizer";
import {
  storeArchiveRows,
  recomputeAggregatesForArchiveInstructors,
} from "@/lib/pipeline/archive-contract-store";

export const maxDuration = 180;
export const dynamic = "force-dynamic";

/**
 * F4: archive 회사 추출 강화 — record DB에 있는 모든 unique companyName을
 * dynamic keyword로 학습. archive 시트의 venue/memo/course 텍스트에서
 * record와 매칭되는 회사명을 추출.
 *
 * 추가로 NEW 계약시트(TH)와 strong 강사 affiliation 회사도 학습.
 */
async function buildDynamicCompanyKeywords(): Promise<string[]> {
  const [recordCompanies, thCompanies] = await Promise.all([
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
  const set = new Set<string>();
  for (const r of recordCompanies) {
    const c = r.companyName?.trim();
    if (c && c.length >= 2 && c.length <= 30) set.add(c);
  }
  for (const t of thCompanies) {
    const c = t.companyName?.trim();
    if (c && c.length >= 2 && c.length <= 30) set.add(c);
  }
  return Array.from(set);
}

export async function POST(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const startedAt = Date.now();
  try {
    const collected = await collectArchiveContract();
    const dynamicKeywords = await buildDynamicCompanyKeywords();
    let totalNormalized = 0;
    const perSheet = collected.sheets.map((s) => {
      const normalized = normalizeArchiveRows(s.rows, dynamicKeywords);
      totalNormalized += normalized.length;
      return { sheet: s, normalized };
    });
    const allNormalized = perSheet.flatMap((x) => x.normalized);
    const storeResult = await storeArchiveRows(allNormalized);
    const aggResult = await recomputeAggregatesForArchiveInstructors(
      storeResult.instructorIdsAffected
    );

    return NextResponse.json({
      ok: true,
      durationMs: Date.now() - startedAt,
      sheets: perSheet.map((x) => ({
        name: x.sheet.sheetName,
        fetched: x.sheet.fetchedCount,
        normalized: x.normalized.length,
        error: x.sheet.error ?? null,
      })),
      total_normalized: totalNormalized,
      store: {
        fetched: storeResult.fetched,
        appended: storeResult.appended,
        updated: storeResult.updated,
        deduped: storeResult.deduped,
        skipped_no_instructor: storeResult.skippedNoInstructor,
        errors: storeResult.errors.slice(0, 10),
        affected_instructors: storeResult.instructorIdsAffected.size,
      },
      aggregates_updated: aggResult.updated,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        durationMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}
