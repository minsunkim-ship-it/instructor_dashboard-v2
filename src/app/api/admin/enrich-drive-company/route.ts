/**
 * POST /api/admin/enrich-drive-company?mode=dry_run|apply
 *
 * drive_satisfaction registry 중 companyName null인 row의 file_id에서
 * Drive parent folder chain을 traverse해 폴더명에서 회사명 추출.
 *
 * 룰:
 * 1. file_id의 parent 폴더부터 최대 5단계 위로 traverse
 * 2. 각 폴더명에서 TH companyName(전체 SET)과 정확 substring 매칭
 * 3. 매칭된 회사명을 registry.companyName으로 update (apply 모드)
 *
 * 인증: CRON_SECRET
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";
import { exchangeGoogleUserAccessToken, googleApiGet } from "@/lib/google-user-oauth";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

type RawRecord = { [key: string]: unknown };
function pickString(o: RawRecord | undefined | null, ...keys: string[]): string | null {
  if (!o) return null;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return null;
}

interface DriveFile {
  id: string;
  name?: string;
  parents?: string[];
  mimeType?: string;
}

async function fetchDriveFile(token: string, fileId: string): Promise<DriveFile | null> {
  try {
    const data = await googleApiGet<DriveFile>(
      token,
      "https://www.googleapis.com/drive/v3",
      `/files/${fileId}?fields=id,name,parents,mimeType&supportsAllDrives=true`
    );
    return data;
  } catch {
    return null;
  }
}

function findCompanyInName(name: string, companySet: Set<string>): string | null {
  // 알려진 회사명 SET에서 substring 매칭. 가장 긴 매칭 우선.
  const matches: string[] = [];
  for (const c of companySet) {
    if (c.length < 2) continue;
    if (name.includes(c)) matches.push(c);
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

  // 알려진 회사명 SET — TH의 distinct companyName + 시드
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
  // 추가 시드 — 자주 등장하는 short alias
  const SEEDS = [
    "삼성전자", "삼성생명", "삼성디스플레이", "삼성화재", "현대자동차", "현대모비스",
    "현대카드", "LG전자", "LG유플러스", "LG화학", "LG CNS", "SK텔레콤", "SK하이닉스",
    "KB국민은행", "KB증권", "신한카드", "신한은행", "하나은행", "우리은행", "기업은행",
    "롯데웰푸드", "롯데마트", "롯데홈쇼핑", "롯데면세점", "롯데캐피탈",
    "포스코", "포스코ICT", "한국전력", "KT", "BGF리테일",
    "웰컴저축은행", "웰컴금융그룹", "다이닝브랜즈그룹", "JB금융지주", "JB금융그룹",
    "신세계디에프", "신세계프라퍼티", "신세계백화점", "이마트", "쿠팡",
    "에스원", "에스원블루", "현대건설", "GS건설", "대우건설",
    "동국제강", "동국제강그룹", "TKG태광", "효성ITX", "효성", "한미약품",
    "키움증권", "미래에셋증권", "NH투자증권",
    "패스트캠퍼스",
  ];
  for (const s of SEEDS) companySet.add(s);

  const pending = await prisma.satisfactionReviewRegistry.findMany({
    where: {
      matchStatus: "pending",
      OR: [{ companyName: null }, { companyName: "" }],
    },
    select: { id: true, registryKey: true, sourceType: true, sourceRefs: true, courseName: true, candidateName: true },
  });

  const token = await exchangeGoogleUserAccessToken();
  const folderCache = new Map<string, DriveFile | null>();

  interface Plan {
    registryKey: string;
    file_id: string;
    folder_chain: string[];
    matched_company: string;
    via_folder: string;
  }
  const plans: Plan[] = [];
  const skipped: { registryKey: string; reason: string }[] = [];

  for (const r of pending) {
    // γ-A1-v18b: course / candidate / candidate_company에서 알려진 회사 substring 매칭 우선
    // gmail/google_forms registry 모두 적용 가능.
    const directMatched =
      findCompanyInName(r.courseName ?? "", companySet) ||
      findCompanyInName(r.candidateName ?? "", companySet);
    if (directMatched) {
      plans.push({
        registryKey: r.registryKey,
        file_id: "(course/candidate)",
        folder_chain: [],
        matched_company: directMatched,
        via_folder: `course/candidate: ${(r.courseName ?? r.candidateName ?? "").slice(0, 60)}`,
      });
      continue;
    }
    const refs = Array.isArray(r.sourceRefs) ? (r.sourceRefs as RawRecord[]) : [];
    const firstRef = refs[0];
    const inner = firstRef?.source_ref as RawRecord | undefined;
    // gmail registry: file_id 없음. subject / snippet / from / to 에서 회사 추출 시도
    if (r.sourceType !== "drive_satisfaction") {
      const subj = pickString(inner, "subject") ?? pickString(firstRef, "subject");
      const snip = pickString(inner, "snippet") ?? pickString(firstRef, "snippet");
      const fromAddr = pickString(inner, "from") ?? pickString(firstRef, "from");
      const toAddr = pickString(inner, "to") ?? pickString(firstRef, "to");
      const haystack = [subj, snip, fromAddr, toAddr].filter(Boolean).join(" | ");
      const fromHaystack = findCompanyInName(haystack, companySet);
      if (fromHaystack) {
        plans.push({
          registryKey: r.registryKey,
          file_id: "(gmail-meta)",
          folder_chain: [],
          matched_company: fromHaystack,
          via_folder: `gmail-meta: ${haystack.slice(0, 80)}`,
        });
      } else {
        skipped.push({ registryKey: r.registryKey, reason: "gmail_no_company_in_meta" });
      }
      continue;
    }
    const fileId = pickString(inner, "file_id");
    if (!fileId) {
      skipped.push({ registryKey: r.registryKey, reason: "no_file_id" });
      continue;
    }
    // parent chain traverse — 최대 5단계
    const chain: string[] = [];
    let matched: string | null = null;
    let viaFolder = "";
    let currentId = fileId;
    for (let depth = 0; depth < 6; depth++) {
      const cached = folderCache.get(currentId);
      const file = cached ?? (await fetchDriveFile(token, currentId));
      folderCache.set(currentId, file);
      if (!file) break;
      if (file.name && depth > 0) chain.push(file.name);
      const c = findCompanyInName(file.name ?? "", companySet);
      if (c) {
        matched = c;
        viaFolder = file.name ?? "";
        break;
      }
      if (!file.parents || file.parents.length === 0) break;
      currentId = file.parents[0];
    }
    if (matched) {
      plans.push({
        registryKey: r.registryKey,
        file_id: fileId,
        folder_chain: chain,
        matched_company: matched,
        via_folder: viaFolder,
      });
    } else {
      skipped.push({ registryKey: r.registryKey, reason: "no_company_in_chain" });
    }
  }

  if (mode === "dry_run") {
    return NextResponse.json({
      ok: true,
      mode,
      durationMs: Date.now() - startedAt,
      total_pending: pending.length,
      to_update_count: plans.length,
      skipped_count: skipped.length,
      plans: plans.slice(0, 30),
      skipped_samples: skipped.slice(0, 10),
    });
  }

  // apply
  let updated = 0;
  for (const p of plans) {
    await prisma.satisfactionReviewRegistry.update({
      where: { registryKey: p.registryKey },
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
