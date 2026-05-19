/**
 * GET /api/admin/audit-instructors-satisfaction?top=40&lookbackMonths=6
 *
 * 강사별 satisfaction 신뢰도 audit (top=N 명까지).
 * Top은 instructor.satisfactionAvg 내림차순 (이미 산출된 값 기준).
 *
 * 강사별로:
 *  - recordCount, avgScore, scoreDistribution (1.x~5.x 버킷)
 *  - lowestScoreRecord: 최저 점수 record source + score
 *  - thCountRecent: 최근 lookbackMonths 안에 TH 개수
 *  - thCompaniesRecent: TH 회사명 SET
 *  - recordCompanies: record 회사명 SET
 *  - thGap: TH에 있는데 record에 없는 회사 수
 *  - suspicions: 의심 신호 배열
 *      low_score_outlier   avg<3.5 && recordCount<5
 *      single_low_record   recordCount==1 && score<=2.5
 *      score_lift_after_cleanup  최저 record 1건 제외 시 avg가 +1.0 이상 jump
 *      th_record_gap       thCountRecent-recordCount >= 3
 *
 * 인증: CRON_SECRET
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function bucket(score: number): string {
  if (score < 2) return "1.x";
  if (score < 3) return "2.x";
  if (score < 4) return "3.x";
  if (score < 5) return "4.x";
  return "5.x";
}

export async function GET(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const top = parseInt(request.nextUrl.searchParams.get("top") ?? "40", 10);
  const lookbackMonths = parseInt(
    request.nextUrl.searchParams.get("lookbackMonths") ?? "6",
    10
  );
  const cutoffDate = new Date();
  cutoffDate.setMonth(cutoffDate.getMonth() - lookbackMonths);

  // 1) top N instructors by satisfactionAvg
  const instructors = await prisma.instructor.findMany({
    where: { satisfactionAvg: { not: null } },
    orderBy: [{ satisfactionAvg: "desc" }, { name: "asc" }],
    take: top,
    select: {
      id: true,
      name: true,
      satisfactionAvg: true,
      satisfactionCount: true,
    },
  });
  const ids = instructors.map((i) => i.id);
  if (ids.length === 0) {
    return NextResponse.json({ ok: true, instructors: [] });
  }

  // 2) records for these instructors
  const records = await prisma.satisfactionRecord.findMany({
    where: { instructorDbId: { in: ids } },
    select: {
      id: true,
      instructorDbId: true,
      companyName: true,
      courseName: true,
      score: true,
      respondentCount: true,
      sourceType: true,
      responseDate: true,
      sourceRef: true,
      createdAt: true,
    },
  });
  const recordsBy = new Map<string, typeof records>();
  for (const r of records) {
    const arr = recordsBy.get(r.instructorDbId) ?? [];
    arr.push(r);
    recordsBy.set(r.instructorDbId, arr);
  }

  // 3) TH for these instructors (recent)
  const ths = await prisma.teachingHistory.findMany({
    where: {
      instructorDbId: { in: ids },
      OR: [
        { endDate: { gte: cutoffDate } },
        { startDate: { gte: cutoffDate } },
      ],
    },
    select: {
      instructorDbId: true,
      companyName: true,
      courseName: true,
      startDate: true,
      endDate: true,
    },
  });
  const thBy = new Map<string, typeof ths>();
  for (const t of ths) {
    const arr = thBy.get(t.instructorDbId) ?? [];
    arr.push(t);
    thBy.set(t.instructorDbId, arr);
  }

  const result = instructors.map((inst, rank) => {
    const recs = recordsBy.get(inst.id) ?? [];
    const recScores = recs.map((r) => Number(r.score));
    const weightedSum = recs.reduce(
      (s, r) => s + Number(r.score) * (r.respondentCount || 1),
      0
    );
    const totalWeight = recs.reduce(
      (s, r) => s + (r.respondentCount || 1),
      0
    );
    const avgScore = totalWeight > 0 ? weightedSum / totalWeight : null;

    // distribution
    const dist: Record<string, number> = { "1.x": 0, "2.x": 0, "3.x": 0, "4.x": 0, "5.x": 0 };
    for (const s of recScores) dist[bucket(s)] += 1;

    // lowest
    let lowestRecord: (typeof records)[number] | null = null;
    for (const r of recs) {
      if (!lowestRecord || Number(r.score) < Number(lowestRecord.score)) {
        lowestRecord = r;
      }
    }

    // score lift after cleanup (drop lowest 1)
    let scoreLift: number | null = null;
    if (lowestRecord && recs.length > 1 && avgScore !== null) {
      const lowestWeight = lowestRecord.respondentCount || 1;
      const afterSum = weightedSum - Number(lowestRecord.score) * lowestWeight;
      const afterWeight = totalWeight - lowestWeight;
      if (afterWeight > 0) {
        scoreLift = afterSum / afterWeight - avgScore;
      }
    }

    const recCompanies = new Set(
      recs.map((r) => (r.companyName ?? "").trim()).filter(Boolean)
    );
    const thRows = thBy.get(inst.id) ?? [];
    const thCompanies = new Set(
      thRows.map((t) => (t.companyName ?? "").trim()).filter(Boolean)
    );
    const thGapCompanies: string[] = [];
    for (const c of thCompanies) {
      let covered = false;
      for (const rc of recCompanies) {
        if (rc === c || rc.includes(c) || c.includes(rc)) {
          covered = true;
          break;
        }
      }
      if (!covered) thGapCompanies.push(c);
    }

    const suspicions: string[] = [];
    if (avgScore !== null && avgScore < 3.5 && recs.length < 5) {
      suspicions.push("low_score_outlier");
    }
    if (recs.length === 1 && Number(recs[0].score) <= 2.5) {
      suspicions.push("single_low_record");
    }
    if (scoreLift !== null && scoreLift >= 1.0) {
      suspicions.push("score_lift_after_cleanup");
    }
    if (thRows.length - recs.length >= 3) {
      suspicions.push("th_record_gap");
    }

    return {
      rank: rank + 1,
      id: inst.id,
      name: inst.name,
      db_satisfaction_avg: inst.satisfactionAvg ? Number(inst.satisfactionAvg) : null,
      db_satisfaction_count: inst.satisfactionCount,
      record_count: recs.length,
      calc_avg_score: avgScore !== null ? Math.round(avgScore * 100) / 100 : null,
      score_distribution: dist,
      lowest_record: lowestRecord
        ? {
            id: lowestRecord.id,
            score: Number(lowestRecord.score),
            n: lowestRecord.respondentCount,
            company: lowestRecord.companyName,
            course: lowestRecord.courseName?.slice(0, 80) ?? null,
            response_date:
              lowestRecord.responseDate?.toISOString().slice(0, 10) ?? null,
            source_type: lowestRecord.sourceType,
            source_ref: lowestRecord.sourceRef,
          }
        : null,
      score_lift_after_cleanup:
        scoreLift !== null ? Math.round(scoreLift * 100) / 100 : null,
      th_count_recent: thRows.length,
      th_companies_recent: Array.from(thCompanies),
      record_companies: Array.from(recCompanies),
      th_gap_companies: thGapCompanies,
      suspicions,
    };
  });

  const summary = {
    total_audited: result.length,
    suspicions: {
      low_score_outlier: result.filter((r) => r.suspicions.includes("low_score_outlier")).length,
      single_low_record: result.filter((r) => r.suspicions.includes("single_low_record")).length,
      score_lift_after_cleanup: result.filter((r) => r.suspicions.includes("score_lift_after_cleanup")).length,
      th_record_gap: result.filter((r) => r.suspicions.includes("th_record_gap")).length,
    },
  };

  return NextResponse.json({ ok: true, summary, instructors: result });
}
