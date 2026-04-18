import { parseContractSchedule } from "@/lib/contract-sheet-parser";
import type { RawInstructorDispatchRow } from "./instructor-dispatch-sheet-collector";

export interface NormalizedInstructorDispatchRow {
  sourceKey: string;
  spreadsheetId: string;
  worksheetGid: number;
  rowNumber: number;
  name: string;
  companyName: string | null;
  courseName: string | null;
  courseId: null;
  startDate: Date | null;
  endDate: Date | null;
  dateLabel: string | null;
  dealFeeHourly: null;
  feeExtra: null;
  totalHours: number | null;
  totalSessions: number | null;
  contractType: string | null;
  detailType: string | null;
  specialNotes: string | null;
  sourceRefExtras: Record<string, string | number | null>;
}

function emptyToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function parseNumberLike(value: string | null | undefined): number | null {
  const normalized = emptyToNull(value);
  if (!normalized) return null;

  const digits = normalized.replace(/[^\d.]/g, "");
  if (!digits) return null;

  const parsed = Number.parseFloat(digits);
  return Number.isFinite(parsed) ? parsed : null;
}

function deriveSessionCount(dateLabel: string | null): number | null {
  if (!dateLabel) return null;

  const schedule = parseContractSchedule(dateLabel);
  if (schedule.dates.length > 0) {
    return schedule.dates.length;
  }

  return 1;
}

export function normalizeInstructorDispatchRow(
  raw: RawInstructorDispatchRow
): NormalizedInstructorDispatchRow {
  const v = raw.values;
  const dateLabel = emptyToNull(v["출강 일정"]);
  const schedule = parseContractSchedule(dateLabel);

  return {
    sourceKey: raw.sourceKey,
    spreadsheetId: raw.spreadsheetId,
    worksheetGid: raw.worksheetGid,
    rowNumber: raw.rowNumber,
    name: raw.instructorName,
    companyName: emptyToNull(v["기업"]),
    courseName: emptyToNull(v["과정명"]),
    courseId: null,
    startDate: schedule.startDate,
    endDate: schedule.endDate,
    dateLabel,
    dealFeeHourly: null,
    feeExtra: null,
    totalHours:
      parseNumberLike(v["출강 시간(총)"]) ??
      parseNumberLike(v["책정 시간(강사 확인)"]) ??
      parseNumberLike(v["책정시간"]),
    totalSessions: deriveSessionCount(dateLabel),
    contractType: emptyToNull(v["구분"]),
    detailType: emptyToNull(v["강사 유형"]),
    specialNotes: emptyToNull(v["비고"]),
    sourceRefExtras: {
      source_key: raw.sourceKey,
      team: emptyToNull(v["담당 팀"]),
      learning_director: emptyToNull(v["담당 LD"]),
      dispatch_month: emptyToNull(v["출강 월"]),
      detail_hours: emptyToNull(v["상세 시간"]),
      total_hours_raw: emptyToNull(v["출강 시간(총)"]),
      planned_hours: emptyToNull(v["책정시간"]),
      confirmed_hours: emptyToNull(v["책정 시간(강사 확인)"]),
      location: emptyToNull(v["지역"]),
      curriculum: emptyToNull(v["커리큘럼"]),
      satisfaction_link: emptyToNull(v["만족도(링크)"]),
      instructor_satisfaction: emptyToNull(v["(강사) 만족도"]),
    },
  };
}
