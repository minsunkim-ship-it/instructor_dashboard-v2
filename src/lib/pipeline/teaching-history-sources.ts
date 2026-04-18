/**
 * 출강 건수 집계에 포함할 canonical teaching_history source 목록.
 *
 * `contract_sheet_rows` 필드명은 legacy지만, 실제로는 계약시트와
 * 강사별 출강시트 모두를 포함한 "출강 sheet 기반 이력 수"를 의미한다.
 */
export const COURSE_COUNT_SOURCE_TYPES = [
  "contract_sheet",
  "instructor_dispatch_sheet",
] as const;

export type CourseCountSourceType =
  (typeof COURSE_COUNT_SOURCE_TYPES)[number];
