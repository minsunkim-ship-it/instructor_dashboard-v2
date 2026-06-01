/**
 * Archive Contract Normalizer — Phase 1-5
 *
 * archive 시트(★조교 계약 작성 요청_B2B교육사업본부_DT기업교육팀.xlsx)의 raw row를
 * TeachingHistory 후보로 정규화. 2024-08 이전 데이터 archive.
 *
 * 헤더 매핑 (NEW 계약시트와 유사):
 *   - "강사명" → instructorName
 *   - "강의 일정" → 단일/multi-day 파싱 → startDate / endDate
 *   - "강의 장소 or 강의 방식" 또는 "비고" → companyName 추출 시도
 *   - "총 강의 시수" → totalHours
 *   - "시간당 강사료" → dealFeeHourly
 *   - "카테고리" → 분야명 (참고)
 *   - "계약 코스 링크" → fastcampus URL (참고)
 */
import type { RawArchiveRow } from "./archive-contract-collector";

export interface NormalizedArchiveRow {
  fileId: string;
  sheetName: string;
  rowNumber: number;
  instructorName: string | null;
  companyName: string | null;
  courseName: string | null;
  startDate: Date | null;
  endDate: Date | null;
  dateLabel: string | null;
  totalHours: number | null;
  dealFeeHourly: number | null;
  category: string | null;
  courseLink: string | null;
}

function emptyToNull(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const t = v.trim();
  return t.length === 0 ? null : t;
}

function parseFeeHourly(raw: string | null): number | null {
  if (!raw) return null;
  // "시간당 강사료 23만" / "10만" / "단독 강사료 17만" 패턴
  const tenK = /(\d{1,4})\s*만/.exec(raw);
  if (tenK) {
    const n = parseInt(tenK[1], 10) * 10000;
    if (n >= 10000 && n <= 10_000_000) return n;
  }
  // "250,000" 또는 "250000"
  const digits = raw.replace(/[,\s원]/g, "");
  const n = parseInt(digits, 10);
  if (Number.isFinite(n) && n > 10000 && n <= 10_000_000) return n;
  return null;
}

function parseNumberLike(raw: string | null): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[hH시간,\s]/g, "");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function makeDate(y: number, m: number, d: number): Date | null {
  if (y < 2018 || y > 2030) return null;
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1) return null;
  return date;
}

/**
 * 강의 일정 파싱.
 * 지원 패턴 (archive 시트 실제 데이터 기준):
 *   - "2022.07.22 오후 2시~5시 2022.07.28 오전 9시~12시 2022.08.08 오후 2시~6시"
 *   - "2022. 07. 14(목) 09:00~18:00 2022. 07. 15(금) 09:00~18:00"
 *   - "2022년 8월 22일(월) 13:00~18:00 2022년 8월 23일(화) 13:00~18:00"
 * 모든 일자 추출 → 첫=start, 마지막=end.
 */
function parseDateLabel(label: string | null): {
  start: Date | null;
  end: Date | null;
} {
  if (!label) return { start: null, end: null };
  const cleaned = label.replace(/\s+/g, " ").trim();
  const allDates = [
    ...cleaned.matchAll(
      /(\d{4})\s*[.년]\s*(\d{1,2})\s*[.월]\s*(\d{1,2})\.?/gu
    ),
  ];
  if (allDates.length === 0) return { start: null, end: null };
  const valid: Date[] = [];
  for (const m of allDates) {
    const d = makeDate(
      parseInt(m[1], 10),
      parseInt(m[2], 10),
      parseInt(m[3], 10)
    );
    if (d) valid.push(d);
  }
  if (valid.length === 0) return { start: null, end: null };
  valid.sort((a, b) => a.getTime() - b.getTime());
  return { start: valid[0], end: valid[valid.length - 1] };
}

/**
 * 강의 장소/비고에서 회사명 키워드 추출.
 * 보수적 — 명확한 회사 이름이 들어 있는 경우만.
 *
 * 패턴 예:
 *   - "KB데이타시스템 합정연수원" → "KB데이타시스템"
 *   - "삼성화재 디지털 연수원 (경기도 고양시)" → "삼성화재"
 *   - "이화여자대학교 ECC" → "이화여자대학교"
 *   - "올리브영 사옥 교육장" → "올리브영"
 *   - "현대자동차 남양연구소" → "현대자동차"
 */
const COMPANY_KEYWORDS = [
  "KB데이타시스템",
  "KB국민은행",
  "KB금융",
  "삼성화재",
  "삼성전자",
  "삼성디스플레이",
  "삼성물산",
  "삼성생명",
  "이화여자대학교",
  "현대자동차",
  "현대모비스",
  "올리브영",
  "롯데",
  "신한",
  "우리은행",
  "우리금융",
  "NH투자증권",
  "KT",
  "LG",
  "SK",
  "오뚜기",
  "효성",
  "포스코",
  "한화",
  "두산",
  "CJ",
  "GS",
  "신세계",
  "교보",
  "동국제강",
  "대상",
  "한국타이어",
  "한국전력",
  "기업은행",
  "IBK",
  "KAIST",
  "서울대",
  "고려대",
  "연세대",
  "한양대",
  "성균관대",
  "중앙대",
  "경희대",
  "아주대",
  "부산대",
];

function extractCompanyFromText(
  text: string | null,
  dynamicKeywords?: string[]
): string | null {
  if (!text) return null;
  // 1) 동적 keyword 우선 (record DB / 강사 affiliation에서 학습한 회사 list)
  if (dynamicKeywords) {
    // 긴 keyword 우선 매칭 (KB데이타시스템 우선 → KB)
    const sorted = [...dynamicKeywords].sort((a, b) => b.length - a.length);
    for (const kw of sorted) {
      if (kw.length >= 2 && text.includes(kw)) return kw;
    }
  }
  // 2) 정적 keyword fallback
  for (const kw of COMPANY_KEYWORDS) {
    if (text.includes(kw)) return kw;
  }
  return null;
}

export function normalizeArchiveRow(
  raw: RawArchiveRow,
  dynamicCompanyKeywords?: string[]
): NormalizedArchiveRow | null {
  const v = raw.values;
  const instructorName = emptyToNull(v["강사명"]);
  if (!instructorName) return null;

  const dateLabel =
    emptyToNull(v["강의 일정"]) ?? emptyToNull(v["강의일정"]);
  const { start, end } = parseDateLabel(dateLabel);
  if (!start) return null; // 일정 파싱 실패 → skip

  const venue = emptyToNull(v["강의 장소 or 강의 방식"]) ?? emptyToNull(v["강의 장소"]);
  const memo = emptyToNull(v["비고"]);
  const courseLink = emptyToNull(v["계약 코스 링크"]);

  // 회사명: 장소 → 비고 → 과정명 → 코스 링크에서 추출 시도
  const courseName = emptyToNull(v["과정명"]) ?? emptyToNull(v["코스명"]);
  const companyName =
    extractCompanyFromText(venue, dynamicCompanyKeywords) ??
    extractCompanyFromText(memo, dynamicCompanyKeywords) ??
    extractCompanyFromText(courseName, dynamicCompanyKeywords) ??
    extractCompanyFromText(courseLink, dynamicCompanyKeywords);

  // F5: totalHours > 999.99 (Decimal(5,2)) 방어
  let totalHours = parseNumberLike(v["총 강의 시수"] ?? v["총강의시수"]);
  if (totalHours !== null && totalHours > 999.99) totalHours = 999.99;
  if (totalHours !== null && totalHours < 0) totalHours = null;

  return {
    fileId: raw.fileId,
    sheetName: raw.sheetName,
    rowNumber: raw.rowNumber,
    instructorName,
    companyName,
    courseName,
    startDate: start,
    endDate: end ?? start,
    dateLabel,
    totalHours,
    dealFeeHourly: parseFeeHourly(v["시간당 강사료"] ?? null),
    category: emptyToNull(v["카테고리"]),
    courseLink,
  };
}

export function normalizeArchiveRows(
  rows: RawArchiveRow[],
  dynamicCompanyKeywords?: string[]
): NormalizedArchiveRow[] {
  const out: NormalizedArchiveRow[] = [];
  for (const r of rows) {
    const n = normalizeArchiveRow(r, dynamicCompanyKeywords);
    if (n) out.push(n);
  }
  return out;
}
