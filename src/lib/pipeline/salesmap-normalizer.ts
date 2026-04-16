/**
 * Salesmap Normalizer — Pilot 4-3
 *
 * 04_data_pipeline.md 5-3절, 5-3-1절: 강사 이름1~5 / 강사료1~5 unpivot
 * 04_data_pipeline.md 6절: 정규화 규칙 (trim, 빈값→null, 날짜 표준화, 금액 정수화)
 *
 * Pilot 4-3 확정 사항:
 * - 세일즈맵 `강사료`는 시간당 단가와 총액이 섞여 있을 수 있으므로, 기본 단가로 확정하지 않는다.
 * - 본 normalizer 는 fee 를 "hourly-interpretable 후보"로만 분류하고 별도 필드에 담는다.
 * - 특수 금액 키워드는 강사료 셀에 포함되지 않는 숫자 필드이므로 여기서는 범위 기반 판정만 수행한다.
 */

import type { RawSalesmapDeal } from "./salesmap-collector";

/** unpivot 후 단일 (deal × instructor slot) 레벨 row */
export interface NormalizedSalesmapRow {
  dealId: string;
  organizationId: string | null;
  slot: number;

  instructorName: string | null;

  companyName: string | null; // organization.이름
  courseName: string | null; // deal.이름
  courseId: string | null; // deal.코스 ID

  startDate: Date | null;
  endDate: Date | null;

  /**
   * 세일즈맵 기준 최근 활동일 후보.
   * 04_data_pipeline 5-3-1: `최근 파이프라인 수정 날짜` > `최근 노트 작성일` > `수정 날짜`
   */
  lastActivityAt: Date | null;

  /**
   * 시간당 단가로 해석 가능한 강사료 후보. 해석 불가(총액/특수 금액 포함 또는 파싱 실패)면 null.
   * 04_data_pipeline 12절 fee fallback 후보로만 사용 가능하며, 본 파일럿에서는 집계/보고용으로만 사용한다.
   */
  hourlyFeeCandidate: number | null;

  /** 강사료 원문(숫자 파싱 가능 여부와 무관하게 보존). 파이프라인 요약에만 사용. */
  feeRaw: string | null;
}

/** 6절: 빈 문자열은 null 로 치환 */
function emptyToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * 세일즈맵 날짜 값은 ISO-8601 timestamp 문자열 또는 빈값이다.
 * 파싱 실패 시 null 반환.
 */
function parseDate(raw: string | null | undefined): Date | null {
  const cleaned = emptyToNull(raw ?? null);
  if (!cleaned) return null;
  const d = new Date(cleaned);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

/**
 * 세일즈맵 강사료 문자열을 시간당 단가 후보 숫자로 파싱한다.
 *
 * 시간당 단가 후보 인정 조건 (04_data_pipeline 12-1, 01_core_policy 8절 기반):
 *  - 숫자 파싱 성공
 *  - 10_000 초과
 *  - 3_000_000 이하 (월 단위/총액/특수 금액 가드)
 *
 * 위 조건을 벗어나는 값은 총액 또는 특수 금액 후보로 간주해 `hourlyFeeCandidate` 를 null 로 둔다.
 * feeRaw 에는 원문 문자열이 그대로 보존된다.
 */
function parseHourlyFeeCandidate(raw: string | null | undefined): number | null {
  const cleaned = emptyToNull(raw ?? null);
  if (!cleaned) return null;
  const digits = cleaned.replace(/[,\s원]/g, "");
  const n = Number.parseFloat(digits);
  if (!Number.isFinite(n)) return null;
  const intVal = Math.round(n);
  if (intVal <= 10_000) return null;
  if (intVal > 3_000_000) return null;
  return intVal;
}

/**
 * 단일 deal row 를 instructor slot 기준으로 펼쳐 NormalizedSalesmapRow[] 를 생성한다.
 * 강사 이름이 비어 있는 slot 은 제외한다.
 */
export function normalizeSalesmapDeal(
  deal: RawSalesmapDeal
): NormalizedSalesmapRow[] {
  const startDate = parseDate(deal.start_date);
  const endDate = parseDate(deal.end_date);

  // 5-3-1: 최근 활동일 후보 우선순위 — 파이프라인 수정 > 노트 > 수정
  const lastActivityAt =
    parseDate(deal.recent_pipeline_edit) ??
    parseDate(deal.recent_note) ??
    parseDate(deal.recent_modified);

  const companyName = emptyToNull(deal.company_name);
  const courseName = emptyToNull(deal.course_name);
  const courseId = emptyToNull(deal.course_id);

  const rows: NormalizedSalesmapRow[] = [];

  for (const slot of deal.instructor_slots) {
    const name = emptyToNull(slot.name);
    if (!name) continue;

    const feeRaw = emptyToNull(slot.fee);
    const hourlyFeeCandidate = parseHourlyFeeCandidate(feeRaw);

    rows.push({
      dealId: deal.deal_id,
      organizationId: deal.organization_id,
      slot: slot.slot,
      instructorName: name,
      companyName,
      courseName,
      courseId,
      startDate,
      endDate,
      lastActivityAt,
      hourlyFeeCandidate,
      feeRaw,
    });
  }

  return rows;
}

/**
 * 전체 deal 목록을 unpivot 하여 slot 레벨 정규화 row 배열을 반환한다.
 */
export function normalizeSalesmapDeals(
  deals: RawSalesmapDeal[]
): NormalizedSalesmapRow[] {
  const out: NormalizedSalesmapRow[] = [];
  for (const d of deals) {
    out.push(...normalizeSalesmapDeal(d));
  }
  return out;
}
