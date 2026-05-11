/**
 * trigger-aggregates-recompute.ts — 모든 강사의 totalCourses/contractSheetRows/recentCourses6mo 캐시 재계산
 *
 * Phase G 패치 + Phase E NULL 보강 적용 후 dedupe count가 변동된 강사들의 캐시 갱신.
 */
import { prisma } from "@/lib/prisma";
import { recomputeAggregatesForInstructors } from "@/lib/pipeline/contract-sheet-store";

const allInstructors = await prisma.instructor.findMany({ select: { id: true } });
console.log(`강사 ${allInstructors.length}명 aggregate 재계산 시작...`);
const updated = await recomputeAggregatesForInstructors(allInstructors.map((i) => i.id));
console.log(`업데이트된 강사: ${updated}명`);
await prisma.$disconnect();
