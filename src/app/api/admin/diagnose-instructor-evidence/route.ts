/**
 * GET /api/admin/diagnose-instructor-evidence?names=박두진,김용담&id=...
 *
 * 강사별 운영 인텔 evidence 매칭 진단 (read-only):
 *   - 마스터: name, affiliation, score, satisfactionCount, isPracticeCoach
 *   - teaching_history: 회사·과정 set + 건수
 *   - satisfactionImportItem 매칭 후보:
 *       candidateName 일치 / candidateCompanyName 일치 / candidateCourseName 일치
 *   - activityImportItem 매칭:
 *       matchedInstructorId 직접 매칭 / candidateName 일치
 *   - SourceLink: notion 외부키 보유 여부
 *   - InstructorIntelligence 현재 상태
 *
 * 만족도 가드레일: 모든 fetch read-only. 변경·매칭 로직 미수정.
 *
 * 인증: CRON_SECRET
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function normText(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

export async function GET(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const namesParam = request.nextUrl.searchParams.get("names") ?? "";
  const idParam = request.nextUrl.searchParams.get("id") ?? "";

  const names = namesParam
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const ids = idParam
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const where: import("@prisma/client").Prisma.InstructorWhereInput =
    ids.length > 0 && names.length > 0
      ? { OR: [{ id: { in: ids } }, { name: { in: names } }] }
      : ids.length > 0
        ? { id: { in: ids } }
        : names.length > 0
          ? { name: { in: names } }
          : {};

  const instructors = await prisma.instructor.findMany({
    where,
    select: {
      id: true,
      name: true,
      affiliation: true,
      score: true,
      satisfactionCount: true,
      satisfactionAvg: true,
      flag: true,
      isPracticeCoach: true,
      memoRaw: true,
      teachingHistories: {
        select: {
          companyName: true,
          courseName: true,
          startDate: true,
          endDate: true,
        },
      },
      sourceLinks: {
        select: { sourceType: true, externalKey: true, matchStatus: true },
      },
      instructorIntelligence: {
        select: {
          generatedAt: true,
          generatedBy: true,
          promptVersion: true,
          evidenceHash: true,
          dataRichness: true,
        },
      },
    },
  });

  const results = await Promise.all(
    instructors.map(async (inst) => {
      const teachingCompanies = Array.from(
        new Set(
          inst.teachingHistories
            .map((h) => normText(h.companyName))
            .filter(Boolean)
        )
      );
      const teachingCourses = Array.from(
        new Set(
          inst.teachingHistories
            .map((h) => normText(h.courseName))
            .filter(Boolean)
        )
      );

      // satisfactionImportItem 매칭 (3 단계)
      const [satByName, satByCompany, satByCourse] = await Promise.all([
        prisma.satisfactionImportItem.findMany({
          where: { candidateName: inst.name },
          select: {
            id: true,
            sourceType: true,
            candidateName: true,
            candidateCompanyName: true,
            candidateCourseName: true,
            scoreNormalized: true,
            responseDate: true,
          },
          take: 30,
        }),
        teachingCompanies.length > 0
          ? prisma.satisfactionImportItem.findMany({
              where: { candidateCompanyName: { in: teachingCompanies } },
              select: {
                id: true,
                sourceType: true,
                candidateName: true,
                candidateCompanyName: true,
                candidateCourseName: true,
                scoreNormalized: true,
              },
              take: 30,
            })
          : Promise.resolve([]),
        teachingCourses.length > 0
          ? prisma.satisfactionImportItem.findMany({
              where: { candidateCourseName: { in: teachingCourses } },
              select: {
                id: true,
                sourceType: true,
                candidateName: true,
                candidateCompanyName: true,
                candidateCourseName: true,
              },
              take: 30,
            })
          : Promise.resolve([]),
      ]);

      // activityImportItem (slack/gmail) 매칭
      const activityById = await prisma.activityImportItem.findMany({
        where: { matchedInstructorId: inst.id },
        select: {
          id: true,
          sourceType: true,
          isOpsReport: true,
          activityAt: true,
          candidateName: true,
        },
        take: 30,
      });
      const activityByName = await prisma.activityImportItem.findMany({
        where: { candidateName: inst.name, matchedInstructorId: null },
        select: {
          id: true,
          sourceType: true,
          isOpsReport: true,
          activityAt: true,
          candidateName: true,
        },
        take: 30,
      });

      // memoRaw 안의 Notion comment 카운트
      const notionCommentCount = (inst.memoRaw ?? "").match(
        /\[Notion comment ·/g
      )?.length ?? 0;

      // ops-notes-hardcoded.json 매칭 — 코드에서 정적 load. 여기서는 카운트만 추정.
      // (정확한 매칭은 generateOperationalIntelligence가 처리)

      return {
        id: inst.id,
        name: inst.name,
        affiliation: inst.affiliation,
        score: inst.score !== null ? Number(inst.score) : null,
        satisfaction_count: inst.satisfactionCount,
        satisfaction_avg:
          inst.satisfactionAvg !== null ? Number(inst.satisfactionAvg) : null,
        is_practice_coach: inst.isPracticeCoach,
        flag: inst.flag,
        teaching_history: {
          row_count: inst.teachingHistories.length,
          distinct_companies: teachingCompanies.length,
          distinct_courses: teachingCourses.length,
          companies_sample: teachingCompanies.slice(0, 6),
          courses_sample: teachingCourses.slice(0, 6),
        },
        notion_link: inst.sourceLinks.find((s) => s.sourceType === "notion")
          ? {
              external_key:
                inst.sourceLinks.find((s) => s.sourceType === "notion")
                  ?.externalKey ?? null,
              match_status:
                inst.sourceLinks.find((s) => s.sourceType === "notion")
                  ?.matchStatus ?? null,
            }
          : null,
        memo_raw_length: inst.memoRaw?.length ?? 0,
        notion_comment_count_in_memo: notionCommentCount,
        satisfaction_import_matching: {
          by_candidate_name_count: satByName.length,
          by_company_count: satByCompany.length,
          by_course_count: satByCourse.length,
          by_name_sample: satByName.slice(0, 3).map((r) => ({
            source_type: r.sourceType,
            candidate_name: r.candidateName,
            company: r.candidateCompanyName,
            course: r.candidateCourseName,
            score: r.scoreNormalized !== null ? Number(r.scoreNormalized) : null,
            response_date: r.responseDate?.toISOString().slice(0, 10) ?? null,
          })),
          by_company_sample_first3: satByCompany.slice(0, 3).map((r) => ({
            source_type: r.sourceType,
            candidate_name: r.candidateName,
            company: r.candidateCompanyName,
            course: r.candidateCourseName,
          })),
          by_course_sample_first3: satByCourse.slice(0, 3).map((r) => ({
            source_type: r.sourceType,
            candidate_name: r.candidateName,
            company: r.candidateCompanyName,
            course: r.candidateCourseName,
          })),
        },
        activity_matching: {
          by_matched_id_count: activityById.length,
          by_candidate_name_count: activityByName.length,
          by_matched_id_sample: activityById.slice(0, 3).map((r) => ({
            source_type: r.sourceType,
            is_ops_report: r.isOpsReport,
            activity_at: r.activityAt?.toISOString().slice(0, 10) ?? null,
            candidate_name: r.candidateName,
          })),
          by_candidate_name_sample: activityByName.slice(0, 3).map((r) => ({
            source_type: r.sourceType,
            is_ops_report: r.isOpsReport,
            activity_at: r.activityAt?.toISOString().slice(0, 10) ?? null,
            candidate_name: r.candidateName,
          })),
        },
        current_oi: inst.instructorIntelligence
          ? {
              generated_at: inst.instructorIntelligence.generatedAt?.toISOString() ?? null,
              generated_by: inst.instructorIntelligence.generatedBy,
              prompt_version: inst.instructorIntelligence.promptVersion,
              evidence_hash: inst.instructorIntelligence.evidenceHash?.slice(0, 12) ?? null,
              data_richness: inst.instructorIntelligence.dataRichness,
            }
          : null,
      };
    })
  );

  return NextResponse.json({
    ok: true,
    generated_at: new Date().toISOString(),
    instructors: results,
  });
}
