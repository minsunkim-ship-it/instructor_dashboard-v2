import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import type { SatisfactionImportItemInput } from "@/lib/pipeline/satisfaction-applier";
import type { SatisfactionSourceSummary } from "@/lib/pipeline/satisfaction-sheets-normalizer";
import type {
  DriveSatisfactionCollectResult,
  DriveSatisfactionFile,
} from "@/lib/pipeline/satisfaction-drive-collector";

interface FileNameMetadata {
  courseName: string | null;
  companyName: string | null;
  instructorNameHint: string | null;
}

const PLATFORM_NAMES = ["패스트캠퍼스", "마이써니", "엔무브"];

function parseFileName(fileName: string): FileNameMetadata {
  let name = fileName
    .replace(/\(응답\)/g, "")
    .replace(/\(공유용\)/g, "")
    .replace(/\(공유\)/g, "")
    .replace(/\(인쇄용\)/g, "")
    .replace(/\(기업\s*전달용\)/g, "")
    .replace(/\(강사님\s*공유용\)/g, "")
    .replace(/의\s*사본/g, "")
    .replace(/_(응답결과|Raw\s*Data|rawdata|raw\s*data)/gi, "")
    .trim();

  name = name
    .replace(/^★\s*\d+\.\s*/, "")
    .replace(/^\(\d+차수?\)\s*/, "")
    .replace(/^\(\d+회차?\)\s*/, "")
    .replace(/^\(하반기\)\s*/, "")
    .replace(/^\(상반기\)\s*/, "")
    .replace(/^\(모듈\)\s*/, "")
    .replace(/^\(데일리\)\s*/, "")
    .replace(/^\d{4}[._-]\s*/, "")
    .replace(/^\d{4}\s+/, "")
    .replace(/^\d{2,4}\s+/, "")
    .replace(/^\(\d{4}\.\d{2}\.\d{2}\.?\s*~?\s*\d{0,2}\.?\d{0,2}\.?\)\s*/, "")
    .replace(/^\(\d{4}\.\d{2}\.?\)\s*/, "")
    .trim();

  let companyName: string | null = null;

  const bracketMatch = name.match(/^\[([^\]]+)\]\s*/);
  if (bracketMatch) {
    let extracted = bracketMatch[1].trim();
    if (/X|x/.test(extracted) && extracted.includes("패스트캠퍼스")) {
      const parts = extracted.split(/\s*[Xx]\s*/);
      extracted = parts.find((p) => !PLATFORM_NAMES.some((pl) => p.includes(pl))) ?? parts[parts.length - 1];
      extracted = extracted.trim();
    }
    companyName = extracted;
    name = name.slice(bracketMatch[0].length).trim();
  }

  name = name
    .replace(
      /[_\s]*만족도\s*(조사|결과|평가|종합|보고|분석|정리|공유|송부|설문|추가\s*설문)?(\s*(결과|폼))?/g,
      ""
    )
    .replace(/[_\s]*설문\s*(조사|결과|평가|문항)?(\s*전달)?/g, "")
    .replace(/[_\s]*raw\s*data/gi, "")
    .replace(/[_\s]*(Daily|Final|Module|데일리|파이널)\s*/gi, "")
    .replace(/\s*\(\d+\)\s*/g, " ")
    .replace(/\s*\d{6}\s*$/, "")
    .replace(/\s*_\s*\d{4,8}\s*$/, "")
    .replace(/\s*[-_]\s*$/, "")
    .replace(/^\s*[-_]\s*/, "")
    .trim();

  if (!companyName) {
    const dashMatch = name.match(/^(.+?)\s*[-–]\s*(.+)$/);
    if (dashMatch) {
      const left = dashMatch[1].trim();
      if (!PLATFORM_NAMES.includes(left)) {
        companyName = left;
      }
      name = dashMatch[2].trim();
    }
  }

  if (!companyName) {
    const underscoreMatch = name.match(/^(.+?)_(.+)$/);
    if (underscoreMatch) {
      const left = underscoreMatch[1].trim();
      if (PLATFORM_NAMES.includes(left)) {
        const rest = underscoreMatch[2].trim();
        const innerUnderscore = rest.match(/^(.+?)_(.+)$/);
        if (innerUnderscore) {
          companyName = innerUnderscore[1].trim();
          name = innerUnderscore[2].trim();
        } else {
          name = rest;
        }
      } else {
        companyName = left;
        name = underscoreMatch[2].trim();
      }
    }
  }

  if (companyName) {
    companyName = companyName
      .replace(/\s*(Daily|Final|데일리|파이널)\s*$/i, "")
      .replace(/^[_\s]+|[_\s]+$/g, "")
      .trim();
  }

  let instructorNameHint: string | null = null;
  const instructorMatch = fileName.match(
    /([가-힣]{2,4})\s*강사님?/
  );
  if (instructorMatch) {
    instructorNameHint = instructorMatch[1];
  }
  if (!instructorNameHint) {
    const slashMatch = fileName.match(/\/\s*([가-힣]{2,4})\s*$/);
    if (slashMatch) {
      instructorNameHint = slashMatch[1];
    }
  }

  const courseName = name || null;
  return { courseName, companyName, instructorNameHint };
}

const COMPANY_ALIASES: Record<string, string[]> = {
  "IBK 기업은행": ["IBK기업은행", "아이비케이기업은행"],
  "IBK기업은행": ["IBK 기업은행", "아이비케이기업은행"],
  "KB금융그룹": ["케이비국민은행", "KB국민은행", "KB 국민은행"],
  "KB국민은행": ["케이비국민은행", "KB 국민은행"],
  "KB": ["케이비국민은행", "KB국민은행", "KB 국민은행"],
  "SK텔링크": ["에스케이텔링크"],
  "JB금융그룹": ["JB금융지주", "전북은행"],
  "현대HDS": ["현대에이치디에스"],
  "TKG 태광": ["태광", "TKG태광"],
  "KT": ["케이티"],
  "현대자동차 연구소": ["현대자동차", "현대자동차그룹"],
  "현대자동차 경영지원본부": ["현대자동차", "현대자동차그룹"],
  "SK그룹": ["에스케이텔레콤", "SK"],
  "LG경영연구원": ["엘지전자", "LG"],
  "삼성금융연수원": ["삼성생명보험", "삼성화재", "삼성금융연수원"],
  "CSM": ["패스트캠퍼스"],
  "B2B": ["패스트캠퍼스"],
  "웰컴금융그룹": ["웰컴저축은행"],
};

const OVERALL_SATISFACTION_PATTERNS = [
  /전체\s*만족도/,
  /전반적인?\s*(강의\s*)?만족도/,
  /전반적인?\s*(세미나\s*)?만족도/,
  /^1\.\s*(강의\s*)?만족도\s*평가$/,
  /^강의\s*만족도\s*평가$/,
  /^만족도\s*평가$/,
];

const SATISFACTION_KEYWORD = /만족도/;

const SUB_CATEGORY_MARKERS =
  /\[커리큘럼\]|\[인사이트\]|\[이론.*실습\]|\[현업적용\]|\[교수법\]|\[추천지수\]|난이도|속도|추천/;

function findSatisfactionColumnIndex(headerRow: string[]): number {
  for (const pattern of OVERALL_SATISFACTION_PATTERNS) {
    for (let i = 0; i < headerRow.length; i += 1) {
      if (pattern.test(headerRow[i]?.trim() ?? "")) return i;
    }
  }

  for (let i = 0; i < headerRow.length; i += 1) {
    const cell = headerRow[i]?.trim() ?? "";
    if (SATISFACTION_KEYWORD.test(cell) && !SUB_CATEGORY_MARKERS.test(cell)) {
      return i;
    }
  }

  return -1;
}

function parseTimestamp(value: string | null | undefined): Date | null {
  if (!value) return null;
  const trimmed = value.trim();

  const koMatch = trimmed.match(
    /(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\s*(오전|오후)?\s*(\d{1,2}):(\d{2}):?(\d{2})?/
  );
  if (koMatch) {
    const [, year, month, day, ampm, hourRaw, minute] = koMatch;
    let hour = Number(hourRaw);
    if (ampm === "오후" && hour < 12) hour += 12;
    if (ampm === "오전" && hour === 12) hour = 0;
    return new Date(
      Date.UTC(Number(year), Number(month) - 1, Number(day), hour, Number(minute))
    );
  }

  const isoMatch = trimmed.match(/(\d{4})[./-](\d{1,2})[./-](\d{1,2})/);
  if (isoMatch) {
    return new Date(
      Date.UTC(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]))
    );
  }

  return null;
}

function detectScale(values: number[]): 5 | 10 | null {
  if (values.length === 0) return null;
  const max = Math.max(...values);
  if (max <= 5) return 5;
  if (max <= 10) return 10;
  return null;
}

function normalizeScore(value: number, scale: 5 | 10): number {
  if (scale === 10) return Math.round((value / 2) * 100) / 100;
  return Math.round(value * 100) / 100;
}

function encodeKeyPart(value: string | null | undefined): string {
  if (!value) return "";
  return encodeURIComponent(value.trim().toLowerCase());
}

function buildDriveRegistryKey(args: {
  fileId: string;
  sheetTitle: string;
  companyName: string | null;
  courseName: string | null;
  dateStr: string | null;
}): string {
  const normalized = [
    "satisfaction",
    "drive",
    args.fileId,
    encodeKeyPart(args.sheetTitle),
    encodeKeyPart(args.companyName),
    encodeKeyPart(args.courseName),
    encodeKeyPart(args.dateStr),
  ].join(":");

  return `satisfaction:drive:${createHash("sha1").update(normalized).digest("hex")}`;
}

function isFormsResponseSheet(headerRow: string[]): boolean {
  const first = headerRow[0]?.trim() ?? "";
  return /타임스탬프|Timestamp/i.test(first);
}

function isTemplateOrEmpty(file: DriveSatisfactionFile): boolean {
  const nameLower = file.fileName.toLowerCase();
  if (nameLower.includes("양식") || nameLower.includes("포맷") || nameLower.includes("템플릿")) {
    return true;
  }
  for (const sheet of file.sheets) {
    if (sheet.rows.length > 2) return false;
  }
  return true;
}

function normalizeFormsSheet(args: {
  file: DriveSatisfactionFile;
  sheet: { title: string; rows: string[][] };
  metadata: FileNameMetadata;
}): SatisfactionImportItemInput | null {
  const { file, sheet, metadata } = args;
  const headerRow = sheet.rows[0];
  if (!headerRow || headerRow.length < 2) return null;

  const scoreColIndex = findSatisfactionColumnIndex(headerRow);
  if (scoreColIndex === -1) return null;

  const scores: number[] = [];
  let earliestDate: Date | null = null;
  let latestDate: Date | null = null;

  for (let i = 1; i < sheet.rows.length; i += 1) {
    const row = sheet.rows[i];
    if (!row) continue;

    const scoreRaw = row[scoreColIndex]?.trim() ?? "";
    const parsed = Number(scoreRaw);
    if (!Number.isFinite(parsed) || parsed < 1) continue;
    scores.push(parsed);

    const ts = parseTimestamp(row[0]);
    if (ts) {
      if (!earliestDate || ts < earliestDate) earliestDate = ts;
      if (!latestDate || ts > latestDate) latestDate = ts;
    }
  }

  if (scores.length === 0) return null;

  const scale = detectScale(scores);
  if (!scale) return null;

  const normalizedScores = scores.map((s) => normalizeScore(s, scale));
  const avgScore =
    Math.round(
      (normalizedScores.reduce((a, b) => a + b, 0) / normalizedScores.length) *
        100
    ) / 100;

  if (avgScore < 1 || avgScore > 5) return null;

  const responseDate = earliestDate ?? latestDate;
  const responseDateStr = responseDate
    ? responseDate.toISOString().slice(0, 10)
    : null;

  const registryKey = buildDriveRegistryKey({
    fileId: file.fileId,
    sheetTitle: sheet.title,
    companyName: metadata.companyName,
    courseName: metadata.courseName,
    dateStr: responseDateStr,
  });

  return {
    sourceType: "drive_satisfaction",
    sourceRefKey: `drive:${file.fileId}:${sheet.title}`,
    sourceRef: {
      file_id: file.fileId,
      file_name: file.fileName,
      sheet_title: sheet.title,
      created_time: file.createdTime,
    },
    rawPayload: {
      file_name: file.fileName,
      sheet_title: sheet.title,
      score_column_header: headerRow[scoreColIndex],
      score_column_index: scoreColIndex,
      detected_scale: scale,
      raw_scores: scores,
      respondent_count: scores.length,
      file_created_time: file.createdTime,
      file_modified_time: file.modifiedTime,
    },
    normalizedPayload: {
      registry_key: registryKey,
      score_normalized: avgScore,
      candidate_name: null,
      company_name: metadata.companyName,
      course_name: metadata.courseName,
      response_date: responseDateStr,
      respondent_count: scores.length,
    },
    candidateName: null,
    candidateCompanyName: metadata.companyName,
    candidateCourseName: metadata.courseName,
    scoreRaw: `${avgScore}/${scale} (avg of ${scores.length})`,
    scoreNormalized: avgScore,
    respondentCount: scores.length,
    responseDate,
  };
}

function normalizeFile(
  file: DriveSatisfactionFile
): SatisfactionImportItemInput[] {
  if (isTemplateOrEmpty(file)) return [];

  const metadata = parseFileName(file.fileName);
  const items: SatisfactionImportItemInput[] = [];

  for (const sheet of file.sheets) {
    if (!sheet.rows[0] || sheet.rows.length < 2) continue;

    if (isFormsResponseSheet(sheet.rows[0])) {
      const item = normalizeFormsSheet({ file, sheet, metadata });
      if (item) items.push(item);
    }
  }

  return items;
}

interface TeachingHistoryRow {
  instructorDbId: string;
  companyName: string | null;
  courseName: string | null;
}

function normalizeForMatch(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[_\-·]/g, "");
}

function getCompanySearchKeys(companyName: string): string[] {
  const norm = normalizeForMatch(companyName);
  const keys = [norm];
  const aliases = COMPANY_ALIASES[companyName];
  if (aliases) {
    for (const alias of aliases) {
      keys.push(normalizeForMatch(alias));
    }
  }
  return keys;
}

function resolveInstructorByTeachingHistory(args: {
  companyName: string | null;
  courseName: string | null;
  instructorNameHint: string | null;
  instructorByName: Map<string, string>;
  historyByCompany: Map<string, TeachingHistoryRow[]>;
}): { instructorId: string; basis: string } | null {
  const { companyName, courseName, instructorNameHint, instructorByName, historyByCompany } = args;

  if (instructorNameHint) {
    const instructorId = instructorByName.get(instructorNameHint);
    if (instructorId) {
      return { instructorId, basis: "filename_instructor_name" };
    }
  }

  if (!companyName) return null;

  const searchKeys = getCompanySearchKeys(companyName);
  const matchedHistories: TeachingHistoryRow[] = [];

  for (const [key, rows] of historyByCompany) {
    for (const searchKey of searchKeys) {
      if (key === searchKey || key.includes(searchKey) || searchKey.includes(key)) {
        matchedHistories.push(...rows);
        break;
      }
    }
  }

  if (matchedHistories.length === 0) return null;

  if (courseName) {
    const normCourse = normalizeForMatch(courseName);
    const courseMatched = matchedHistories.filter((h) => {
      const normH = normalizeForMatch(h.courseName);
      return normH.includes(normCourse) || normCourse.includes(normH);
    });

    if (courseMatched.length > 0) {
      const uniqueIds = new Set(courseMatched.map((h) => h.instructorDbId));
      if (uniqueIds.size === 1) {
        return {
          instructorId: courseMatched[0].instructorDbId,
          basis: "teaching_history_company_course",
        };
      }
      return null;
    }
  }

  const uniqueIds = new Set(matchedHistories.map((h) => h.instructorDbId));
  if (uniqueIds.size === 1) {
    return {
      instructorId: matchedHistories[0].instructorDbId,
      basis: "teaching_history_company_only",
    };
  }

  return null;
}

export async function normalizeSatisfactionDriveResults(
  result: DriveSatisfactionCollectResult
): Promise<{
  items: SatisfactionImportItemInput[];
  sourceSummary: SatisfactionSourceSummary;
}> {
  const allItems: SatisfactionImportItemInput[] = [];
  let skippedFiles = 0;

  for (const file of result.files) {
    const items = normalizeFile(file);
    if (items.length === 0) {
      skippedFiles += 1;
      continue;
    }
    allItems.push(...items);
  }

  const [teachingHistories, instructors] = await Promise.all([
    prisma.teachingHistory.findMany({
      where: { companyName: { not: null } },
      select: {
        instructorDbId: true,
        companyName: true,
        courseName: true,
      },
    }),
    prisma.instructor.findMany({
      select: { id: true, name: true },
    }),
  ]);

  const instructorByName = new Map<string, string>();
  for (const inst of instructors) {
    if (!instructorByName.has(inst.name)) {
      instructorByName.set(inst.name, inst.id);
    }
  }

  const historyByCompany = new Map<string, TeachingHistoryRow[]>();
  for (const row of teachingHistories) {
    const key = normalizeForMatch(row.companyName);
    if (!key) continue;
    const list = historyByCompany.get(key) ?? [];
    list.push(row);
    historyByCompany.set(key, list);
  }

  let autoAcceptedCount = 0;
  for (const item of allItems) {
    const rawPayload = item.rawPayload as Record<string, unknown> | undefined;
    const fileNameForHint = (rawPayload?.file_name as string) ?? "";
    const hintMeta = parseFileName(fileNameForHint);

    const match = resolveInstructorByTeachingHistory({
      companyName: item.candidateCompanyName ?? null,
      courseName: item.candidateCourseName ?? null,
      instructorNameHint: hintMeta.instructorNameHint,
      instructorByName,
      historyByCompany,
    });

    if (match) {
      const payload = item.normalizedPayload as Record<string, unknown>;
      payload.suggested_instructor_id = match.instructorId;
      payload.resolution_basis = match.basis;
      autoAcceptedCount += 1;
    }
  }

  const pendingCount = allItems.length - autoAcceptedCount;

  return {
    items: allItems,
    sourceSummary: {
      sourceKey: result.sourceKey,
      sourceType: "drive_satisfaction",
      fetchedRows: result.files.reduce(
        (sum, f) =>
          sum + f.sheets.reduce((s, sh) => s + sh.rows.length, 0),
        0
      ),
      importedItems: allItems.length,
      skippedRows: skippedFiles,
      autoAcceptedCandidates: autoAcceptedCount,
      pendingCandidates: pendingCount,
      status:
        allItems.length > 0
          ? "success"
          : result.files.length > 0
            ? "partial"
            : "skipped",
      note: `${result.files.length} files processed, ${allItems.length} items extracted, ${autoAcceptedCount} auto-matched, ${skippedFiles} skipped`,
    },
  };
}
