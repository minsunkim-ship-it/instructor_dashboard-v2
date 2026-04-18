type NullableString = string | null | undefined;
type NullableNumber = number | null | undefined;

export interface TeachingHistoryKindLike {
  courseId?: NullableString;
  course_id?: NullableString;
  courseName?: NullableString;
  course_name?: NullableString;
  dealFeeHourly?: NullableNumber;
  deal_fee_hourly?: NullableNumber;
  feeExtra?: NullableString;
  fee_extra?: NullableString;
  detailType?: NullableString;
  detail_type?: NullableString;
  specialNotes?: NullableString;
  special_notes?: NullableString;
}

const SPECIAL_ITEM_KEYWORDS = ["출장비", "건당", "별도"];

function normalizeText(value: NullableString): string | null {
  if (!value) return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized === "" ? null : normalized;
}

function containsSpecialKeyword(value: NullableString): boolean {
  const text = normalizeText(value);
  if (!text) return false;
  return SPECIAL_ITEM_KEYWORDS.some((keyword) => text.includes(keyword));
}

function getCourseId(item: TeachingHistoryKindLike): string | null {
  return normalizeText(item.courseId ?? item.course_id);
}

function getCourseName(item: TeachingHistoryKindLike): string | null {
  return normalizeText(item.courseName ?? item.course_name);
}

function getDetailType(item: TeachingHistoryKindLike): string | null {
  return normalizeText(item.detailType ?? item.detail_type);
}

function getFeeExtra(item: TeachingHistoryKindLike): string | null {
  return normalizeText(item.feeExtra ?? item.fee_extra);
}

function getSpecialNotes(item: TeachingHistoryKindLike): string | null {
  return normalizeText(item.specialNotes ?? item.special_notes);
}

function getDealFeeHourly(item: TeachingHistoryKindLike): number | null {
  const raw = item.dealFeeHourly ?? item.deal_fee_hourly;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

/**
 * 출강 이력이 아니라 별도 정산 항목(출장비, 건당 비용 등)인 계약 행을 판별한다.
 * 이 항목은 teaching history/count에서는 제외하고, fee history/special item으로만 다룬다.
 */
export function isNonTeachingCompensationItem(
  item: TeachingHistoryKindLike
): boolean {
  const detailType = getDetailType(item);
  const feeExtra = getFeeExtra(item);
  const specialNotes = getSpecialNotes(item);
  const courseId = getCourseId(item);
  const courseName = getCourseName(item);
  const dealFeeHourly = getDealFeeHourly(item);

  if (detailType?.includes("출장비")) {
    return true;
  }

  if (detailType && containsSpecialKeyword(detailType) && dealFeeHourly === null) {
    return true;
  }

  if (
    !courseId &&
    !courseName &&
    dealFeeHourly === null &&
    (containsSpecialKeyword(feeExtra) || containsSpecialKeyword(specialNotes))
  ) {
    return true;
  }

  return false;
}

