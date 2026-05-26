/**
 * POST /api/admin/enrich-company-from-filename?mode=dry_run|apply
 *
 * pending registry 중 companyName null 인 row의 file_name / courseName에서
 * 알려진 회사명 (TH companies + SEEDS) substring 매칭 → companyName update.
 *
 * 인증: CRON_SECRET
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type RawRecord = { [key: string]: unknown };
function pickString(o: RawRecord | undefined | null, ...keys: string[]): string | null {
  if (!o) return null;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return null;
}

const KOREAN = /[가-힣]/;
function isWordBoundaryMatch(haystack: string, needle: string, idx: number): boolean {
  if (needle.length >= 4) return true;
  const before = idx > 0 ? haystack[idx - 1] : "";
  const after = idx + needle.length < haystack.length ? haystack[idx + needle.length] : "";
  if (before && KOREAN.test(before)) return false;
  if (after && KOREAN.test(after)) return false;
  return true;
}
function findCompanyInName(name: string, companySet: Set<string>): string | null {
  const matches: string[] = [];
  for (const c of companySet) {
    if (c.length < 2) continue;
    const idx = name.indexOf(c);
    if (idx >= 0 && isWordBoundaryMatch(name, c, idx)) matches.push(c);
  }
  if (matches.length === 0) return null;
  return matches.sort((a, b) => b.length - a.length)[0];
}

export async function POST(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const mode = request.nextUrl.searchParams.get("mode") ?? "dry_run";
  const startedAt = Date.now();

  // companySet — TH + SEEDS + 추가 educational org
  const thCompanies = await prisma.teachingHistory.findMany({
    where: { companyName: { not: null } },
    select: { companyName: true },
    distinct: ["companyName"],
  });
  const companySet = new Set<string>();
  for (const t of thCompanies) {
    if (t.companyName && t.companyName.trim().length >= 2) {
      companySet.add(t.companyName.trim());
    }
  }
  const SEEDS = [
    "KB", "KB금융그룹", "KB국민은행", "KB증권",
    "교보", "교보생명", "교보문고",
    "퍼시스", "LF", "앰코테크놀로지코리아", "앰코",
    "동국제강", "동국제강그룹", "동국홀딩스",
    "삼성전자", "삼성생명", "삼성디스플레이", "삼성화재", "삼성SDS", "삼성물산",
    "현대자동차", "현대모비스", "현대카드", "현대건설", "현대오토에버", "현대제철",
    "LG전자", "LG유플러스", "LG화학", "LG CNS", "LG에너지솔루션",
    "SK텔레콤", "SK하이닉스", "SK이노베이션",
    "신한카드", "신한은행", "신한금융지주", "신한라이프",
    "하나은행", "하나금융지주", "우리은행", "우리금융그룹", "우리금융지주",
    "기업은행", "IBK기업은행",
    "롯데웰푸드", "롯데마트", "롯데캐피탈", "롯데홈쇼핑", "롯데면세점",
    "포스코", "포스코ICT", "한국전력", "KT",
    "BGF리테일", "BGF",
    "웰컴저축은행", "웰컴금융그룹",
    "JB금융그룹", "JB금융지주",
    "신세계디에프", "신세계프라퍼티", "이마트",
    "쿠팡", "토스", "토스뱅크", "카카오뱅크", "카카오페이",
    "두산에너빌리티", "한화시스템", "한화에어로스페이스",
    "효성ITX", "효성", "한미약품", "키움증권", "미래에셋증권", "NH투자증권",
    "TKG태광", "태광", "에쓰오일", "S-OIL",
    "솔브레인", "솔브레인홀딩스",
    "디어포스", "스코프랩스",
    // 학교/공공
    "서울과기대", "서울과학기술대학교", "아주대학교", "아주대",
    "성균관대학교", "성균관대", "한국과학기술원", "KAIST",
    "서울대학교", "연세대학교", "고려대학교", "한양대학교",
    "부산대학교", "서울시립대학교", "경북대학교",
    "한국벤처캐피탈협회", "성남상공회의소", "화성산업진흥원",
    "한국교통안전공단", "한국지능정보사회진흥원",
    "한국가스공사", "한국수력원자력",
    "양주백석고등학교",
    // 그 외
    "현모", "비비엔그루", "풍산", "한미반도체",
    "신라호텔", "신라", "셀트리온", "한국타이어", "한화", "두산", "한라",
    "GS건설", "DL이앤씨", "DL건설",
    "오스테오닉", "세라젬", "이크레더블",
    "뷰웍스", "한국유미코아", "코아",
    "엔무브", "에스원",
    "보석업체", "씨젠의료재단",
    "롯데웰푸드", "현대카드캐피탈",
    "삼성금융연수원",
    // v24-28: 추가 SEED (NULL 잔존 회사들)
    "인카금융서비스", "인카금융",
    "비비엔그루", "BVB그루",
    "제일기획", "하나은행",
    "신한금융그룹", "신한라이프",
    "현모", "현모홀딩스",
    "원데이클래스", "더 굿 스쿨",
    "지니뮤직", "TKG태광", "TKG 태광",
    "SK일렉링크", "SK하이닉스시스템IC",
    "한미반도체", "삼성SDI",
    "신세계인터내셔날", "신세계디에프",
    "TCC스틸", "코리안리재보험",
    "두산밥캣", "두산퓨얼셀",
    "한미금융",
  ];
  for (const s of SEEDS) companySet.add(s);
  // 우리 회사는 제외
  const EXCLUDED = new Set(["패스트캠퍼스", "패스트", "Day1", "B2B"]);
  for (const e of EXCLUDED) companySet.delete(e);

  const pending = await prisma.satisfactionReviewRegistry.findMany({
    where: {
      matchStatus: "pending",
      OR: [{ companyName: null }, { companyName: "" }],
    },
    select: { id: true, registryKey: true, courseName: true, sourceRefs: true, sourceType: true },
  });

  interface Plan { registry_key: string; matched_company: string; via: string; file_name: string | null }
  const plans: Plan[] = [];
  const skipped: Array<{ registry_key: string; reason: string }> = [];

  for (const reg of pending) {
    const refs = Array.isArray(reg.sourceRefs) ? (reg.sourceRefs as RawRecord[]) : [];
    const inner = refs[0]?.source_ref as RawRecord | undefined;
    const fileName = pickString(inner, "file_name") ?? pickString(refs[0], "file_name");
    const subject = pickString(inner, "subject") ?? pickString(refs[0], "subject");
    // 우선순위: file_name → courseName → subject
    const haystack = [fileName, reg.courseName, subject].filter(Boolean).join(" | ");
    if (!haystack) {
      skipped.push({ registry_key: reg.registryKey, reason: "no_text" });
      continue;
    }
    const matched = findCompanyInName(haystack, companySet);
    if (!matched) {
      skipped.push({ registry_key: reg.registryKey, reason: "no_company_match" });
      continue;
    }
    plans.push({
      registry_key: reg.registryKey,
      matched_company: matched,
      via: fileName ? "file_name" : (reg.courseName ? "course" : "subject"),
      file_name: fileName,
    });
  }

  if (mode === "dry_run") {
    return NextResponse.json({
      ok: true,
      mode,
      durationMs: Date.now() - startedAt,
      pending_null: pending.length,
      to_update: plans.length,
      skipped_count: skipped.length,
      plans: plans.slice(0, 50),
    });
  }

  let updated = 0;
  for (const p of plans) {
    await prisma.satisfactionReviewRegistry.update({
      where: { registryKey: p.registry_key },
      data: { companyName: p.matched_company },
    });
    updated += 1;
  }

  return NextResponse.json({
    ok: true,
    mode,
    durationMs: Date.now() - startedAt,
    updated,
  });
}
