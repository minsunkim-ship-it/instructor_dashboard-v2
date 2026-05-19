/**
 * POST /api/admin/renormalize-stored-items?mode=dry_run|apply&source=gmail
 *
 * v23 Track A 새 normalizer 로직을 기존 SatisfactionImportItem 전체에 적용.
 *
 * dry_run:
 *  - 변경 row 수 + 30건 sample 노출
 *  - DB write 없음
 *
 * apply:
 *  - ImportItem.candidateCompanyName / candidateCourseName 업데이트
 *  - ImportItem.normalizedPayload.score_normalized / respondent_count 업데이트
 *  - 영향 받은 SatisfactionReviewRegistry는 status=pending으로 reset + companyName/avgScore reset
 *  - 영향 받은 SatisfactionRecord 삭제 → 다음 resolver run에서 재매칭
 *  - refreshSatisfactionAggregates 호출
 *
 * 인증: CRON_SECRET
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";
import { refreshSatisfactionAggregates } from "@/lib/pipeline/satisfaction-applier";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

type RawRecord = { [key: string]: unknown };
function pickString(o: RawRecord | undefined | null, ...keys: string[]): string | null {
  if (!o) return null;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return null;
}
function pickNumber(o: RawRecord | undefined | null, ...keys: string[]): number | null {
  if (!o) return null;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const n = parseFloat(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}
function parseNumber(value: string): number | null {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

// ============ v23 새 normalize 로직 inline ============
function looksLikeKoreanPhrasePrefix(value: string): boolean {
  if (/(지난|오늘|어제|작일|금일|이번주|이번\s*주|작년|올해|내년)/.test(value)) return true;
  if (/(진행한|진행된|진행하|진행해주신|진행하였|진행됐|진행됬|보내|드립니다|드린|작성해|말씀|확인)/.test(value)) return true;
  if (/^\d{1,4}\s*[월\/\-.]\s*\d{1,2}/.test(value)) return true;
  if (/^\d{1,2}\s*월\s*\d{1,2}\s*일/.test(value)) return true;
  if (/[~]/.test(value)) return true;
  if (/^[\s\d~월일\/\-.,()]+$/.test(value)) return true;
  if (/^[\s\[\(]/.test(value)) return true;
  return false;
}

function newParseCompanyHintFromCourseName(courseName: string | null | undefined): string | null {
  const cleaned = (courseName ?? "").trim();
  if (!cleaned) return null;
  if (/(님께|요청드립니다|요청 드립니다|정산|안내|세금계산서|결과 전달|결과 공유|리마인드|발행 정보)/i.test(cleaned)) {
    return null;
  }
  if (looksLikeKoreanPhrasePrefix(cleaned)) return null;
  const dashMatch = cleaned.match(/^([^-\n]{2,30}?)\s*-\s*/);
  if (dashMatch?.[1]) {
    const c = dashMatch[1].trim();
    if (looksLikeKoreanPhrasePrefix(c)) return null;
    return c;
  }
  const underscoreMatch = cleaned.match(/^([^_\n]{2,30}?)_/);
  if (underscoreMatch?.[1]) {
    const c = underscoreMatch[1].trim();
    if (looksLikeKoreanPhrasePrefix(c)) return null;
    return c;
  }
  return null;
}

function newParseCompanyHintFromSubject(subject: string | null | undefined): string | null {
  const cleaned = (subject ?? "").trim();
  if (!cleaned) return null;
  const bracketMatch = cleaned.match(/^\[[^/\]]+\/([^\]]+)\]/);
  if (bracketMatch?.[1]) return bracketMatch[1].trim();
  const bracketDashMatch = cleaned.match(/^\[[^\]]+\]\s*([^-\n]{2,30}?)\s*-/);
  if (bracketDashMatch?.[1] && !bracketDashMatch[1].includes("님께") && !bracketDashMatch[1].includes("강사")) {
    return bracketDashMatch[1].trim();
  }
  const COURSE_KEYWORD = "(?:강의|교육|과정|연수|워크숍|특강|수업|클래스|아카데미|커리큘럼)";
  const shortNameDashMatch = cleaned.match(/[-–]\s*([가-힣A-Za-z0-9]{2,4})\s*[-–]/);
  if (shortNameDashMatch?.[1]) {
    const c = shortNameDashMatch[1].trim();
    if (!/(패스트캠퍼스|Day1|day1|fastcampus)/i.test(c) && c.length >= 2) return c;
  }
  const afterDashWithBufferMatch = cleaned.match(
    new RegExp(
      `[-–]\\s*([가-힣A-Za-z0-9]{2,12})(?:\\s*\\([^)]+\\))?[\\s가-힣A-Za-z0-9()_./,]{0,50}?${COURSE_KEYWORD}`
    )
  );
  if (afterDashWithBufferMatch?.[1]) {
    const c = afterDashWithBufferMatch[1].trim();
    if (!/(패스트캠퍼스|Day1|day1|fastcampus)/i.test(c) && c.length >= 2) return c;
  }
  const directDashMatch = cleaned.match(/^([가-힣A-Za-z0-9()]{2,30})\s*[-–_]\s*/);
  if (directDashMatch?.[1] && !directDashMatch[1].includes("강사") && !directDashMatch[1].includes("님께")) {
    return directDashMatch[1].trim();
  }
  const underscoreMatch = cleaned.match(/-\s*([^_]+)_/);
  if (underscoreMatch?.[1]) return underscoreMatch[1].trim();
  const singleBracket = cleaned.match(/^\[([가-힣A-Za-z0-9()]{2,30})\]\s/);
  if (singleBracket?.[1] && !/(패스트캠퍼스|day1|Day1)/i.test(singleBracket[1])) {
    return singleBracket[1].trim();
  }
  return null;
}

function newParseScoreFromText(text: string): number | null {
  if (!text) return null;
  const tenScalePatterns = [
    /10\s*점\s*(?:척도|만점|만족)[\s\S]{0,80}?중\s*([1-9](?:\.\d+)?|10(?:\.0+)?)\s*점/i,
    /10\s*점\s*(?:척도|만점|만족)[\s\S]{0,80}?기준\s*([1-9](?:\.\d+)?)\s*점/i,
    /10\s*점\s*(?:척도|만점|만족)[\s\S]{0,80}?에서\s*([1-9](?:\.\d+)?)\s*점/i,
    /(\d+(?:\.\d+)?)\s*\/\s*10\s*점?(?!\d)/,
    /(\d+(?:\.\d+)?)\s*점\s*\/\s*10\s*점?/,
    /만족도[\s\S]{0,40}?10\s*점\s*(?:척도|만점|만족)[\s\S]{0,40}?중\s*([1-9](?:\.\d+)?|10(?:\.0+)?)\s*점/i,
    /(\d+(?:\.\d+)?)\s*점\s*\(\s*10\s*점\s*(?:만점|척도)\s*\)/i,
  ];
  for (const pattern of tenScalePatterns) {
    const match = text.match(pattern);
    if (!match?.[1]) continue;
    const parsed = parseNumber(match[1]);
    if (parsed === null) continue;
    if (parsed === 10) continue;
    if (parsed > 5 && parsed < 10) return Math.round((parsed / 2) * 100) / 100;
    if (parsed >= 1 && parsed <= 5) return Math.round((parsed / 2) * 100) / 100;
  }
  const fiveScalePatterns = [
    /강의\s*만족도(?:\s*평가)?[^\d]{0,10}([1-5](?:\.\d+)?)(?:\s*\/\s*5(?:\.0)?)?/i,
    /강사\s*만족도[^\d]{0,10}([1-5](?:\.\d+)?)(?:\s*\/\s*5(?:\.0)?)?/i,
    /전체\s*만족도[^\d]{0,10}([1-5](?:\.\d+)?)(?:\s*\/\s*5(?:\.0)?)?/i,
    /(?:종합\s*평균\s*만족도|평균\s*만족도|만족도\s*평균|평균\s*점수|종합\s*만족도)[^\d]{0,10}([1-5](?:\.\d+)?)/i,
  ];
  const candidateLines = text.split("\n").map((r) => r.trim()).filter(Boolean);
  for (const line of candidateLines) {
    for (const pattern of fiveScalePatterns) {
      const match = line.match(pattern);
      if (!match?.[1]) continue;
      const parsed = parseNumber(match[1]);
      if (parsed !== null && parsed >= 1 && parsed <= 5) return parsed;
    }
  }
  return null;
}

function newParseRespondentCount(text: string): number | null {
  if (!text) return null;
  const patterns = [
    /응답인원[^\d]*(\d+)명/,
    /설문\s*참여인원[^\d]*(\d+)명?/i,
    /응답\s*수[^\d]*(\d+)명?/i,
    /만족도\s*인원[^\d]*(\d+)명?/i,
    /응답자\s*수[^\d]*(\d+)명?/i,
    /응답 평균\s*\(n\s*=\s*(\d+)\)/i,
    /\(n\s*=\s*(\d+)\)[^\n]{0,80}종합 평균 만족도/i,
    /n\s*=\s*(\d+)/i,
    /참여\s*인원[^\d]*(\d+)명?/i,
    /수강\s*인원[^\d]*(\d+)명?/i,
    /응답한\s*인원[^\d]*(\d+)명?/i,
    /(\d+)\s*명\s*(?:응답|참여|수강)/i,
    /총\s*응답[^\d]*(\d+)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const n = parseInt(match[1], 10);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}
// ============ END inline ============

interface ItemUpdate {
  itemId: string;
  registryKey: string | null;
  changes: {
    company: { old: string | null; new: string | null };
    course: { old: string | null; new: string | null };
    score: { old: number | null; new: number | null };
    respondent: { old: number | null; new: number | null };
  };
  changedFields: string[];
}

export async function POST(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const mode = request.nextUrl.searchParams.get("mode") ?? "dry_run";
  const sourceFilter = request.nextUrl.searchParams.get("source") ?? "gmail";
  // v23 Step 2 batch mode: limit + offset 으로 점진적 apply
  const limit = parseInt(request.nextUrl.searchParams.get("limit") ?? "5000", 10);
  const offset = parseInt(request.nextUrl.searchParams.get("offset") ?? "0", 10);
  const startedAt = Date.now();

  const sourceTypes =
    sourceFilter === "gmail"
      ? ["gmail_summary", "gmail_satisfaction"]
      : sourceFilter === "all"
      ? undefined
      : [sourceFilter];

  // 모든 후보 ImportItem을 일관된 순서로 조회 (offset/limit 안정성 보장)
  const items = await prisma.satisfactionImportItem.findMany({
    where: sourceTypes ? { sourceType: { in: sourceTypes } } : {},
    select: {
      id: true,
      sourceType: true,
      sourceRefKey: true,
      candidateName: true,
      candidateCompanyName: true,
      candidateCourseName: true,
      rawPayload: true,
      normalizedPayload: true,
    },
    orderBy: { id: "asc" },
    take: 5000,
  });

  const updates: ItemUpdate[] = [];
  const affectedRegistryKeys = new Set<string>();

  for (const it of items) {
    const raw = (it.rawPayload as RawRecord) ?? {};
    const norm = (it.normalizedPayload as RawRecord) ?? {};
    const subject = pickString(raw, "subject");
    const snippet = pickString(raw, "snippet");
    const body = pickString(raw, "body_excerpt", "body");
    const haystack = [subject, snippet, body].filter(Boolean).join("\n");

    const oldCompany = it.candidateCompanyName ?? pickString(norm, "company_name", "companyName");
    const oldCourse = it.candidateCourseName ?? pickString(norm, "course_name", "courseName");
    const oldScore = pickNumber(norm, "score_normalized", "scoreNormalized");
    const oldRespondent = pickNumber(norm, "respondent_count", "respondentCount");

    // 새 normalize
    const newCompanyFromCourse = newParseCompanyHintFromCourseName(oldCourse);
    const newCompanyFromSubject = newParseCompanyHintFromSubject(subject);
    const newCompany = newCompanyFromCourse ?? newCompanyFromSubject ?? oldCompany;
    const newScore = newParseScoreFromText(haystack);
    const newRespondent = newParseRespondentCount(haystack);

    // course rewrite: 비정형 시간 어구면 정리 (null로) — 단 정상 course면 유지
    let newCourse = oldCourse;
    if (oldCourse && looksLikeKoreanPhrasePrefix(oldCourse)) {
      newCourse = null;
    }

    // 변경된 필드 식별
    const changedFields: string[] = [];
    if (oldCompany !== newCompany && (newCompany !== null || oldCompany !== null)) {
      // 비정형 → 정상으로 정정되는 경우만 (정상 → null 되돌리기 X)
      if (newCompany !== null || (oldCompany !== null && looksLikeKoreanPhrasePrefix(oldCompany))) {
        changedFields.push("company");
      }
    }
    if (oldCourse !== newCourse) {
      changedFields.push("course");
    }
    if (oldScore !== newScore && newScore !== null) {
      changedFields.push("score");
    }
    if (oldRespondent !== newRespondent && newRespondent !== null) {
      changedFields.push("respondent");
    }
    if (changedFields.length === 0) continue;

    // affected registry
    const registryKey =
      pickString(norm, "registry_key", "registryKey") ?? null;
    if (registryKey) affectedRegistryKeys.add(registryKey);

    updates.push({
      itemId: it.id,
      registryKey,
      changes: {
        company: { old: oldCompany, new: changedFields.includes("company") ? newCompany : oldCompany },
        course: { old: oldCourse, new: changedFields.includes("course") ? newCourse : oldCourse },
        score: { old: oldScore, new: changedFields.includes("score") ? newScore : oldScore },
        respondent: { old: oldRespondent, new: changedFields.includes("respondent") ? newRespondent : oldRespondent },
      },
      changedFields,
    });
  }

  const totalChangedAll = updates.length;
  // batch: 같은 정렬 결과에서 offset~offset+limit slice
  const batchUpdates = updates.slice(offset, offset + limit);
  const batchRegistryKeys = new Set<string>();
  for (const u of batchUpdates) if (u.registryKey) batchRegistryKeys.add(u.registryKey);

  const summary = {
    total_scanned: items.length,
    total_changed_all: totalChangedAll,
    batch_size: batchUpdates.length,
    batch_offset: offset,
    batch_limit: limit,
    has_more: offset + limit < totalChangedAll,
    next_offset: offset + limit < totalChangedAll ? offset + limit : null,
    by_field: {
      company: batchUpdates.filter((u) => u.changedFields.includes("company")).length,
      course: batchUpdates.filter((u) => u.changedFields.includes("course")).length,
      score: batchUpdates.filter((u) => u.changedFields.includes("score")).length,
      respondent: batchUpdates.filter((u) => u.changedFields.includes("respondent")).length,
    },
    affected_registries_all: affectedRegistryKeys.size,
    affected_registries_batch: batchRegistryKeys.size,
  };

  if (mode === "dry_run") {
    return NextResponse.json({
      ok: true,
      mode,
      durationMs: Date.now() - startedAt,
      summary,
      sample: batchUpdates.slice(0, 30),
    });
  }

  // ===== apply (batch only) =====
  let updatedItems = 0;
  let resetRegistries = 0;
  let deletedRecords = 0;
  const touchedInstructorIds = new Set<string>();

  for (const u of batchUpdates) {
    const newCompany = u.changes.company.new;
    const newCourse = u.changes.course.new;
    const newScore = u.changes.score.new;
    const newRespondent = u.changes.respondent.new;

    const existingItem = await prisma.satisfactionImportItem.findUnique({
      where: { id: u.itemId },
      select: { normalizedPayload: true },
    });
    const norm = (existingItem?.normalizedPayload as RawRecord) ?? {};
    const newNorm: RawRecord = { ...norm };
    if (u.changedFields.includes("score") && newScore !== null) {
      newNorm.score_normalized = newScore;
    }
    if (u.changedFields.includes("respondent") && newRespondent !== null) {
      newNorm.respondent_count = newRespondent;
    }
    if (u.changedFields.includes("company") && newCompany !== null) {
      newNorm.company_name = newCompany;
    }
    if (u.changedFields.includes("course")) {
      newNorm.course_name = newCourse;
    }

    await prisma.satisfactionImportItem.update({
      where: { id: u.itemId },
      data: {
        ...(u.changedFields.includes("company") ? { candidateCompanyName: newCompany } : {}),
        ...(u.changedFields.includes("course") ? { candidateCourseName: newCourse } : {}),
        normalizedPayload: newNorm as Prisma.InputJsonObject,
      },
    });
    updatedItems += 1;
  }

  // 영향 받은 registry pending reset + record 삭제 (batch만)
  if (batchRegistryKeys.size > 0) {
    const registries = await prisma.satisfactionReviewRegistry.findMany({
      where: { registryKey: { in: Array.from(batchRegistryKeys) } },
      select: { id: true, registryKey: true, matchStatus: true, resolvedInstructorId: true },
    });
    for (const r of registries) {
      if (r.resolvedInstructorId) touchedInstructorIds.add(r.resolvedInstructorId);
    }
    // 영향 record 삭제 (registry_key가 sourceRef 안에 있음)
    const allRecords = await prisma.satisfactionRecord.findMany({
      where: { instructorDbId: { in: Array.from(touchedInstructorIds) } },
      select: { id: true, sourceRef: true, instructorDbId: true },
    });
    const recordsToDelete: string[] = [];
    for (const rec of allRecords) {
      const sr = rec.sourceRef as RawRecord | null;
      const rk = pickString(sr, "registry_key");
      if (rk && batchRegistryKeys.has(rk)) {
        recordsToDelete.push(rec.id);
        touchedInstructorIds.add(rec.instructorDbId);
      }
    }
    if (recordsToDelete.length > 0) {
      await prisma.satisfactionRecord.deleteMany({ where: { id: { in: recordsToDelete } } });
      deletedRecords = recordsToDelete.length;
    }
    // registries pending reset
    await prisma.satisfactionReviewRegistry.updateMany({
      where: { registryKey: { in: Array.from(batchRegistryKeys) } },
      data: {
        matchStatus: "pending",
        resolvedInstructorId: null,
        avgScore: null, // 새 ImportItem 데이터로 재계산되도록 reset
        companyName: null, // 동일
        resolutionBasis: `v23_renormalize|${new Date().toISOString()}`,
      },
    });
    resetRegistries = registries.length;
  }

  if (touchedInstructorIds.size > 0) {
    await refreshSatisfactionAggregates(Array.from(touchedInstructorIds));
  }

  return NextResponse.json({
    ok: true,
    mode,
    durationMs: Date.now() - startedAt,
    summary,
    applied: {
      updated_items: updatedItems,
      reset_registries: resetRegistries,
      deleted_records: deletedRecords,
      affected_instructors: touchedInstructorIds.size,
    },
    note: "registry pending reset + records 삭제됨. 다음에 resolve-gmail + applySatisfactionImports 또는 /api/refresh 실행해야 새 normalized 데이터 기반으로 registry/record 재생성됨.",
  });
}
