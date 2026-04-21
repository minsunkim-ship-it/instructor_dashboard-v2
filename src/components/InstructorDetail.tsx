"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useCallback, useRef } from "react";
import type {
  InstructorDetailResponse,
  InstructorDetailData,
  SatisfactionCreateResponse,
} from "@/types/api";
import {
  parseContractSchedule,
  toDateOnlyString,
} from "@/lib/contract-sheet-parser";
import {
  groupTeachingHistories,
  getTeachingHistoryDisplayCompany,
  getTeachingHistoryDisplayTitle,
  type TeachingHistoryDisplayItem,
} from "@/lib/teaching-history-display";

// --- Fetch helpers ---

async function fetchInstructorDetail(
  id: string,
  teachingHistoryLimit: number
): Promise<InstructorDetailResponse> {
  const searchParams = new URLSearchParams({
    teaching_history_limit: String(teachingHistoryLimit),
  });
  const res = await fetch(`/api/instructors/${id}?${searchParams.toString()}`);
  if (!res.ok) throw new Error("상세 조회 실패");
  return res.json();
}

async function postSatisfaction(
  instructorId: string,
  body: {
    score: number;
    comment?: string;
    company_name?: string;
    course_name?: string;
    response_date?: string;
  }
): Promise<SatisfactionCreateResponse> {
  const res = await fetch(`/api/instructors/${instructorId}/satisfaction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    throw new Error(
      err?.errors?.[0]?.message ?? "만족도 저장에 실패했습니다."
    );
  }
  return res.json();
}

// --- Formatting helpers ---

function formatScore(score: number | null): string {
  if (score === null) return "-";
  return score.toFixed(1);
}

function formatMoney(won: number | null): string {
  if (won === null) return "-";
  const man = won / 10000;
  if (man === Math.floor(man)) return `${Math.floor(man)}만원`;
  return `${man.toFixed(1)}만원`;
}

function formatMoneyPerHour(won: number | null, isFulltime: boolean): string {
  if (isFulltime) return "전임강사";
  if (won === null) return "-";
  const man = won / 10000;
  if (man === Math.floor(man)) return `${Math.floor(man)}만원/시간`;
  return `${man.toFixed(1)}만원/시간`;
}

function formatHours(hours: number): string {
  if (hours === Math.floor(hours)) return `${hours}시간`;
  return `${hours.toFixed(1)}시간`;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "-";
  return dateStr.replace(/-/g, ".");
}

function getTodayDateInputValue(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatDateRange(
  startDate: string | null,
  endDate: string | null
): string {
  if (startDate && endDate) {
    const start = formatDate(startDate);
    const end = formatDate(endDate);
    return start === end ? start : `${start} ~ ${end}`;
  }
  if (startDate) return formatDate(startDate);
  if (endDate) return formatDate(endDate);
  return "-";
}

function getOperationalNoteDate(
  note: InstructorDetailData["raw_operational_notes"][number]
): string | null {
  const sourceRef = note.source_ref ?? {};
  const sourceDateCandidates = [
    note.observed_at,
    typeof sourceRef.observed_at === "string" ? sourceRef.observed_at : null,
    typeof sourceRef.date === "string" ? sourceRef.date : null,
    typeof sourceRef.event_date === "string" ? sourceRef.event_date : null,
    note.ingested_at ? note.ingested_at.slice(0, 10) : null,
  ];

  return (
    sourceDateCandidates.find(
      (value): value is string =>
        typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)
    ) ?? null
  );
}

function formatOperationalSourceLabel(sourceType: string): string {
  switch (sourceType) {
    case "teaching_feedback_qualitative":
      return "정성 피드백";
    case "teaching_feedback_ops":
      return "운영 피드백";
    case "notion_comment":
      return "노션 comment";
    case "slack_highlight":
      return "슬랙";
    case "curated_ops":
      return "Curated Ops";
    default:
      return sourceType;
  }
}

type RecentSatisfactionEntry = {
  key: string;
  observedAt: string | null;
  companyName: string | null;
  courseName: string | null;
  sessionLabel: string | null;
};

function buildRecentSatisfactionEntries(
  data: InstructorDetailData
): RecentSatisfactionEntry[] {
  return (data.recent_satisfaction_history ?? [])
    .map((item, index) => ({
      key: `${item.observed_at ?? "unknown"}::${item.company_name ?? ""}::${item.course_name ?? ""}::${item.session_label ?? ""}::${index}`,
      observedAt: item.observed_at,
      companyName: item.company_name,
      courseName: item.course_name,
      sessionLabel: item.session_label,
    }))
    .sort((a, b) => (b.observedAt ?? "").localeCompare(a.observedAt ?? ""));
}

function buildHeaderTags(data: InstructorDetailData) {
  return [
    ...data.categories.map((item) => ({
      key: `category-${item}`,
      label: item,
      className: "bg-indigo-50 text-indigo-700",
    })),
    ...data.specialties.map((item) => ({
      key: `specialty-${item}`,
      label: item,
      className: "bg-gray-100 text-gray-700",
    })),
    ...data.teaching_titles.map((item) => ({
      key: `teaching-${item}`,
      label: item,
      className: "bg-sky-50 text-sky-700",
    })),
  ];
}

function normalizeComparableText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

type RawOperationalNoteGroup = {
  key: string;
  sourceType: string;
  observedAt: string | null;
  ids: string[];
  texts: string[];
};

type CollapsedOperationalNoteGroup = RawOperationalNoteGroup & {
  observedDates: string[];
  duplicateCount: number;
};

function collapseOperationalNoteGroups(
  groups: RawOperationalNoteGroup[]
): CollapsedOperationalNoteGroup[] {
  return Array.from(
    groups.reduce((map, group) => {
      const comparableKey = [
        group.sourceType,
        group.texts.map((text) => normalizeComparableText(text)).sort().join("||"),
      ].join("::");
      const existing = map.get(comparableKey) ?? {
        ...group,
        observedDates: group.observedAt ? [group.observedAt] : [],
        duplicateCount: 0,
      };

      existing.duplicateCount += 1;
      existing.ids = Array.from(new Set([...existing.ids, ...group.ids]));

      const mergedTexts = new Map<string, string>();
      for (const text of [...existing.texts, ...group.texts]) {
        const normalized = normalizeComparableText(text);
        if (!normalized || mergedTexts.has(normalized)) continue;
        mergedTexts.set(normalized, text);
      }
      existing.texts = Array.from(mergedTexts.values());

      existing.observedDates = Array.from(
        new Set(
          [...existing.observedDates, ...(group.observedAt ? [group.observedAt] : [])].filter(
            (value): value is string => Boolean(value)
          )
        )
      ).sort((a, b) => b.localeCompare(a));

      existing.observedAt = existing.observedDates[0] ?? existing.observedAt;
      map.set(comparableKey, existing);
      return map;
    }, new Map<string, CollapsedOperationalNoteGroup>())
  )
    .map(([, group]) => group)
    .sort((a, b) => (b.observedAt ?? "").localeCompare(a.observedAt ?? ""));
}

function extractDateRangeFromLabel(
  label: string | null
): { start: string | null; end: string | null } {
  const parsed = parseContractSchedule(label);
  return {
    start: toDateOnlyString(parsed.startDate),
    end: toDateOnlyString(parsed.endDate),
  };
}

function formatTeachingPeriod(item: TeachingHistoryDisplayItem): string {
  if (item.start_date || item.end_date) {
    const start =
      typeof item.start_date === "string"
        ? item.start_date
        : toDateOnlyString(item.start_date ?? null);
    const end =
      typeof item.end_date === "string"
        ? item.end_date
        : toDateOnlyString(item.end_date ?? null);
    return formatDateRange(start, end);
  }

  const { start, end } = extractDateRangeFromLabel(item.date_label ?? null);
  return formatDateRange(start, end);
}

function formatTeachingSummary(item: TeachingHistoryDisplayItem): string {
  const parts: string[] = [];
  const totalHours =
    typeof item.total_hours === "number"
      ? item.total_hours
      : typeof item.total_hours === "string" && item.total_hours.trim() !== ""
        ? Number(item.total_hours)
        : null;

  if (item.total_sessions && item.total_sessions > 0) {
    parts.push(`${item.total_sessions}회`);
  }

  if (totalHours && totalHours > 0) {
    const hours =
      totalHours % 1 === 0
        ? String(totalHours)
        : totalHours.toFixed(1);
    parts.push(`${hours}시간`);
  }

  return parts.join(" · ");
}

function InlineTooltip({
  label,
  text,
}: {
  label: string;
  text: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex shrink-0">
      <button
        type="button"
        className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-gray-200 text-[10px] font-semibold text-gray-400 cursor-help bg-white"
        aria-label={`${label} 설명`}
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        onBlur={() => setOpen(false)}
      >
        ?
      </button>
      <span
        className={`absolute left-1/2 top-full z-20 mt-2 w-56 -translate-x-1/2 rounded-md border border-gray-200 bg-white px-2.5 py-2 text-[11px] font-normal leading-4 text-gray-600 shadow-lg ${
          open ? "block" : "hidden"
        }`}
      >
        {text}
      </span>
    </span>
  );
}

type FeeChangeDirection = "initial" | "up" | "down";
const COLLAPSED_TEACHING_HISTORY_COUNT = 15;

interface CollapsedFeeHistoryItem {
  amount: number;
  source_type: string;
  context: string | null;
  start_label: string;
  end_label: string | null;
  start_key: string;
  end_key: string | null;
  is_current: boolean;
  direction: FeeChangeDirection;
  notes: TeachingFeeNoteItem[];
}

function getParsedFeeDateRange(
  item: Pick<FeeHistoryItem, "effective_date" | "effective_label">
): { label: string | null; sortKey: string | null } {
  if (item.effective_date) {
    return {
      label: formatDate(item.effective_date),
      sortKey: item.effective_date,
    };
  }

  const parsed = extractDateRangeFromLabel(item.effective_label);
  if (parsed.start || parsed.end) {
    return {
      label: formatDateRange(parsed.start, parsed.end),
      sortKey: parsed.start ?? parsed.end,
    };
  }

  return { label: null, sortKey: null };
}

function getFeeDateLabel(item: FeeHistoryItem): string {
  return getParsedFeeDateRange(item).label ?? "-";
}

function getFeeSortKey(item: FeeHistoryItem): string {
  return getParsedFeeDateRange(item).sortKey ?? "";
}

function dateKeyToTimestamp(dateKey: string): number {
  const [year, month, day] = dateKey.split("-").map((value) => Number(value));
  return Date.UTC(year, month - 1, day);
}

function sortFeeHistoryChronologically(
  history: FeeHistoryItem[]
): FeeHistoryItem[] {
  return [...history].sort((a, b) => {
    const aKey = getFeeSortKey(a);
    const bKey = getFeeSortKey(b);
    return aKey.localeCompare(bKey);
  });
}

function collapseFeeTimeline(
  history: FeeHistoryItem[]
): CollapsedFeeHistoryItem[] {
  const timeline = sortFeeHistoryChronologically(history).filter(
    (item) => {
      const { label, sortKey } = getParsedFeeDateRange(item);
      return (
        !item.is_special_amount &&
        item.fee_kind === "hourly" &&
        item.amount !== null &&
        Boolean(label && sortKey)
      );
    }
  );

  const collapsed: CollapsedFeeHistoryItem[] = [];

  for (const item of timeline) {
    const label = getFeeDateLabel(item);
    const sortKey = getFeeSortKey(item);
    const previous = collapsed[collapsed.length - 1];
    const amount = item.amount!;

    if (previous && previous.amount === amount) {
      previous.end_label = label;
      previous.end_key = sortKey;
      previous.is_current = previous.is_current || item.is_current;
      continue;
    }

    const direction: FeeChangeDirection = !previous
      ? "initial"
      : amount > previous.amount
        ? "up"
        : "down";

    collapsed.push({
      amount,
      source_type: item.source_type,
      context: item.context,
      start_label: label,
      end_label: label,
      start_key: sortKey,
      end_key: sortKey,
      is_current: item.is_current,
      direction,
      notes: [],
    });
  }

  return collapsed;
}

// --- Score breakdown label/max mapping ---

const SCORE_LABELS: Record<
  string,
  { label: string; max: number; tooltip: string; colorClass: string; softClass: string }
> = {
  courses: {
    label: "출강횟수",
    max: 35,
    tooltip: "계약시트와 출강 이력 기준 총 출강 횟수를 35점 만점으로 환산한 값",
    colorClass: "bg-blue-600",
    softClass: "bg-blue-100",
  },
  satisfaction: {
    label: "최근 6개월 만족도 조사 결과",
    max: 15,
    tooltip:
      "최근 6개월 만족도 조사 결과 평균을 15점 만점으로 환산한 값, 데이터가 없으면 전체 강사의 보통 수준 점수를 사용",
    colorClass: "bg-amber-500",
    softClass: "bg-amber-100",
  },
  slack: {
    label: "슬랙활동",
    max: 15,
    tooltip: "슬랙에서 확인된 강사 관련 활동량을 15점 만점으로 환산한 값",
    colorClass: "bg-violet-500",
    softClass: "bg-violet-100",
  },
  recency: {
    label: "최근성",
    max: 15,
    tooltip: "슬랙·세일즈맵·이메일 중 가장 최근 활동일을 기준으로 계산한 최신 활동 점수",
    colorClass: "bg-emerald-500",
    softClass: "bg-emerald-100",
  },
  salesmap: {
    label: "세일즈맵",
    max: 10,
    tooltip: "세일즈맵에서 확인된 딜 활동량을 10점 만점으로 환산한 값",
    colorClass: "bg-orange-500",
    softClass: "bg-orange-100",
  },
  email: {
    label: "이메일",
    max: 5,
    tooltip: "이메일에서 확인된 강사 관련 스레드 활동량을 5점 만점으로 환산한 값",
    colorClass: "bg-cyan-500",
    softClass: "bg-cyan-100",
  },
  ops_channel: {
    label: "운영채널",
    max: 5,
    tooltip: "운영보고 채널에서 확인된 운영 실무 개입도를 5점 만점으로 환산한 값",
    colorClass: "bg-pink-500",
    softClass: "bg-pink-100",
  },
};

// --- TeachingHistory item shape ---

interface TeachingHistoryItem {
  id: string;
  company_name: string | null;
  course_name: string | null;
  course_id: string | null;
  start_date: string | null;
  end_date: string | null;
  date_label: string | null;
  deal_fee_hourly: number | null;
  fee_extra: string | null;
  total_hours: number | null;
  total_sessions: number | null;
  contract_type: string | null;
  detail_type: string | null;
  special_notes: string | null;
  source_type: string | null;
}

// --- FeeHistory item shape — 05_api_spec.md 6-3절 / 03_data_model.md 4-3절 ---

interface FeeHistoryItem {
  effective_date: string | null;
  effective_label: string | null;
  amount: number | null;
  fee_kind: string;
  context: string | null;
  source_type: string;
  is_current: boolean;
  is_special_amount: boolean;
}

interface TeachingFeeNoteItem {
  id: string;
  period: string | null;
  start_date: string | null;
  end_date: string | null;
  amount: number | null;
  context: string | null;
  note: string;
}

const HIDDEN_CONTRACT_NOTE_PATTERNS = [
  /사업자등록증/,
  /통장사본/,
  /폴더\s*링크/,
  /서류\s*취합/,
  /계약서\s*재작성/,
  /담당자\s*확인\s*요청/,
];

function shouldHideContractNote(note: string): boolean {
  return HIDDEN_CONTRACT_NOTE_PATTERNS.some((pattern) => pattern.test(note));
}

function extractVisibleContractNotes(
  ...values: Array<string | null | undefined>
): string[] {
  return values
    .flatMap((value) =>
      (value ?? "")
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean)
    )
    .filter((note) => !shouldHideContractNote(note));
}

// Feature J: 출처 라벨 정규화 (내부 source_type → 화면 라벨)
const FEE_SOURCE_LABELS: Record<string, string> = {
  notion: "노션",
  salesmap: "세일즈맵",
  contract_sheet: "계약시트",
  instructor_dispatch_sheet: "강사 출강시트",
  fee_fix: "수동 보정",
  manual: "수동",
};

function formatFeeSource(sourceType: string): string {
  return FEE_SOURCE_LABELS[sourceType] ?? sourceType;
}

function extractTeachingFeeNotes(
  history: TeachingHistoryItem[]
): TeachingFeeNoteItem[] {
  return history
    .flatMap((item) => {
      const notes = extractVisibleContractNotes(
        item.special_notes,
        item.fee_extra
      );
      if (notes.length === 0) return [];

      const contextParts = [item.company_name, item.course_name].filter(
        (value): value is string => Boolean(value && value.trim())
      );

      return notes.map((note, index) => ({
        id: `${item.id}-${index}`,
        period:
          item.start_date || item.end_date
            ? formatDateRange(item.start_date, item.end_date)
            : null,
        start_date: item.start_date,
        end_date: item.end_date,
        amount: item.deal_fee_hourly,
        context: contextParts.length > 0 ? contextParts.join(" / ") : null,
        note,
      }));
    })
    .sort((a, b) => (a.period ?? "").localeCompare(b.period ?? ""));
}

function noteMatchesTimeline(
  note: TeachingFeeNoteItem,
  item: CollapsedFeeHistoryItem
): boolean {
  if (note.amount === null || note.amount !== item.amount) return false;

  if (!note.start_date || !item.start_key) return false;

  return note.start_date === item.start_key;
}

function attachTeachingFeeNotes(
  timeline: CollapsedFeeHistoryItem[],
  notes: TeachingFeeNoteItem[]
): CollapsedFeeHistoryItem[] {
  const next = timeline.map((item) => ({ ...item, notes: [] as TeachingFeeNoteItem[] }));

  for (const note of notes) {
    const target = next.find((item) => noteMatchesTimeline(note, item));
    if (target) {
      const duplicate = target.notes.some(
        (existing) =>
          existing.note === note.note &&
          existing.period === note.period &&
          existing.context === note.context
      );
      if (!duplicate) {
        target.notes.push(note);
      }
    }
  }

  return next;
}

function compactTeachingHistoryNote(
  item: TeachingHistoryItem | TeachingHistoryDisplayItem
): string {
  const notes = extractVisibleContractNotes(item.special_notes, item.fee_extra);
  if (notes.length === 0) return "-";

  const firstLine = notes[0].replace(/\s+/g, " ").trim();
  return firstLine.length > 60 ? `${firstLine.slice(0, 60).trim()}...` : firstLine;
}

function normalizeFeeLinkText(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[\s()[\]{}.,:;'"`~!?+\-_/\\|]+/g, "")
    .trim();
}

function formatMoneyDelta(won: number): string {
  const prefix = won > 0 ? "+" : "-";
  return `${prefix}${formatMoney(Math.abs(won))}`;
}

function formatFeeSegmentPeriod(
  item: CollapsedFeeHistoryItem,
  isCurrentSegment: boolean
): string {
  if (isCurrentSegment) {
    return `${item.start_label} ~ 현재`;
  }
  if (!item.end_label || item.end_label === item.start_label) {
    return item.start_label;
  }
  return `${item.start_label} ~ ${item.end_label}`;
}

function looksLikeDescriptiveFeeLabel(value: string | null | undefined): boolean {
  if (!value) return false;
  return /(문항개발비|출장비|개발비|제작비|콘텐츠|자료개발|원고|감수|녹화본 제공비|멘토링|특강|프로젝트|시급|지급)/iu.test(
    value
  );
}

function compactFeeContext(
  context: string | null,
  fallbackLabel?: string | null
): string | null {
  if (!context) return null;

  const normalized = context.replace(/\s+/g, " ").trim();
  if (!normalized) return null;

  const withoutSchedule = normalized.replace(
    /\s+\d{4}[./-]\d{1,2}[./-]\d{1,2}.*$/,
    ""
  );
  const withoutTrailingAmount = withoutSchedule.replace(
    /\s*[·•]\s*\d{2,3}(?:,?\d{3})+(?:\s*(?:원|만원))?\s*$/u,
    ""
  );
  const withoutMetaTags = withoutTrailingAmount
    .replace(
      /\s*(?:\[(?:부가세\s*별도|부가세별도|vat(?:\s*별도)?|b2b)\]|\((?:부가세\s*별도|부가세별도|vat(?:\s*별도)?|b2b)\))\s*/giu,
      " "
    )
    .replace(/\s+/g, " ")
    .replace(/\s*\/\s*/g, " / ")
    .trim();
  const compacted = withoutMetaTags || withoutTrailingAmount.trim();
  const contextSegments = compacted
    .split(/[·•]/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const preferredSegment = contextSegments.find((segment) =>
    looksLikeDescriptiveFeeLabel(segment)
  );
  const fallbackSegment = looksLikeDescriptiveFeeLabel(fallbackLabel)
    ? fallbackLabel!.trim()
    : null;
  const displayText = preferredSegment ?? fallbackSegment ?? compacted;

  if (displayText.length <= 100) {
    return displayText;
  }

  return `${displayText.slice(0, 100).trim()}...`;

interface FeeHistoryTimelineDetail {
  item: CollapsedFeeHistoryItem;
  changeAmount: number;
  isCurrentSegment: boolean;
}

interface FeeHistoryDateGroup {
  sortKey: string;
  label: string;
  timelineItems: FeeHistoryTimelineDetail[];
  referenceItems: FeeHistoryItem[];
}

type FeeHistoryCardKind = "timeline" | "reference";

function buildFeeHistoryDateGroups(
  timeline: CollapsedFeeHistoryItem[],
  referenceItems: FeeHistoryItem[]
): FeeHistoryDateGroup[] {
  const groups = new Map<string, FeeHistoryDateGroup>();

  const ensureGroup = (sortKey: string, label: string) => {
    const existing = groups.get(sortKey);
    if (existing) {
      if (!existing.label || existing.label === "-") {
        existing.label = label;
      }
      return existing;
    }

    const next: FeeHistoryDateGroup = {
      sortKey,
      label,
      timelineItems: [],
      referenceItems: [],
    };
    groups.set(sortKey, next);
    return next;
  };

  timeline.forEach((item, index) => {
    const previous = index > 0 ? timeline[index - 1] : null;
    const group = ensureGroup(item.start_key, item.start_label);
    group.timelineItems.push({
      item,
      changeAmount: previous ? item.amount - previous.amount : 0,
      isCurrentSegment: index === timeline.length - 1,
    });
  });

  referenceItems.forEach((item) => {
    const sortKey = getFeeSortKey(item);
    if (!sortKey) return;

    const group = ensureGroup(sortKey, getFeeDateLabel(item));
    group.referenceItems.push(item);
  });

  return [...groups.values()].sort((a, b) => a.sortKey.localeCompare(b.sortKey));
}

function getFeeHistoryCardId(
  sortKey: string,
  kind: FeeHistoryCardKind,
  index: number
): string {
  return `fee-history-${sortKey}-${kind}-${index}`;
}

function getTeachingHistoryFeeMatchKeys(
  item: TeachingHistoryDisplayItem
): string[] {
  const rawKeys = [
    getTeachingHistoryDisplayTitle(item),
    item.course_name ?? null,
    item.company_name ?? null,
  ];

  return Array.from(
    new Set(
      rawKeys
        .map((value) => normalizeFeeLinkText(value))
        .filter((value) => value.length >= 4)
    )
  );
}

function findLatestFeeHistoryCardId(
  item: TeachingHistoryDisplayItem,
  dateGroups: FeeHistoryDateGroup[]
): string | null {
  const matchKeys = getTeachingHistoryFeeMatchKeys(item);
  if (matchKeys.length === 0) return null;

  let matchedId: string | null = null;

  for (const group of dateGroups) {
    group.timelineItems.forEach(({ item: timelineItem }, index) => {
      const searchBlob = normalizeFeeLinkText(
        [
          compactFeeContext(timelineItem.context),
          ...timelineItem.notes.map((note) => note.note),
          ...timelineItem.notes
            .map((note) => note.context)
            .filter((value): value is string => Boolean(value)),
        ].join(" ")
      );

      if (matchKeys.some((key) => searchBlob.includes(key))) {
        matchedId = getFeeHistoryCardId(group.sortKey, "timeline", index);
      }
    });

    group.referenceItems.forEach((referenceItem, index) => {
      const searchBlob = normalizeFeeLinkText(
        compactFeeContext(referenceItem.context, referenceItem.effective_label)
      );
      if (matchKeys.some((key) => searchBlob.includes(key))) {
        matchedId = getFeeHistoryCardId(group.sortKey, "reference", index);
      }
    });
  }

  return matchedId;
}

function FeeTrendChart({ timeline }: { timeline: CollapsedFeeHistoryItem[] }) {
  if (timeline.length === 0) return null;

  const width = 720;
  const height = 132;
  const paddingLeft = 12;
  const paddingRight = 12;
  const paddingTop = 18;
  const paddingBottom = 18;
  const labelGutter = 56;
  const amounts = timeline.map((item) => item.amount);
  const maxAmount = Math.max(...amounts);
  const minAmount = Math.min(...amounts);
  const amountPadding =
    maxAmount === minAmount
      ? Math.max(10000, Math.round(maxAmount * 0.08) || 10000)
      : Math.max(10000, Math.round((maxAmount - minAmount) * 0.2));
  const chartMax = maxAmount + amountPadding;
  const chartMin = Math.max(0, minAmount - amountPadding);
  const currentItem = timeline[timeline.length - 1];
  const range = Math.max(1, chartMax - chartMin);
  const plotRight = width - paddingRight - labelGutter;
  const usableWidth = plotRight - paddingLeft;
  const usableHeight = height - paddingTop - paddingBottom;
  const baseY = height - paddingBottom;
  const timestamps = timeline.map((item) => dateKeyToTimestamp(item.start_key));
  const minTimestamp = Math.min(...timestamps);
  const maxTimestamp = Math.max(...timestamps);

  const getX = (timestamp: number) =>
    paddingLeft +
    (timeline.length === 1 || maxTimestamp === minTimestamp
      ? usableWidth / 2
      : ((timestamp - minTimestamp) / (maxTimestamp - minTimestamp)) *
        usableWidth);
  const getY = (amount: number) =>
    paddingTop + ((chartMax - amount) / range) * usableHeight;

  const points = timeline.map((item, index) => {
    const timestamp = timestamps[index];
    return {
      item,
      x: getX(timestamp),
      y: getY(item.amount),
    };
  });

  const linePath = points
    .map((point, index) =>
      `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`
    )
    .join(" ");
  const areaPath =
    points.length > 1
      ? [
          `M ${points[0].x} ${baseY}`,
          ...points.map((point) => `L ${point.x} ${point.y}`),
          `L ${points[points.length - 1].x} ${baseY}`,
          "Z",
        ].join(" ")
      : null;
  const amountGuides = Array.from(new Set(amounts))
    .sort((a, b) => b - a)
    .map((amount) => ({
      amount,
      y: getY(amount),
      isCurrent: amount === currentItem.amount,
    }));

  return (
    <div className="rounded-lg border border-gray-200 bg-white px-4 py-4">
      <div className="mb-3 flex items-end justify-between gap-4">
        <div>
          <div className="text-xs font-medium text-gray-500">단가 추이</div>
          <div className="mt-1 text-sm text-gray-600">
            실제 날짜 간격 기준으로 변동 흐름을 표시합니다.
          </div>
        </div>
        <div className="flex items-end gap-5 text-right">
          <div>
            <div className="text-xs text-gray-500">변동 횟수</div>
            <div className="text-lg font-semibold text-gray-900">
              {Math.max(0, timeline.length - 1)}회
            </div>
          </div>
          <div>
            <div className="text-xs text-gray-500">현재 단가</div>
            <div className="text-lg font-semibold text-gray-900">
              {formatMoney(currentItem.amount)}
            </div>
          </div>
        </div>
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-28 w-full"
        role="img"
        aria-label="단가 추이 그래프"
      >
        <line
          x1={paddingLeft}
          x2={plotRight}
          y1={baseY}
          y2={baseY}
          stroke="#E5E7EB"
          strokeWidth="1"
        />
        {amountGuides.map((guide) => (
          <g key={`guide-${guide.amount}`}>
            <line
              x1={paddingLeft}
              x2={plotRight}
              y1={guide.y}
              y2={guide.y}
              stroke={guide.isCurrent ? "#BFDBFE" : "#F3F4F6"}
              strokeWidth="1"
              strokeDasharray={guide.isCurrent ? undefined : "4 4"}
            />
            <text
              x={width - paddingRight}
              y={guide.y + 4}
              textAnchor="end"
              fontSize="11"
              fill={guide.isCurrent ? "#1D4ED8" : "#6B7280"}
              fontWeight={guide.isCurrent ? "600" : "500"}
            >
              {formatMoney(guide.amount)}
            </text>
          </g>
        ))}
        <line
          x1={paddingLeft}
          x2={plotRight}
          y1={paddingTop}
          y2={paddingTop}
          stroke="#F3F4F6"
          strokeWidth="1"
        />
        <line
          x1={paddingLeft}
          x2={plotRight}
          y1={paddingTop + usableHeight / 2}
          y2={paddingTop + usableHeight / 2}
          stroke="#F3F4F6"
          strokeWidth="1"
          strokeDasharray="4 4"
        />
        {areaPath && <path d={areaPath} fill="#DBEAFE" opacity="0.5" />}
        <path
          d={linePath}
          fill="none"
          stroke="#2563EB"
          strokeWidth="3"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {points.map((point, index) => {
          const { x, y } = point;
          const isLastPoint = index === points.length - 1;

          return (
            <g key={`${point.item.start_key}-${point.item.amount}-${index}`}>
              {isLastPoint && (
                <circle
                  cx={x}
                  cy={y}
                  r="9"
                  fill="#FFFFFF"
                  stroke="#93C5FD"
                  strokeWidth="2"
                />
              )}
              <circle cx={x} cy={y} r={isLastPoint ? 5.5 : 4.5} fill="#2563EB" />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// --- Main component ---

interface InstructorDetailProps {
  instructorId: string;
}

export default function InstructorDetail({
  instructorId,
}: InstructorDetailProps) {
  const [teachingHistoryLimits, setTeachingHistoryLimits] = useState<
    Record<string, number>
  >({});
  const [highlightedFeeHistoryId, setHighlightedFeeHistoryId] = useState<
    string | null
  >(null);
  const feeHistoryHighlightTimerRef = useRef<number | null>(null);
  const teachingHistoryLimit = teachingHistoryLimits[instructorId] ?? 30;

  const { data, isLoading, isError, error, isFetching } = useQuery({
    queryKey: ["instructor", instructorId, teachingHistoryLimit],
    queryFn: () => fetchInstructorDetail(instructorId, teachingHistoryLimit),
    staleTime: 60_000,
  });

  const handleJumpToFeeHistory = useCallback((targetId: string) => {
    const target = document.getElementById(targetId);
    if (!target) return;

    target.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlightedFeeHistoryId(targetId);

    if (feeHistoryHighlightTimerRef.current !== null) {
      window.clearTimeout(feeHistoryHighlightTimerRef.current);
    }

    feeHistoryHighlightTimerRef.current = window.setTimeout(() => {
      setHighlightedFeeHistoryId(null);
      feeHistoryHighlightTimerRef.current = null;
    }, 2400);
  }, []);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        상세 정보를 불러오는 중...
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex items-center justify-center h-full text-red-500">
        {(error as Error)?.message ?? "상세 정보를 불러오지 못했습니다."}
      </div>
    );
  }

  if (!data?.data) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        데이터가 없습니다.
      </div>
    );
  }

  const inst = data.data;

  return (
    <div className="bg-gray-50">
      <div className="max-w-4xl mx-auto px-6 py-6 space-y-6">
        <HeaderSection data={inst} />
        <MetricsSection data={inst} />
        <ScoreSatisfactionSection data={inst} instructorId={instructorId} />
        <OpsIntelligenceSection data={inst} />
        <TeachingHistorySection
          key={instructorId}
          data={inst}
          onJumpToFeeHistory={handleJumpToFeeHistory}
          onLoadMore={() =>
            setTeachingHistoryLimits((current) => ({
              ...current,
              [instructorId]: (current[instructorId] ?? 30) + 30,
            }))
          }
          isLoadingMore={isFetching && !isLoading}
        />
        <FeeHistorySection
          data={inst}
          highlightedFeeHistoryId={highlightedFeeHistoryId}
        />
        <MemoSection data={inst} />
      </div>
    </div>
  );
}

// --- A. Header Section ---

function HeaderSection({ data }: { data: InstructorDetailData }) {
  const headerTags = buildHeaderTags(data);

  return (
    <section className="space-y-3">
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-2xl font-bold text-gray-900">{data.name}</h2>
          </div>
        </div>
      </div>

      {/* Contact */}
      {(data.contact.email || data.contact.phone) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-600">
          {data.contact.email && (
            <a
              href={`mailto:${data.contact.email}`}
              className="inline-flex min-w-0 items-center gap-2 hover:text-blue-700"
            >
              <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                Email
              </span>
              <span className="break-all font-medium text-gray-800">
                {data.contact.email}
              </span>
            </a>
          )}
          {data.contact.phone && (
            <a
              href={`tel:${data.contact.phone.replace(/[^0-9+]/g, "")}`}
              className="inline-flex items-center gap-2 hover:text-blue-700"
            >
              <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                Phone
              </span>
              <span className="font-medium text-gray-800">
                {data.contact.phone}
              </span>
            </a>
          )}
        </div>
      )}

      {headerTags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {headerTags.map((tag) => (
            <span
              key={tag.key}
              className={`inline-flex items-center rounded-md px-2 py-1 text-xs font-medium ${tag.className}`}
            >
              {tag.label}
            </span>
          ))}
        </div>
      )}

      {/* Profile summary */}
      {data.profile_summary && (
        <p className="text-sm text-gray-600 leading-relaxed bg-gray-50 rounded-md px-3 py-2">
          {data.profile_summary}
        </p>
      )}
    </section>
  );
}

// --- B. Key Metrics Section ---

function MetricsSection({ data }: { data: InstructorDetailData }) {
  const metrics = [
    {
      label: "총 출강 횟수",
      value: `${data.total_courses}회`,
    },
    {
      label: "총 강의 시간",
      value: formatHours(data.total_hours),
    },
    {
      label: "최근 6개월",
      value: `${data.recent_courses_6mo}회`,
    },
    {
      label: "누적 지급액 (추정)",
      value: formatMoney(data.total_paid),
    },
    {
      label: "기본 단가",
      value: formatMoneyPerHour(data.base_fee_hourly, data.is_fulltime),
    },
  ];

  return (
    <section className="grid grid-cols-2 gap-2.5 lg:grid-cols-5">
      {metrics.map((m) => (
        <div
          key={m.label}
          className="min-w-0 rounded-lg border border-gray-200 bg-white px-3.5 py-3"
        >
          <div className="mb-1 text-[11px] leading-tight text-gray-500 md:text-xs">
            {m.label}
          </div>
          <div className="truncate text-base font-semibold text-gray-900 md:text-lg">
            {m.value}
          </div>
        </div>
      ))}
    </section>
  );
}

// --- C. Score & Satisfaction Section ---

function ScoreSatisfactionSection({
  data,
  instructorId,
}: {
  data: InstructorDetailData;
  instructorId: string;
}) {
  const breakdown = data.score_breakdown ?? {};
  const recentSatisfactionEntries = buildRecentSatisfactionEntries(data);
  const orderedKeys = [
    "courses",
    "satisfaction",
    "slack",
    "recency",
    "salesmap",
    "email",
    "ops_channel",
  ];
  const breakdownItems = orderedKeys
    .map((key) => {
      const meta = SCORE_LABELS[key];
      if (!meta) return null;
      const value = typeof breakdown[key] === "number" ? breakdown[key] : 0;
      return {
        key,
        ...meta,
        value,
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  return (
    <section className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      {/* Left: Total score + breakdown */}
      <div className="bg-white border border-gray-200 rounded-lg px-5 py-4">
        <div className="flex items-end justify-between gap-3 mb-4">
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-bold text-gray-900">
              {formatScore(data.score)}
            </span>
            <span className="text-sm text-gray-400">/ 100</span>
          </div>
          <span className="text-[11px] text-gray-400">
            항목별 기여도
          </span>
        </div>
        <div className="h-3 rounded-full bg-gray-100 overflow-hidden flex mb-4">
          {breakdownItems.map((item) => (
            <div
              key={item.key}
              className={`${item.colorClass} h-full transition-all`}
              style={{ width: `${Math.min(100, Math.max(0, item.value))}%` }}
              aria-label={`${item.label}: ${item.tooltip}`}
            />
          ))}
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          {breakdownItems.map((item) => (
            <div key={item.key} className="flex items-center gap-2 min-w-0">
              <span
                className={`h-2.5 w-2.5 rounded-full shrink-0 ${item.colorClass}`}
              />
              <span className="text-xs text-gray-600 truncate">
                {item.label}
              </span>
              <InlineTooltip label={item.label} text={item.tooltip} />
              <span className="ml-auto text-xs font-medium text-gray-900 shrink-0">
                {item.value.toFixed(1)} / {item.max}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Right: Satisfaction */}
      <div className="bg-white border border-gray-200 rounded-lg px-5 py-4">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <div className="text-xs text-gray-500">최근 6개월 만족도 조사 결과</div>
          </div>
          <SatisfactionWriteSection instructorId={instructorId} compact />
        </div>
        <div className="flex items-baseline gap-2 mb-2">
          <span className="text-3xl font-bold text-gray-900">
            {data.satisfaction.avg !== null
              ? data.satisfaction.avg.toFixed(1)
              : "-"}
          </span>
          <span className="text-sm text-gray-400">/ 5.0</span>
        </div>
        <div className="space-y-1 text-sm text-gray-600">
          <div>응답 {data.satisfaction.count}건</div>
          {data.satisfaction.is_imputed && (
            <div className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-yellow-50 text-yellow-700">
              추정값
            </div>
          )}
        </div>
        {recentSatisfactionEntries.length > 0 && (
          <div className="mt-4 rounded-md border border-gray-200 bg-gray-50 px-3 py-3">
            <div className="text-[11px] font-medium text-gray-700">
              최근 6개월 내역 {recentSatisfactionEntries.length}건
            </div>
            <details className="mt-2">
              <summary className="cursor-pointer text-[11px] font-medium text-gray-600">
                날짜와 과정 내역 보기
              </summary>
              <div className="mt-2 max-h-72 space-y-2 overflow-y-auto pr-1">
                {recentSatisfactionEntries.map((item) => (
                  <div
                    key={item.key}
                    className="rounded bg-white px-3 py-2 text-[11px] text-gray-600"
                  >
                    <div className="text-[10px] font-medium text-gray-500">
                      {formatDate(item.observedAt)}
                    </div>
                    <div className="mt-1 text-gray-700">
                      {[item.companyName, item.courseName, item.sessionLabel]
                        .filter(Boolean)
                        .join(" · ") || "과정 정보 없음"}
                    </div>
                  </div>
                ))}
              </div>
            </details>
          </div>
        )}
      </div>
    </section>
  );
}

// --- D. Satisfaction Write Form ---

function SatisfactionWriteSection({
  instructorId,
  compact = false,
}: {
  instructorId: string;
  compact?: boolean;
}) {
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const [score, setScore] = useState<number>(3.0);
  const [companyName, setCompanyName] = useState("");
  const [courseName, setCourseName] = useState("");
  const [comment, setComment] = useState("");
  const [responseDate, setResponseDate] = useState(getTodayDateInputValue);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const resetForm = useCallback(() => {
    setScore(3.0);
    setCompanyName("");
    setCourseName("");
    setComment("");
    setResponseDate(getTodayDateInputValue());
  }, []);

  const openForm = useCallback(() => {
    resetForm();
    setSuccessMsg(null);
    setIsOpen(true);
  }, [resetForm]);

  const closeForm = useCallback(() => {
    setIsOpen(false);
  }, []);

  const mutation = useMutation({
    mutationFn: (body: {
      score: number;
      comment?: string;
      company_name?: string;
      course_name?: string;
      response_date?: string;
    }) => postSatisfaction(instructorId, body),
    onSuccess: () => {
      closeForm();
      setSuccessMsg("만족도가 저장되었습니다.");
      resetForm();
      // Invalidate detail query to refetch
      queryClient.invalidateQueries({ queryKey: ["instructor", instructorId] });
      // Also invalidate list to reflect updated scores
      queryClient.invalidateQueries({ queryKey: ["instructors"] });
      // Clear success message after 3s
      setTimeout(() => setSuccessMsg(null), 3000);
    },
  });

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      setSuccessMsg(null);
      const body: {
        score: number;
        comment?: string;
        company_name?: string;
        course_name?: string;
        response_date?: string;
      } = { score };
      if (comment.trim()) body.comment = comment.trim();
      if (companyName.trim()) body.company_name = companyName.trim();
      if (courseName.trim()) body.course_name = courseName.trim();
      if (responseDate) body.response_date = responseDate;
      mutation.mutate(body);
    },
    [score, comment, companyName, courseName, responseDate, mutation]
  );

  return (
    <>
      {compact ? (
        <div className="flex flex-col items-end gap-2">
          <button
            type="button"
            onClick={openForm}
            className="inline-flex items-center gap-1.5 rounded-md border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 transition hover:bg-blue-100"
          >
            <svg
              viewBox="0 0 20 20"
              aria-hidden="true"
              className="h-3.5 w-3.5 fill-current"
            >
              <path d="M13.6 2.2a2 2 0 0 1 2.8 2.8l-8.1 8.1-3.6.8.8-3.6 8.1-8.1Zm1.4 1.4a.5.5 0 0 0-.7 0l-1 1 1.7 1.7 1-1a.5.5 0 0 0 0-.7l-1-1Zm-2.7 2-6.1 6.1-.4 1.8 1.8-.4 6.1-6.1-1.4-1.4Z" />
            </svg>
            <span>작성</span>
          </button>
          {successMsg && (
            <div className="rounded-md border border-green-200 bg-green-50 px-2.5 py-1.5 text-[11px] text-green-700">
              {successMsg}
            </div>
          )}
        </div>
      ) : (
        <section className="space-y-2">
          <div className="rounded-lg border border-gray-200 bg-white px-5 py-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-sm font-semibold text-gray-900">
                  만족도 작성
                </div>
                <div className="mt-1 text-xs text-gray-500">
                  강사 만족도 기록을 팝업에서 바로 남길 수 있습니다.
                </div>
              </div>
              <button
                type="button"
                onClick={openForm}
                className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-blue-700"
              >
                만족도 입력
              </button>
            </div>
          </div>

          {successMsg && (
            <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
              {successMsg}
            </div>
          )}
        </section>
      )}
      {isOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/45 px-4"
          onClick={() => !mutation.isPending && closeForm()}
        >
          <div
            className="w-full max-w-lg rounded-xl bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 border-b border-gray-100 px-5 py-4">
              <div>
                <div className="text-base font-semibold text-gray-900">
                  만족도 작성
                </div>
                <div className="mt-1 text-sm text-gray-500">
                  점수와 선택 메모를 저장합니다.
                </div>
              </div>
              <button
                type="button"
                onClick={closeForm}
                disabled={mutation.isPending}
                className="rounded-md px-2 py-1 text-sm text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                닫기
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4 px-5 py-5">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  점수 <span className="text-red-500">*</span>
                </label>
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={1}
                    max={5}
                    step={0.5}
                    value={score}
                    onChange={(e) => setScore(Number(e.target.value))}
                    className="flex-1 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-500"
                  />
                  <span className="w-10 text-center text-lg font-semibold text-gray-900">
                    {score.toFixed(1)}
                  </span>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  기업명
                </label>
                <input
                  type="text"
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  placeholder="기업명 (선택)"
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  과정명
                </label>
                <input
                  type="text"
                  value={courseName}
                  onChange={(e) => setCourseName(e.target.value)}
                  placeholder="과정명 (선택)"
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  코멘트
                </label>
                <textarea
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="코멘트 (선택)"
                  rows={3}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 resize-none"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  응답일
                </label>
                <input
                  type="date"
                  value={responseDate}
                  onChange={(e) => setResponseDate(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>

              <div className="flex items-center justify-between gap-3 pt-2">
                {mutation.isError ? (
                  <span className="text-sm text-red-600">
                    {(mutation.error as Error)?.message ??
                      "저장에 실패했습니다."}
                  </span>
                ) : (
                  <span className="text-sm text-gray-400"> </span>
                )}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={closeForm}
                    disabled={mutation.isPending}
                    className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    취소
                  </button>
                  <button
                    type="submit"
                    disabled={mutation.isPending}
                    className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {mutation.isPending ? "저장 중..." : "저장"}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

// --- E. Operations Intelligence Section ---

function OpsIntelligenceSection({ data }: { data: InstructorDetailData }) {
  const behavioral = data.behavioral_intelligence;
  const intelligenceMeta = data.operational_intelligence_meta ?? {
    generated_at: null,
    generated_by: null,
    generation_model: null,
  };
  const getOperationalNoteBundleKey = (
    note: InstructorDetailData["raw_operational_notes"][number]
  ): string => {
    const sourceRef = note.source_ref ?? {};
    const satisfactionImportItemId =
      typeof sourceRef.satisfaction_import_item_id === "string"
        ? sourceRef.satisfaction_import_item_id
        : null;
    if (satisfactionImportItemId) {
      return `${note.source_type}:satisfaction_import_item:${satisfactionImportItemId}`;
    }

    const activityImportItemId =
      typeof sourceRef.activity_import_item_id === "string"
        ? sourceRef.activity_import_item_id
        : null;
    if (activityImportItemId) {
      return `${note.source_type}:activity_import_item:${activityImportItemId}`;
    }

    const entryIndex =
      typeof sourceRef.entry_index === "number" ||
      typeof sourceRef.entry_index === "string"
        ? String(sourceRef.entry_index)
        : null;
    if (entryIndex) {
      return `${note.source_type}:entry_index:${entryIndex}`;
    }

    return note.id;
  };
  const groupedOperationalNotes = Array.from(
    data.raw_operational_notes.reduce((map, note) => {
      const key = getOperationalNoteBundleKey(note);
      const noteDate = getOperationalNoteDate(note);
      const existing = map.get(key) ?? {
        key,
        sourceType: note.source_type,
        observedAt: noteDate,
        ids: [] as string[],
        texts: [] as string[],
      };
      existing.ids.push(note.id);
      if (!existing.texts.includes(note.raw_text)) {
        existing.texts.push(note.raw_text);
      }
      if (!existing.observedAt && noteDate) {
        existing.observedAt = noteDate;
      }
      map.set(key, existing);
      return map;
    }, new Map<string, RawOperationalNoteGroup>())
  ).map(([, group]) => group);
  const collapsedOperationalNotes = collapseOperationalNoteGroups(
    groupedOperationalNotes
  );
  const operationalNoteCount = collapsedOperationalNotes.length;
  const evidenceSourceCount = new Set(
    collapsedOperationalNotes.map((item) => item.sourceType)
  ).size;
  const observedDates = Array.from(
    new Set(
      collapsedOperationalNotes
        .map((item) => item.observedAt)
        .filter((value): value is string => Boolean(value))
    )
  ).sort((a, b) => b.localeCompare(a));
  const rawOperationalNoteById = new Map(
    data.raw_operational_notes.map((item) => [item.id, item] as const)
  );
  const followupRawNoteIds = new Set(data.human_followups.map((item) => item.raw_note_id));
  const followupBundleKeys = new Set(
    collapsedOperationalNotes
      .filter((group) => group.ids.some((id) => followupRawNoteIds.has(id)))
      .map((group) => group.key)
  );
  const followupCount = followupBundleKeys.size;
  const followupDates = Array.from(
    new Set(
      data.human_followups
        .map((item) => {
          const rawNote = rawOperationalNoteById.get(item.raw_note_id);
          return rawNote ? getOperationalNoteDate(rawNote) : null;
        })
        .filter((value): value is string => Boolean(value))
    )
  ).sort((a, b) => b.localeCompare(a));
  const visibleOperationalNotes = collapsedOperationalNotes.filter(
    (group) => !followupBundleKeys.has(group.key)
  );
  const operationalNoteCountsBySource = Array.from(
    visibleOperationalNotes.reduce((map, item) => {
      map.set(item.sourceType, (map.get(item.sourceType) ?? 0) + 1);
      return map;
    }, new Map<string, number>())
  ).sort((a, b) => b[1] - a[1]);
  const operationalNotesBySource = operationalNoteCountsBySource.map(
    ([sourceType]) => [
      sourceType,
      visibleOperationalNotes.filter((item) => item.sourceType === sourceType),
    ] as const
  );
  const filteredEvidenceSnapshots = data.operational_evidence_snapshots.filter(
    (snapshot) =>
      snapshot.matched_feedback_item_count > 0 ||
      snapshot.examples.length > 0 ||
      (snapshot.source === "curated_ops" && snapshot.matched_item_count > 0)
  );
  const formatPatternLabel = (pattern: string): string | null => {
    const match = pattern.match(/^([a-z_]+) 반복 근거 (\d+)건$/);
    if (match) {
      const [, family, count] = match;
      const familyLabel =
        family === "delivery_quality"
          ? "전달력/진행 관련 우려"
          : family === "curriculum_compliance"
            ? "커리큘럼/진행 적합성 우려"
            : family === "material_delivery"
              ? "자료/교안 전달 우려"
              : family === "responsiveness_or_schedule"
                ? "응답/일정 조율 우려"
                : family === "environment_issue"
                  ? "운영 환경 이슈"
                  : family === "positive_signal"
                    ? "긍정 평가 반복"
                    : null;
      return familyLabel ? `${familyLabel} ${count}건` : pattern;
    }

    if (pattern.startsWith("positive_signal positive 근거")) {
      return null;
    }
    if (
      pattern.includes("만족도 평균") ||
      pattern.includes("출강 이력") ||
      pattern.includes("최근 6개월 출강")
    ) {
      return null;
    }

    return pattern;
  };
  const visibleStrengthPatterns = behavioral.strength_patterns
    .map(formatPatternLabel)
    .filter((pattern): pattern is string => Boolean(pattern));
  const visibleRiskNotes = data.risk_notes
    .map(formatPatternLabel)
    .filter((pattern): pattern is string => Boolean(pattern));
  const behavioralSummaryCards = [
    {
      label: "강의 스타일",
      value: behavioral.teaching_style,
    },
    {
      label: "커리큘럼 적합성",
      value: behavioral.curriculum_compliance,
    },
    {
      label: "태도/운영",
      value: behavioral.attitude,
    },
  ].filter(
    (
      item
    ): item is {
      label: string;
      value: string;
    } => Boolean(item.value)
  );
  const generatedByLabel =
    intelligenceMeta.generated_by === "mixed"
      ? "LLM + 규칙"
      : intelligenceMeta.generated_by === "rule_based"
        ? "규칙 기반"
        : intelligenceMeta.generated_by ?? null;
  const generatedAtLabel = intelligenceMeta.generated_at
    ? formatDate(intelligenceMeta.generated_at.slice(0, 10))
    : null;
  const hasDecisionCard =
    data.recommended_for.length > 0 ||
    data.avoid_for.length > 0 ||
    visibleRiskNotes.length > 0 ||
    visibleStrengthPatterns.length > 0 ||
    behavioralSummaryCards.length > 0 ||
    behavioral.recommendation !== null ||
    behavioral.key_question_for_humans !== null;
  const hasAuditData =
    filteredEvidenceSnapshots.length > 0 ||
    operationalNoteCount > 0 ||
    generatedByLabel !== null ||
    generatedAtLabel !== null ||
    behavioral.data_richness_reason !== null ||
    behavioral.confidence_reason !== null;

  if (!hasDecisionCard && !hasAuditData) return null;

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-gray-900">운영 인텔리전스</h3>

      <div className="flex flex-wrap gap-2 text-[11px] text-gray-600">
        <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-1">
          근거 밀도 {behavioral.data_richness}
        </span>
        <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-1">
          confidence {behavioral.confidence}
        </span>
        {generatedByLabel && (
          <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-1">
            생성 {generatedByLabel}
          </span>
        )}
        {generatedAtLabel && (
          <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-1">
            업데이트 {generatedAtLabel}
          </span>
        )}
        {followupCount > 0 && (
          <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-1 text-amber-800">
            확인 필요 {followupCount}건
          </span>
        )}
      </div>

      {behavioral.recommendation && (
        <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
          <p className="text-[11px] font-medium text-gray-700">운영 판단 요약</p>
          <p className="mt-1 text-sm leading-6 text-gray-700">
            {behavioral.recommendation}
          </p>
        </div>
      )}

      {behavioral.key_question_for_humans && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
          <p className="text-[11px] font-medium text-amber-900">
            확인 필요 사항
          </p>
          {followupDates.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-amber-900">
              <span className="font-medium">작성일</span>
                      {followupDates.slice(0, 6).map((date) => (
                        <span
                          key={date}
                          className="inline-flex items-center rounded-full bg-white/70 px-2 py-1"
                        >
                          {formatDate(date)}
                        </span>
                      ))}
              {followupDates.length > 6 && (
                <span className="inline-flex items-center rounded-full bg-white/70 px-2 py-1">
                  +{followupDates.length - 6}일
                </span>
              )}
            </div>
          )}
          <p className="mt-1 text-xs leading-5 text-amber-900">
            {behavioral.key_question_for_humans}
          </p>
          {data.human_followups.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs font-medium text-amber-900">
                원문 예시 {data.human_followups.length}건 보기
              </summary>
              <div className="mt-2 space-y-1">
                {data.human_followups.map((item, index) => {
                  const rawNote = rawOperationalNoteById.get(item.raw_note_id);
                  const noteDate = rawNote ? getOperationalNoteDate(rawNote) : null;

                  return (
                  <div
                    key={`${item.raw_note_id}-${index}`}
                    className="rounded bg-white/80 px-2 py-1.5 text-[11px] text-amber-950"
                  >
                    <div className="mb-0.5 flex flex-wrap items-center gap-2 text-[10px] font-medium text-amber-800">
                      <span>{formatOperationalSourceLabel(item.source_type)}</span>
                      {item.review_priority ? <span>· {item.review_priority}</span> : null}
                      <span>· 작성일 {formatDate(noteDate)}</span>
                    </div>
                    <div>{item.raw_text}</div>
                  </div>
                  );
                })}
              </div>
            </details>
          )}
        </div>
      )}

      {data.recommended_for.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium text-gray-700">추천 대상</p>
          <div className="flex flex-wrap gap-1.5">
            {data.recommended_for.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center px-2 py-1 rounded-md text-xs font-medium bg-green-50 text-green-700"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>
      )}

      {data.avoid_for.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium text-gray-700">지양 대상</p>
          <div className="flex flex-wrap gap-1.5">
            {data.avoid_for.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center px-2 py-1 rounded-md text-xs font-medium bg-orange-50 text-orange-700"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>
      )}

      {visibleStrengthPatterns.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium text-gray-700">긍정 패턴</p>
          <div className="flex flex-wrap gap-1.5">
            {visibleStrengthPatterns.map((pattern) => (
              <span
                key={pattern}
                className="inline-flex items-center px-2 py-1 rounded-md text-xs font-medium bg-emerald-50 text-emerald-700"
              >
                {pattern}
              </span>
            ))}
          </div>
        </div>
      )}

      {visibleRiskNotes.length > 0 && (
        <div className="space-y-2">
          {visibleRiskNotes.map((note, i) => (
            <div
              key={i}
              className="px-3 py-2 text-sm bg-yellow-50 text-yellow-800 border border-yellow-200 rounded-md"
            >
              {note}
            </div>
          ))}
        </div>
      )}

      {behavioralSummaryCards.length > 0 && (
        <div className="grid gap-2 sm:grid-cols-3">
          {behavioralSummaryCards.map((item) => (
            <div
              key={item.label}
              className="rounded-md border border-gray-200 bg-white px-3 py-2"
            >
              <p className="text-[11px] font-medium text-gray-700">
                {item.label}
              </p>
              <p className="mt-1 text-xs leading-5 text-gray-600">
                {item.value}
              </p>
            </div>
          ))}
        </div>
      )}

      {hasAuditData && (
        <details className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2">
          <summary className="cursor-pointer text-[11px] font-medium text-gray-700">
            검수용 근거 보기
          </summary>
          <div className="mt-3 space-y-3">
            {(behavioral.data_richness_reason || behavioral.confidence_reason) && (
              <div className="grid gap-2 sm:grid-cols-2">
                {behavioral.data_richness_reason && (
                  <div className="rounded-md border border-gray-200 bg-white px-3 py-2">
                    <p className="text-[11px] font-medium text-gray-700">
                      근거 밀도 판단 이유
                    </p>
                    <p className="mt-1 text-xs leading-5 text-gray-600">
                      {behavioral.data_richness_reason}
                    </p>
                  </div>
                )}

                {behavioral.confidence_reason && (
                  <div className="rounded-md border border-gray-200 bg-white px-3 py-2">
                    <p className="text-[11px] font-medium text-gray-700">
                      confidence 판단 이유
                    </p>
                    <p className="mt-1 text-xs leading-5 text-gray-600">
                      {behavioral.confidence_reason}
                    </p>
                  </div>
                )}
              </div>
            )}

            {operationalNoteCount > 0 && (
              <div className="space-y-2">
                <div className="flex flex-wrap gap-2 text-[11px] text-gray-600">
                  <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-1">
                    작성일 {observedDates.length}일
                  </span>
                  <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-1">
                    근거 source {evidenceSourceCount}개
                  </span>
                </div>

                {operationalNoteCountsBySource.length > 0 && (
                  <div className="rounded-md border border-gray-200 bg-white px-3 py-2">
                    <div className="mb-2 text-[11px] font-medium text-gray-700">
                      source별 운영 note
                    </div>
                    {followupCount > 0 && (
                      <div className="mb-2 text-[11px] text-gray-500">
                        확인 필요 사항에 이미 포함된 항목은 여기서 제외했습니다.
                      </div>
                    )}
                    <div className="flex flex-wrap gap-2 text-[11px] text-gray-600">
                      {operationalNoteCountsBySource.map(([sourceType, count]) => (
                        <span
                          key={sourceType}
                          className="inline-flex items-center rounded-full bg-gray-100 px-2 py-1"
                        >
                          {formatOperationalSourceLabel(sourceType)} {count}건
                        </span>
                      ))}
                    </div>
                    <div className="mt-3 space-y-2">
                      {operationalNotesBySource.map(([sourceType, notes]) => (
                        <details
                          key={sourceType}
                          className="rounded border border-gray-100 bg-gray-50 px-3 py-2"
                        >
                          {(() => {
                            const sourceDates = Array.from(
                              new Set(
                                notes
                                  .flatMap((note) => note.observedDates)
                                  .filter((value): value is string => Boolean(value))
                              )
                            ).sort((a, b) => b.localeCompare(a));
                            const formattedSourceDates = sourceDates.map((date) =>
                              formatDate(date)
                            );
                            const sourceDateLabel =
                              formattedSourceDates.length === 0
                                ? "날짜 없음"
                                : formattedSourceDates.length <= 2
                                  ? formattedSourceDates.join(", ")
                                  : `${formattedSourceDates.slice(0, 2).join(", ")} 외 ${formattedSourceDates.length - 2}일`;
                            return (
                              <summary className="cursor-pointer text-[11px] font-medium text-gray-700">
                                {formatOperationalSourceLabel(sourceType)} · 작성일 {sourceDateLabel} · 원문 {notes.length}묶음 보기
                              </summary>
                            );
                          })()}
                          <div className="mt-2 space-y-1">
                            {notes.map((note) => (
                              <div
                                key={note.key}
                                className="rounded bg-white px-2 py-1.5 text-[11px] text-gray-600"
                              >
                                <div className="mb-0.5 flex flex-wrap items-center gap-2 text-[10px] font-medium text-gray-500">
                                  <span>{formatOperationalSourceLabel(note.sourceType)}</span>
                                  <span className="text-gray-300">|</span>
                                  <span>작성일 {formatDate(note.observedAt)}</span>
                                  {note.duplicateCount > 1 && (
                                    <>
                                      <span className="text-gray-300">|</span>
                                      <span>반복 {note.duplicateCount}회</span>
                                    </>
                                  )}
                                </div>
                                <div>{note.texts.join(" / ")}</div>
                              </div>
                            ))}
                          </div>
                        </details>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {filteredEvidenceSnapshots.length > 0 && (
              <div className="space-y-2">
                <p className="text-[11px] font-medium text-gray-700">
                  근거 수집 데이터
                </p>
                <div className="overflow-hidden rounded-md border border-gray-200 bg-white">
                  <div className="grid grid-cols-[minmax(0,1.4fr)_repeat(4,minmax(0,0.8fr))] gap-3 border-b border-gray-100 px-3 py-2 text-[11px] font-medium text-gray-500">
                    <div>source</div>
                    <div>전체 row</div>
                    <div>매핑 row</div>
                    <div>매핑 피드백</div>
                    <div>미매핑 피드백</div>
                  </div>
                  <div className="divide-y divide-gray-100">
                    {filteredEvidenceSnapshots.map((snapshot) => (
                      <div key={snapshot.source} className="px-3 py-2.5">
                        <div className="grid grid-cols-[minmax(0,1.4fr)_repeat(4,minmax(0,0.8fr))] gap-3 items-start">
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-gray-800 truncate">
                              {snapshot.title}
                            </p>
                            {snapshot.note && (
                              <p className="mt-0.5 text-[11px] leading-5 text-gray-500 line-clamp-1">
                                {snapshot.note}
                              </p>
                            )}
                          </div>
                          <div className="text-[11px] text-gray-700">
                            {snapshot.total_item_count}건
                          </div>
                          <div className="text-[11px] text-gray-700">
                            {snapshot.matched_item_count}건
                          </div>
                          <div className="text-[11px] text-gray-700">
                            {snapshot.matched_feedback_item_count}건
                          </div>
                          <div className="text-[11px] text-gray-700">
                            {snapshot.unmapped_feedback_item_count}건
                          </div>
                        </div>
                        {snapshot.examples.length > 0 && (
                          <details className="mt-2">
                            <summary className="cursor-pointer text-xs font-medium text-gray-600">
                              예시 {snapshot.examples.length}건 보기
                            </summary>
                            <div className="mt-2 space-y-1">
                              {snapshot.examples.map((example, index) => (
                                <div
                                  key={`${snapshot.source}-${example.kind}-${index}`}
                                  className="rounded bg-gray-50 px-2 py-1.5 text-[11px] text-gray-600"
                                >
                                  <div className="mb-0.5 text-[10px] font-medium text-gray-500">
                                    {example.kind === "matched_feedback"
                                      ? "매핑된 피드백"
                                      : example.kind === "unmapped_feedback"
                                        ? "미매핑 추정 피드백"
                                        : "curated note"}
                                    {example.source_type ? ` · ${example.source_type}` : ""}
                                  </div>
                                  <div>{example.text}</div>
                                </div>
                              ))}
                            </div>
                          </details>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </details>
      )}
    </section>
  );
}

// --- F. Teaching History Table ---

function TeachingHistorySection({
  data,
  onJumpToFeeHistory,
  onLoadMore,
  isLoadingMore,
}: {
  data: InstructorDetailData;
  onJumpToFeeHistory: (targetId: string) => void;
  onLoadMore: () => void;
  isLoadingMore: boolean;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const rawHistory = data.teaching_history as TeachingHistoryItem[];
  const history = groupTeachingHistories(rawHistory, {
    fromDate: "2025-01-01",
    untilDate: new Date().toISOString().split("T")[0],
  });
  const totalCount = rawHistory.length + data.teaching_history_remaining_count;
  const feeHistory = data.fee_history as FeeHistoryItem[];
  const feeTimeline = attachTeachingFeeNotes(
    collapseFeeTimeline(feeHistory),
    extractTeachingFeeNotes(rawHistory)
  );
  const feeReferenceItems = sortFeeHistoryChronologically(feeHistory).filter(
    (item) => {
      const { label, sortKey } = getParsedFeeDateRange(item);
      return (
        (item.is_special_amount || item.fee_kind !== "hourly") &&
        Boolean(label && sortKey)
      );
    }
  );
  const feeDateGroups = buildFeeHistoryDateGroups(feeTimeline, feeReferenceItems);
  const visibleHistory = isExpanded
    ? history
    : history.slice(0, COLLAPSED_TEACHING_HISTORY_COUNT);
  const collapsedCount = Math.max(
    0,
    history.length - COLLAPSED_TEACHING_HISTORY_COUNT
  );

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
        <span>강의 상세 이력</span>
        <span className="text-gray-500">
          (최근 {rawHistory.length}건 / 전체 {totalCount}건)
        </span>
      </div>

      {history.length === 0 ? (
        <p className="text-sm text-gray-400">강의 이력이 없습니다</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
          <div className="overflow-x-auto">
            <table className="min-w-full table-fixed">
              <thead className="border-b border-gray-200 bg-gray-50">
                <tr className="text-left text-xs font-medium text-gray-500">
                  <th className="px-5 py-4 w-[20%]">시기</th>
                  <th className="px-5 py-4 w-[18%]">기업명</th>
                  <th className="px-5 py-4 w-[46%]">과정명</th>
                  <th className="px-5 py-4 w-[16%]">강사료</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {visibleHistory.map((item) => {
                  const company =
                    getTeachingHistoryDisplayCompany(item) ??
                    item.company_name?.trim() ??
                    "-";
                  const title = getTeachingHistoryDisplayTitle(item);
                  const dateDisplay = formatTeachingPeriod(item);
                  const summary = formatTeachingSummary(item);
                  const note = compactTeachingHistoryNote(item);
                  const relatedFeeHistoryId =
                    note !== "-"
                      ? findLatestFeeHistoryCardId(item, feeDateGroups)
                      : null;

                  return (
                    <tr key={item.id} className="align-top">
                      <td className="px-5 py-4 text-sm text-gray-500">
                        <div>{dateDisplay}</div>
                        {summary && (
                          <div className="mt-1 text-xs text-gray-400">
                            {summary}
                          </div>
                        )}
                      </td>
                      <td className="px-5 py-4 text-sm font-semibold text-gray-900">
                        <div className="break-words">{company}</div>
                      </td>
                      <td className="px-5 py-4 text-sm text-gray-700">
                        <div className="flex items-start gap-2">
                          {relatedFeeHistoryId ? (
                            <button
                              type="button"
                              onClick={() =>
                                onJumpToFeeHistory(relatedFeeHistoryId)
                              }
                              className="min-w-0 text-left"
                              title={`${title} 단가 이력으로 이동`}
                            >
                              <div className="font-medium text-gray-900 underline decoration-blue-200 underline-offset-2 transition hover:text-blue-700">
                                {title}
                              </div>
                            </button>
                          ) : (
                            <div className="font-medium text-gray-900" title={title}>
                              {title}
                            </div>
                          )}
                          {relatedFeeHistoryId && (
                            <button
                              type="button"
                              onClick={() =>
                                onJumpToFeeHistory(relatedFeeHistoryId)
                              }
                              className="shrink-0 rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700 transition hover:bg-blue-100"
                            >
                              단가 이력
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="px-5 py-4 text-sm font-semibold text-gray-900">
                        {formatMoney(item.deal_fee_hourly ?? null)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {(collapsedCount > 0 || data.teaching_history_remaining_count > 0) && (
            <div className="flex items-center justify-between gap-3 border-t border-gray-100 px-5 py-3">
              <div className="text-xs text-gray-500">
                {collapsedCount > 0
                  ? `접힌 이력 ${collapsedCount}건`
                  : `${data.teaching_history_remaining_count}건 더 있음`}
              </div>
              <div className="flex items-center gap-2">
                {collapsedCount > 0 && (
                  <button
                    type="button"
                    onClick={() => setIsExpanded((current) => !current)}
                    className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 transition hover:bg-gray-50"
                  >
                    {isExpanded ? "15개만 보기" : `${collapsedCount}건 더 펼치기`}
                  </button>
                )}
                {isExpanded && data.teaching_history_remaining_count > 0 && (
                  <button
                    type="button"
                    onClick={onLoadMore}
                    disabled={isLoadingMore}
                    className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isLoadingMore ? "불러오는 중..." : "서버에서 더 보기"}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// --- G. Fee History Section — 06_implementation_spec.md Feature J ---

function FeeHistorySection({
  data,
  highlightedFeeHistoryId,
}: {
  data: InstructorDetailData;
  highlightedFeeHistoryId: string | null;
}) {
  const history = data.fee_history as FeeHistoryItem[];
  const undatedHourlyCount = history.filter((item) => {
    const { label, sortKey } = getParsedFeeDateRange(item);
    return (
      !item.is_special_amount &&
      item.fee_kind === "hourly" &&
      item.amount !== null &&
      !(label && sortKey)
    );
  }).length;
  const timeline = attachTeachingFeeNotes(
    collapseFeeTimeline(history),
    extractTeachingFeeNotes(data.teaching_history as TeachingHistoryItem[])
  );
  const referenceItems = sortFeeHistoryChronologically(history).filter(
    (item) => {
      const { label, sortKey } = getParsedFeeDateRange(item);
      return (
        (item.is_special_amount || item.fee_kind !== "hourly") &&
        Boolean(label && sortKey)
      );
    }
  );
  const dateGroups = buildFeeHistoryDateGroups(timeline, referenceItems);

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-gray-900">단가 이력</h3>
      {history.length === 0 ? (
        <p className="text-sm text-gray-400">이력 없음</p>
      ) : (
        <div className="space-y-4">
          {timeline.length > 0 && <FeeTrendChart timeline={timeline} />}

          {undatedHourlyCount > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
              날짜를 확정할 수 없는 단가 이력 {undatedHourlyCount}건은 추이에서 제외했습니다.
            </div>
          )}

          {dateGroups.length > 0 && (
            <div className="rounded-lg border border-gray-200 bg-white">
              <div className="border-b border-gray-100 px-4 py-3">
                <div className="grid gap-2 md:grid-cols-[120px_minmax(0,1fr)_minmax(0,1fr)]">
                  <div className="text-xs font-medium text-gray-500">시점</div>
                  <div className="text-xs font-medium text-gray-500">
                    시간당 단가 변동
                  </div>
                  <div className="text-xs font-medium text-gray-500">
                    특수 금액 / 참고
                  </div>
                </div>
              </div>
              <div className="divide-y divide-gray-100">
                {dateGroups.map((group) => {
                  return (
                    <div key={group.sortKey} className="px-4 py-4">
                      <div className="grid gap-3 md:grid-cols-[120px_minmax(0,1fr)_minmax(0,1fr)]">
                        <div className="text-sm font-semibold text-gray-900">
                          {group.label}
                        </div>

                        <div className="space-y-2">
                          {group.timelineItems.length > 0 ? (
                            group.timelineItems.map(
                              ({ item, changeAmount, isCurrentSegment }, index) => {
                                const sourceDisplay =
                                  item.source_type === "contract_sheet"
                                    ? null
                                    : formatFeeSource(item.source_type);
                                const contextLine = [
                                  sourceDisplay,
                                  compactFeeContext(item.context, item.effective_label),
                                ]
                                  .filter(Boolean)
                                  .join(" · ");
                                const directionLabel =
                                  item.direction === "initial"
                                    ? "시작"
                                    : item.direction === "up"
                                      ? "상승"
                                      : "하락";
                                const badgeClass =
                                  item.direction === "up"
                                    ? "bg-green-100 text-green-700"
                                    : item.direction === "down"
                                      ? "bg-red-100 text-red-700"
                                      : "bg-gray-100 text-gray-600";

                                return (
                                  <div
                                    id={getFeeHistoryCardId(
                                      group.sortKey,
                                      "timeline",
                                      index
                                    )}
                                    key={`${item.start_key}-${item.amount}-${index}`}
                                    className={`rounded-md border px-3 py-3 transition-colors ${
                                      highlightedFeeHistoryId ===
                                      getFeeHistoryCardId(
                                        group.sortKey,
                                        "timeline",
                                        index
                                      )
                                        ? "border-blue-300 bg-blue-50"
                                        : "border-gray-200 bg-gray-50"
                                    }`}
                                  >
                                    <div className="flex items-start justify-between gap-4">
                                      <div className="min-w-0 flex-1 space-y-1">
                                        <div className="flex items-center gap-2 flex-wrap">
                                          <span
                                            className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${badgeClass}`}
                                          >
                                            {directionLabel}
                                          </span>
                                          {isCurrentSegment && (
                                            <span className="inline-flex items-center rounded bg-blue-100 px-1.5 py-0.5 text-xs font-medium text-blue-700">
                                              현재 단가
                                            </span>
                                          )}
                                        </div>
                                        <div className="text-xs text-gray-500">
                                          유지 구간:{" "}
                                          {formatFeeSegmentPeriod(
                                            item,
                                            isCurrentSegment
                                          )}
                                        </div>
                                        {contextLine && (
                                          <div className="text-xs text-gray-500">
                                            {contextLine}
                                          </div>
                                        )}
                                        {item.notes.length > 0 && (
                                          <div className="mt-2 space-y-1">
                                            {item.notes.map((note) => (
                                              <div
                                                key={note.id}
                                                className="rounded bg-white px-2 py-1.5 text-xs text-gray-600"
                                              >
                                                {(note.period || note.context) && (
                                                  <div className="mb-0.5 text-[11px] text-gray-500">
                                                    {[note.period, note.context]
                                                      .filter(Boolean)
                                                      .join(" · ")}
                                                  </div>
                                                )}
                                                <div>{note.note}</div>
                                              </div>
                                            ))}
                                          </div>
                                        )}
                                      </div>
                                      <div className="shrink-0 text-right">
                                        <div className="text-sm font-semibold text-gray-900">
                                          {formatMoney(item.amount)}
                                        </div>
                                        {changeAmount !== 0 && (
                                          <div className="mt-1 text-xs text-gray-500">
                                            {formatMoneyDelta(changeAmount)}
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                );
                              }
                            )
                          ) : (
                            <div className="rounded-md border border-dashed border-gray-200 px-3 py-3 text-xs text-gray-400">
                              해당 날짜의 시간당 단가 변동 없음
                            </div>
                          )}
                        </div>

                        <div className="space-y-2">
                          {group.referenceItems.length > 0 ? (
                            group.referenceItems.map((item, index) => {
                              const sourceDisplay =
                                item.source_type === "contract_sheet"
                                  ? null
                                  : formatFeeSource(item.source_type);
                              const contextLine = [
                                sourceDisplay,
                                compactFeeContext(item.context),
                              ]
                                .filter(Boolean)
                                .join(" · ");
                              const badgeClass = item.is_special_amount
                                ? "bg-orange-100 text-orange-700"
                                : "bg-gray-100 text-gray-600";
                              const badgeLabel = item.is_special_amount
                                ? "특수 금액"
                                : "참고";

                              return (
                                <div
                                  id={getFeeHistoryCardId(
                                    group.sortKey,
                                    "reference",
                                    index
                                  )}
                                  key={`${group.sortKey}-${item.source_type}-${index}`}
                                  className={`rounded-md border px-3 py-3 transition-colors ${
                                    highlightedFeeHistoryId ===
                                    getFeeHistoryCardId(
                                      group.sortKey,
                                      "reference",
                                      index
                                    )
                                      ? "border-blue-300 bg-blue-50"
                                      : "border-orange-200 bg-orange-50"
                                  }`}
                                >
                                  <div className="flex items-start justify-between gap-4">
                                    <div className="min-w-0 flex-1 space-y-1">
                                      <div className="flex items-center gap-2 flex-wrap">
                                        <span
                                          className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${badgeClass}`}
                                        >
                                          {badgeLabel}
                                        </span>
                                      </div>
                                      {contextLine && (
                                        <div className="text-xs text-gray-500">
                                          {contextLine}
                                        </div>
                                      )}
                                    </div>
                                    <div className="shrink-0 text-right">
                                      <div className="text-sm font-semibold text-gray-900">
                                        {formatMoney(item.amount)}
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              );
                            })
                          ) : (
                            <div className="rounded-md border border-dashed border-gray-200 px-3 py-3 text-xs text-gray-400">
                              해당 날짜의 특수 금액 / 참고 이력 없음
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {dateGroups.length === 0 && (
            <p className="text-sm text-gray-400">이력 없음</p>
          )}
        </div>
      )}
    </section>
  );
}

// --- H. Operations Memo Section ---

function MemoSection({ data }: { data: InstructorDetailData }) {
  const diagnostics = data.notion_memo_diagnostics ?? {
    source_linked: false,
    notion_page_id: null,
    enrichment_attempted: false,
    enrichment_updated: false,
    comment_capability: "unknown" as const,
    page_comment_count: 0,
    block_comment_count: 0,
    block_text_count: 0,
    incoming_line_count: 0,
    error_message: null,
  };
  const showDiagnostics =
    diagnostics.source_linked ||
    diagnostics.enrichment_attempted ||
    diagnostics.error_message !== null;

  if (!data.memo && !showDiagnostics) return null;

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-gray-900">운영 메모</h3>
      {showDiagnostics && (
        <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
          <div className="mb-2 text-[11px] font-medium text-gray-600">
            Notion 메모 진단
          </div>
          <div className="grid gap-2 text-[11px] text-gray-600 sm:grid-cols-2 lg:grid-cols-3">
            <div>source link {diagnostics.source_linked ? "연결됨" : "없음"}</div>
            <div>enrichment {diagnostics.enrichment_attempted ? "시도함" : "미시도"}</div>
            <div>updated {diagnostics.enrichment_updated ? "예" : "아니오"}</div>
            <div>comment capability {diagnostics.comment_capability}</div>
            <div>page comments {diagnostics.page_comment_count}건</div>
            <div>block comments {diagnostics.block_comment_count}건</div>
            <div>page body lines {diagnostics.block_text_count}건</div>
            <div>incoming lines {diagnostics.incoming_line_count}건</div>
            <div className="sm:col-span-2 lg:col-span-3">
              notion page id {diagnostics.notion_page_id ?? "-"}
            </div>
          </div>
          {diagnostics.error_message && (
            <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {diagnostics.error_message}
            </div>
          )}
        </div>
      )}
      {data.memo && (
        <div className="px-4 py-3 text-sm text-gray-700 bg-gray-50 border border-gray-200 rounded-lg whitespace-pre-wrap leading-relaxed">
          {data.memo}
        </div>
      )}
    </section>
  );
}
