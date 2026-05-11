/**
 * snapshot-pre-p0-policy-shift.ts — Phase 2-1 dry-run (read-only)
 *
 * 목적:
 *   - 모든 정규 강사의 현재 satisfactionAvg/count snapshot
 *   - L0 fan-out (catalog_expected_instructors_super_priority) record 식별
 *   - L3/L4 (회사+과정 substring / instructorHint) record 식별
 *   - 정정 시 강사별 변동 예측 (이 record들이 삭제되면 어떻게 될지)
 *
 * 산출:
 *   reports/pre-p0-snapshot.json   ← 롤백/회귀 안전망
 *   reports/pre-p0-impact.md       ← 사용자 보고용
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";

interface RecordImpact {
  recordId: string;
  instructorId: string;
  instructorName: string;
  score: number;
  responseDate: string | null;
  respondentCount: number | null;
  sourceType: string;
  companyName: string | null;
  courseName: string | null;
  resolutionLevel: string | null;
  resolutionBasis: string | null;
  registryKey: string | null;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function getString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}
function extractResolutionFromSourceRef(
  sourceRef: unknown
): { level: string | null; basis: string | null } {
  const record = asRecord(sourceRef);
  const sourceRefs = record.source_refs;
  if (Array.isArray(sourceRefs) && sourceRefs.length > 0) {
    const first = asRecord(sourceRefs[0]);
    const nested = asRecord(first.source_ref);
    return {
      level: getString(nested.resolution_level),
      basis: getString(nested.resolution_basis),
    };
  }
  return { level: null, basis: null };
}

async function main() {
  const today = new Date();
  const cutoffDate = new Date(today);
  cutoffDate.setUTCMonth(cutoffDate.getUTCMonth() - 6);
  const cutoffStr = cutoffDate.toISOString().slice(0, 10);

  // 모든 정규 강사
  const instructors = await prisma.instructor.findMany({
    where: { isPracticeCoach: false },
    select: {
      id: true,
      name: true,
      isFulltime: true,
      satisfactionAvg: true,
      satisfactionCount: true,
    },
    orderBy: { name: "asc" },
  });
  const instructorById = new Map(instructors.map((i) => [i.id, i]));

  // 모든 SatisfactionRecord (cutoff 안)
  const records = await prisma.satisfactionRecord.findMany({
    where: {
      OR: [
        { responseDate: { gte: new Date(`${cutoffStr}T00:00:00.000Z`) } },
        { responseDate: null },
      ],
    },
    select: {
      id: true,
      instructorDbId: true,
      score: true,
      companyName: true,
      courseName: true,
      responseDate: true,
      respondentCount: true,
      sourceType: true,
      sourceRef: true,
    },
  });

  // L0 / L3 / L4 분류
  const l0Records: RecordImpact[] = [];
  const l3Records: RecordImpact[] = [];
  const l4Records: RecordImpact[] = [];
  const otherRecords: RecordImpact[] = [];

  for (const r of records) {
    const { level, basis } = extractResolutionFromSourceRef(r.sourceRef);
    const inst = instructorById.get(r.instructorDbId);
    if (!inst) continue; // 실습코치는 제외됨
    const ref = asRecord(r.sourceRef);
    const impact: RecordImpact = {
      recordId: r.id,
      instructorId: r.instructorDbId,
      instructorName: inst.name,
      score: Number(r.score),
      responseDate: r.responseDate?.toISOString().slice(0, 10) ?? null,
      respondentCount: r.respondentCount,
      sourceType: r.sourceType,
      companyName: r.companyName,
      courseName: r.courseName,
      resolutionLevel: level,
      resolutionBasis: basis,
      registryKey: getString(ref.registry_key),
    };

    if (level === "L0" || basis === "catalog_expected_instructors_super_priority") {
      l0Records.push(impact);
    } else if (level === "L3" || basis === "company_course_substring") {
      l3Records.push(impact);
    } else if (
      level === "L4" ||
      basis === "catalog_instructor_hint" ||
      basis === "catalog_expected_instructors"
    ) {
      l4Records.push(impact);
    } else {
      otherRecords.push(impact);
    }
  }

  // 강사별 영향 — L0/L3/L4 record 제거 시 satisfactionAvg/count 어떻게 변할지
  const allRemovable = [...l0Records, ...l3Records, ...l4Records];
  const removableByInstructor = new Map<string, RecordImpact[]>();
  for (const r of allRemovable) {
    const list = removableByInstructor.get(r.instructorId) ?? [];
    list.push(r);
    removableByInstructor.set(r.instructorId, list);
  }

  interface InstructorImpact {
    instructorId: string;
    instructorName: string;
    role: string;
    currentAvg: number | null;
    currentCount: number;
    removableCount: number;
    afterCount: number;
    afterAvg: number | null;
    delta: { count: number; avg: number | null };
    removableSourceTypes: string[];
  }

  const instructorImpacts: InstructorImpact[] = [];
  for (const inst of instructors) {
    const removable = removableByInstructor.get(inst.id) ?? [];
    const myRecords = records.filter((r) => r.instructorDbId === inst.id);
    const remainingRecords = myRecords.filter(
      (r) => !removable.some((rm) => rm.recordId === r.id)
    );
    const afterCount = remainingRecords.length;
    const afterAvg =
      afterCount > 0
        ? remainingRecords.reduce((sum, r) => sum + Number(r.score), 0) / afterCount
        : null;
    const currentAvg = inst.satisfactionAvg ? Number(inst.satisfactionAvg) : null;
    if (removable.length === 0) continue;
    instructorImpacts.push({
      instructorId: inst.id,
      instructorName: inst.name,
      role: inst.isFulltime ? "전임" : "정규",
      currentAvg,
      currentCount: inst.satisfactionCount,
      removableCount: removable.length,
      afterCount,
      afterAvg: afterAvg !== null ? Math.round(afterAvg * 100) / 100 : null,
      delta: {
        count: afterCount - inst.satisfactionCount,
        avg:
          afterAvg !== null && currentAvg !== null
            ? Math.round((afterAvg - currentAvg) * 100) / 100
            : null,
      },
      removableSourceTypes: Array.from(new Set(removable.map((r) => r.sourceType))),
    });
  }
  instructorImpacts.sort((a, b) => b.removableCount - a.removableCount);

  const md: string[] = [];
  md.push("# P0 정책 적용 영향 dry-run (Phase 2-1)");
  md.push(`Generated at: ${new Date().toISOString()}`);
  md.push(`6개월 cutoff: ${cutoffStr} 이후 record 분석`);
  md.push("");
  md.push("## record 분류");
  md.push(`- 전체 record (cutoff 안): **${records.length}건**`);
  md.push(`- L0 fan-out (catalog_expected_instructors_super_priority): **${l0Records.length}건**`);
  md.push(`- L3 (회사+과정 substring): **${l3Records.length}건**`);
  md.push(`- L4 (instructorHint/expectedInstructors): **${l4Records.length}건**`);
  md.push(`- 그 외 (단일 강사 정확 매칭, gmail 등): ${otherRecords.length}건`);
  md.push("");
  md.push(`정책 변경 시 제거 대상: **${allRemovable.length}건** (L0+L3+L4)`);
  md.push("");
  md.push("## 영향 강사 — Top 20");
  md.push("| 강사 | role | current avg/count | after avg/count | Δ count | Δ avg | source types |");
  md.push("|---|---|---|---|---|---|---|");
  for (const i of instructorImpacts.slice(0, 20)) {
    md.push(
      `| ${i.instructorName} | ${i.role} | ${i.currentAvg ?? "—"} / ${i.currentCount} | ${i.afterAvg ?? "—"} / ${i.afterCount} | ${i.delta.count} | ${i.delta.avg ?? "—"} | ${i.removableSourceTypes.join(",")} |`
    );
  }
  md.push("");

  // L0 record 상세 (최대 10건)
  md.push("## L0 fan-out record 상세 (최대 10건)");
  md.push("| 강사 | 회사 | 과정 | 일자 | 점수 | 응답수 | sourceType |");
  md.push("|---|---|---|---|---|---|---|");
  for (const r of l0Records.slice(0, 10)) {
    md.push(
      `| ${r.instructorName} | ${r.companyName ?? "—"} | ${(r.courseName ?? "—").slice(0, 25)} | ${r.responseDate ?? "—"} | ${r.score} | ${r.respondentCount ?? "—"} | ${r.sourceType} |`
    );
  }
  md.push("");

  md.push("## L3/L4 record 상세 (있을 시)");
  md.push(`L3 ${l3Records.length}건, L4 ${l4Records.length}건`);
  md.push("");

  md.push("## 사용자 명시 영향 (요청 케이스)");
  md.push("| 강사 | 현재 | 정정 후 | 의미 |");
  md.push("|---|---|---|---|");
  const focus = ["박상훈", "유종훈", "김정수A", "정민수A", "최진영B", "공지연", "김인섭", "송유이"];
  for (const name of focus) {
    const i = instructorImpacts.find((x) => x.instructorName === name);
    if (!i) {
      const inst = instructors.find((x) => x.name === name);
      if (inst) {
        md.push(
          `| ${name} | ${inst.satisfactionAvg ?? "—"} / ${inst.satisfactionCount} | (변동 없음) | L0/L3/L4 record 없음 — 정정 영향 없음 |`
        );
      }
      continue;
    }
    const meaning =
      i.afterCount === 0
        ? "강사별 평균 사라짐 — course-level satisfaction으로만 표시 가능"
        : `${i.removableCount}건 제거 → 단일 강사 매칭만 남음`;
    md.push(
      `| ${name} | ${i.currentAvg ?? "—"} / ${i.currentCount} | ${i.afterAvg ?? "—"} / ${i.afterCount} | ${meaning} |`
    );
  }

  const reportDir = path.resolve(process.cwd(), "reports");
  await mkdir(reportDir, { recursive: true });
  await writeFile(
    path.join(reportDir, "pre-p0-snapshot.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        cutoffDate: cutoffStr,
        instructors: instructors.map((i) => ({
          id: i.id,
          name: i.name,
          isFulltime: i.isFulltime,
          satisfactionAvg: i.satisfactionAvg,
          satisfactionCount: i.satisfactionCount,
        })),
        l0Records,
        l3Records,
        l4Records,
        instructorImpacts,
      },
      null,
      2
    ),
    "utf-8"
  );
  await writeFile(path.join(reportDir, "pre-p0-impact.md"), md.join("\n"), "utf-8");

  console.log(`\n=== 요약 ===`);
  console.log(`전체 record (cutoff 안): ${records.length}`);
  console.log(`L0 fan-out: ${l0Records.length}건 / L3: ${l3Records.length}건 / L4: ${l4Records.length}건`);
  console.log(`제거 대상 합: ${allRemovable.length}건`);
  console.log(`영향 강사: ${instructorImpacts.length}명`);
  console.log(`Saved: reports/pre-p0-snapshot.json`);
  console.log(`Saved: reports/pre-p0-impact.md`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
