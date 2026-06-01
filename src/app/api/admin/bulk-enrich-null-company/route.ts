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

  interface Plan {
    record_id: string;
    instructor: string;
    source_type: string;
    extracted_company: string;
    source_hint: string;
  }
  const plans: Plan[] = [];
  const skipped: { record_id: string; instructor: string; reason: string; hint: string }[] = [];

  for (const r of records) {
    let extractedCo: string | null = null;
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
      hint = `file=${fileName ?? ""} sheet=${sheetTitle ?? ""}`;
      extractedCo =
        extractCompany(fileName ?? null, keywords) ??
        extractCompany(sheetTitle ?? null, keywords);
    } else if (r.sourceType === "gmail_summary") {
      const sr = r.sourceRef as Record<string, unknown> | null;
      const rk = typeof sr?.registry_key === "string" ? sr.registry_key : null;
      const item = rk ? rawByKey.get(rk) : undefined;
      const rawCo = item?.candidateCompanyName?.trim() ?? null;
      const np = item?.normalizedPayload as Record<string, unknown> | undefined;
      const subject = typeof np?.subject === "string" ? np.subject : "";
      const body = typeof np?.body_excerpt === "string" ? np.body_excerpt : "";
      hint = `subject=${subject.slice(0, 60)}`;
      extractedCo =
        rawCo ??
        extractCompany(subject, keywords) ??
        extractCompany(body, keywords);
    }

    if (extractedCo) {
      plans.push({
        record_id: r.id,
        instructor: r.instructor.name,
        source_type: r.sourceType,
        extracted_company: extractedCo,
        source_hint: hint.slice(0, 120),
      });
    } else {
      skipped.push({
        record_id: r.id,
        instructor: r.instructor.name,
        reason: "no_extract",
        hint: hint.slice(0, 120),
      });
    }
  }

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      mode: "dry_run",
      total_null: records.length,
      plan_count: plans.length,
      skipped_count: skipped.length,
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
