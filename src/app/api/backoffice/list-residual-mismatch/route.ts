/**
 * GET /api/backoffice/list-residual-mismatch
 *
 * 자동 처리 불가한 잔존 mismatch record를 카테고리별로 dump.
 * /admin/review에서 사용자 검토 큐로 표기.
 *
 * 카테고리:
 *   - null_co_drive_self  : drive_satisfaction 자가평가 (X 강사님_만족도). 정상 데이터
 *   - null_co_gmail_raw_lost : gmail SatisfactionImportItem cleanup. 회사 검증 불가, 점수 정상
 *   - empty_drive_generic : drive_satisfaction record 회사명이 generic (분야명)
 *   - has_suggested       : audit 추천 있지만 슬랙·gmail로 추천 잘못 확인 또는 미확인
 *
 * 인증: CRON_SECRET 또는 NextAuth session (proxy.ts 룰)
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";
import { companyMatchesWithAlias } from "@/lib/company-aliases";
import { auth, isAuthDisabled } from "@/auth";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

interface ResidualItem {
  record_id: string;
  instructor_id: string;
  instructor_name: string;
  company: string | null;
  course: string | null;
  score: number;
  respondent_count: number | null;
  response_date: string | null;
  source_type: string;
  file_name?: string | null;
  sheet_title?: string | null;
  suggested_instructor?: string | null;
  category:
    | "null_co_drive_self"
    | "null_co_gmail_raw_lost"
    | "empty_drive_generic"
    | "has_suggested";
}

export async function GET(request: NextRequest) {
  // cron secret 또는 NextAuth session 허용
  let authorized = false;
  if (isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    authorized = true;
  } else if (!isAuthDisabled()) {
    const session = await auth();
    if (session?.user?.email) authorized = true;
  } else {
    authorized = true;
  }
  if (!authorized) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  // 모든 record + 본인 TH 적재 (audit logic 재구현)
  const records = await prisma.satisfactionRecord.findMany({
    select: {
      id: true,
      instructorDbId: true,
      score: true,
      respondentCount: true,
      companyName: true,
      courseName: true,
      responseDate: true,
      sourceType: true,
      sourceRef: true,
      instructor: { select: { id: true, name: true } },
    },
  });
  const allTHs = await prisma.teachingHistory.findMany({
    where: { companyName: { not: null } },
    select: { instructorDbId: true, companyName: true },
  });
  const selfTHByInst = new Map<string, string[]>();
  for (const t of allTHs) {
    if (!t.companyName) continue;
    const arr = selfTHByInst.get(t.instructorDbId) ?? [];
    arr.push(t.companyName);
    selfTHByInst.set(t.instructorDbId, arr);
  }
  // self-record company count
  const selfRecCo = new Map<string, Map<string, number>>();
  for (const r of records) {
    if (!r.companyName) continue;
    const bucket = selfRecCo.get(r.instructorDbId) ?? new Map<string, number>();
    bucket.set(r.companyName, (bucket.get(r.companyName) ?? 0) + 1);
    selfRecCo.set(r.instructorDbId, bucket);
  }

  // 잔존 mismatch 판별
  const residual: ResidualItem[] = [];
  for (const r of records) {
    // self TH 매칭 있으면 skip (정상)
    if (r.companyName) {
      const selfTHs = selfTHByInst.get(r.instructorDbId) ?? [];
      if (selfTHs.some((c) => companyMatchesWithAlias(c, r.companyName))) continue;
      // self-strong (2+ 동일 회사) skip
      const selfCnt = selfRecCo.get(r.instructorDbId)?.get(r.companyName) ?? 0;
      if (selfCnt >= 2) continue;
    }

    const sr = r.sourceRef as Record<string, unknown> | null;
    const refs = Array.isArray(sr?.source_refs)
      ? (sr.source_refs as Record<string, unknown>[])
      : [];
    const inner =
      refs[0] && typeof refs[0].source_ref === "object"
        ? (refs[0].source_ref as Record<string, unknown>)
        : null;
    const fileName = typeof inner?.file_name === "string" ? inner.file_name : null;
    const sheetTitle = typeof inner?.sheet_title === "string" ? inner.sheet_title : null;

    // drive_satisfaction file_name이 record.companyName 매칭하면 trust (skip)
    if (r.sourceType === "drive_satisfaction" && r.companyName && fileName) {
      if (companyMatchesWithAlias(fileName, r.companyName)) continue;
    }

    // 카테고리 판정
    let category: ResidualItem["category"];
    if (!r.companyName) {
      if (r.sourceType === "drive_satisfaction" && fileName && /강사님_만족도/.test(fileName)) {
        category = "null_co_drive_self";
      } else if (r.sourceType === "gmail_summary") {
        category = "null_co_gmail_raw_lost";
      } else if (r.sourceType === "drive_satisfaction") {
        category = "null_co_drive_self";
      } else {
        category = "null_co_gmail_raw_lost";
      }
    } else if (r.sourceType === "drive_satisfaction") {
      category = "empty_drive_generic";
    } else {
      // has_suggested 후보 — 일단 generic 분류
      category = "has_suggested";
    }

    residual.push({
      record_id: r.id,
      instructor_id: r.instructorDbId,
      instructor_name: r.instructor.name,
      company: r.companyName,
      course: r.courseName?.slice(0, 100) ?? null,
      score: Number(r.score),
      respondent_count: r.respondentCount,
      response_date: r.responseDate?.toISOString().slice(0, 10) ?? null,
      source_type: r.sourceType,
      file_name: fileName,
      sheet_title: sheetTitle,
      category,
    });
  }

  // category별 group
  const byCategory: Record<string, { label: string; description: string; items: ResidualItem[] }> = {
    null_co_drive_self: {
      label: "강사 자가평가 (회사 N/A)",
      description: "X 강사님_만족도 sheet — 강사 본인 self-feedback. 정상 데이터.",
      items: [],
    },
    null_co_gmail_raw_lost: {
      label: "회사명 손실 (gmail raw cleanup)",
      description: "SatisfactionImportItem cleanup으로 회사 추적 불가. 점수 정상이면 진짜 강의 가능성.",
      items: [],
    },
    empty_drive_generic: {
      label: "회사명 결함 (분야명/generic)",
      description: "record 회사가 '디자인씽킹'/'파이썬' 등 강의 분야. normalizer 결함 record.",
      items: [],
    },
    has_suggested: {
      label: "추천 강사 있음 (사용자 검토 필요)",
      description: "audit가 다른 강사 추천. 슬랙/gmail로 진위 확인 필요.",
      items: [],
    },
  };
  for (const item of residual) {
    byCategory[item.category].items.push(item);
  }

  return NextResponse.json({
    ok: true,
    total: residual.length,
    categories: Object.entries(byCategory).map(([code, v]) => ({
      code,
      label: v.label,
      description: v.description,
      count: v.items.length,
      items: v.items.sort((a, b) => {
        if (a.instructor_name !== b.instructor_name)
          return a.instructor_name.localeCompare(b.instructor_name);
        return (a.response_date ?? "").localeCompare(b.response_date ?? "");
      }),
    })),
  });
}
