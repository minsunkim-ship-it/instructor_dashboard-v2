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

// v23 Drive: 회사명/과정명 검증 가드 (gmail-normalizer와 동일 정책)
const DRIVE_COMPANY_BLOCKLIST = new Set<string>([
  "AI", "DX", "AX", "ML", "DL", "BI", "RPA", "OT", "IT", "HR", "PB", "MX",
  "데이터", "Data", "BIZ", "Biz",
  "기획", "영업", "인사", "R&D",
  "교육", "과정", "강의", "전문가", "양성", "기초", "심화",
  "25년", "25년도", "26년", "26년도", "올해", "내년", "작년",
  "1월", "2월", "3월", "4월", "5월", "6월", "7월", "8월", "9월", "10월", "11월", "12월",
  "기업", "법인", "직원", "수강생", "참여자", "사원",
  "학원", "센터", "본부", "팀",
  "패스트캠퍼스", "패스트", "Day1", "day1", "fastcampus", "FastCampus",
  // Drive 특수: course type이 회사로 잘못 들어가는 케이스
  "UXUI", "디자인씽킹", "DesignThinking", "프로덕트", "Product",
  "비즈니스매너", "비즈니스",
  // 연도만 (companyName 자리에 절대 안 옴)
  "2024", "2025", "2026", "2027",
]);
const DRIVE_KNOWN_SHORT_COMPANIES = new Set([
  "KT", "CJ", "LG", "SK", "GS", "BC", "DB", "LS", "HL", "MG", "KB", "NH", "JB", "DK", "DL", "MS", "TS", "BH", "EM",
]);

function isLikelyDriveCompanyName(value: string | null | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (trimmed.length < 2) return false;
  if (DRIVE_COMPANY_BLOCKLIST.has(trimmed)) return false;
  if (/^[A-Za-z]{2,3}$/.test(trimmed) && !DRIVE_KNOWN_SHORT_COMPANIES.has(trimmed.toUpperCase())) return false;
  // 숫자만 / 숫자 시작 (예: "2026", "25년")
  if (/^[\d]+/.test(trimmed)) return false;
  // 한국어 시간/상태 어구 시작
  if (/^(지난|오늘|어제|작일|금일|이번주|작년|올해|내년)/.test(trimmed)) return false;
  return true;
}

function isLikelyDriveCourseName(value: string | null | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (trimmed.length < 3) return false;
  // course가 차수/일차 표기만 남은 경우 (예: "1일차", "3차수")
  if (/^\d+\s*(일차|차수|회차|기)$/.test(trimmed)) return false;
  // "9월_토지인허가" 같은 월별 표기 시작
  if (/^\d{1,2}\s*월[_\s]/.test(trimmed)) return false;
  return true;
}

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

  let courseName: string | null = name || null;

  // v23 Drive: 추출 결과 검증
  // 1. companyName이 비정상이면 null로 (UXUI/디자인씽킹/2026/AI 등)
  if (companyName && !isLikelyDriveCompanyName(companyName)) {
    companyName = null;
  }
  // 2. courseName이 차수/일차만 남거나 비정상이면 null로
  if (courseName && !isLikelyDriveCourseName(courseName)) {
    courseName = null;
  }

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

// v23 Drive: 강사 만족도 column 우선 매칭 패턴 (강사 평가가 진짜 가치)
const INSTRUCTOR_SATISFACTION_PATTERNS = [
  /강사.*만족도/,
  /강사.*만족하/,
  /강의.*강사.*만족/,
  /강사.*강의.*만족/,
];

const OVERALL_SATISFACTION_PATTERNS = [
  /전체\s*만족도/,
  /전반적인?\s*(강의\s*)?만족도/,
  /전반적인?\s*(세미나\s*)?만족도/,
  /전반적으로\s*만족/,
  /^1\.\s*(강의\s*)?만족도\s*평가$/,
  /^강의\s*만족도\s*평가$/,
  /^만족도\s*평가$/,
];

// v23 Drive: "만족" 어휘 변형 모두 포함 (만족도/만족하/만족스/만족합)
const SATISFACTION_KEYWORD = /만족(도|하|스|합)/;

const SUB_CATEGORY_MARKERS =
  /\[커리큘럼\]|\[인사이트\]|\[이론.*실습\]|\[현업적용\]|\[교수법\]|\[추천지수\]|난이도|속도|추천/;

function findSatisfactionColumnIndex(headerRow: string[]): number {
  // 우선순위 1: 강사 만족도 (가장 가치 있는 신호)
  for (const pattern of INSTRUCTOR_SATISFACTION_PATTERNS) {
    for (let i = 0; i < headerRow.length; i += 1) {
      if (pattern.test(headerRow[i]?.trim() ?? "")) return i;
    }
  }
  // 우선순위 2: 전체 만족도
  for (const pattern of OVERALL_SATISFACTION_PATTERNS) {
    for (let i = 0; i < headerRow.length; i += 1) {
      if (pattern.test(headerRow[i]?.trim() ?? "")) return i;
    }
  }
  // 우선순위 3: 만족(도|하|스|합) 어휘 (sub-category 제외)
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
  // 기본: 타임스탬프 시작
  if (/타임스탬프|Timestamp/i.test(first)) return true;
  // v23 Drive: Forms 응답 외 형식도 만족도 sheet 인식
  // - 첫 컬럼이 "1-1." / "1." / "Q1" 등 객관식 응답 번호
  // - 또는 헤더 전체에 "만족도" / "강사 만족도" / "교육 만족도" 같은 키워드 포함
  if (/^([Q]?\d+[-.]\d+|\d+\.)/i.test(first)) {
    const headerText = headerRow.join(" ");
    if (/(만족|강사|교육 평가|평가|점수)/i.test(headerText)) return true;
  }
  // v24-7 Drive: MS Forms 응답시트 (Id, 시작 시간, 완료 시간, 전자 메일, 이름, ...)
  // 첫 컬럼 "Id" + 헤더 전체에 "시작 시간"/"완료 시간"/"Start time"/"Completion time" + 만족 키워드
  // (v24-9: "만족하십니까?" 같은 어구 매칭 위해 "만족도" → "만족")
  if (/^id$/i.test(first)) {
    const headerText = headerRow.join(" ");
    const hasFormsMarker = /(시작\s*시간|완료\s*시간|Start\s*time|Completion\s*time)/i.test(headerText);
    const hasSatisfaction = /(만족|강사|교육 평가|평가|점수)/i.test(headerText);
    if (hasFormsMarker && hasSatisfaction) return true;
  }
  return false;
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

function findTimestampColumnIndex(headerRow: string[]): number {
  // 타임스탬프 / Timestamp / 시작 시간 / Start time / 완료 시간
  for (let i = 0; i < headerRow.length; i += 1) {
    const cell = headerRow[i]?.trim() ?? "";
    if (/(타임스탬프|Timestamp|시작\s*시간|Start\s*time|완료\s*시간|Completion\s*time)/i.test(cell)) {
      return i;
    }
  }
  return 0;
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

  const timestampColIndex = findTimestampColumnIndex(headerRow);

  const scores: number[] = [];
  let earliestDate: Date | null = null;
  let latestDate: Date | null = null;

  for (let i = 1; i < sheet.rows.length; i += 1) {
    const row = sheet.rows[i];
    if (!row) continue;

    const scoreRaw = row[scoreColIndex]?.trim() ?? "";
    // v23 Drive: "5. 만족", "4. 조금 그렇다." 같은 객관식 응답 형식에서 첫 숫자 추출
    // 기존: Number(scoreRaw) → "5. 만족" NaN으로 skip → 모든 응답 누락
    let parsed = Number(scoreRaw);
    if (!Number.isFinite(parsed)) {
      const m = scoreRaw.match(/^(\d+(?:\.\d+)?)/);
      if (m) parsed = Number(m[1]);
    }
    // v24-12 Drive: MS Forms Likert text 응답 매핑 (매우만족/만족/보통/불만족/매우불만족)
    if (!Number.isFinite(parsed)) {
      const cleaned = scoreRaw.replace(/\s+/g, "");
      const likertMap: Record<string, number> = {
        "매우만족": 5, "매우만족함": 5, "매우만족합니다": 5, "아주만족": 5, "매우그렇다": 5,
        "만족": 4, "만족함": 4, "만족합니다": 4, "조금만족": 4, "대체로만족": 4, "그렇다": 4,
        "보통": 3, "보통이다": 3, "보통입니다": 3, "그저그렇다": 3,
        "불만족": 2, "조금불만족": 2, "불만족함": 2, "아니다": 2, "조금아니다": 2,
        "매우불만족": 1, "매우아니다": 1, "전혀만족하지않음": 1, "전혀아니다": 1,
      };
      if (likertMap[cleaned] !== undefined) parsed = likertMap[cleaned];
    }
    if (!Number.isFinite(parsed) || parsed < 1) continue;
    scores.push(parsed);

    const ts = parseTimestamp(row[timestampColIndex]);
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
