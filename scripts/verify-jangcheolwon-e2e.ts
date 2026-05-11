/**
 * verify-jangcheolwon-e2e.ts — Phase D 장철원 E2E 검증 (read-only)
 *
 * 신 시스템 Railway DB에서 장철원 강사의 상태를 점검:
 *  1. Instructor row 존재 + notion_id 정식 페이지
 *  2. SourceLink (notion) 등록 확인
 *  3. TeachingHistory 건수
 *  4. SatisfactionRecord / SatisfactionReviewRegistry 등록 상태
 *  5. 영향 모집단 핵심 5명 동시 점검 (박인영/장철원/권병희/소준섭/윤용승)
 *
 * 안전성: read-only.
 */
import { prisma } from "@/lib/prisma";

const TARGET_INSTRUCTORS = ["박인영", "장철원", "권병희", "소준섭", "윤용승"];

interface InstructorReport {
  name: string;
  found: boolean;
  id?: string;
  notionPageId?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  baseFeeHourly?: number | null;
  isFulltime?: boolean;
  flag?: string | null;
  teachingHistoryCount?: number;
  satisfactionRecordCount?: number;
  satisfactionReviewRegistryPending?: number;
  satisfactionReviewRegistryResolved?: number;
}

async function reportInstructor(name: string): Promise<InstructorReport> {
  const inst = await prisma.instructor.findUnique({
    where: { name },
    include: {
      sourceLinks: {
        where: { sourceType: "notion" },
        select: { externalKey: true },
      },
      _count: {
        select: {
          teachingHistories: true,
          satisfactionRecords: true,
        },
      },
    },
  });
  if (!inst) {
    return { name, found: false };
  }
  const reviewPending = await prisma.satisfactionReviewRegistry.count({
    where: { resolvedInstructorId: inst.id, matchStatus: "pending" },
  });
  const reviewResolved = await prisma.satisfactionReviewRegistry.count({
    where: { resolvedInstructorId: inst.id, matchStatus: { not: "pending" } },
  });
  return {
    name,
    found: true,
    id: inst.id,
    notionPageId: inst.sourceLinks[0]?.externalKey ?? null,
    contactEmail: inst.contactEmail,
    contactPhone: inst.contactPhone,
    baseFeeHourly: inst.baseFeeHourly,
    isFulltime: inst.isFulltime,
    flag: inst.flag,
    teachingHistoryCount: inst._count.teachingHistories,
    satisfactionRecordCount: inst._count.satisfactionRecords,
    satisfactionReviewRegistryPending: reviewPending,
    satisfactionReviewRegistryResolved: reviewResolved,
  };
}

async function main() {
  console.log("Phase D — 장철원 + 영향 모집단 핵심 5명 E2E 검증");
  console.log("");

  for (const name of TARGET_INSTRUCTORS) {
    const r = await reportInstructor(name);
    console.log(`[${name}]`);
    if (!r.found) {
      console.log(`  ❌ Instructor 테이블에 없음`);
      console.log("");
      continue;
    }
    console.log(`  id              : ${r.id}`);
    console.log(`  notion_id       : ${r.notionPageId ?? "(없음)"}`);
    console.log(`  email           : ${r.contactEmail ?? "(없음)"}`);
    console.log(`  phone           : ${r.contactPhone ?? "(없음)"}`);
    console.log(`  base_fee_hourly : ${r.baseFeeHourly ?? "(없음)"}`);
    console.log(`  isFulltime      : ${r.isFulltime}`);
    console.log(`  flag            : ${r.flag ?? "(없음)"}`);
    console.log(`  teaching_history: ${r.teachingHistoryCount}건`);
    console.log(`  satisfaction_record: ${r.satisfactionRecordCount}건`);
    console.log(
      `  review_registry : pending ${r.satisfactionReviewRegistryPending}, resolved ${r.satisfactionReviewRegistryResolved}`
    );
    console.log("");
  }
}

main()
  .catch((err) => {
    console.error("Verification error:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
