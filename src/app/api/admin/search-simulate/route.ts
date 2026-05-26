/**
 * GET /api/admin/search-simulate?query=KB&limit=20
 *
 * CRON_SECRET 인증으로 /api/instructors 검색 로직 결과 미리보기.
 * NextAuth session 없이도 검색 결과 확인 가능 — Phase A 검증·deploy 확인용.
 *
 * 응답: matched 강사 list + matched_field/matched_companies/matched_courses 메타.
 *
 * 만족도·TH 가드레일: read-only.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";
import { shouldIncludeInInstructorList } from "@/lib/instructor-list-visibility";
import { extractNotionPropertyTextList } from "@/lib/notion-property-utils";
import {
  normalizeCompanyWithAlias,
  companyMatchesWithAlias,
} from "@/lib/company-aliases";
import { resolveCanonical, KNOWN_ALIASES } from "@/lib/instructor-aliases";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const query = (request.nextUrl.searchParams.get("query") ?? "").trim();
  const limit = parseInt(request.nextUrl.searchParams.get("limit") ?? "20", 10);

  if (!query) {
    return NextResponse.json({ ok: false, error: "query param required" });
  }

  const startedAt = Date.now();
  const allInst = (
    await prisma.instructor.findMany({
      include: {
        teachingHistories: {
          select: { companyName: true, courseName: true },
        },
      },
    })
  ).filter((inst) => shouldIncludeInInstructorList(inst));

  const lowerQuery = query.toLowerCase();
  const nameAliasSet = new Set<string>([lowerQuery]);
  const canonical = resolveCanonical(query);
  if (canonical) nameAliasSet.add(canonical.toLowerCase());
  const aliasGroup = KNOWN_ALIASES[query.trim()];
  if (aliasGroup) for (const a of aliasGroup) nameAliasSet.add(a.toLowerCase());
  const normalizedQueryCompany = normalizeCompanyWithAlias(query);

  const hits: Array<{
    id: string;
    name: string;
    score: number | null;
    matched_field:
      | "name"
      | "categories"
      | "specialties"
      | "teaching_titles"
      | "affiliation"
      | "teaching_company"
      | "teaching_course"
      | null;
    matched_companies: string[];
    matched_courses: string[];
  }> = [];

  for (const inst of allInst) {
    const teachingInfo = extractNotionPropertyTextList(
      inst.notionRawProperties,
      "담당 강의 정보"
    );
    let field:
      | "name"
      | "categories"
      | "specialties"
      | "teaching_titles"
      | "affiliation"
      | "teaching_company"
      | "teaching_course"
      | null = null;
    const companies = new Set<string>();
    const courses = new Set<string>();

    for (const aliasLower of nameAliasSet) {
      if (inst.name.toLowerCase().includes(aliasLower)) {
        field = "name";
        break;
      }
    }
    if (
      field === null &&
      inst.categories.some((c) => c.toLowerCase().includes(lowerQuery))
    )
      field = "categories";
    if (
      field === null &&
      inst.specialties.some((s) => s.toLowerCase().includes(lowerQuery))
    )
      field = "specialties";
    if (
      field === null &&
      teachingInfo.some((v) => v.toLowerCase().includes(lowerQuery))
    )
      field = "teaching_titles";
    if (
      field === null &&
      inst.affiliation &&
      inst.affiliation.toLowerCase().includes(lowerQuery)
    )
      field = "affiliation";

    if (normalizedQueryCompany && normalizedQueryCompany.length >= 2) {
      for (const th of inst.teachingHistories) {
        if (!th.companyName) continue;
        if (companyMatchesWithAlias(th.companyName, query)) {
          companies.add(th.companyName);
          if (field === null) field = "teaching_company";
        }
      }
    }
    for (const th of inst.teachingHistories) {
      if (!th.courseName) continue;
      if (th.courseName.toLowerCase().includes(lowerQuery)) {
        courses.add(th.courseName);
        if (field === null) field = "teaching_course";
      }
    }

    if (field !== null || companies.size > 0 || courses.size > 0) {
      hits.push({
        id: inst.id,
        name: inst.name,
        score: inst.score !== null ? Number(inst.score) : null,
        matched_field: field,
        matched_companies: Array.from(companies).slice(0, 5),
        matched_courses: Array.from(courses).slice(0, 5),
      });
    }
  }

  hits.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  return NextResponse.json({
    ok: true,
    query,
    normalized_company: normalizedQueryCompany,
    name_alias_set: Array.from(nameAliasSet),
    elapsed_ms: Date.now() - startedAt,
    total_match: hits.length,
    showing: Math.min(hits.length, limit),
    instructors_total: allInst.length,
    hits: hits.slice(0, limit),
  });
}
