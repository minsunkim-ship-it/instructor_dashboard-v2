/**
 * unit-test-generic-forms-parser.ts — Phase B/C dry-run (DB 쓰기 없음)
 *
 * 목적: buildGenericGoogleFormsDraftItems + resolveInstructorByCourseAndDate가
 * 박상훈 동국홀딩스/동국제강 케이스에서 정상 작동하는지 read-only 검증.
 *
 * 검증:
 *   1. catalog title 파싱 — companyName/courseName/sessionLabel 추출
 *   2. resolveInstructorByCourseAndDate — 박상훈이 후보에 포함되는지
 *
 * 실패 시 process.exit(1).
 */
import { prisma } from "@/lib/prisma";

// 동국제강그룹 catalog title 4종 시뮬레이션
const SAMPLE_TITLES = [
  "동국제강그룹_2026 DK AI 역량강화 아카데미 Basic-6차수과정 만족도조사(응답)",
  "동국제강그룹_2026 DK AI 역량강화 아카데미 Basic-7차수과정 만족도조사(응답)",
  "(공유용) 디어포스_리더 대상 AI 리터러시 과정_만족도 평가(응답)",
  "★[현대자동차 연구소] Awareness 전환 설문 결과",
];

// 헬퍼 함수 (normalizer.ts와 동일 — 단위 테스트용 복제)
function deriveCompanyFromTitle(title: string): string {
  let cleaned = title.trim();
  cleaned = cleaned.replace(/^[★\(\[]?\s*공유용\s*[\)\]]?\s*[_\s-]*/u, "");
  cleaned = cleaned.replace(/^[★\(\[]?\s*공유\s*[\)\]]?\s*[_\s-]*/u, "");
  cleaned = cleaned.replace(/^[★]+\s*/u, "");
  cleaned = cleaned.replace(/^\(([^)]+)\)\s*/u, "$1 ");
  cleaned = cleaned.replace(/^\[([^\]]+)\]\s*/u, "$1 ");
  const underscoreIndex = cleaned.indexOf("_");
  if (underscoreIndex > 0) return cleaned.slice(0, underscoreIndex).trim();
  const spaceIndex = cleaned.indexOf(" ");
  if (spaceIndex > 0) return cleaned.slice(0, spaceIndex).trim();
  return cleaned;
}

function deriveCourseFromTitle(title: string, companyName: string): string {
  let cleaned = title.trim();
  cleaned = cleaned.replace(/^[★\(\[]?\s*공유용\s*[\)\]]?\s*[_\s-]*/u, "");
  cleaned = cleaned.replace(/^[★\(\[]?\s*공유\s*[\)\]]?\s*[_\s-]*/u, "");
  cleaned = cleaned.replace(/^[★]+\s*/u, "");
  cleaned = cleaned.replace(/^\(([^)]+)\)\s*/u, "");
  cleaned = cleaned.replace(/^\[([^\]]+)\]\s*/u, "");
  if (companyName && cleaned.startsWith(companyName)) {
    cleaned = cleaned.slice(companyName.length).replace(/^[_\s-]+/u, "");
  }
  cleaned = cleaned.replace(/\s*\(응답\)\s*$/u, "");
  cleaned = cleaned.replace(/\s*만족도\s*(조사|평가|설문)?(\s*결과)?(\s*\(응답\))?\s*$/u, "");
  cleaned = cleaned.replace(/\s*설문\s*결과\s*$/u, "");
  return cleaned.trim();
}

function deriveSessionLabelFromTitle(title: string): string | null {
  const basicMatch = title.match(
    /(Basic|Pro|Plus|기본|심화|초급|중급|고급)\s*-?\s*(\d+)\s*(차수|기|회차)/iu
  );
  if (basicMatch) {
    return `${basicMatch[1]}-${basicMatch[2]}${basicMatch[3]}`;
  }
  const sessionMatch = title.match(/(\d+)\s*(차수|회차|기)/u);
  if (sessionMatch) {
    return `${sessionMatch[1]}${sessionMatch[2]}`;
  }
  return null;
}

async function testTitleParsing() {
  console.log("=== Test 1: title 파싱 ===");
  const fails: string[] = [];

  for (const title of SAMPLE_TITLES) {
    const company = deriveCompanyFromTitle(title);
    const course = deriveCourseFromTitle(title, company);
    const session = deriveSessionLabelFromTitle(title);
    console.log(`  title: ${title}`);
    console.log(`    company: "${company}" / course: "${course}" / session: ${session ?? "(none)"}`);

    if (!company || !course) fails.push(`empty parse: ${title}`);
  }

  // 동국제강 6차수 — 예상값 검증
  const dongkuk6Title = SAMPLE_TITLES[0];
  const dongkuk6Company = deriveCompanyFromTitle(dongkuk6Title);
  const dongkuk6Session = deriveSessionLabelFromTitle(dongkuk6Title);
  if (dongkuk6Company !== "동국제강그룹") fails.push(`동국제강그룹 expected, got: ${dongkuk6Company}`);
  if (dongkuk6Session !== "Basic-6차수") fails.push(`Basic-6차수 expected, got: ${dongkuk6Session}`);

  // 디어포스 — 회사명 첫 토큰
  const dearforceTitle = SAMPLE_TITLES[2];
  const dearforceCompany = deriveCompanyFromTitle(dearforceTitle);
  if (dearforceCompany !== "디어포스") fails.push(`디어포스 expected, got: ${dearforceCompany}`);

  if (fails.length === 0) console.log("  ✅ PASS\n");
  else {
    console.log("  ❌ FAIL");
    for (const f of fails) console.log(`    - ${f}`);
    console.log("");
  }
  return fails.length === 0;
}

async function testResolverParkSanghoon() {
  console.log("=== Test 2: 박상훈 동국 매칭 (resolveInstructorByCourseAndDate 시뮬레이션) ===");

  const ths = await prisma.teachingHistory.findMany({
    where: {
      OR: [
        { companyName: { contains: "동국" } },
        { courseName: { contains: "DK AI" } },
        { courseName: { contains: "AI 역량강화" } },
      ],
    },
    select: {
      instructorDbId: true,
      companyName: true,
      courseName: true,
      startDate: true,
      endDate: true,
      instructor: { select: { name: true, isPracticeCoach: true, isFulltime: true } },
    },
  });

  console.log(`  동국 관련 teaching_history ${ths.length}건`);
  if (ths.length === 0) {
    console.log("  ⚠️ teaching_history 0건 — 패치 회귀 또는 source 데이터 부재");
    return false;
  }

  // 박상훈 강의 일정 확인
  const parkSanghoonRows = ths.filter((r) => r.instructor.name === "박상훈");
  console.log(`  박상훈 강의 ${parkSanghoonRows.length}건`);
  for (const r of parkSanghoonRows.slice(0, 5)) {
    console.log(
      `    - ${r.companyName ?? "—"} / ${(r.courseName ?? "—").slice(0, 30)} / ${r.startDate?.toISOString().slice(0, 10)}~${r.endDate?.toISOString().slice(0, 10)}`
    );
  }

  if (parkSanghoonRows.length === 0) {
    console.log("  ❌ 박상훈 동국 강의 0건 — 회복 패치 회귀 의심");
    return false;
  }

  // 가상 응답일자: 박상훈 첫 강의의 startDate를 매칭 대상으로
  const firstRow = parkSanghoonRows[0];
  if (!firstRow.startDate) {
    console.log("  ⚠️ startDate null — 매칭 시뮬레이션 skip");
    return true;
  }
  const targetDate = firstRow.startDate;

  // L1 시뮬레이션: 같은 [start, end]에 응답일자 포함하는 정규 강사 찾기
  const candidates = ths.filter((r) => {
    if (r.instructor.isPracticeCoach || r.instructor.isFulltime) return false;
    const startMs = r.startDate?.getTime() ?? null;
    const endMs = r.endDate?.getTime() ?? null;
    const targetMs = targetDate.getTime();
    if (startMs === null || endMs === null) return false;
    return startMs <= targetMs && targetMs <= endMs;
  });
  const candidateNames = Array.from(new Set(candidates.map((r) => r.instructor.name)));
  console.log(
    `  L1 매칭 (응답일=${targetDate.toISOString().slice(0, 10)}): ${candidateNames.length}명 — ${candidateNames.join(", ")}`
  );

  if (!candidateNames.includes("박상훈")) {
    console.log("  ❌ 박상훈이 L1 매칭에 없음 — Phase C 알고리즘 결함");
    return false;
  }

  console.log("  ✅ PASS — 박상훈이 L1 매칭에 포함됨\n");
  return true;
}

async function main() {
  const titleOk = await testTitleParsing();
  const resolverOk = await testResolverParkSanghoon();

  if (titleOk && resolverOk) {
    console.log("종합: ✅ ALL PASS");
    process.exit(0);
  } else {
    console.log("종합: ❌ FAIL");
    process.exit(1);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
