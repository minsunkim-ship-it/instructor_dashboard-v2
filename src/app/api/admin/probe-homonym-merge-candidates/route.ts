/**
 * GET /api/admin/probe-homonym-merge-candidates
 *
 * 동명이인 그룹에서 alias merge 가능 case 진단 (read-only).
 *
 * 알고리즘 (general):
 *   1. base name (suffix A/B/C 제거)이 같은 Instructor 그룹
 *   2. 그룹 안에 strong (contactEmail 있음) + weak (contact 없음, record/TH 보유) 존재
 *   3. weak의 TH 회사 list가 strong과 겹치는지 비교
 *   4. SatisfactionRecord/TH가 weak로 매핑된 경우 strong으로 redirect 후보
 *
 * 인증: CRON_SECRET
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";

export const maxDuration = 60;
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

function normalizeCompany(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[\s()[\]{}.,:;'"`~!?+\-_/\\|]+/g, "");
}

export async function GET(request: NextRequest) {
  if (!authorize(request)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const startedAt = Date.now();

  const all = await prisma.instructor.findMany({
    select: {
      id: true,
      name: true,
      contactEmail: true,
      contactPhone: true,
      satisfactionAvg: true,
      satisfactionCount: true,
      totalCourses: true,
    },
  });

  const allTHs = await prisma.teachingHistory.findMany({
    select: { instructorDbId: true, companyName: true },
  });
  const allRecords = await prisma.satisfactionRecord.findMany({
    select: { instructorDbId: true },
  });

  const thByInst = new Map<string, Set<string>>();
  for (const t of allTHs) {
    if (!t.companyName) continue;
    const s = thByInst.get(t.instructorDbId) ?? new Set<string>();
    s.add(normalizeCompany(t.companyName));
    thByInst.set(t.instructorDbId, s);
  }
  const thCountByInst = new Map<string, number>();
  for (const t of allTHs) {
    thCountByInst.set(t.instructorDbId, (thCountByInst.get(t.instructorDbId) ?? 0) + 1);
  }
  const recordCountByInst = new Map<string, number>();
  for (const r of allRecords) {
    recordCountByInst.set(r.instructorDbId, (recordCountByInst.get(r.instructorDbId) ?? 0) + 1);
  }

  // base name 그룹
  const byBase = new Map<string, typeof all>();
  for (const i of all) {
    const base = getBaseName(i.name);
    if (base.length < 2) continue;
    const arr = byBase.get(base) ?? [];
    arr.push(i);
    byBase.set(base, arr);
  }

  interface MergeCandidate {
    baseName: string;
    weak: {
      id: string;
      name: string;
      contactEmail: string | null;
      contactPhone: string | null;
      th_count: number;
      record_count: number;
      th_companies: string[];
      satisfactionAvg: number | null;
      satisfactionCount: number;
    };
    strong: {
      id: string;
      name: string;
      contactEmail: string | null;
      contactPhone: string | null;
      th_count: number;
      record_count: number;
      th_companies: string[];
      satisfactionAvg: number | null;
      satisfactionCount: number;
    };
    company_overlap: string[];
    weak_unique_companies: string[];
    auto_safe: boolean; // 모든 weak 회사가 strong 회사 안에 포함 = 자동 merge 가능
  }
  const candidates: MergeCandidate[] = [];

  for (const [base, group] of byBase.entries()) {
    if (group.length < 2) continue;
    const strong = group.filter((i) => i.contactEmail || i.contactPhone);
    const weak = group.filter((i) => !i.contactEmail && !i.contactPhone);
    if (strong.length !== 1 || weak.length === 0) continue; // 단일 strong + ≥1 weak case만

    const strongRow = strong[0];
    const strongCompanies = thByInst.get(strongRow.id) ?? new Set<string>();

    for (const weakRow of weak) {
      const weakCompanies = thByInst.get(weakRow.id) ?? new Set<string>();
      const thCount = thCountByInst.get(weakRow.id) ?? 0;
      const recordCount = recordCountByInst.get(weakRow.id) ?? 0;
      // weak가 record/TH 둘 다 없으면 그냥 unused row — merge 대상 아님 (별개 처리)
      if (thCount === 0 && recordCount === 0) continue;

      const overlap = Array.from(weakCompanies).filter((c) => strongCompanies.has(c));
      const weakOnly = Array.from(weakCompanies).filter((c) => !strongCompanies.has(c));
      const autoSafe = weakOnly.length === 0 && weakCompanies.size > 0;

      candidates.push({
        baseName: base,
        weak: {
          id: weakRow.id,
          name: weakRow.name,
          contactEmail: weakRow.contactEmail,
          contactPhone: weakRow.contactPhone,
          th_count: thCount,
          record_count: recordCount,
          th_companies: Array.from(weakCompanies),
          satisfactionAvg: weakRow.satisfactionAvg !== null ? Number(weakRow.satisfactionAvg) : null,
          satisfactionCount: weakRow.satisfactionCount,
        },
        strong: {
          id: strongRow.id,
          name: strongRow.name,
          contactEmail: strongRow.contactEmail,
          contactPhone: strongRow.contactPhone,
          th_count: thCountByInst.get(strongRow.id) ?? 0,
          record_count: recordCountByInst.get(strongRow.id) ?? 0,
          th_companies: Array.from(strongCompanies),
          satisfactionAvg:
            strongRow.satisfactionAvg !== null ? Number(strongRow.satisfactionAvg) : null,
          satisfactionCount: strongRow.satisfactionCount,
        },
        company_overlap: overlap,
        weak_unique_companies: weakOnly,
        auto_safe: autoSafe,
      });
    }
  }

  return NextResponse.json({
    ok: true,
    durationMs: Date.now() - startedAt,
    total_merge_candidates: candidates.length,
    auto_safe_count: candidates.filter((c) => c.auto_safe).length,
    candidates,
  });
}
