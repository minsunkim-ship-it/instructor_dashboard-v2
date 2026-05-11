/**
 * diagnose-songyui-companies.ts — 송유이 강의 13개 회사 중 catalog 등록 여부
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";

const inst = await prisma.instructor.findUnique({ where: { name: "송유이" }, select: { id: true } });
if (!inst) process.exit(1);

const ths = await prisma.teachingHistory.findMany({
  where: { instructorDbId: inst.id },
  select: { companyName: true, courseName: true, startDate: true },
  orderBy: { startDate: "desc" },
});

const byCompany = new Map<string, Array<{ course: string | null; start: string | null }>>();
for (const t of ths) {
  if (!t.companyName) continue;
  const list = byCompany.get(t.companyName) ?? [];
  list.push({ course: t.courseName, start: t.startDate?.toISOString().slice(0, 10) ?? null });
  byCompany.set(t.companyName, list);
}

// catalog
const catalogPath = path.resolve(process.cwd(), "data/satisfaction-sheet-catalog.json");
const catalogRaw = await readFile(catalogPath, "utf-8");
const catalog = JSON.parse(catalogRaw) as { sources: Array<{ key: string; title: string; companyName?: string | null; disabled?: boolean }> };
const codeSheets = ["KT AI Campus", "현대모비스", "우리은행 AX", "동국제강", "디어포스", "JB우리캐피탈", "삼성생명", "현대자동차"];

console.log(`송유이 강의 회사 ${byCompany.size}곳:\n`);
for (const [company, courses] of byCompany) {
  // catalog 매칭 시도
  const normCompany = company.toLowerCase().replace(/\s+/g, "");
  const catalogMatches = catalog.sources
    .filter((s) => !s.disabled)
    .filter((s) => {
      const t = s.title.toLowerCase().replace(/\s+/g, "");
      const c = (s.companyName ?? "").toLowerCase().replace(/\s+/g, "");
      return t.includes(normCompany) || normCompany.includes(t.slice(0, 6)) || (c && (c.includes(normCompany) || normCompany.includes(c)));
    });
  const codeMatches = codeSheets.filter((s) => {
    const t = s.toLowerCase().replace(/\s+/g, "");
    return t.includes(normCompany) || normCompany.includes(t.slice(0, 4));
  });
  const matched = catalogMatches.length + codeMatches.length;
  console.log(`  ${company} (${courses.length}건):`);
  console.log(`    catalog: ${matched > 0 ? "✓ " + (catalogMatches.map(c => c.key).concat(codeMatches).join(",")) : "✗ 시트 부재"}`);
  for (const c of courses.slice(0, 2)) {
    console.log(`      - ${(c.course ?? "—").slice(0, 50)} / ${c.start ?? "—"}`);
  }
}

await prisma.$disconnect();
