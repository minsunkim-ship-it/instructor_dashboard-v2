import { prisma } from "@/lib/prisma";
import {
  groupTeachingHistories,
  countGroupedTeachingHistories,
  type TeachingHistoryDisplayItem,
} from "@/lib/teaching-history-display";
import { isNonTeachingCompensationItem } from "@/lib/teaching-history-kind";

const inst = await prisma.instructor.findUnique({
  where: { name: "박상훈" },
  select: { id: true },
});
if (!inst) {
  console.error("박상훈 미존재");
  process.exit(1);
}

const ths = await prisma.teachingHistory.findMany({
  where: { instructorDbId: inst.id },
  orderBy: { startDate: "asc" },
});

console.log(`박상훈 raw teaching_histories: ${ths.length}건`);
for (const t of ths) {
  const isNonTeach = isNonTeachingCompensationItem({
    courseId: t.courseId,
    courseName: t.courseName,
    dealFeeHourly: t.dealFeeHourly,
    feeExtra: t.feeExtra,
    detailType: t.detailType,
    specialNotes: t.specialNotes,
  });
  console.log(
    `  - ${t.companyName ?? "—"} / ${(t.courseName ?? "—").slice(0, 40)} / ${t.startDate?.toISOString().slice(0, 10) ?? "—"} / fee=${t.dealFeeHourly} / detail=${t.detailType ?? "—"} / sourceType=${t.sourceType} / ${isNonTeach ? "NON_TEACHING" : "TEACHING"}`
  );
}

const items: TeachingHistoryDisplayItem[] = ths.map((t) => ({
  course_name: t.courseName,
  company_name: t.companyName,
  course_id: t.courseId,
  deal_fee_hourly: t.dealFeeHourly,
  contract_type: t.contractType,
  detail_type: t.detailType,
  fee_extra: t.feeExtra,
  special_notes: t.specialNotes,
  start_date: t.startDate?.toISOString() ?? null,
  end_date: t.endDate?.toISOString() ?? null,
  total_sessions: t.totalSessions,
  total_hours: t.totalHours ? Number(t.totalHours) : null,
}));

const grouped = groupTeachingHistories(items);
console.log(`\nGrouped teaching histories: ${grouped.length}건`);
for (const g of grouped) {
  console.log(`  - ${g.display_company ?? "—"} / ${g.display_title ?? "—"} / ${g.start_date} ~ ${g.end_date} / source_count=${g.source_count}`);
}

const count = countGroupedTeachingHistories(items);
console.log(`\ncountGroupedTeachingHistories: ${count}`);

await prisma.$disconnect();
