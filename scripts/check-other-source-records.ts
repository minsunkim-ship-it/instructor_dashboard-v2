import { prisma } from "@/lib/prisma";

const counts = await Promise.all([
  prisma.satisfactionRecord.count({ where: { companyName: { contains: "현대모비스" } } }),
  prisma.satisfactionRecord.count({ where: { companyName: { contains: "우리은행" } } }),
  prisma.satisfactionRecord.count({ where: { companyName: { contains: "삼성" } } }),
  prisma.satisfactionRecord.count({ where: { companyName: { contains: "신세계" } } }),
  prisma.satisfactionRecord.count({ where: { companyName: { contains: "JB우리" } } }),
  prisma.satisfactionRecord.count({ where: { companyName: { contains: "디어포스" } } }),
  prisma.satisfactionRecord.count({ where: { companyName: { contains: "동국" } } }),
  prisma.satisfactionRecord.count({ where: { companyName: { contains: "KT" } } }),
  prisma.satisfactionRecord.count({}),
]);
console.log(`현대모비스: ${counts[0]}`);
console.log(`우리은행: ${counts[1]}`);
console.log(`삼성: ${counts[2]}`);
console.log(`신세계: ${counts[3]}`);
console.log(`JB우리: ${counts[4]}`);
console.log(`디어포스: ${counts[5]}`);
console.log(`동국: ${counts[6]}`);
console.log(`KT: ${counts[7]}`);
console.log(`전체: ${counts[8]}`);
await prisma.$disconnect();
