/**
 * Ground-truth Stage C — pure helpers.
 *
 * `/api/admin/ground-truth-resolve` route 의 Stage C 강화 룰 중
 * non-lecture blocklist 와 stage-c status 판정 함수를 분리해
 * 단위 테스트와 회귀 fixture 검증을 가능하게 한다.
 *
 * 회귀 케이스(2026-05-29):
 *   소준섭 record (2025-10-15, score 4.78) 의 Stage C course_id 256054
 *   `HD한국조선해양_2026 AIC AI 역량 평가문제출제 및 채점 계약서` 매칭은
 *   false_positive — 일정 단독 매칭이 문항개발 계약을 강의로 오인했다.
 *   해당 케이스가 Stage C에서 제외되거나, cross-source 부재 시
 *   low_confidence_stage_c 로 분류되어야 한다.
 */

/**
 * 강의가 아닌 문항 출제/채점/자문/평가문제 개발/장기 과제 TH 패턴.
 * 응답 인원·만족도 평가가 발생하지 않으므로 satisfaction record 매칭 제외.
 */
export const NON_LECTURE_PATTERNS: RegExp[] = [
  /문항\s*출제/,
  /문항\s*개발/,
  /평가\s*문제\s*출제/,
  /평가\s*문제\s*개발/,
  /역량\s*평가\s*문제/,
  /채점/,
  /자문/,
  /컨설팅\s*계약/,
  /(?<!공동\s)연구\s*용역/,
  /\b문항\b/,
  /\b출제\b/,
];

export interface NonLectureProbeInput {
  courseName: string | null;
  specialNotes: string | null;
  detailType: string | null;
  contractType: string | null;
  startDate: Date | null;
  endDate: Date | null;
  /** Prisma Decimal, number, string 모두 허용. null = 미상. */
  totalHours: unknown;
}

/**
 * TH가 강의가 아닌 long-term 문항개발/자문/채점 계약인지 판별.
 * 매칭 시 사유 문자열 반환 (null = 강의 가능성 있음, 매칭 가능).
 */
export function detectNonLectureReason(t: NonLectureProbeInput): string | null {
  const haystack = [
    t.courseName ?? "",
    t.specialNotes ?? "",
    t.detailType ?? "",
    t.contractType ?? "",
  ].join(" | ");
  for (const pat of NON_LECTURE_PATTERNS) {
    if (pat.test(haystack)) {
      return `non_lecture_keyword:${pat.source}`;
    }
  }
  // 추가 휴리스틱: 90일 초과 span + totalHours 0/null = 장기 프로젝트 의심
  const start = t.startDate?.getTime() ?? null;
  const end = t.endDate?.getTime() ?? null;
  if (start !== null && end !== null) {
    const spanDays = (end - start) / (24 * 60 * 60 * 1000);
    if (spanDays > 90) {
      const totalHoursNum = coerceHours(t.totalHours);
      if (
        totalHoursNum === null ||
        !Number.isFinite(totalHoursNum) ||
        totalHoursNum <= 0
      ) {
        return `long_span_no_hours:${Math.round(spanDays)}d`;
      }
    }
  }
  return null;
}

function coerceHours(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === "object" && v !== null && "toString" in v) {
    const n = Number((v as { toString: () => string }).toString());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export interface CrossSourceSignal {
  found: boolean;
  slack_hits: number;
  gmail_hits: number;
  sample_refs: string[];
}

/**
 * Stage C 후보의 status 결정 — cross-source 신호 부재 시 강제 low_confidence_stage_c.
 *
 * - cross_source.found === true && confidence >= 0.75 → "resolved"
 * - 그 외 모두 → "low_confidence_stage_c"
 */
export function decideStageCStatus(
  confidence: number,
  crossSource: CrossSourceSignal
): "resolved" | "low_confidence_stage_c" {
  return crossSource.found && confidence >= 0.75
    ? "resolved"
    : "low_confidence_stage_c";
}
