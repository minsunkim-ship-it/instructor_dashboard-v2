/**
 * debug-park-sanghoon-aggregate.ts — recompute logic 단독 재현
 */
import { prisma } from "@/lib/prisma";
import { countGroupedTeachingHistories } from "@/lib/teaching-history-display";
import { COURSE_COUNT_SOURCE_TYPES } from "@/lib/pipeline/teaching-history-sources";

const inst = await prisma.instructor.findUnique({ where: { name: "박상훈" }, select: { id: true } });
if (!inst) process.exit(1);

const today = new Date().toISOString().split("T")[0];

const histories = await prisma.teachingHistory.findMany({
  where: { instructorDbId: inst.id },
  select: {
    instructorDbId: true,
    sourceType: true,
    companyName: true,
    courseName: true,
    courseId: true,
    detailType: true,
    feeExtra: true,
    specialNotes: true,
    startDate: true,
    endDate: true,
    dateLabel: true,
    totalSessions: true,
    totalHours: true,
  },
});

console.log(`raw histories: ${histories.length}`);

const allItems = histories.map((row) => ({
  company_name: row.companyName,
  course_name: row.courseName,
  course_id: row.courseId,
  detail_type: row.detailType,
  fee_extra: row.feeExtra,
  special_notes: row.specialNotes,
  start_date: row.startDate?.toISOString().split("T")[0] ?? null,
  end_date: row.endDate?.toISOString().split("T")[0] ?? null,
  date_label: row.dateLabel,
  total_sessions: row.totalSessions,
  total_hours: row.totalHours !== null ? Number(row.totalHours) : null,
}));

const courseCountableItems = histories
  .filter((row) => COURSE_COUNT_SOURCE_TYPES.includes(row.sourceType as typeof COURSE_COUNT_SOURCE_TYPES[number]))
  .map((row) => ({
    company_name: row.companyName,
    course_name: row.courseName,
    course_id: row.courseId,
    detail_type: row.detailType,
    fee_extra: row.feeExtra,
    special_notes: row.specialNotes,
    start_date: row.startDate?.toISOString().split("T")[0] ?? null,
    end_date: row.endDate?.toISOString().split("T")[0] ?? null,
    date_label: row.dateLabel,
    total_sessions: row.totalSessions,
    total_hours: row.totalHours !== null ? Number(row.totalHours) : null,
  }));

console.log(`COURSE_COUNT_SOURCE_TYPES: ${JSON.stringify(COURSE_COUNT_SOURCE_TYPES)}`);
console.log(`raw sourceTypes: ${[...new Set(histories.map(h => h.sourceType))].join(", ")}`);
console.log(`allItems: ${allItems.length}`);
console.log(`courseCountableItems: ${courseCountableItems.length}`);

const totalCourses = countGroupedTeachingHistories(allItems, { fromDate: "2025-01-01", untilDate: today });
const contractSheetRows = countGroupedTeachingHistories(courseCountableItems, { fromDate: "2025-01-01", untilDate: today });
console.log(`totalCourses (computed): ${totalCourses}`);
console.log(`contractSheetRows (computed): ${contractSheetRows}`);

const noCutoff = countGroupedTeachingHistories(allItems);
console.log(`totalCourses (no untilDate): ${noCutoff}`);

await prisma.$disconnect();
