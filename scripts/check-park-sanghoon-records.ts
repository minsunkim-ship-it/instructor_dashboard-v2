import { prisma } from "@/lib/prisma";

const inst = await prisma.instructor.findUnique({
  where: { name: "박상훈" },
  select: { id: true, name: true, totalCourses: true, satisfactionCount: true, satisfactionAvg: true },
});
console.log("박상훈:", inst);

if (inst) {
  const records = await prisma.satisfactionRecord.findMany({
    where: { instructorDbId: inst.id },
    select: {
      id: true,
      score: true,
      companyName: true,
      courseName: true,
      responseDate: true,
      respondentCount: true,
      sourceType: true,
      sourceRef: true,
    },
  });
  console.log(`Records: ${records.length}건`);
  for (const r of records) {
    console.log(
      `  - ${r.score} | ${r.companyName ?? "—"} | ${r.courseName ?? "—"} | ${r.responseDate?.toISOString().slice(0, 10) ?? "—"} | respondents=${r.respondentCount ?? "—"} | ${r.sourceType}`
    );
  }
}

await prisma.$disconnect();
