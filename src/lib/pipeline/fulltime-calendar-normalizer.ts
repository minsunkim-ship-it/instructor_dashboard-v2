/**
 * Fulltime Calendar Normalizer — Phase 1-2
 *
 * 전임 캘린더 raw row → TeachingHistory 후보로 정규화.
 * - row_with_instructor kind: 강사명 컬럼 → instructor name
 * - fixed_instructor kind: spec의 fixedInstructorName 사용
 * - 진행확정여부=O 또는 빈칸인 row만 캡처 (X/논의단계 제외)
 * - 교육일정 / 출강 일정 텍스트 → startDate/endDate 파싱
 */
import type { RawFulltimeRow } from "./fulltime-calendar-collector";

export interface NormalizedFulltimeRow {
  spreadsheetId: string;
  tabTitle: string;
  rowNumber: number;
  instructorName: string | null;
  companyName: string | null;
  courseName: string | null;
  startDate: Date | null;
  endDate: Date | null;
  dateLabel: string | null;
  totalHours: number | null;
  detailType: string | null; // 출강유형 (메인강사/보조강사/실습코치)
  monthLabel: string | null; // 출강 월 (수습/9월/...)
}

function emptyToNull(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const t = v.trim();
  return t.length === 0 ? null : t;
}

function parseNumberLike(v: string | null): number | null {
  if (!v) return null;
  const digits = v.replace(/[hH시간,\s]/g, "");
  if (!digits) return null;
  const n = Number.parseFloat(digits);
  return Number.isFinite(n) ? n : null;
}

/**
 * 교육일정 / 출강 일정 텍스트에서 startDate / endDate를 파싱.
 *
 * 지원 패턴:
 *   - "2025.8.19 (화) 09:30~17:30"
 *   - "2025.10.22(수)"
 *   - "2025. 11.13.(목) 10:00~12:00"
 *   - "2025년 12월 22일 (월) 08:30~17:00"
 *   - "2025.10.28~2025.11.27 9:00~10:00" (range)
 *   - "2025.09~2025.10 9:00~10:00" (month-only range — start=YYYY-MM-01, end=YYYY-MM-말일)
 *
 * 실패하면 둘 다 null.
 */
function parseDateLabel(label: string | null): {
  start: Date | null;
  end: Date | null;
} {
  if (!label) return { start: null, end: null };
  const cleaned = label.replace(/\s+/g, " ").trim();

  // "YYYY.M.D~YYYY.M.D" range
  const rangeYMD =
    /(\d{4})\s*[.년]\s*(\d{1,2})\s*[.월]\s*(\d{1,2})\.?\s*(?:\([^)]+\))?\s*(?:[~\-–]\s*|\s+to\s+|\s+~\s*)\s*(\d{4})?\s*[.년]?\s*(\d{1,2})\s*[.월]\s*(\d{1,2})\.?/u.exec(
      cleaned
    );
  if (rangeYMD) {
    const y1 = parseInt(rangeYMD[1], 10);
    const m1 = parseInt(rangeYMD[2], 10);
    const d1 = parseInt(rangeYMD[3], 10);
    const y2 = parseInt(rangeYMD[4] ?? rangeYMD[1], 10);
    const m2 = parseInt(rangeYMD[5], 10);
    const d2 = parseInt(rangeYMD[6], 10);
    const s = makeDate(y1, m1, d1);
    const e = makeDate(y2, m2, d2);
    if (s && e) return { start: s, end: e };
  }

  // "YYYY.M ~ YYYY.M" month-only range
  const rangeYM =
    /(\d{4})\s*[.년]\s*(\d{1,2})\s*[~\-–]\s*(\d{4})?\s*[.년]?\s*(\d{1,2})\s*(?:\.\s*\d{1,2})?(?!\s*월)/u.exec(
      cleaned
    );
  if (rangeYM && !rangeYMD) {
    const y1 = parseInt(rangeYM[1], 10);
    const m1 = parseInt(rangeYM[2], 10);
    const y2 = parseInt(rangeYM[3] ?? rangeYM[1], 10);
    const m2 = parseInt(rangeYM[4], 10);
    const s = makeDate(y1, m1, 1);
    const e = makeEndOfMonth(y2, m2);
    if (s && e) return { start: s, end: e };
  }

  // Multi-day pattern: 한 셀에 여러 일자 (개행으로 구분)
  // 예: "2025.07.14 (월) 8H\n2025.07.15 (화) 8H\n2025.07.21 (월) 8H"
  // 모든 매치 수집 → 첫번째=start, 마지막=end
  const allDates = [
    ...cleaned.matchAll(/(\d{4})\s*[.년]\s*(\d{1,2})\s*[.월]\s*(\d{1,2})\.?/gu),
  ];
  if (allDates.length > 0) {
    const valid: Date[] = [];
    for (const m of allDates) {
      const d = makeDate(
        parseInt(m[1], 10),
        parseInt(m[2], 10),
        parseInt(m[3], 10)
      );
      if (d) valid.push(d);
    }
    if (valid.length > 0) {
      valid.sort((a, b) => a.getTime() - b.getTime());
      return { start: valid[0], end: valid[valid.length - 1] };
    }
  }

  return { start: null, end: null };
}

function makeDate(y: number, m: number, d: number): Date | null {
  if (y < 2020 || y > 2030) return null;
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1) return null;
  return date;
}

function makeEndOfMonth(y: number, m: number): Date | null {
  if (y < 2020 || y > 2030) return null;
  if (m < 1 || m > 12) return null;
  const next = new Date(Date.UTC(y, m, 1));
  next.setUTCDate(0); // last day of m
  return next;
}

export function normalizeFulltimeRow(
  raw: RawFulltimeRow
): NormalizedFulltimeRow | null {
  const v = raw.values;

  // 진행확정여부 = O / true / ㅇ / 1 통과. X / false / 0 거부. 빈칸도 통과.
  // 신동원·김재성 탭은 "O" 입력, 공지연 탭은 체크박스("true") 입력 — 두 표기 모두 허용.
  if (raw.kind === "row_with_instructor") {
    const confirmation = emptyToNull(v["진행확정여부"]);
    if (confirmation) {
      const c = confirmation.trim().toLowerCase();
      if (c === "x" || c === "false" || c === "0" || c === "no") return null;
    }
  }

  const instructorName =
    raw.kind === "row_with_instructor"
      ? emptyToNull(v["강사명"])
      : raw.fixedInstructorName ?? null;
  if (!instructorName) return null;

  const companyName = emptyToNull(v["기업"]);
  const courseName = emptyToNull(v["과정명"]);
  const dateLabel =
    emptyToNull(v["교육일정"]) ??
    emptyToNull(v["출강 일정"]) ??
    emptyToNull(v["출강일정"]) ??
    emptyToNull(v["일정"]);

  const totalHours =
    parseNumberLike(v["출강시간(총)"]) ??
    parseNumberLike(v["출강 시간(총)"]) ??
    parseNumberLike(v["시수"]);

  const detailType =
    emptyToNull(v["출강유형"]) ??
    emptyToNull(v["강사 유형"]) ??
    emptyToNull(v["구분"]);

  const monthLabel = emptyToNull(v["출강 월"]);

  const { start, end } = parseDateLabel(dateLabel);

  return {
    spreadsheetId: raw.spreadsheetId,
    tabTitle: raw.tabTitle,
    rowNumber: raw.rowNumber,
    instructorName,
    companyName,
    courseName,
    startDate: start,
    endDate: end,
    dateLabel,
    totalHours,
    detailType,
    monthLabel,
  };
}

export function normalizeFulltimeRows(
  rawRows: RawFulltimeRow[]
): NormalizedFulltimeRow[] {
  const out: NormalizedFulltimeRow[] = [];
  for (const r of rawRows) {
    const n = normalizeFulltimeRow(r);
    if (n) out.push(n);
  }
  return out;
}
