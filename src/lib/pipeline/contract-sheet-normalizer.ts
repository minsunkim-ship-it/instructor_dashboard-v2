/**
 * Contract Sheet Normalizer — Pilot 4-1
 *
 * 04_data_pipeline.md 5-1-1절 헤더 매핑 + 6절 정규화 규칙.
 *
 * Pilot 4-1 확정 사항:
 * - company_name: 계약시트 직접 컬럼이 없으므로 항상 NULL
 * - detail_type: `계약서 유형 선택` 다음의 첫 번째 `세부 유형` (collector에서 canonical 인덱스로 해결됨)
 * - start_date: `강의 일정` 원문에서 파싱한 첫 날짜 (실패 시 NULL)
 * - end_date: `강의 일정` 원문에서 파싱한 마지막 날짜 (실패 시 NULL)
 * - date_label: `강의 일정` 원문을 그대로 보존
 */

import type { RawContractRow } from "./contract-sheet-collector";
import {
  parseContractSchedule,
  parseContractTimestamp,
} from "@/lib/contract-sheet-parser";

/**
 * instructor 매칭 + teaching_histories 저장에 필요한 정규화 결과.
 * source_ref 식별자(spreadsheetId, worksheetGid, rowNumber)를 함께 반영한다.
 */
export interface NormalizedContractRow {
  // source_ref identity — 04_data_pipeline.md 18-1 source-specific 식별자
  spreadsheetId: string;
  worksheetGid: number;
  rowNumber: number;

  // 강사 매칭 키 — 01_core_policy 4절 exact match
  name: string | null;

  // teaching_histories 필드 — 03_data_model 4-2절
  companyName: null; // Pilot 4-1 확정: 계약시트 직접 컬럼 없음
  courseName: string | null;
  courseId: string | null;
  startDate: Date | null;
  endDate: Date | null;
  dateLabel: string | null;
  dealFeeHourly: number | null;
  feeExtra: string | null;
  totalHours: number | null;
  totalSessions: number | null;
  contractType: string | null;
  detailType: string | null;
  specialNotes: string | null;
  timestampRaw: string | null;
  recordedAt: Date | null;
}

/** 6절: 빈 문자열은 NULL로 치환 */
function emptyToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/**
 * 5-1-1: `시간당 강사료 (ex. 250,000)` 파싱.
 * 쉼표/공백/`원` 제거 후 정수 파싱하고, `10000` 이하면 NULL.
 * 04_data_pipeline.md 16-3: `teaching_histories.deal_fee_hourly`는 숫자 정규화 후 10000 이하 값 NULL 처리.
 */
function parseFeeHourly(raw: string | null): number | null {
  const cleaned = emptyToNull(raw);
  if (!cleaned) return null;
  const digits = cleaned.replace(/[,\s원]/g, "");
  const n = Number.parseInt(digits, 10);
  if (!Number.isFinite(n)) return null;
  if (n <= 10000) return null;
  // 구분자 제거 후 여러 단가가 concat된 비정상 값(예: "165,000/150,000" → 165000150000) 가드.
  // 10,000,000원/시간을 초과하는 값은 기본 단가 후보에서 제외 — 03_data_model 4-2 INT4 범위 보호.
  if (n > 10_000_000) return null;
  return n;
}

/** 5-1-1 총 강의시수: 숫자 정규화 */
function parseNumberLike(raw: string | null): number | null {
  const cleaned = emptyToNull(raw);
  if (!cleaned) return null;
  const digits = cleaned.replace(/[,\s]/g, "");
  const n = Number.parseFloat(digits);
  return Number.isFinite(n) ? n : null;
}

/** 5-1-1 총 회차: 정수 정규화 */
function parseIntLike(raw: string | null): number | null {
  const n = parseNumberLike(raw);
  if (n === null) return null;
  return Math.round(n);
}

/**
 * 5-1-1절 헤더 매핑 기준으로 단일 행을 정규화한다.
 * 강사명(name)이 비어 있으면 null로 남겨 저장 단계에서 skip 처리한다.
 */
export function normalizeContractRow(
  raw: RawContractRow
): NormalizedContractRow {
  const v = raw.values;

  // 5-1-1 매핑
  const name = emptyToNull(v["강사명"]);
  const courseName = emptyToNull(v["강의 코스명 (코스명 전체 정확히)"]);
  const courseId = emptyToNull(v["강의 코스 ID (숫자만)"]);
  const dateLabel = emptyToNull(v["강의 일정"]);
  const dealFeeHourly = parseFeeHourly(v["시간당 강사료 (ex. 250,000)"] ?? null);
  const feeExtra = emptyToNull(v["강사료 외 (ex. 100,000 / 없으면 빈칸)"]);
  const totalHours = parseNumberLike(
    v["총 강의시수 (숫자로 기입 ex. 8) 회차 * 시수 (총= 모든 합을 더한수)"] ?? null
  );
  const totalSessions = parseIntLike(v["총 회차 (ex. 2)"] ?? null);
  const contractType = emptyToNull(v["강사 계약 유형"]);
  const detailType = emptyToNull(v["세부 유형"]);
  const specialNotes = emptyToNull(v["기타-계약관련 특이사항 기재"]);
  const timestamp = parseContractTimestamp(v["타임스탬프"] ?? null);

  // 날짜 파싱 — Pilot 4-1 확정
  const schedule = parseContractSchedule(dateLabel, timestamp.yearHint);
  const startDate = schedule.startDate;
  const endDate = schedule.endDate;

  return {
    spreadsheetId: raw.spreadsheetId,
    worksheetGid: raw.worksheetGid,
    rowNumber: raw.rowNumber,

    name,

    companyName: null, // Pilot 4-1 확정: 계약시트 직접 컬럼 없음
    courseName,
    courseId,
    startDate,
    endDate,
    dateLabel,
    dealFeeHourly,
    feeExtra,
    totalHours,
    totalSessions,
    contractType,
    detailType,
    specialNotes,
    timestampRaw: timestamp.raw,
    recordedAt: timestamp.recordedAt,
  };
}
