import { prisma } from "@/lib/prisma";

const runs = await prisma.pipelineRun.findMany({
  where: { runType: "pilot_4_4_satisfaction_sheets" },
  orderBy: { startedAt: "desc" },
  take: 5,
  select: {
    id: true,
    status: true,
    startedAt: true,
    finishedAt: true,
    triggeredBy: true,
  },
});
for (const r of runs) {
  console.log(
    `${r.startedAt.toISOString()} | ${r.status} | ${r.finishedAt ? "fin=" + r.finishedAt.toISOString() : "running..."} | ${r.triggeredBy}`
  );
}

await prisma.$disconnect();
