import {
  parseContractSchedule,
  toDateOnlyString,
} from "@/lib/contract-sheet-parser";
import { isNonTeachingCompensationItem } from "@/lib/teaching-history-kind";

export interface TeachingHistoryDisplayItem {
  id?: string;
  course_name?: string | null;
  company_name?: string | null;
  course_id?: string | null;
  deal_fee_hourly?: number | null;
  contract_type?: string | null;
  detail_type?: string | null;
  fee_extra?: string | null;
  special_notes?: string | null;
  start_date?: string | Date | null;
  end_date?: string | Date | null;
  date_label?: string | null;
  total_sessions?: number | null;
  total_hours?: number | string | null;
}

export interface GroupedTeachingHistory extends TeachingHistoryDisplayItem {
  display_title: string;
  display_company: string | null;
  source_count: number;
  total_sessions: number | null;
  total_hours: number | null;
}

function toDateOnly(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) {
    return value.toISOString().split("T")[0];
  }
  return value.split("T")[0] ?? value;
}

function parseHours(value: number | string | null | undefined): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseFee(value: number | string | null | undefined): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeText(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized === "" ? null : normalized;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatCompactMoney(amount: number): string {
  const man = amount / 10000;
  return Number.isInteger(man) ? `${man}만원` : `${man.toFixed(1)}만원`;
}

function extractAmountLabels(value: string | null | undefined): string[] {
  const text = normalizeText(value);
  if (!text) return [];

  const labels: string[] = [];
  const seen = new Set<number>();
  const regex = /(\d+(?:[.,]\d+)*)\s*(만\s*원?|원)?/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const raw = match[1]?.replace(/,/g, "");
    const unit = match[2] ?? "";
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) continue;

    let amount: number;
    if (unit.startsWith("만")) {
      amount = Math.round(parsed * 10000);
    } else if (!unit && parsed < 1000) {
      amount = Math.round(parsed * 10000);
    } else {
      amount = Math.round(parsed);
    }

    if (amount <= 0 || seen.has(amount)) continue;
    seen.add(amount);
    labels.push(formatCompactMoney(amount));
  }

  return labels;
}

function getSpecialItemLabel(item: TeachingHistoryDisplayItem): string | null {
  const detailType = normalizeText(item.detail_type);
  const amountLabels = extractAmountLabels(item.fee_extra);

  if (detailType && amountLabels.length > 0) {
    return amountLabels.length === 1
      ? `${detailType} ${amountLabels[0]}`
      : `${detailType} ${amountLabels[0]} 외 ${amountLabels.length - 1}건`;
  }

  if (detailType) return detailType;

  if (amountLabels.length > 0) {
    return amountLabels.length === 1
      ? `특수 금액 ${amountLabels[0]}`
      : `특수 금액 ${amountLabels[0]} 외 ${amountLabels.length - 1}건`;
  }

  return null;
}

function stripIterationSuffix(value: string | null | undefined): string | null {
  const normalized = normalizeText(value);
  if (!normalized) return null;

  return normalized
    .replace(/\s*[\(\[]\s*\d+\s*(회차|차수)\s*[\)\]]\s*$/u, "")
    .replace(/\s+\d+\s*(회차|차수)\s*$/u, "")
    .trim();
}

export function normalizeCompanyKey(value: string | null | undefined): string {
  return (stripIterationSuffix(value) ?? "")
    .replace(/\s+/g, "")
    .trim()
    .toLowerCase();
}

function stripLeadingCourseMeta(value: string): string {
  let next = value;

  while (true) {
    const updated = next
      .replace(/^\[(?:부가세\s*별도|vat\s*별도|vat)\]\s*/iu, "")
      .replace(/^\((?:B2B|B2C|온라인|오프라인|비대면|대면|집합)\)\s*/iu, "")
      .trim();

    if (updated === next) {
      return updated;
    }

    next = updated;
  }
}

function stripCourseCompanyPrefix(
  value: string,
  companyName: string | null | undefined
): string {
  const company = stripIterationSuffix(companyName);
  if (!company) return value;

  const exactPrefix = new RegExp(
    `^${escapeRegExp(company)}(?:\\([^)]*\\))?[\\s_:/-]+`,
    "u"
  );

  return value.replace(exactPrefix, "").trim();
}

function stripLeadingUnderscorePrefix(value: string): string {
  const underscoreIndex = value.indexOf("_");
  if (underscoreIndex <= 0) return value;

  const prefix = value.slice(0, underscoreIndex).trim();
  const suffix = value.slice(underscoreIndex + 1).trim();

  if (!suffix) return value;
  if (prefix.length > 30) return value;

  return suffix;
}

function stripTrailingCourseMeta(value: string): string {
  let next = value;

  while (true) {
    const updated = next
      .replace(
        /\s*[_-]?\s*\((?:오프라인|온라인|비대면|대면|집합|단기|장기)[^)]*\)\s*$/u,
        ""
      )
      .replace(
        /\s*[_-]?\s*(?:19|20|21|22|23|24|25|26)\s*년\s*\d{1,2}\s*월\s*$/u,
        ""
      )
      .replace(/\s*[_-]?\s*\((?:19|20)\d{2}\)\s*$/u, "")
      .replace(/\s*\((?:오프라인|온라인|비대면|대면|집합|단기|장기)[^)]*$/u, "")
      .trim();

    if (updated === next) {
      return updated;
    }

    next = updated;
  }
}

function compactCourseTitle(item: TeachingHistoryDisplayItem): string | null {
  const courseName = normalizeText(item.course_name);
  if (!courseName) return null;

  const withoutUnderscorePrefix = stripLeadingUnderscorePrefix(courseName);
  const withSpaces = withoutUnderscorePrefix
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const withoutLeadingMeta = stripLeadingCourseMeta(withSpaces);
  const withoutCompanyPrefix = stripCourseCompanyPrefix(
    withoutLeadingMeta,
    item.company_name
  );
  const withoutTrailingMeta = stripTrailingCourseMeta(withoutCompanyPrefix);

  return normalizeText(withoutTrailingMeta) ?? courseName;
}

export function extractTeachingHistoryRange(
  item: TeachingHistoryDisplayItem
): { start_date: string | null; end_date: string | null } {
  const startDate = toDateOnly(item.start_date);
  const endDate = toDateOnly(item.end_date);

  if (startDate || endDate) {
    return {
      start_date: startDate,
      end_date: endDate,
    };
  }

  const parsed = parseContractSchedule(item.date_label ?? null);
  return {
    start_date: toDateOnlyString(parsed.startDate),
    end_date: toDateOnlyString(parsed.endDate),
  };
}

function getOverlapRange(
  item: TeachingHistoryDisplayItem,
  fromDate: string,
  untilDate: string
): { start_date: string; end_date: string } | null {
  const range = extractTeachingHistoryRange(item);
  const startDate = range.start_date ?? range.end_date;
  const endDate = range.end_date ?? range.start_date;

  if (!startDate || !endDate) return null;
  if (endDate < fromDate) return null;
  if (startDate > untilDate) return null;

  return {
    start_date: startDate,
    end_date: endDate,
  };
}

function getCourseSignature(item: TeachingHistoryDisplayItem): string {
  const courseName = normalizeText(item.course_name) ?? "";
  const companyName = normalizeCompanyKey(item.company_name);
  const courseId = normalizeText(item.course_id) ?? "";
  const specialLabel = getSpecialItemLabel(item) ?? "";

  if (courseId) {
    return ["course_id", courseId].join("||");
  }

  if (courseName) {
    return ["course_name", courseName, companyName].join("||");
  }

  if (specialLabel) {
    return [
      "special_item",
      specialLabel,
      item.date_label?.trim() ?? "",
      companyName,
    ].join("||");
  }

  if (companyName) {
    return ["company_name", companyName].join("||");
  }

  const range = extractTeachingHistoryRange(item);
  return [
    "__untitled__",
    range.start_date ?? "",
    range.end_date ?? "",
    item.date_label?.trim() ?? "",
  ].join("||");
}

export function getTeachingHistoryDedupSignature(
  item: TeachingHistoryDisplayItem
): string {
  const range = extractTeachingHistoryRange(item);
  const totalHours = parseHours(item.total_hours);
  const dealFeeHourly = parseFee(item.deal_fee_hourly);

  return [
    item.course_name?.trim() ?? "",
    normalizeCompanyKey(item.company_name),
    item.course_id?.trim() ?? "",
    dealFeeHourly ?? "",
    item.contract_type?.trim() ?? "",
    item.detail_type?.trim() ?? "",
    item.fee_extra?.trim() ?? "",
    item.special_notes?.trim() ?? "",
    range.start_date ?? "",
    range.end_date ?? "",
    item.total_sessions ?? "",
    totalHours ?? "",
    item.date_label?.trim() ?? "",
  ].join("||");
}

export function dedupeTeachingHistories(
  items: TeachingHistoryDisplayItem[],
  options?: {
    fromDate?: string;
    untilDate?: string;
  }
): TeachingHistoryDisplayItem[] {
  const fromDate = options?.fromDate ?? "2025-01-01";
  const untilDate =
    options?.untilDate ?? new Date().toISOString().split("T")[0];
  const unique = new Map<string, TeachingHistoryDisplayItem>();

  for (const item of items) {
    if (isNonTeachingCompensationItem(item)) continue;

    const overlap = getOverlapRange(item, fromDate, untilDate);
    if (!overlap) continue;

    const signature = getTeachingHistoryDedupSignature(item);
    if (!unique.has(signature)) {
      unique.set(signature, {
        ...item,
        start_date: overlap.start_date,
        end_date: overlap.end_date,
      });
    }
  }

  return Array.from(unique.values());
}

export function calculateTeachingHistoryTotalPaid(
  items: TeachingHistoryDisplayItem[],
  options?: {
    fromDate?: string;
    untilDate?: string;
  }
): number | null {
  const deduped = dedupeTeachingHistories(items, options);
  const payable = deduped
    .map((item) => ({
      fee: parseFee(item.deal_fee_hourly),
      hours: parseHours(item.total_hours),
    }))
    .filter(
      (item): item is { fee: number; hours: number } =>
        item.fee !== null && item.hours !== null
    );

  if (payable.length === 0) {
    return null;
  }

  return payable.reduce((sum, item) => sum + item.fee * item.hours, 0);
}

export function getTeachingHistoryDisplayTitle(
  item: TeachingHistoryDisplayItem
): string {
  return (
    compactCourseTitle(item) ||
    (normalizeText(item.course_id)
      ? `코스ID ${normalizeText(item.course_id)}`
      : null) ||
    getSpecialItemLabel(item) ||
    stripIterationSuffix(item.company_name) ||
    "과정명 미확인"
  );
}

export function getTeachingHistoryDisplayCompany(
  item: TeachingHistoryDisplayItem
): string | null {
  return stripIterationSuffix(item.company_name);
}

export function groupTeachingHistories(
  items: TeachingHistoryDisplayItem[],
  options?: {
    fromDate?: string;
    untilDate?: string;
  }
): GroupedTeachingHistory[] {
  const unique = new Map<string, TeachingHistoryDisplayItem>();
  for (const item of dedupeTeachingHistories(items, options)) {
    unique.set(getTeachingHistoryDedupSignature(item), item);
  }

  const grouped = new Map<string, GroupedTeachingHistory>();

  for (const item of unique.values()) {
    const groupKey = getCourseSignature(item);
    const startDate = toDateOnly(item.start_date);
    const endDate = toDateOnly(item.end_date);
    const totalHours = parseHours(item.total_hours);
    const totalSessions = item.total_sessions ?? null;
    const existing = grouped.get(groupKey);

    if (!existing) {
      grouped.set(groupKey, {
        ...item,
        start_date: startDate,
        end_date: endDate,
        total_sessions: totalSessions && totalSessions > 0 ? totalSessions : null,
        total_hours: totalHours && totalHours > 0 ? totalHours : null,
        display_title: getTeachingHistoryDisplayTitle(item),
        display_company: getTeachingHistoryDisplayCompany(item),
        source_count: 1,
      });
      continue;
    }

    if (startDate && (!existing.start_date || startDate < existing.start_date)) {
      existing.start_date = startDate;
    }
    if (endDate && (!existing.end_date || endDate > existing.end_date)) {
      existing.end_date = endDate;
    }
    if (!existing.course_name && item.course_name) {
      existing.course_name = item.course_name;
    }
    if (!existing.company_name && item.company_name) {
      existing.company_name = item.company_name;
    }
    if (!existing.course_id && item.course_id) {
      existing.course_id = item.course_id;
    }
    if (totalSessions && totalSessions > 0) {
      existing.total_sessions = (existing.total_sessions ?? 0) + totalSessions;
    }
    if (totalHours && totalHours > 0) {
      existing.total_hours = (existing.total_hours ?? 0) + totalHours;
    }
    existing.display_title = getTeachingHistoryDisplayTitle(existing);
    const nextDisplayCompany = getTeachingHistoryDisplayCompany(item);
    if (!existing.display_company) {
      existing.display_company = nextDisplayCompany;
    } else if (
      nextDisplayCompany &&
      normalizeCompanyKey(existing.display_company) !==
        normalizeCompanyKey(nextDisplayCompany)
    ) {
      const existingBase = stripIterationSuffix(existing.display_company);
      const nextBase = stripIterationSuffix(nextDisplayCompany);
      existing.display_company =
        existingBase && nextBase && existingBase === nextBase
          ? existingBase
          : null;
    }
    existing.source_count += 1;
  }

  return Array.from(grouped.values()).sort((a, b) => {
    const aEnd = toDateOnly(a.end_date) ?? toDateOnly(a.start_date) ?? "";
    const bEnd = toDateOnly(b.end_date) ?? toDateOnly(b.start_date) ?? "";
    const endCompare = bEnd.localeCompare(aEnd);
    if (endCompare !== 0) return endCompare;

    const aStart = toDateOnly(a.start_date) ?? "";
    const bStart = toDateOnly(b.start_date) ?? "";
    const startCompare = bStart.localeCompare(aStart);
    if (startCompare !== 0) return startCompare;

    return a.display_title.localeCompare(b.display_title, "ko");
  });
}

export function countGroupedTeachingHistories(
  items: TeachingHistoryDisplayItem[],
  options?: {
    fromDate?: string;
    untilDate?: string;
  }
): number {
  return groupTeachingHistories(items, options).length;
}

export function sumGroupedTeachingHistoryHours(
  items: TeachingHistoryDisplayItem[],
  options?: {
    fromDate?: string;
    untilDate?: string;
  }
): number {
  return groupTeachingHistories(items, options).reduce(
    (sum, item) => sum + (item.total_hours ?? 0),
    0
  );
}
