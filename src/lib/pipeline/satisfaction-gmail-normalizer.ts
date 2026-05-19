import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { exchangeGoogleUserAccessToken, googleApiGet } from "@/lib/google-user-oauth";
import type { SatisfactionImportItemInput } from "@/lib/pipeline/satisfaction-applier";
import { normalizeFeedbackNotesInImportItems } from "@/lib/pipeline/feedback-note-llm";
import type { SatisfactionGmailCollectResult, SatisfactionGmailThread } from "@/lib/pipeline/satisfaction-gmail-collector";
import type { SatisfactionSourceSummary } from "@/lib/pipeline/satisfaction-sheets-normalizer";

const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
const SHEETS_API_BASE = "https://sheets.googleapis.com/v4";
const DRIVE_API_TIMEOUT_MS = 5_000;
const SHEETS_API_TIMEOUT_MS = 5_000;
const GMAIL_SATISFACTION_NORMALIZE_CONCURRENCY = 4;
const driveResolutionCache = new Map<string, InstructorResolutionResult | null>();
const driveEvidenceCache = new Map<string, DriveSheetResolutionResult>();
const DRIVE_FEEDBACK_QUERY_TERMS = [
  "좋았던 점",
  "아쉬운 점",
  "운영진 의견",
  "운영 의견",
  "주관식 주요 의견",
  "개선 요청",
] as const;

const DRIVE_SHEET_EVIDENCE_SIGNAL_KEYWORDS = [
  "좋",
  "아쉽",
  "유익",
  "도움",
  "어려",
  "빠르",
  "느리",
  "개선",
  "요청",
  "필요",
  "문제",
  "이슈",
  "지연",
  "불편",
  "만족",
  "확인",
  "변경",
  "완료",
  "계정",
  "운영",
  "수강생",
  "강사",
  "실습",
  "적용",
  "인사이트",
  "피드백",
  "트러블",
  "결석",
  "지각",
  "출석",
  "불참",
  "긍정",
  "부정",
] as const;

interface InstructorLookupMaps {
  byName: Map<string, { id: string; name: string; contactEmail: string | null }>;
  byEmail: Map<string, { id: string; name: string; contactEmail: string | null }>;
}

interface ParsedMailbox {
  name: string | null;
  email: string | null;
}

interface DraftGmailSatisfactionEvent {
  sourceRefKey: string;
  sourceRef: Record<string, unknown>;
  rawPayload: Record<string, unknown>;
  normalizedPayload: Record<string, unknown>;
  candidateName?: string | null;
  candidateCompanyName?: string | null;
  candidateCourseName?: string | null;
  scoreRaw?: string | null;
  scoreNormalized?: number | null;
  respondentCount?: number | null;
  responseDate?: Date | string | null;
}

interface GmailInferenceContext {
  accountEmail: string;
  instructorHint: string | null;
  companyHint: string | null;
  suggestedInstructorId: string | null;
  resolutionBasis: string | null;
  driveSheetNotes?: DriveSheetEvidenceNote[];
}

interface DriveSheetEvidenceNote {
  tab: string;
  row_index: number;
  note_type: "teaching_feedback_qualitative" | "teaching_feedback_ops";
  text: string;
}

interface InstructorResolutionResult {
  instructorHint: string;
  suggestedInstructorId: string;
  resolutionBasis: string;
  driveSheetNotes?: DriveSheetEvidenceNote[];
}

interface DriveSheetResolutionResult {
  resolved: InstructorResolutionResult | null;
  driveSheetNotes: DriveSheetEvidenceNote[];
}

export interface SkippedGmailThreadSample {
  threadId: string;
  subject: string | null;
  sentAt: string | null;
  reason: string;
  snippet: string | null;
  bodyExcerpt: string | null;
}

function cleanText(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/\r/g, "")
    .replace(/\*/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * body_excerpt(1200자)에 가려진 본문/제목의 모든 URL을 raw_payload에 보존한다.
 * body_excerpt 자체는 LLM input(feedback-note-llm)에 그대로 쓰이므로 길이를 늘리지 않는다.
 * 대신 link 추출용 별개 키 `extracted_urls`로 분리해서 비용 영향 없이 catalog 자동 발견,
 * forms.gle resolver 등 후속 단계가 활용할 수 있게 한다.
 */
function extractAllUrlsFromText(...sources: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  for (const text of sources) {
    if (!text) continue;
    const matches = text.match(/https?:\/\/[^\s<>"'\)\]]+/g);
    if (!matches) continue;
    for (const url of matches) {
      // trailing punctuation 정리 (한국어 메일에서 흔히 ".", "," 가 link 끝에 붙음)
      const cleaned = url.replace(/[.,;:!?)]+$/, "");
      if (cleaned) seen.add(cleaned);
    }
  }
  return Array.from(seen);
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];

  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (true) {
        const current = nextIndex++;
        if (current >= items.length) return;
        results[current] = await worker(items[current], current);
      }
    })
  );

  return results;
}

function isDriveSheetSkippableLine(value: string): boolean {
  const cleaned = cleanText(value);
  if (cleaned.length < 4) return true;
  if (
    /^(강의관리|강의요약|과정 정리|교육 개요|운영|캘린더|교육 운영\/방식 관련|교육 내용 관련|좋았던 점|아쉬운 점|운영진 의견|운영 의견|주관식 주요 의견)$/i.test(
      cleaned
    )
  ) {
    return true;
  }
  if (
    /(과정명|교육 형태|교육 일정|교육 장소|교육 대상|관련 자료|과정 폴더|강의교안|커리큘럼|강의사진|만족도 조사|기업 담당자|FC 담당자|강사님|연락처|이메일|교육 과정 개요|과정 개요|운영 캘린더|강의 캘린더|마감일 캘린더|집합교육 안내|온라인 입과|고용보험 환급 서류)/.test(
      cleaned
    )
  ) {
    return true;
  }
  if (
    /(^|\/ )(?:(회차|날짜|강의 요약|교육일정|과정정보|수료기준|강의 정보|강의장 세팅|체크리스트))(\/|$)/.test(
      cleaned
    )
  ) {
    return true;
  }
  if (/\d{1,2}:\d{2}\s*~\s*\d{1,2}:\d{2}/.test(cleaned)) return true;
  if ((cleaned.match(/\//g) ?? []).length >= 8) return true;
  if (/^[0-9./:()\s|-]+$/.test(cleaned)) return true;
  return false;
}

function isDriveSheetMetaBreakLine(value: string): boolean {
  const cleaned = cleanText(value);
  return (
    /(^|\/ )(?:(회차|날짜|강의 요약|교육일정|과정정보|수료기준|No|Time|타임라인))(\/|$)/.test(
      cleaned
    ) ||
    cleaned.includes("강의관리시트") ||
    cleaned.includes("강의관리 시트") ||
    /^(20\d{2}\s*[가-힣A-Za-z]+(?:\s*\/\s*20\d{2}\s*[가-힣A-Za-z]+)*)$/.test(cleaned) ||
    /^(Phase\d|OT\b|\d+\s*\/\s*\d{2}:\d{2})/.test(cleaned)
  );
}

const DRIVE_SHEET_SECTION_LABELS = [
  "운영진 의견",
  "운영 의견",
  "이슈 내용",
  "좋았던 점",
  "아쉬운 점",
  "개선 요청",
  "개선이 필요한 점",
  "주관식 주요 의견",
  "가장 기억에 남는 학습 내용",
  "강사님께 전달",
  "수강생 의견",
  "교육생 의견",
  "피드백",
] as const;

function isDriveSheetSectionLabel(value: string): boolean {
  return DRIVE_SHEET_SECTION_LABELS.some((label) => value.includes(label));
}

function sanitizeDriveSheetEvidenceText(text: string): string | null {
  const cleaned = cleanText(text)
    .replace(/^[/|-]+\s*/, "")
    .replace(/\s*[/|-]+\s*$/, "")
    .trim();
  if (!cleaned) return null;
  if (isDriveSheetSkippableLine(cleaned)) return null;
  if (
    /^(회차|날짜|강의 요약|교육일정|과정정보|수료기준|No|Time|타임라인)(?:$|\s|\/)/.test(
      cleaned
    )
  ) {
    return null;
  }
  if (/(?:^|\/ )(?:TRUE|FALSE)(?:$|\/ )/.test(cleaned)) return null;
  if (/강사는 .*[\?？]\s*\/\s*(?:TRUE|FALSE)/.test(cleaned)) return null;
  if (/출석 사항에 특이 사항이 있나요\?/.test(cleaned)) return null;
  if ((cleaned.match(/\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}/g) ?? []).length >= 2) {
    return null;
  }
  if (/^(20\d{2}\s*[가-힣A-Za-z]+)/.test(cleaned) && cleaned.length < 20) {
    return null;
  }
  if (cleaned.length < 8) {
    return null;
  }
  const hasSignalKeyword = DRIVE_SHEET_EVIDENCE_SIGNAL_KEYWORDS.some((keyword) =>
    cleaned.includes(keyword)
  );
  const looksLikeSentence =
    /[.!?]/.test(cleaned) ||
    /(습니다|했습니다|였습|좋았|아쉬|됩니다|보입니다|느껴|같습니다|확인되었습니다|부탁드립니다|했습니다|드렸습니다|있었습니다)/.test(
      cleaned
    );
  if (!hasSignalKeyword && !looksLikeSentence) {
    return null;
  }
  return cleaned;
}

function extractDriveSheetEvidenceNotes(args: {
  tab: string;
  rows: string[][];
}): DriveSheetEvidenceNote[] {
  const notes: DriveSheetEvidenceNote[] = [];
  let section: "teaching_feedback_qualitative" | "teaching_feedback_ops" | null =
    null;

  for (let index = 0; index < args.rows.length; index += 1) {
    const row = args.rows[index] ?? [];
    const cells = row
      .map((cell) => cleanText(cell))
      .filter((cell) => cell.length > 0);
    const rowText = cleanText(cells.join(" / "));
    if (!rowText) continue;

    if (isDriveSheetMetaBreakLine(rowText)) {
      section = null;
      continue;
    }

    const headingIndex = cells.findIndex((cell) => isDriveSheetSectionLabel(cell));
    if (headingIndex !== -1) {
      const heading = cells[headingIndex]!;
      if (/(운영진 의견|운영 의견|이슈 내용)/i.test(heading)) {
        section = "teaching_feedback_ops";
      } else {
        section = "teaching_feedback_qualitative";
      }

      const payload = sanitizeDriveSheetEvidenceText(
        cells.slice(headingIndex + 1).join(" / ")
      );
      if (payload) {
        notes.push({
          tab: args.tab,
          row_index: index + 1,
          note_type: section,
          text: payload,
        });
      }
      continue;
    }

    if (isDriveSheetSkippableLine(rowText)) continue;
    if (!section) continue;

    const payload = sanitizeDriveSheetEvidenceText(rowText);
    if (!payload) continue;

    notes.push({
      tab: args.tab,
      row_index: index + 1,
      note_type: section,
      text: payload,
    });
  }

  return notes;
}

function encodeKeyPart(value: string | null | undefined): string {
  if (!value) return "";
  return encodeURIComponent(value.trim().toLowerCase());
}

export function buildGmailRegistryKey(args: {
  sourceFamily: string;
  companyName?: string | null;
  courseName: string;
  sessionOrDate: string;
  instructorName?: string | null;
}): string {
  const normalized = [
    "satisfaction",
    encodeKeyPart(args.sourceFamily),
    encodeKeyPart(args.companyName ?? ""),
    encodeKeyPart(args.courseName),
    encodeKeyPart(args.sessionOrDate),
    encodeKeyPart(args.instructorName ?? ""),
  ].join(":");

  return `satisfaction:${encodeKeyPart(args.sourceFamily)}:${createHash("sha1")
    .update(normalized)
    .digest("hex")}`;
}

function parseNumber(value: string | null | undefined): number | null {
  if (!value) return null;
  const normalized = value.replace(/,/g, "").trim();
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDateOnly(value: string | null | undefined): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  const fullDateMatch = trimmed.match(/(\d{4})[./-]\s*(\d{1,2})[./-]\s*(\d{1,2})/);
  if (fullDateMatch) {
    const [, year, month, day] = fullDateMatch;
    return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 0, 0, 0));
  }
  return null;
}

function parseMonthDayWithYear(
  value: string | null | undefined,
  fallbackYear: number
): Date | null {
  if (!value) return null;
  const match = value.match(/(\d{1,2})\s*\/\s*(\d{1,2})/);
  if (!match) return null;
  const [, month, day] = match;
  return new Date(Date.UTC(fallbackYear, Number(month) - 1, Number(day), 0, 0, 0));
}

function toDateOnlyString(value: Date | string | null | undefined): string | null {
  const date = value instanceof Date ? value : parseDateOnly(value ?? null);
  return date ? date.toISOString().slice(0, 10) : null;
}

function parseMailboxHeader(value: string | null | undefined): ParsedMailbox[] {
  const text = value ?? "";
  const results: ParsedMailbox[] = [];
  const matchedEmails = new Set<string>();
  const angleRegex = /"?([^"<]*)"?\s*<([^>]+)>/g;
  let match: RegExpExecArray | null;
  while ((match = angleRegex.exec(text)) !== null) {
    const name = match[1]?.trim() || null;
    const email = match[2]?.trim().toLowerCase() || null;
    if (email) matchedEmails.add(email);
    results.push({ name, email });
  }

  const emailRegex = /([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/gi;
  while ((match = emailRegex.exec(text)) !== null) {
    const email = match[1]?.trim().toLowerCase() || null;
    if (!email || matchedEmails.has(email)) continue;
    results.push({ name: null, email });
  }

  return results;
}

function parseInstructorHintFromSubject(subject: string | null | undefined): string | null {
  const cleaned = cleanText(subject)
    .replace(/^re:\s*/i, "")
    .replace(/^\[[^\]]+\]\s*/, "");
  const match = cleaned.match(/([^-]+?)\s*강사님께\s*-/);
  const hint = match?.[1]?.trim() ?? null;
  return hint ? hint.replace(/\s+/g, "") : null;
}

function parseCompanyHintFromSubject(subject: string | null | undefined): string | null {
  const cleaned = cleanText(subject);
  if (!cleaned) return null;
  // 구조: "[패스트캠퍼스/회사명] ..." — slash 뒤 회사
  const bracketMatch = cleaned.match(/^\[[^/\]]+\/([^\]]+)\]/);
  if (bracketMatch?.[1]) return bracketMatch[1].trim();

  // "[패스트캠퍼스] 회사명 - 본문" or "[패스트캠퍼스] 강사X 강사님께 - ..."
  const bracketDashMatch = cleaned.match(/^\[[^\]]+\]\s*([^-\n]{2,30}?)\s*-/);
  if (bracketDashMatch?.[1] && !bracketDashMatch[1].includes("님께") && !bracketDashMatch[1].includes("강사")) {
    return bracketDashMatch[1].trim();
  }

  // v23 A3 (개선 v2): "[패스트캠퍼스] X 강사님께 - 회사명 ..." → dash **뒤** 회사
  // 송선영: "송선영 강사님께 - 세방전지 강의..." → 세방전지
  // 변형호: "변형호 강사님께 - 신한금융지주 AI Agent 실전역량 과정..." → 신한금융지주
  // 유종훈: "유종훈 대표님께 - 삼성물산(생성형 AI 기초) 과정..." → 삼성물산
  // 이한준: "이한준 강사님께 - 피에스텍 25년 직무 통합 교육 과정..." → 피에스텍
  // 김건태: "김건태 과장님께 - KT - RAG 기법 이해 및 실전 적용 과정..." → KT
  const COURSE_KEYWORD = "(?:강의|교육|과정|연수|워크숍|특강|수업|클래스|아카데미|커리큘럼)";

  // 우선순위 1: dash + 짧은 회사명(2-4자) + 다시 dash (KT, BC, CJ 케이스)
  // "김건태 과장님께 - KT - RAG..." → KT
  const shortNameDashMatch = cleaned.match(/[-–]\s*([가-힣A-Za-z0-9]{2,4})\s*[-–]/);
  if (shortNameDashMatch?.[1]) {
    const c = shortNameDashMatch[1].trim();
    if (!/(패스트캠퍼스|Day1|day1|fastcampus)/i.test(c) && c.length >= 2) {
      return c;
    }
  }

  // 우선순위 2: dash + 회사명(괄호 제외 2-12자) + 옵셔널 괄호부연 + buffer + course keyword
  // 송선영: "- 세방전지 강의..." → 세방전지
  // 변형호: "- 신한금융지주 AI Agent 실전역량 과정..." → 신한금융지주
  // 유종훈: "- 삼성물산(생성형 AI 기초) 과정..." → 삼성물산 (괄호 부연 제외)
  // 이한준: "- 피에스텍 25년 직무 통합 교육..." → 피에스텍
  const afterDashWithBufferMatch = cleaned.match(
    new RegExp(
      `[-–]\\s*([가-힣A-Za-z0-9]{2,12})(?:\\s*\\([^)]+\\))?[\\s가-힣A-Za-z0-9()_./,]{0,50}?${COURSE_KEYWORD}`
    )
  );
  if (afterDashWithBufferMatch?.[1]) {
    const c = afterDashWithBufferMatch[1].trim();
    if (!/(패스트캠퍼스|Day1|day1|fastcampus)/i.test(c) && c.length >= 2) {
      return c;
    }
  }

  // v23 A3: "회사명 - 본문" (대괄호 없이 회사명으로 시작)
  const directDashMatch = cleaned.match(/^([가-힣A-Za-z0-9()]{2,30})\s*[-–_]\s*/);
  if (directDashMatch?.[1] && !directDashMatch[1].includes("강사") && !directDashMatch[1].includes("님께")) {
    return directDashMatch[1].trim();
  }

  // "본문 - 회사명_..." 패턴
  const underscoreMatch = cleaned.match(/-\s*([^_]+)_/);
  if (underscoreMatch?.[1]) return underscoreMatch[1].trim();

  // v23 A3: "[회사명] ..." — slash 없이 단일 회사명만 (예: "[BC카드] 만족도 결과 ...")
  const singleBracket = cleaned.match(/^\[([가-힣A-Za-z0-9()]{2,30})\]\s/);
  if (singleBracket?.[1] && !/(패스트캠퍼스|day1|Day1)/i.test(singleBracket[1])) {
    return singleBracket[1].trim();
  }

  return null;
}

// v23 A2: 한국어 시간/상태 어구가 첫 토큰에 등장하면 회사명 추출 거부
// 결함 사례: "지난 주 19-20일 진행해주신 [세방전지...]" → "지난 주 19" 회사명으로 추출 → 잘못
//          "8월 5~7일 진행하였던, [삼성물산..." → "8월 5~7일 진행하였던, [삼성물산" 회사명
//          "08/16(토)에 진행하셨던 [신한금융지주회사..." → "08/16(토)에 진행하셨던 [ 신한금융지주회사"
function looksLikeKoreanPhrasePrefix(value: string): boolean {
  // 한국어 시간/상태/접속 어구 (회사명으로는 안 등장)
  if (/(지난|오늘|어제|작일|금일|이번주|이번\s*주|작년|올해|내년)/.test(value)) return true;
  // "진행한/진행된/진행하/진행해주신/진행하였던/진행됐던/진행됬던" — 메일 본문 시작 어구
  if (/(진행한|진행된|진행하|진행해주신|진행하였|진행됐|진행됬|보내|드립니다|드린|작성해|말씀|확인)/.test(value)) return true;
  // 날짜 패턴 시작 (X월 X일 / X/X / YYYY-MM-DD / MM/DD(요일))
  if (/^\d{1,4}\s*[월\/\-.]\s*\d{1,2}/.test(value)) return true;
  if (/^\d{1,2}\s*월\s*\d{1,2}\s*일/.test(value)) return true;
  // tilde 또는 끝이 숫자/공백 (예: "지난 주 19", "8월 5~7일")
  if (/[~]/.test(value)) return true;
  if (/^[\s\d~월일\/\-.,()]+$/.test(value)) return true;
  // 첫 글자 비정형 (대괄호·괄호·공백 시작)
  if (/^[\s\[\(]/.test(value)) return true;
  return false;
}

function parseCompanyHintFromCourseName(courseName: string | null | undefined): string | null {
  const cleaned = cleanText(courseName);
  if (!cleaned) return null;
  if (
    /(님께|요청드립니다|요청 드립니다|정산|안내|세금계산서|결과 전달|결과 공유|리마인드|발행 정보)/i.test(
      cleaned
    )
  ) {
    return null;
  }
  // v23 A2: 한국어 어구로 시작하는 courseName 거부 (시간/날짜/메일본문 첫 줄)
  if (looksLikeKoreanPhrasePrefix(cleaned)) return null;

  const dashMatch = cleaned.match(/^([^-\n]{2,30}?)\s*-\s*/);
  if (dashMatch?.[1]) {
    const candidate = dashMatch[1].trim();
    // 추출 결과도 비정형이면 거부
    if (looksLikeKoreanPhrasePrefix(candidate)) return null;
    return candidate;
  }

  const underscoreMatch = cleaned.match(/^([^_\n]{2,30}?)_/);
  if (underscoreMatch?.[1]) {
    const candidate = underscoreMatch[1].trim();
    if (looksLikeKoreanPhrasePrefix(candidate)) return null;
    return candidate;
  }

  const prefixPatterns = [
    /^(JB금융지주)\b/,
    /^(CJ올리브네트웍스)\b/,
    /^(효성ITX)\b/i,
    /^(제일기획)\b/,
    /^(우리은행)\b/,
    /^(KB)\b/,
  ];
  for (const pattern of prefixPatterns) {
    const match = cleaned.match(pattern);
    if (match?.[1]) return match[1].trim();
  }

  return null;
}

function parseScoreFromText(text: string): number | null {
  // v23 A1: 10점 척도 우선 검출 + 5점 환산
  // 송선영 사례: "10점 척도 (10점 만족) 중 8점" → 8/2 = 4.0
  // 함정: "10점 척도 (10점 만족) 중 8점" — "10" 만점 표현(10점/10점) skip 필수
  //
  // 핵심: "중 X점" / "X점/10" / "총점 X" 같이 "10이 아닌 실제 점수"만 잡음.
  // 일반 "10점 척도" + 단독 10점은 거짓 매칭 위험.
  const tenScalePatterns = [
    // "중 N점" (10점 척도 컨텍스트 + "중" 뒤 실제 점수)
    /10\s*점\s*(?:척도|만점|만족)[\s\S]{0,80}?중\s*([1-9](?:\.\d+)?|10(?:\.0+)?)\s*점/i,
    // "기준 N점"
    /10\s*점\s*(?:척도|만점|만족)[\s\S]{0,80}?기준\s*([1-9](?:\.\d+)?)\s*점/i,
    // "에서 N점"
    /10\s*점\s*(?:척도|만점|만족)[\s\S]{0,80}?에서\s*([1-9](?:\.\d+)?)\s*점/i,
    // "X/10" 직접 (X는 6-10 또는 1-5; 8/10, 9.5/10)
    /(\d+(?:\.\d+)?)\s*\/\s*10\s*점?(?!\d)/,
    // "X점 / 10"
    /(\d+(?:\.\d+)?)\s*점\s*\/\s*10\s*점?/,
    // 만족도 + 10점 척도/만점 + "중 X점" (인접 strict)
    /만족도[\s\S]{0,40}?10\s*점\s*(?:척도|만점|만족)[\s\S]{0,40}?중\s*([1-9](?:\.\d+)?|10(?:\.0+)?)\s*점/i,
    // "총점 X (10점 만점)" 또는 "X점 (10점 만점)"
    /(\d+(?:\.\d+)?)\s*점\s*\(\s*10\s*점\s*(?:만점|척도)\s*\)/i,
  ];
  for (const pattern of tenScalePatterns) {
    const match = text.match(pattern);
    if (!match?.[1]) continue;
    const parsed = parseNumber(match[1]);
    if (parsed === null) continue;
    // 10점 만점 표현은 skip (false positive 차단)
    if (parsed === 10) continue;
    if (parsed > 5 && parsed < 10) {
      return Math.round((parsed / 2) * 100) / 100;
    }
    if (parsed >= 1 && parsed <= 5) {
      return Math.round((parsed / 2) * 100) / 100;
    }
  }

  const linePatterns = [
    /강의\s*만족도(?:\s*평가)?[^\d]{0,10}([1-5](?:\.\d+)?)(?:\s*\/\s*5(?:\.0)?)?/i,
    /전반적인\s*강사\s*만족도[^\d]{0,10}([1-5](?:\.\d+)?)(?:\s*\/\s*5(?:\.0)?)?/i,
    /강사\s*만족도[^\d]{0,10}([1-5](?:\.\d+)?)(?:\s*\/\s*5(?:\.0)?)?/i,
    /강의내용\s*만족도[^\d]{0,10}([1-5](?:\.\d+)?)(?:\s*\/\s*5(?:\.0)?)?/i,
    /총\s*만족도[^\d]{0,10}([1-5](?:\.\d+)?)(?:\s*\/\s*5(?:\.0)?)?/i,
    /전체\s*만족도[^\d]{0,10}([1-5](?:\.\d+)?)(?:\s*\/\s*5(?:\.0)?)?/i,
    /만족도\s*결과[^\d]{0,10}([1-5](?:\.\d+)?)(?:\s*\/\s*5(?:\.0)?)?/i,
    /(?:종합\s*평균\s*만족도|평균\s*만족도|만족도\s*평균|평균\s*점수|종합\s*만족도)[^\d]{0,10}([1-5](?:\.\d+)?)(?:\s*\/\s*5(?:\.0)?)?/i,
    /\[만족도\][^\d]{0,10}([1-5](?:\.\d+)?)(?:\s*\/\s*5(?:\.0)?)?/i,
  ];

  const candidateLines = text
    .split("\n")
    .map((row) => row.trim())
    .filter(Boolean);

  for (const line of candidateLines) {
    for (const pattern of linePatterns) {
      const match = line.match(pattern);
      if (!match?.[1]) continue;
      const parsed = parseNumber(match[1]);
      if (parsed !== null && parsed >= 1 && parsed <= 5) return parsed;
    }
  }

  const fallbackPatterns = [
    /전체 만족도(?:는)?[^\d]*(\d+(?:\.\d+)?)/,
    /총\s*만족도(?:는)?[^\d]*(\d+(?:\.\d+)?)/,
    /만족도\s*결과(?:는)?[^\d]*(\d+(?:\.\d+)?)/,
    /\[만족도\][^\d]*(\d+(?:\.\d+)?)/,
    /(?:종합\s*평균\s*만족도|평균\s*만족도|만족도\s*평균|평균\s*점수|종합\s*만족도)[\s:：\n-]*([1-5](?:\.\d+)?)/i,
    /([1-5](?:\.\d+)?)\s*\/\s*5(?:\.0)?(?=[^\n]{0,20}(?:만족도|평균))/i,
    /(?:객관식|설문\s*결과)[\s\S]{0,120}강의\s*만족도(?:\s*평가)?[^\d]{0,20}([1-5](?:\.\d+)?)/i,
    /(?:객관식|설문\s*결과)[\s\S]{0,120}강사\s*만족도[^\d]{0,20}([1-5](?:\.\d+)?)/i,
  ];
  for (const pattern of fallbackPatterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const parsed = parseNumber(match[1]);
      if (parsed !== null && parsed >= 1 && parsed <= 5) return parsed;
    }
  }
  return null;
}

function explainSkippedThread(thread: SatisfactionGmailThread): string {
  const bodyText = cleanText(thread.bodyText);
  const sectionHeaderRegex = /(?:^|\n)\s*\d+[.)]?\s*([^\n]+?)(?:\s+결과)?\s*\((\d{1,2}\s*\/\s*\d{1,2})\)/g;
  const hasSectionHeaders = sectionHeaderRegex.test(bodyText);
  const score = parseScoreFromText(bodyText);
  const courseFromBody = parseSingleCourseName(bodyText);
  const courseFromSubject = parseCourseNameFromSubject(thread.subject);

  if (hasSectionHeaders && score === null) {
    return "section headers detected but score parsing failed";
  }
  if (hasSectionHeaders && score !== null) {
    return "section headers detected but course extraction failed";
  }
  if (score === null && !courseFromBody && !courseFromSubject) {
    return "no score and no course name pattern matched";
  }
  if (score === null) {
    return "course name found but score parsing failed";
  }
  if (!courseFromBody && !courseFromSubject) {
    return "score found but course name parsing failed";
  }
  return "no gmail satisfaction event extracted";
}

function parseRespondentCountFromText(text: string): number | null {
  const patterns = [
    /응답인원[^\d]*(\d+)명/,
    /설문\s*참여인원[^\d]*(\d+)명?/i,
    /응답\s*수[^\d]*(\d+)명?/i,
    /만족도\s*인원[^\d]*(\d+)명?/i,
    /응답자\s*수[^\d]*(\d+)명?/i,
    /응답 평균\s*\(n\s*=\s*(\d+)\)/i,
    /\(n\s*=\s*(\d+)\)[^\n]{0,80}종합 평균 만족도/i,
    /n\s*=\s*(\d+)/i,
    // v23 A4: 추가 패턴
    /참여\s*인원[^\d]*(\d+)명?/i,
    /수강\s*인원[^\d]*(\d+)명?/i,
    /응답한\s*인원[^\d]*(\d+)명?/i,
    /(\d+)\s*명\s*(?:응답|참여|수강)/i,
    /총\s*응답[^\d]*(\d+)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const parsed = parseNumber(match[1]);
      if (parsed !== null) return parsed;
    }
  }
  // v23 A4: 매칭 실패 시 null (caller가 `?? 1`로 fallback 명시). 정확성 신호 보존.
  return null;
}

function parseSingleCourseName(bodyText: string): string | null {
  const cleanCourseLine = (value: string | null | undefined): string | null => {
    if (!value) return null;
    const line = cleanText(value)
      .split("\n")[0]
      .replace(/\s*>{3,}\s*/g, " ")
      .replace(
        /\s*-\s*(?:과정일시|강의일시|교육일시|응답인원|객관식|설문 결과|문항 내용|운영진 의견).*$/i,
        ""
      )
      .replace(/\s+(?:객관식|설문 결과|문항 내용|운영진 의견).*$/i, "")
      .trim();
    const cleanedCourse = cleanCourseName(line);
    if (
      cleanedCourse &&
      /^(금일|오늘|이번|금번|당일|아래|결과|만족도\s*조사|\d+\s*(?:차수|일차))$/i.test(
        cleanedCourse
      )
    ) {
      return null;
    }
    return cleanedCourse;
  };

  const introPatterns = [
    /(?:유선으로\s*요청주셨던|유선으로\s*요청주신|요청주셨던|요청주신|이번|금번|아래)\s+(.+?)\s*만족도\s*조사\s*결과\s*(?:전달|공유|보내)/i,
    /(?:유선으로\s*요청주셨던|유선으로\s*요청주신|요청주셨던|요청주신|이번|금번|아래)\s+(.+?)\s*만족도\s*결과\s*(?:전달|공유|보내)/i,
    /(.+?)\s*만족도\s*조사\s*결과\s*(?:전달|공유|보내)/i,
    /(.+?)\s*만족도\s*결과\s*(?:전달|공유|보내)/i,
  ];

  for (const line of bodyText.split("\n").map((row) => row.trim()).filter(Boolean)) {
    for (const pattern of introPatterns) {
      const match = line.match(pattern);
      if (!match?.[1]) continue;
      const lineValue = cleanCourseLine(match[1]);
      if (lineValue) return lineValue;
    }
  }

  const patterns = [
    /과정명\s*[:：]\s*(.+)/i,
    /교육명\s*[:：]\s*(.+)/i,
    /강의명\s*[:：]\s*(.+)/i,
    /과정\s*[:：]\s*(.+)/i,
  ];

  for (const pattern of patterns) {
    const match = bodyText.match(pattern);
    if (!match?.[1]) continue;
    const line = cleanCourseLine(match[1]);
    if (line) return line;
  }

  return null;
}

function parseInstructorHintFromBody(bodyText: string | null | undefined): string | null {
  const cleaned = cleanText(bodyText);
  const match =
    cleaned.match(/담당\s*강사\s*:\s*([^\n]+)/i) ??
    cleaned.match(/담당\s*강사\s*:\s*([^\n]+)/i);
  const hint = match?.[1]?.trim().replace(/강사\s*$/i, "") ?? null;
  return hint ? hint.replace(/\s+/g, "") : null;
}

function tokenizeCourseName(courseName: string | null | undefined): string[] {
  const stopwords = new Set([
    "AI",
    "ai",
    "과정",
    "워크숍",
    "교육",
    "대상",
    "활용",
    "생성형",
    "금융",
    "실습",
    "원데이",
    "기반",
    "자동화",
    "리터러시",
    "리더십",
    "차수",
    "일차",
    "특강",
    "보고서",
  ]);
  return cleanText(courseName)
    .replace(/[()[\]_,/-]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !stopwords.has(token));
}

function normalizeDateOnly(value: Date | string | null | undefined): Date | null {
  if (value instanceof Date) return value;
  return parseDateOnly(value ?? null);
}

async function resolveInstructorFromTeachingHistory(args: {
  companyName: string | null;
  courseName: string | null;
  responseDate: Date | string | null | undefined;
  lookups: InstructorLookupMaps;
}): Promise<InstructorResolutionResult | null> {
  if (!args.companyName || !args.courseName) return null;
  const responseDate = normalizeDateOnly(args.responseDate);
  const tokens = tokenizeCourseName(args.courseName).slice(0, 5);

  const histories = await prisma.teachingHistory.findMany({
    where: {
      companyName: { equals: args.companyName, mode: "insensitive" },
      ...(responseDate
        ? {
            AND: [
              { OR: [{ startDate: { lte: responseDate } }, { startDate: null }] },
              { OR: [{ endDate: { gte: responseDate } }, { endDate: null }] },
            ],
          }
        : {}),
      ...(tokens.length > 0
        ? {
            OR: tokens.map((token) => ({
              courseName: { contains: token, mode: "insensitive" },
            })),
          }
        : {}),
    },
    select: {
      instructor: { select: { id: true, name: true } },
    },
    take: 20,
  });

  const candidates = new Map<string, { id: string; name: string }>();
  for (const history of histories) {
    const name = history.instructor?.name?.trim();
    const id = history.instructor?.id;
    if (!name || !id) continue;
    candidates.set(id, { id, name });
  }
  if (candidates.size !== 1) return null;
  const only = [...candidates.values()][0];
  return {
    instructorHint: only.name,
    suggestedInstructorId: only.id,
    resolutionBasis: "teaching_history_single_instructor",
  };
}

interface DriveFile {
  id: string;
  name?: string;
  mimeType?: string;
}

export interface DriveSheetSearchInput {
  companyName: string | null;
  courseName: string | null;
  courseTokens: string[];
}

export interface DriveSheetCandidateQuery {
  label: "broad" | "feedback_narrow";
  query: string;
}

export interface DriveSheetCandidateFile {
  id: string;
  name: string | null;
  mimeType: string | null;
  sheetTitles: string[];
}

export function buildDriveSheetCandidateQueries(args: {
  companyName: string | null;
  courseName: string | null;
}): DriveSheetCandidateQuery[] {
  if (!args.companyName || !args.courseName) return [];

  const courseTokens = tokenizeCourseName(args.courseName).slice(0, 4);
  const queryParts = [
    `fullText contains "${args.companyName.replace(/"/g, '\\"')}"`,
    `(name contains "강의관리" or name contains "싱크업")`,
  ];
  if (courseTokens[0]) {
    queryParts.splice(
      1,
      0,
      `fullText contains "${courseTokens[0].replace(/"/g, '\\"')}"`
    );
  }
  const feedbackClause = `(${DRIVE_FEEDBACK_QUERY_TERMS.map(
    (term) => `fullText contains "${term}"`
  ).join(" or ")})`;

  return [
    {
      label: "broad",
      query: `${queryParts.join(" and ")} and trashed=false`,
    },
    {
      label: "feedback_narrow",
      query: `${queryParts.join(" and ")} and ${feedbackClause} and trashed=false`,
    },
  ];
}

export function deriveDriveSheetSearchInputFromThread(
  thread: SatisfactionGmailThread
): DriveSheetSearchInput {
  const courseName =
    parseSingleCourseName(cleanText(thread.bodyText)) ??
    parseCourseNameFromSubject(thread.subject);
  const normalizedCourseName = cleanCourseName(courseName);
  const companyName =
    parseCompanyHintFromSubject(thread.subject) ??
    parseCompanyHintFromCourseName(normalizedCourseName);

  return {
    companyName,
    courseName: normalizedCourseName,
    courseTokens: tokenizeCourseName(normalizedCourseName).slice(0, 4),
  };
}

export async function searchDriveSheetCandidateFiles(args: {
  accessToken: string;
  companyName: string | null;
  courseName: string | null;
  pageSize?: number;
  includeSheetTitles?: boolean;
}): Promise<{
  input: DriveSheetSearchInput;
  queries: DriveSheetCandidateQuery[];
  files: DriveSheetCandidateFile[];
}> {
  const input = {
    companyName: args.companyName,
    courseName: args.courseName,
    courseTokens: tokenizeCourseName(args.courseName).slice(0, 4),
  };
  const queries = buildDriveSheetCandidateQueries(input);
  const filesById = new Map<string, DriveFile>();
  const pageSize = String(Math.max(1, Math.min(args.pageSize ?? 8, 20)));

  for (const query of queries) {
    try {
      const data = await googleApiGet<{ files?: DriveFile[] }>(
        args.accessToken,
        DRIVE_API_BASE,
        "/files",
        {
          q: query.query,
          pageSize,
          fields: "files(id,name,mimeType)",
          corpora: "allDrives",
          includeItemsFromAllDrives: "true",
          supportsAllDrives: "true",
        },
        { timeoutMs: DRIVE_API_TIMEOUT_MS }
      );

      for (const file of data.files ?? []) {
        if (file.id) {
          filesById.set(file.id, file);
        }
      }
    } catch {
      // Diagnostics should keep broader results even if one query fails.
    }
  }

  const files: DriveSheetCandidateFile[] = [];
  for (const file of filesById.values()) {
    let sheetTitles: string[] = [];

    if (
      args.includeSheetTitles &&
      file.mimeType === "application/vnd.google-apps.spreadsheet"
    ) {
      try {
        const meta = await googleApiGet<{
          sheets?: Array<{ properties?: { title?: string } }>;
        }>(args.accessToken, SHEETS_API_BASE, `/spreadsheets/${file.id}`, {
          fields: "sheets.properties.title",
        });
        sheetTitles = (meta.sheets ?? [])
          .map((sheet) => sheet.properties?.title?.trim() ?? "")
          .filter(Boolean);
      } catch {
        sheetTitles = [];
      }
    }

    files.push({
      id: file.id,
      name: file.name?.trim() ?? null,
      mimeType: file.mimeType?.trim() ?? null,
      sheetTitles,
    });
  }

  return { input, queries, files };
}

async function loadDriveSheetResolution(args: {
  companyName: string | null;
  courseName: string | null;
  lookups: InstructorLookupMaps;
  accessToken: string;
}): Promise<DriveSheetResolutionResult> {
  if (!args.companyName || !args.courseName) {
    return { resolved: null, driveSheetNotes: [] };
  }
  const cacheKey = `${args.companyName}::${args.courseName}`;
  if (driveEvidenceCache.has(cacheKey)) {
    return driveEvidenceCache.get(cacheKey)!;
  }

  const courseTokens = tokenizeCourseName(args.courseName).slice(0, 4);
  const candidateQueries = buildDriveSheetCandidateQueries({
    companyName: args.companyName,
    courseName: args.courseName,
  });
  const filesById = new Map<string, DriveFile>();

  for (const query of candidateQueries) {
    try {
      const data = await googleApiGet<{ files?: DriveFile[] }>(
        args.accessToken,
        DRIVE_API_BASE,
        "/files",
        {
          q: query.query,
          pageSize: "8",
          fields: "files(id,name,mimeType)",
          corpora: "allDrives",
          includeItemsFromAllDrives: "true",
          supportsAllDrives: "true",
        }
      );
      for (const file of data.files ?? []) {
        if (file.id) {
          filesById.set(file.id, file);
        }
      }
    } catch {
      // Keep the broader query results if a narrower query fails.
    }
  }

  const files = [...filesById.values()].filter(
    (file) => file.mimeType === "application/vnd.google-apps.spreadsheet"
  );
  if (files.length === 0) {
    const result = { resolved: null, driveSheetNotes: [] };
    driveResolutionCache.set(cacheKey, null);
    driveEvidenceCache.set(cacheKey, result);
    return result;
  }

  const instructorNames = [...args.lookups.byName.keys()];
  const matches = new Map<string, { id: string; name: string }>();
  const driveSheetNotes: DriveSheetEvidenceNote[] = [];

  for (const file of files.slice(0, 2)) {
    for (const name of instructorNames) {
      if (file.name?.includes(name)) {
        const instructor = args.lookups.byName.get(name);
        if (instructor) {
          matches.set(instructor.id, { id: instructor.id, name: instructor.name });
        }
      }
    }

    let meta: { sheets?: Array<{ properties?: { title?: string } }> };
    try {
      meta = await googleApiGet<{
        sheets?: Array<{ properties?: { title?: string } }>;
      }>(args.accessToken, SHEETS_API_BASE, `/spreadsheets/${file.id}`, {
        fields: "sheets.properties.title",
      }, { timeoutMs: SHEETS_API_TIMEOUT_MS });
    } catch {
      continue;
    }
    const allTabs = (meta.sheets ?? [])
      .map((sheet) => sheet.properties?.title)
      .filter((title): title is string => Boolean(title));
    const matchingTabs = allTabs
      .filter((title) =>
        ["강의관리", "강의요약", "과정 정리", "교육 개요", "운영", "캘린더"].some((keyword) =>
          title.includes(keyword)
        )
      )
      .slice(0, 3);
    const evidenceTabs = allTabs
      .filter(
        (title) =>
          (title.includes("강의관리") ||
            title.includes("강의요약") ||
            title.includes("운영")) &&
          !title.includes("캘린더") &&
          !title.includes("인수인계")
      )
      .slice(0, 2);

    for (const tab of matchingTabs) {
      let values: { values?: string[][] };
      try {
        values = await googleApiGet<{ values?: string[][] }>(
          args.accessToken,
          SHEETS_API_BASE,
          `/spreadsheets/${file.id}/values/${encodeURIComponent(`${tab}!A1:AZ120`)}`,
          {},
          { timeoutMs: SHEETS_API_TIMEOUT_MS }
        );
      } catch {
        continue;
      }
      const rows = values.values ?? [];
      const joinedRows = rows.map((row) => row.join(" | "));
      for (let index = 0; index < joinedRows.length; index += 1) {
        const rowText = joinedRows[index];
        const tokenHits = courseTokens.filter((token) => rowText.includes(token));
        if (
          !rowText.includes(args.companyName) &&
          tokenHits.length < Math.min(2, Math.max(1, courseTokens.length))
        ) {
          continue;
        }

        const windowStart = Math.max(0, index - 6);
        const windowEnd = Math.min(joinedRows.length, index + 7);
        const windowText = joinedRows.slice(windowStart, windowEnd).join("\n");

        for (const name of instructorNames) {
          if (!windowText.includes(name)) continue;
          const instructor = args.lookups.byName.get(name);
          if (!instructor) continue;
          matches.set(instructor.id, { id: instructor.id, name: instructor.name });
        }
      }
    }

    for (const tab of evidenceTabs) {
      let values: { values?: string[][] };
      try {
        values = await googleApiGet<{ values?: string[][] }>(
          args.accessToken,
          SHEETS_API_BASE,
          `/spreadsheets/${file.id}/values/${encodeURIComponent(`${tab}!A1:AZ400`)}`,
          {},
          { timeoutMs: SHEETS_API_TIMEOUT_MS }
        );
      } catch {
        continue;
      }
      const rows = values.values ?? [];
      const extractedNotes = extractDriveSheetEvidenceNotes({
        tab,
        rows,
      });
      for (const note of extractedNotes) {
        if (
          !driveSheetNotes.some(
            (existing) =>
              existing.tab === note.tab &&
              existing.row_index === note.row_index &&
              existing.text === note.text
          )
        ) {
          driveSheetNotes.push(note);
        }
      }
    }
  }

  if (matches.size !== 1) {
    const result = { resolved: null, driveSheetNotes };
    driveResolutionCache.set(cacheKey, null);
    driveEvidenceCache.set(cacheKey, result);
    return result;
  }
  const only = [...matches.values()][0];
  const resolved = {
    instructorHint: only.name,
    suggestedInstructorId: only.id,
    resolutionBasis: "drive_sheet_single_instructor",
    driveSheetNotes,
  };
  driveResolutionCache.set(cacheKey, resolved);
  const result = { resolved, driveSheetNotes };
  driveEvidenceCache.set(cacheKey, result);
  return result;
}

async function resolveInstructorFromDriveSheet(args: {
  companyName: string | null;
  courseName: string | null;
  lookups: InstructorLookupMaps;
  accessToken: string;
}): Promise<InstructorResolutionResult | null> {
  const result = await loadDriveSheetResolution(args);
  return result.resolved;
}

async function resolveSuggestedInstructorFallback(args: {
  sourceType: string;
  registryKey: string | null;
  companyName: string | null;
  courseName: string | null;
  responseDate: Date | string | null | undefined;
  lookups: InstructorLookupMaps;
  accessToken: string;
}): Promise<InstructorResolutionResult | null> {
  if (process.env.GMAIL_SATISFACTION_ENABLE_FALLBACK_RESOLUTION !== "true") {
    return null;
  }

  if (args.companyName && args.courseName) {
    const sameCourse = await prisma.satisfactionReviewRegistry.findMany({
      where: {
        sourceType: args.sourceType,
        matchStatus: { in: ["auto_accepted", "approved"] },
        companyName: args.companyName,
        courseName: args.courseName,
        resolvedInstructorId: { not: null },
      },
      select: {
        resolvedInstructorId: true,
        resolvedInstructor: { select: { name: true } },
      },
      take: 5,
    });
    const distinct = new Map<string, string>();
    for (const row of sameCourse) {
      if (!row.resolvedInstructorId || !row.resolvedInstructor?.name) continue;
      distinct.set(row.resolvedInstructorId, row.resolvedInstructor.name);
    }
    if (distinct.size === 1) {
      const [suggestedInstructorId, instructorHint] = [...distinct.entries()][0];
      return {
        instructorHint,
        suggestedInstructorId,
        resolutionBasis: "existing_course_single_instructor",
      };
    }
  }

  if (args.registryKey) {
    const existing = await prisma.satisfactionReviewRegistry.findMany({
      where: {
        sourceType: args.sourceType,
        matchStatus: { in: ["auto_accepted", "approved"] },
        registryKey: { startsWith: args.registryKey },
        resolvedInstructorId: { not: null },
      },
      select: {
        resolvedInstructorId: true,
        resolvedInstructor: { select: { name: true } },
      },
      take: 5,
    });
    const distinct = new Map<string, string>();
    for (const row of existing) {
      if (!row.resolvedInstructorId || !row.resolvedInstructor?.name) continue;
      distinct.set(row.resolvedInstructorId, row.resolvedInstructor.name);
    }
    if (distinct.size === 1) {
      const [suggestedInstructorId, instructorHint] = [...distinct.entries()][0];
      return {
        instructorHint,
        suggestedInstructorId,
        resolutionBasis: "existing_registry_single_instructor",
      };
    }
  }
  const byTeachingHistory = await resolveInstructorFromTeachingHistory(args);
  if (byTeachingHistory) return byTeachingHistory;
  return resolveInstructorFromDriveSheet(args);
}

function parseSessionLabel(text: string): string | null {
  const match = text.match(/(\d+(?:일차|차수))/);
  return match?.[1] ?? null;
}

function buildEventKey(args: {
  courseName: string;
  sessionLabel?: string | null;
  responseDate?: Date | string | null;
  score: number;
  respondentCount: number;
  companyName?: string | null;
}): string {
  return [
    "gmail_event",
    encodeKeyPart(args.companyName ?? ""),
    encodeKeyPart(args.courseName),
    encodeKeyPart(args.sessionLabel ?? ""),
    encodeKeyPart(toDateOnlyString(args.responseDate) ?? ""),
    encodeKeyPart(String(args.score)),
    encodeKeyPart(String(args.respondentCount)),
  ].join(":");
}

function parseResponseDateFromBody(bodyText: string, sentAt: string | null): Date | null {
  const fromCourseDate = parseDateOnly(
    bodyText.match(/과정일시\s*:\s*([0-9.\-/ ]+\([^)]+\)?)/)?.[1] ??
      bodyText.match(/강의일시\s*:\s*([0-9.\-/ ]+\([^)]+\)?)/)?.[1] ??
      bodyText.match(/교육일시\s*:\s*([0-9.\-/ ]+\([^)]+\)?)/)?.[1] ??
      bodyText.match(/과정일시\s*:\s*([0-9.\-/ ]+)/)?.[1] ??
      bodyText.match(/강의일시\s*:\s*([0-9.\-/ ]+)/)?.[1] ??
      bodyText.match(/교육일시\s*:\s*([0-9.\-/ ]+)/)?.[1] ??
      null
  );
  if (fromCourseDate) return fromCourseDate;

  const sentDate = sentAt ? new Date(sentAt) : null;
  return sentDate && !Number.isNaN(sentDate.getTime()) ? sentDate : null;
}

function cleanCourseName(value: string | null | undefined): string | null {
  const cleaned = cleanText(value)
    .replace(/^re:\s*/i, "")
    .replace(/^fw:\s*/i, "")
    .replace(/^fwd:\s*/i, "")
    .replace(/^\[[^\]]+\]\s*/, "")
    .replace(
      /^[가-힣A-Za-z0-9._()\-\s]+(?:님|과장님|차장님|매니저님|책임님|대표님|선임님)께\s*-\s*/i,
      ""
    )
    .replace(/^작일\s*\([^)]+\)\s*진행된\s*\[?/i, "")
    .replace(/^\d{1,2}월\s*\d{1,2}일\s*진행되었던,?\s*/i, "")
    .replace(/^이번에\s*진행된\s*/i, "")
    .replace(/^지난주에\s*종료된\s*/i, "")
    .replace(/\s*(?:만족도\s*)?(?:결과\s*공유|결과\s*전달|조사\s*결과|설문\s*결과|만족도\s*결과)\s*$/i, "")
    .replace(/\s*(?:만족도\s*)?(?:결과\s*공유드립니다|결과\s*전달드립니다|조사\s*결과\s*전달드립니다|조사\s*결과\s*공유드립니다|설문\s*결과\s*공유드립니다|만족도\s*설문\s*결과\s*공유드립니다|만족도\s*설문\s*결과\s*전달드립니다|최종\s*만족도\s*결과\s*공유드립니다|전체\s*만족도\s*송부\s*드립니다|결과\s*보고드립니다|확정\s*일자\s*전달드립니다)\.?\s*$/i, "")
    .replace(/\s*만족도\s*및\s*과제\s*제출(?:결과)?\s*전달드립니다?\.?\s*$/i, "")
    .replace(/\s*설문평가\s*결과\s*$/i, "")
    .replace(/\s*만족도\s*조사\s*초안(?:\([^)]*\))?\s*$/i, "")
    .replace(/\s*만족도\s*설문\s*결과\s*$/i, "")
    .replace(/\s*만족도\s*조사\s*결과\s*$/i, "")
    .replace(/\s*강의\s*안내\s*메일\s*드립니다\.?\s*$/i, "")
    .replace(/\s*출강\s*문의\s*드립니다\.?\s*$/i, "")
    .replace(/\s*출강문의드립니다\.?\s*$/i, "")
    .replace(/\s*운영\s*제반사항\s*회신의\s*건\s*$/i, "")
    .replace(/\s*회신의\s*건\s*$/i, "")
    .replace(/\s*요청의\s*건\s*$/i, "")
    .replace(/\]?\s*과정의\s*$/i, "")
    .replace(/\s*-\s*$/, "")
    .trim();
  return cleaned || null;
}

function parseCourseNameFromSubject(
  subject: string | null | undefined
): string | null {
  const cleaned = cleanText(subject)
    .replace(/^re:\s*/i, "")
    .replace(/^fw:\s*/i, "")
    .replace(/^\[[^\]]+\]\s*/, "")
    .trim();

  const patterns = [
    /강사님께\s*-\s*(.+)/i,
    /^\[[^\]]+\]\s*(.+)$/i,
    /결과\s*공유\s*-\s*(.+)/i,
    /결과\s*전달\s*-\s*(.+)/i,
    /만족도\s*결과\s*-\s*(.+)/i,
    /설문\s*결과\s*-\s*(.+)/i,
    /(.+?)\s*설문평가\s*결과$/i,
    /(.+?)\s*(?:사전|사후|사전\/사후)\s*설문(?:\s*Raw\s*Data|\s*raw\s*data)?(?:\s*공유)?$/i,
    /-\s*(.+?)(?:\s*(?:만족도\s*)?(?:결과\s*공유|결과\s*전달|조사\s*결과|설문\s*결과|만족도\s*결과))$/i,
  ];

  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    const courseName = cleanCourseName(match?.[1] ?? null);
    if (courseName) return courseName;
  }

  const genericSubjectCourse = cleanCourseName(
    cleaned
      .replace(/^\[[^\]]+\]\s*/, "")
      .replace(/\s*운영\s*제반사항\s*회신의\s*건\s*$/i, "")
      .replace(/\s*회신의\s*건\s*$/i, "")
      .replace(/\s*요청의\s*건\s*$/i, "")
  );
  if (genericSubjectCourse && /교육|과정|리더십|리터러시|Copilot|Agent/i.test(genericSubjectCourse)) {
    return genericSubjectCourse;
  }

  return null;
}

export const __test__ = {
  parseScoreFromText,
  parseSingleCourseName,
  parseCourseNameFromSubject,
  cleanCourseName,
  extractSectionEvents,
  extractSingleEvent,
  extractEvidenceOnlyEvent,
};

function extractSectionEvents(
  thread: SatisfactionGmailThread,
  context: GmailInferenceContext
): DraftGmailSatisfactionEvent[] {
  const bodyText = cleanText(thread.bodyText);
  const sentDate = thread.sentAt ? new Date(thread.sentAt) : null;
  const sentYear =
    sentDate && !Number.isNaN(sentDate.getTime()) ? sentDate.getUTCFullYear() : new Date().getUTCFullYear();
  const headerRegex = /(?:^|\n)\s*\d+[.)]?\s*([^\n]+?)(?:\s+결과)?\s*\((\d{1,2}\s*\/\s*\d{1,2})\)/g;
  const matches = Array.from(bodyText.matchAll(headerRegex));
  if (matches.length === 0) {
    return [];
  }

  const items: DraftGmailSatisfactionEvent[] = [];
  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index];
    const next = matches[index + 1];
    const sectionTitle = cleanText(current[1]);
    const sectionDateToken = current[2];
    const sectionStart = current.index ?? 0;
    const sectionEnd = next?.index ?? bodyText.length;
    const sectionText = bodyText.slice(sectionStart, sectionEnd).trim();

    const score = parseScoreFromText(sectionText);
    if (score === null) continue;

    const respondentCount = parseRespondentCountFromText(sectionText) ?? 1;
    const responseDate =
      parseMonthDayWithYear(sectionDateToken, sentYear) ??
      parseResponseDateFromBody(sectionText, thread.sentAt);
    const sessionLabel = parseSessionLabel(sectionTitle);
    const courseName =
      cleanCourseName(
        sectionTitle.replace(/\s+\d+(?:일차|차수)\s*$/, "").trim() || sectionTitle
      ) ?? sectionTitle;
    const companyName = context.companyHint ?? parseCompanyHintFromCourseName(courseName);
    const registryKey = buildGmailRegistryKey({
      sourceFamily: "gmail_satisfaction",
      companyName,
      courseName,
      sessionOrDate: sessionLabel ?? toDateOnlyString(responseDate) ?? `thread:${thread.threadId}:${index + 1}`,
    });
    const eventKey = buildEventKey({
      companyName,
      courseName,
      sessionLabel,
      responseDate,
      score,
      respondentCount,
    });

    items.push({
      sourceRefKey: `gmail_satisfaction:${thread.threadId}:${index + 1}`,
      sourceRef: {
        account_email: context.accountEmail,
        thread_id: thread.threadId,
        message_id: thread.messageId,
        section_index: index + 1,
      },
      rawPayload: {
        subject: thread.subject,
        from: thread.from,
        to: thread.to,
        cc: thread.cc,
        sent_at: thread.sentAt,
        section_title: sectionTitle,
        body_excerpt: sectionText.slice(0, 1200),
        extracted_urls: extractAllUrlsFromText(thread.subject, sectionText),
      },
      normalizedPayload: {
        registry_key: registryKey,
        company_name: companyName,
        company_name_for_key: companyName ?? "",
        course_name: courseName,
        event_key: eventKey,
        session_label: sessionLabel,
        response_date: toDateOnlyString(responseDate),
        instructor_name: context.instructorHint,
        respondent_count: respondentCount,
        source_family: "gmail_satisfaction",
        ...(context.suggestedInstructorId
          ? {
              suggested_instructor_id: context.suggestedInstructorId,
              resolution_basis: context.resolutionBasis ?? "gmail_subject_or_email_exact",
            }
          : {}),
      },
      candidateName: context.instructorHint,
      candidateCompanyName: companyName,
      candidateCourseName: courseName,
      scoreRaw: String(score),
      scoreNormalized: score,
      respondentCount,
      responseDate,
    });
  }

  return items;
}

function extractSingleEvent(
  thread: SatisfactionGmailThread,
  context: GmailInferenceContext
): DraftGmailSatisfactionEvent | null {
  const bodyText = cleanText(thread.bodyText);
  const courseName =
    parseSingleCourseName(bodyText) ??
    parseCourseNameFromSubject(thread.subject);
  const score = parseScoreFromText(bodyText);
  if (!courseName || score === null) {
    return null;
  }

  const responseDate = parseResponseDateFromBody(bodyText, thread.sentAt);
  const sessionLabel =
    parseSessionLabel(bodyText) ??
    parseSessionLabel(cleanText(thread.subject)) ??
    null;
  const respondentCount = parseRespondentCountFromText(bodyText) ?? 1;
  const cleanedCourseName = cleanCourseName(courseName) ?? courseName;
  const companyName =
    context.companyHint ?? parseCompanyHintFromCourseName(cleanedCourseName);
  const registryKey = buildGmailRegistryKey({
    sourceFamily: "gmail_satisfaction",
    companyName,
    courseName: cleanedCourseName,
    sessionOrDate: sessionLabel ?? toDateOnlyString(responseDate) ?? `thread:${thread.threadId}`,
  });
  const eventKey = buildEventKey({
    companyName,
    courseName: cleanedCourseName,
    sessionLabel,
    responseDate,
    score,
    respondentCount,
  });

  return {
    sourceRefKey: `gmail_satisfaction:${thread.threadId}:1`,
    sourceRef: {
      account_email: context.accountEmail,
      thread_id: thread.threadId,
      message_id: thread.messageId,
      section_index: 1,
    },
    rawPayload: {
      subject: thread.subject,
      from: thread.from,
      to: thread.to,
      cc: thread.cc,
      sent_at: thread.sentAt,
      body_excerpt: bodyText.slice(0, 1200),
      extracted_urls: extractAllUrlsFromText(thread.subject, bodyText),
    },
    normalizedPayload: {
        registry_key: registryKey,
        company_name: companyName,
        company_name_for_key: companyName ?? "",
        course_name: cleanedCourseName,
        event_key: eventKey,
      session_label: sessionLabel,
      response_date: toDateOnlyString(responseDate),
      instructor_name: context.instructorHint,
      respondent_count: respondentCount,
      source_family: "gmail_satisfaction",
      ...(context.suggestedInstructorId
        ? {
            suggested_instructor_id: context.suggestedInstructorId,
            resolution_basis: context.resolutionBasis ?? "gmail_subject_or_email_exact",
          }
        : {}),
    },
    candidateName: context.instructorHint,
    candidateCompanyName: companyName,
    candidateCourseName: cleanedCourseName,
    scoreRaw: String(score),
    scoreNormalized: score,
    respondentCount,
    responseDate,
  };
}

function hasEvidenceOnlySignal(thread: SatisfactionGmailThread): boolean {
  const text = cleanText([thread.subject, thread.snippet, thread.bodyText]
    .filter(Boolean)
    .join("\n"));
  return /(사전\s*설문|사후\s*설문|사전\/사후\s*설문|설문\s*raw\s*data|raw\s*data|rawdata|설문\s*결과|만족도\s*조사)/i.test(
    text
  );
}

function extractEvidenceOnlyEvent(
  thread: SatisfactionGmailThread,
  context: GmailInferenceContext
): DraftGmailSatisfactionEvent | null {
  if (!hasEvidenceOnlySignal(thread)) {
    return null;
  }

  const bodyText = cleanText(thread.bodyText);
  const courseName =
    parseSingleCourseName(bodyText) ??
    parseCourseNameFromSubject(thread.subject);
  if (!courseName) {
    return null;
  }

  const responseDate = parseResponseDateFromBody(bodyText, thread.sentAt);
  const sessionLabel =
    parseSessionLabel(bodyText) ??
    parseSessionLabel(cleanText(thread.subject)) ??
    null;
  const cleanedCourseName = cleanCourseName(courseName) ?? courseName;
  const companyName =
    context.companyHint ?? parseCompanyHintFromCourseName(cleanedCourseName);
  const registryKey = buildGmailRegistryKey({
    sourceFamily: "gmail_satisfaction",
    companyName,
    courseName: cleanedCourseName,
    sessionOrDate: sessionLabel ?? toDateOnlyString(responseDate) ?? `thread:${thread.threadId}`,
  });

  return {
    sourceRefKey: `gmail_satisfaction:${thread.threadId}:evidence`,
    sourceRef: {
      account_email: context.accountEmail,
      thread_id: thread.threadId,
      message_id: thread.messageId,
      section_index: 1,
      evidence_only: true,
    },
    rawPayload: {
      subject: thread.subject,
      from: thread.from,
      to: thread.to,
      cc: thread.cc,
      sent_at: thread.sentAt,
      body_excerpt: bodyText.slice(0, 1200),
      extracted_urls: extractAllUrlsFromText(thread.subject, bodyText),
      evidence_only: true,
    },
    normalizedPayload: {
      registry_key: registryKey,
      company_name: companyName,
      company_name_for_key: companyName ?? "",
      course_name: cleanedCourseName,
      event_key: `evidence:${thread.threadId}`,
      session_label: sessionLabel,
      response_date: toDateOnlyString(responseDate),
      instructor_name: context.instructorHint,
      respondent_count: 1,
      source_family: "gmail_satisfaction",
      evidence_only: true,
      ...(context.suggestedInstructorId
        ? {
            suggested_instructor_id: context.suggestedInstructorId,
            resolution_basis: context.resolutionBasis ?? "gmail_subject_or_email_exact",
          }
        : {}),
    },
    candidateName: context.instructorHint,
    candidateCompanyName: companyName,
    candidateCourseName: cleanedCourseName,
    scoreRaw: null,
    scoreNormalized: null,
    respondentCount: 1,
    responseDate,
  };
}

async function loadInstructorMaps(): Promise<InstructorLookupMaps> {
  const instructors = await prisma.instructor.findMany({
    select: { id: true, name: true, contactEmail: true },
  });

  const byName = new Map<string, { id: string; name: string; contactEmail: string | null }>();
  const byEmail = new Map<string, { id: string; name: string; contactEmail: string | null }>();

  for (const instructor of instructors) {
    if (instructor.name) {
      byName.set(instructor.name.trim(), instructor);
    }
    if (instructor.contactEmail) {
      byEmail.set(instructor.contactEmail.trim().toLowerCase(), instructor);
    }
  }

  return { byName, byEmail };
}

function resolveSuggestedInstructor(
  thread: SatisfactionGmailThread,
  lookups: InstructorLookupMaps
): {
  instructorHint: string | null;
  suggestedInstructorId: string | null;
  resolutionBasis: string | null;
} {
  const instructorHint = parseInstructorHintFromSubject(thread.subject ?? null);
  if (instructorHint) {
    const exactByName =
      lookups.byName.get(instructorHint) ??
      lookups.byName.get(instructorHint.replace(/\s+/g, ""));
    if (exactByName) {
      return {
        instructorHint,
        suggestedInstructorId: exactByName.id,
        resolutionBasis: "name_exact",
      };
    }
  }

  const bodyInstructorHint = parseInstructorHintFromBody(thread.bodyText);
  if (bodyInstructorHint) {
    const exactByName =
      lookups.byName.get(bodyInstructorHint) ??
      lookups.byName.get(bodyInstructorHint.replace(/\s+/g, ""));
    if (exactByName) {
      return {
        instructorHint: bodyInstructorHint,
        suggestedInstructorId: exactByName.id,
        resolutionBasis: "body_instructor_exact",
      };
    }
  }

  const fromMailbox = parseMailboxHeader(thread.from)[0] ?? null;
  if (fromMailbox?.email) {
    const exactByEmail = lookups.byEmail.get(fromMailbox.email);
    if (exactByEmail) {
      return {
        instructorHint: fromMailbox.name?.replace(/\s+/g, "") ?? exactByEmail.name,
        suggestedInstructorId: exactByEmail.id,
        resolutionBasis: "from_email_exact",
      };
    }
  }

  const mailboxNames = [
    ...parseMailboxHeader(thread.from),
    ...parseMailboxHeader(thread.to),
    ...parseMailboxHeader(thread.cc),
  ]
    .map((mailbox) => mailbox.name?.replace(/\s+/g, "") ?? null)
    .filter((name): name is string => Boolean(name));

  for (const name of mailboxNames) {
    const exactByName = lookups.byName.get(name);
    if (exactByName) {
      return {
        instructorHint: name,
        suggestedInstructorId: exactByName.id,
        resolutionBasis: "mailbox_name_exact",
      };
    }
  }

  const recipientEmails = [
    ...parseMailboxHeader(thread.to),
    ...parseMailboxHeader(thread.cc),
  ]
    .map((mailbox) => mailbox.email)
    .filter((email): email is string => Boolean(email));

  for (const email of recipientEmails) {
    const exactByEmail = lookups.byEmail.get(email);
    if (exactByEmail) {
      return {
        instructorHint: instructorHint ?? exactByEmail.name,
        suggestedInstructorId: exactByEmail.id,
        resolutionBasis: "email_exact",
      };
    }
  }

  return {
    instructorHint,
    suggestedInstructorId: null,
    resolutionBasis: null,
  };
}

export async function normalizeSatisfactionGmailResults(
  result: SatisfactionGmailCollectResult
): Promise<{
  items: SatisfactionImportItemInput[];
  sourceSummary: SatisfactionSourceSummary;
  skippedSamples: SkippedGmailThreadSample[];
}> {
  const lookups = await loadInstructorMaps();
  const items: SatisfactionImportItemInput[] = [];
  const skippedSamples: SkippedGmailThreadSample[] = [];
  let skippedThreads = 0;
  let autoAcceptedCandidates = 0;
  let pendingCandidates = 0;
  let accessTokenPromise: Promise<string> | null = null;
  const getAccessToken = () => {
    if (!accessTokenPromise) {
      accessTokenPromise = exchangeGoogleUserAccessToken();
    }
    return accessTokenPromise;
  };

  const threadResults = await mapWithConcurrency(
    result.threads,
    GMAIL_SATISFACTION_NORMALIZE_CONCURRENCY,
    async (thread) => {
    const companyHint = parseCompanyHintFromSubject(thread.subject);
    const { instructorHint, suggestedInstructorId, resolutionBasis } = resolveSuggestedInstructor(
      thread,
      lookups
    );
    const context: GmailInferenceContext = {
      accountEmail: result.accountEmail,
      instructorHint,
      companyHint,
      suggestedInstructorId,
      resolutionBasis,
    };

    const multiSectionItems = extractSectionEvents(thread, context);
    const draftItems =
      multiSectionItems.length > 0
        ? multiSectionItems
        : (() => {
            const single = extractSingleEvent(thread, context);
            if (single) return [single];
            const evidenceOnly = extractEvidenceOnlyEvent(thread, context);
            return evidenceOnly ? [evidenceOnly] : [];
          })();

    if (draftItems.length === 0) {
      return {
        items: [] as SatisfactionImportItemInput[],
        skipped: {
          threadId: thread.threadId,
          subject: thread.subject,
          sentAt: thread.sentAt,
          reason: explainSkippedThread(thread),
          snippet: thread.snippet,
          bodyExcerpt: cleanText(thread.bodyText).slice(0, 800) || null,
        } as SkippedGmailThreadSample,
        autoAcceptedCandidates: 0,
        pendingCandidates: 0,
      };
    }

    const producedItems: SatisfactionImportItemInput[] = [];
    let threadAutoAccepted = 0;
    let threadPending = 0;
    for (const item of draftItems) {
      const normalizedPayload = item.normalizedPayload as Record<string, unknown>;
      if (!item.candidateCompanyName && item.candidateCourseName) {
        const inferredCompanyName = parseCompanyHintFromCourseName(item.candidateCourseName);
        if (inferredCompanyName) {
          item.candidateCompanyName = inferredCompanyName;
          normalizedPayload.company_name = inferredCompanyName;
          normalizedPayload.company_name_for_key = inferredCompanyName;

          const sourceFamily =
            typeof normalizedPayload.source_family === "string"
              ? normalizedPayload.source_family
              : "gmail_satisfaction";
          const sessionLabel =
            typeof normalizedPayload.session_label === "string"
              ? normalizedPayload.session_label
              : null;
          const responseDate =
            typeof normalizedPayload.response_date === "string"
              ? normalizedPayload.response_date
              : null;
          const instructorName =
            typeof normalizedPayload.instructor_name === "string"
              ? normalizedPayload.instructor_name
              : null;
          const respondentCount =
            typeof normalizedPayload.respondent_count === "number"
              ? normalizedPayload.respondent_count
              : item.respondentCount ?? 1;
          const registrySessionOrDate =
            sessionLabel ??
            responseDate ??
            `thread:${String((item.sourceRef as Record<string, unknown>).thread_id ?? "")}`;
          normalizedPayload.registry_key = buildGmailRegistryKey({
            sourceFamily,
            companyName: inferredCompanyName,
            courseName: item.candidateCourseName,
            sessionOrDate: registrySessionOrDate,
            instructorName,
          });
          if (item.scoreNormalized !== null && item.scoreNormalized !== undefined) {
            normalizedPayload.event_key = buildEventKey({
              companyName: inferredCompanyName,
              courseName: item.candidateCourseName,
              sessionLabel,
              responseDate,
              score: item.scoreNormalized,
              respondentCount,
            });
          }
        }
      }
      if (item.candidateCompanyName && item.candidateCourseName) {
        const driveSheet = await loadDriveSheetResolution({
          companyName: item.candidateCompanyName,
          courseName: item.candidateCourseName,
          lookups,
          accessToken: await getAccessToken(),
        });
        if (driveSheet.driveSheetNotes.length > 0) {
          item.rawPayload.drive_sheet_notes = driveSheet.driveSheetNotes;
        }
      }
      if (
        (!normalizedPayload.suggested_instructor_id ||
          typeof normalizedPayload.suggested_instructor_id !== "string") &&
        item.candidateCourseName
      ) {
        const fallback = await resolveSuggestedInstructorFallback({
          sourceType: "gmail_summary",
          registryKey:
            typeof normalizedPayload.registry_key === "string"
              ? normalizedPayload.registry_key
              : null,
          companyName: item.candidateCompanyName ?? null,
          courseName: item.candidateCourseName ?? null,
          responseDate: item.responseDate ?? null,
          lookups,
          accessToken: await getAccessToken(),
        });
        if (fallback) {
          // Expert P0-3: gmail fallback 매칭(회사+과정 substring/registry prefix/teaching history)은
          // L3 substring auto-accept와 본질적으로 동일 → applier에 suggested_instructor_id 채우지 않음.
          // candidateName/instructor_name은 검토용 hint로 노출, 매칭은 pending_review로 처리.
          item.candidateName = fallback.instructorHint;
          normalizedPayload.instructor_name = fallback.instructorHint;
          normalizedPayload.fallback_suggested_instructor_id =
            fallback.suggestedInstructorId;
          normalizedPayload.resolution_basis = `pending:${fallback.resolutionBasis}`;
          normalizedPayload.should_auto_accept = false;
          if ((fallback.driveSheetNotes?.length ?? 0) > 0) {
            item.rawPayload.drive_sheet_notes = fallback.driveSheetNotes;
          }
        }
      }
      if (
        typeof normalizedPayload.suggested_instructor_id === "string" &&
        normalizedPayload.suggested_instructor_id.length > 0
      ) {
        threadAutoAccepted += 1;
      } else {
        threadPending += 1;
      }
      producedItems.push({
        sourceType: "gmail_summary",
        sourceRefKey: item.sourceRefKey,
        sourceRef: item.sourceRef,
        rawPayload: item.rawPayload,
        normalizedPayload: item.normalizedPayload,
        candidateName: item.candidateName ?? null,
        candidateCompanyName: item.candidateCompanyName ?? null,
        candidateCourseName: item.candidateCourseName ?? null,
        scoreRaw: item.scoreRaw ?? null,
        scoreNormalized: item.scoreNormalized ?? null,
        respondentCount: item.respondentCount ?? null,
        responseDate: item.responseDate ?? null,
      });
    }
    return {
      items: producedItems,
      skipped: null as SkippedGmailThreadSample | null,
      autoAcceptedCandidates: threadAutoAccepted,
      pendingCandidates: threadPending,
    };
  });

  for (const threadResult of threadResults) {
    if (threadResult.skipped) {
      skippedThreads += 1;
      if (skippedSamples.length < 5) {
        skippedSamples.push(threadResult.skipped);
      }
    }
    items.push(...threadResult.items);
    autoAcceptedCandidates += threadResult.autoAcceptedCandidates;
    pendingCandidates += threadResult.pendingCandidates;
  }

  await normalizeFeedbackNotesInImportItems(items);

  const sourceSummary: SatisfactionSourceSummary = {
    sourceKey: result.sourceKey,
    sourceType: "gmail_summary",
    fetchedRows: result.threads.length,
    importedItems: items.length,
    skippedRows: skippedThreads,
    autoAcceptedCandidates,
    pendingCandidates,
    status: items.length === 0 ? "skipped" : skippedThreads > 0 ? "partial" : "success",
    note:
      items.length === 0
        ? "만족도 점수/과정 정보를 추출할 수 있는 Gmail thread가 없어 skip"
        : skippedThreads > 0
          ? `${skippedThreads}개 thread는 만족도 이벤트 추출 실패로 skip`
          : undefined,
  };

  return { items, sourceSummary, skippedSamples };
}
