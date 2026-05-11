/**
 * diagnose-all-instructor-satisfaction-distribution.ts — 전체 정규 강사 만족도 데이터 분포 (read-only)
 *
 * 목적: 800명 정규 강사 전체에 대해
 *   1. 강의 수 vs 만족도 record 수 분포
 *   2. count=0 / 1 / 2+ 분포
 *   3. source 다양성 (gmail only vs sheet vs mix)
 *   4. resolution_basis 분포 (자동 매칭 신뢰도)
 *   5. cutoff 안/밖 record 분포
 *   6. P0 정책 적용 시 신뢰 가능한 강사 수 변동 예측
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function getString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}
function extractRes(sourceRef: unknown): { level: string | null; basis: string | null } {
  const refs = asRecord(sourceRef).source_refs;
  if (Array.isArray(refs) && refs.length > 0) {
    const nested = asRecord(asRecord(refs[0]).source_ref);
    return { level: getString(nested.resolution_level), basis: getString(nested.resolution_basis) };
  }
  return { level: null, basis: null };
}

async function main() {
  const today = new Date();
  const cutoff = new Date(today);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - 6);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  // 정규 강사만 (실습코치 제외, 전임 포함)
  const instructors = await prisma.instructor.findMany({
    where: { isPracticeCoach: false },
    select: { id: true, name: true, isFulltime: true, satisfactionAvg: true, satisfactionCount: true, totalCourses: true },
  });

  // 각 강사 record list
  const records = await prisma.satisfactionRecord.findMany({
    select: { instructorDbId: true, score: true, sourceType: true, responseDate: true, sourceRef: true },
  });
  const byInstructor = new Map<string, typeof records>();
  for (const r of records) {
    const list = byInstructor.get(r.instructorDbId) ?? [];
    list.push(r);
    byInstructor.set(r.instructorDbId, list);
  }

  interface Stat {
    name: string;
    role: string;
    totalCourses: number;
    cacheCount: number;
    recordCount: number;
    cutoffInCount: number;
    cutoffOutCount: number;
    sources: Record<string, number>;
    levels: Record<string, number>;
    bases: Record<string, number>;
    p0RemovedCount: number;
    p0AfterCount: number;
  }

  const stats: Stat[] = [];
  for (const inst of instructors) {
    const myRecords = byInstructor.get(inst.id) ?? [];
    const sources: Record<string, number> = {};
    const levels: Record<string, number> = {};
    const bases: Record<string, number> = {};
    let cutoffIn = 0;
    let cutoffOut = 0;
    let p0Removed = 0;
    for (const r of myRecords) {
      sources[r.sourceType] = (sources[r.sourceType] ?? 0) + 1;
      const inWindow = r.responseDate ? r.responseDate >= cutoff : true;
      if (inWindow) cutoffIn++;
      else cutoffOut++;
      const { level, basis } = extractRes(r.sourceRef);
      if (level) levels[level] = (levels[level] ?? 0) + 1;
      if (basis) bases[basis] = (bases[basis] ?? 0) + 1;
      // P0 정책: L0/L3/L4 자동 매칭은 pending_review로 → record에서 제거
      const isRemovable =
        level === "L0" ||
        level === "L3" ||
        level === "L4" ||
        basis === "catalog_expected_instructors_super_priority" ||
        basis === "company_course_substring" ||
        basis === "catalog_instructor_hint" ||
        basis === "catalog_expected_instructors";
      if (isRemovable && inWindow) p0Removed++;
    }
    stats.push({
      name: inst.name,
      role: inst.isFulltime ? "전임" : "정규",
      totalCourses: inst.totalCourses,
      cacheCount: inst.satisfactionCount,
      recordCount: myRecords.length,
      cutoffInCount: cutoffIn,
      cutoffOutCount: cutoffOut,
      sources,
      levels,
      bases,
      p0RemovedCount: p0Removed,
      p0AfterCount: cutoffIn - p0Removed,
    });
  }

  // 분포 집계
  const total = stats.length;
  const buckets = {
    L0_no_courses: stats.filter((s) => s.totalCourses === 0).length,
    L_courses_no_records: stats.filter((s) => s.totalCourses > 0 && s.recordCount === 0).length,
    L_courses_records_in_cutoff_0: stats.filter(
      (s) => s.totalCourses > 0 && s.recordCount > 0 && s.cutoffInCount === 0
    ).length,
    L_count_1_in_cutoff: stats.filter((s) => s.cutoffInCount === 1).length,
    L_count_2_to_4_in_cutoff: stats.filter((s) => s.cutoffInCount >= 2 && s.cutoffInCount <= 4).length,
    L_count_5_plus_in_cutoff: stats.filter((s) => s.cutoffInCount >= 5).length,
  };

  // P0 적용 후 신뢰 가능한 강사 수 (cutoff 안 ≥ 1건 + L0/L3/L4 자동 매칭 아님)
  const reliableBefore = stats.filter((s) => s.cutoffInCount >= 1).length;
  const reliableAfter = stats.filter((s) => s.p0AfterCount >= 1).length;

  // 강의는 있는데 record 0건인 강사 — top 10 (강의 많은 순)
  const noRecords = stats
    .filter((s) => s.totalCourses > 0 && s.recordCount === 0)
    .sort((a, b) => b.totalCourses - a.totalCourses);

  // P0로 record 사라지는 강사 (after=0)
  const becomesEmpty = stats.filter((s) => s.cutoffInCount > 0 && s.p0AfterCount === 0);

  // 1건만 있는 강사 (cutoff 안)
  const onlyOne = stats.filter((s) => s.cutoffInCount === 1).sort((a, b) => b.totalCourses - a.totalCourses);

  // source 다양성
  const sourceTypeCount: Record<string, number> = {};
  for (const s of stats) {
    for (const t of Object.keys(s.sources)) sourceTypeCount[t] = (sourceTypeCount[t] ?? 0) + 1;
  }

  // resolution basis 분포 (전체 record 기준)
  const allBases: Record<string, number> = {};
  const allLevels: Record<string, number> = {};
  for (const s of stats) {
    for (const [b, c] of Object.entries(s.bases)) allBases[b] = (allBases[b] ?? 0) + c;
    for (const [l, c] of Object.entries(s.levels)) allLevels[l] = (allLevels[l] ?? 0) + c;
  }

  const md: string[] = [];
  md.push("# 전체 정규 강사 만족도 데이터 분포 (read-only)");
  md.push(`Generated at: ${new Date().toISOString()}`);
  md.push(`6개월 cutoff: ${cutoffStr} 이후 record 기준`);
  md.push(`정규 강사 (실습코치 제외) 총 ${total}명`);
  md.push("");

  md.push("## 만족도 데이터 보유 분포");
  md.push("| 분류 | 강사 수 | 비율 |");
  md.push("|---|---:|---:|");
  md.push(`| L0: 강의 0건 | ${buckets.L0_no_courses} | ${((buckets.L0_no_courses / total) * 100).toFixed(1)}% |`);
  md.push(`| 강의 있으나 record 0건 | ${buckets.L_courses_no_records} | ${((buckets.L_courses_no_records / total) * 100).toFixed(1)}% |`);
  md.push(`| record 있으나 cutoff 안 0건 | ${buckets.L_courses_records_in_cutoff_0} | ${((buckets.L_courses_records_in_cutoff_0 / total) * 100).toFixed(1)}% |`);
  md.push(`| cutoff 안 1건 | ${buckets.L_count_1_in_cutoff} | ${((buckets.L_count_1_in_cutoff / total) * 100).toFixed(1)}% |`);
  md.push(`| cutoff 안 2~4건 | ${buckets.L_count_2_to_4_in_cutoff} | ${((buckets.L_count_2_to_4_in_cutoff / total) * 100).toFixed(1)}% |`);
  md.push(`| cutoff 안 5건+ | ${buckets.L_count_5_plus_in_cutoff} | ${((buckets.L_count_5_plus_in_cutoff / total) * 100).toFixed(1)}% |`);
  md.push("");

  md.push("## 신뢰 가능한 강사 (cutoff 안 ≥ 1건)");
  md.push(`- 현재: **${reliableBefore}명** / ${total}명 (${((reliableBefore / total) * 100).toFixed(1)}%)`);
  md.push(`- P0 적용 후: **${reliableAfter}명** / ${total}명 (${((reliableAfter / total) * 100).toFixed(1)}%)`);
  md.push(`- 차이: ${reliableAfter - reliableBefore}명 (P0로 가짜 매칭 제거되어 강사별 평균 사라지는 강사 = ${reliableBefore - reliableAfter}명)`);
  md.push("");

  md.push("## resolution basis 분포 (cutoff 안 + 밖 모두)");
  for (const [b, c] of Object.entries(allBases).sort((a, b) => b[1] - a[1])) {
    md.push(`- ${b}: ${c}건`);
  }
  md.push("");
  md.push("## resolution level 분포");
  for (const [l, c] of Object.entries(allLevels).sort((a, b) => b[1] - a[1])) {
    md.push(`- ${l}: ${c}건`);
  }
  md.push("");

  md.push("## sourceType 사용 강사 수");
  for (const [t, c] of Object.entries(sourceTypeCount).sort((a, b) => b[1] - a[1])) {
    md.push(`- ${t}: ${c}명`);
  }
  md.push("");

  md.push(`## 강의는 많은데 record 0건 — Top 20 (catalog/수집 부재 의심)`);
  md.push("| 강사 | role | 강의수 | record |");
  md.push("|---|---|---|---|");
  for (const s of noRecords.slice(0, 20)) {
    md.push(`| ${s.name} | ${s.role} | ${s.totalCourses} | 0 |`);
  }
  md.push("");

  md.push(`## P0 적용 시 강사별 평균 사라지는 강사 (cutoff 안 → 0)`);
  md.push("| 강사 | 현재 cutoff 안 | P0 후 | 의미 |");
  md.push("|---|---|---|---|");
  for (const s of becomesEmpty.slice(0, 30)) {
    md.push(`| ${s.name} | ${s.cutoffInCount} | 0 | L0/L3/L4 자동 매칭만 있음 → pending_review |`);
  }
  md.push("");

  md.push(`## cutoff 안 1건만 있는 강사 — Top 30 (신뢰도 낮은 평균)`);
  md.push("| 강사 | role | 강의수 | sourceType | 1건 점수 |");
  md.push("|---|---|---|---|---|");
  for (const s of onlyOne.slice(0, 30)) {
    const types = Object.keys(s.sources).join(",");
    md.push(`| ${s.name} | ${s.role} | ${s.totalCourses} | ${types} | (1건) |`);
  }

  const reportDir = path.resolve(process.cwd(), "reports");
  await mkdir(reportDir, { recursive: true });
  await writeFile(
    path.join(reportDir, "all-instructor-distribution.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), buckets, reliableBefore, reliableAfter, allBases, allLevels, sourceTypeCount, stats }, null, 2),
    "utf-8"
  );
  await writeFile(path.join(reportDir, "all-instructor-distribution.md"), md.join("\n"), "utf-8");

  console.log(`정규 강사 ${total}명`);
  console.log(`  강의 0건: ${buckets.L0_no_courses}`);
  console.log(`  강의 있으나 record 0: ${buckets.L_courses_no_records}`);
  console.log(`  record 있으나 cutoff 안 0: ${buckets.L_courses_records_in_cutoff_0}`);
  console.log(`  cutoff 안 1건: ${buckets.L_count_1_in_cutoff}`);
  console.log(`  cutoff 안 2-4건: ${buckets.L_count_2_to_4_in_cutoff}`);
  console.log(`  cutoff 안 5건+: ${buckets.L_count_5_plus_in_cutoff}`);
  console.log(`신뢰 가능 강사: 현재 ${reliableBefore}명 → P0 후 ${reliableAfter}명`);
  console.log(`Saved: reports/all-instructor-distribution.md`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
