"use client";

import { useQuery } from "@tanstack/react-query";
import { useState, useCallback, useEffect, useRef } from "react";
import type {
  InstructorDetailResponse,
  InstructorDetailData,
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
import { getCurrentFeeTimelineIndex } from "@/lib/fee-history-timeline";
import { extractDisplayLinesWithoutGoogleLinks } from "@/lib/google-link-sanitizer";

// --- Fetch helpers ---

async function fetchInstructorDetail(
  id: string,
  teachingHistoryLimit: number
): Promise<InstructorDetailResponse> {
  // Step 5 lazy load: 메인 detail은 OI 제외(include_oi=0). OI는 별도 endpoint에서 fetch.
  const searchParams = new URLSearchParams({
    teaching_history_limit: String(teachingHistoryLimit),
    include_oi: "0",
  });
  const res = await fetch(`/api/instructors/${id}?${searchParams.toString()}`);
  if (!res.ok) throw new Error("상세 조회 실패");
  return res.json();
}

interface IntelligenceData {
  recommended_for: string[];
  avoid_for: string[];
  risk_notes: string[];
  raw_operational_notes: InstructorDetailData["raw_operational_notes"];
  classified_notes: InstructorDetailData["classified_notes"];
  human_followups: InstructorDetailData["human_followups"];
  behavioral_intelligence: InstructorDetailData["behavioral_intelligence"];
  operational_intelligence_meta: InstructorDetailData["operational_intelligence_meta"];
  operational_evidence_snapshots: InstructorDetailData["operational_evidence_snapshots"];
}

async function fetchInstructorIntelligence(
  id: string
): Promise<IntelligenceData> {
  const res = await fetch(`/api/instructors/${id}/intelligence`);
  if (!res.ok) throw new Error("운영 인텔 조회 실패");
  const json = (await res.json()) as { data: IntelligenceData };
  return json.data;
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

function getNotionCommentBundleKey(
  note: InstructorDetailData["raw_operational_notes"][number]
): string {
  const sourceRef = note.source_ref ?? {};
  const author =
    typeof sourceRef.author === "string" ? sourceRef.author.trim() : "";
  const observedAt = getOperationalNoteDate(note) ?? "";
  return `${note.source_type}:notion_comment:${author}:${observedAt}`;
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

type NotionCommentCard = {
  key: string;
  sourceLabel: string;
  observedAt: string | null;
  text: string;
};

type OperationalSourceCitation = {
  id: string;
  sourceTitle: string;
  sourceMeta: string;
  observedAt: string | null;
  text: string;
};

const NOTION_COMMENT_SECTION_ID = "notion-comment-experience";

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

function OperationalMemoCard({
  sourceLabel,
  observedAt,
  text,
}: {
  sourceLabel: string;
  observedAt: string | null;
  text: string;
}) {
  return (
    <article className="rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="font-semibold text-gray-800">{sourceLabel}</span>
        <span className="text-gray-300">·</span>
        <span className="font-medium text-gray-600">
          작성일 {formatDate(observedAt)}
        </span>
      </div>
      <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-gray-800">
        {text}
      </p>
    </article>
  );
}

function sanitizeOperationalSourceText(text: string): string {
  return extractDisplayLinesWithoutGoogleLinks(text).join("\n").trim();
}

function buildOperationalSourceContext(
  note: InstructorDetailData["raw_operational_notes"][number]
): string | null {
  const context = [note.client_name, note.course_name, note.round_label]
    .filter((value): value is string => Boolean(value && value.trim()))
    .join(" · ");

  return context || null;
}

function getOperationalSourceTitle(
  note: InstructorDetailData["raw_operational_notes"][number]
): string {
  const sourceRef = note.source_ref ?? {};
  const sourceTitleCandidates = [
    typeof sourceRef.subject === "string" ? sourceRef.subject : null,
    typeof sourceRef.section_title === "string" ? sourceRef.section_title : null,
    typeof sourceRef.title === "string" ? sourceRef.title : null,
    note.course_name,
  ]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);

  const primary = sourceTitleCandidates[0] ?? "";
  const secondaryCandidates = [note.round_label, note.client_name]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean)
    .filter((value) => !primary.includes(value));

  const title = [primary, ...secondaryCandidates].filter(Boolean).join(" · ");
  return title || buildOperationalSourceContext(note) || formatOperationalSource(note.source_type);
}

function buildOperationalSourceCitations(
  data: InstructorDetailData,
  sourceNoteIds: string[]
): OperationalSourceCitation[] {
  const noteById = new Map(data.raw_operational_notes.map((note) => [note.id, note]));

  return Array.from(new Set(sourceNoteIds))
    .map((sourceNoteId) => noteById.get(sourceNoteId))
    .filter(
      (
        note
      ): note is InstructorDetailData["raw_operational_notes"][number] =>
        Boolean(note)
    )
    .filter((note) => note.source_type !== "notion_comment")
    .map((note) => ({
      id: note.id,
      sourceTitle: getOperationalSourceTitle(note),
      sourceMeta: formatOperationalSource(note.source_type),
      observedAt: getOperationalNoteDate(note),
      text: sanitizeOperationalSourceText(note.raw_text),
    }))
    .filter((item) => item.text.length > 0);
}

/**
 * Step 9 inline citation: raw_operational_notes 중 sourceNoteIds 첫 매칭 raw_text 발췌.
 * UI에 quote-box 형식으로 표시 — "왜 이런 의견이 나왔는지" 즉시 노출.
 */
function getInlineCitation(
  sourceNoteIds: string[] | undefined,
  rawNotes: InstructorDetailData["raw_operational_notes"],
  maxLength = 140
): string | null {
  if (!sourceNoteIds || sourceNoteIds.length === 0) return null;
  const noteById = new Map(rawNotes.map((n) => [n.id, n]));
  for (const noteId of sourceNoteIds) {
    const note = noteById.get(noteId);
    if (!note || !note.raw_text) continue;
    // 연속된 빈 줄·중복 공백만 정리하고 줄바꿈은 보존
    const text = note.raw_text
      .replace(/[\t ]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (!text) continue;
    return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
  }
  return null;
}

function InlineCitation({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <div className="mt-2 border-l-2 border-slate-300 bg-slate-50/70 px-2.5 py-1.5 text-[11px] leading-[1.55] text-slate-600 whitespace-pre-line">
      {text}
    </div>
  );
}

function OperationalSourceRefs({
  data,
  sourceNoteIds,
  title = "대표 출처",
}: {
  data: InstructorDetailData;
  sourceNoteIds: string[];
  title?: string;
}) {
  const citations = buildOperationalSourceCitations(data, sourceNoteIds);
  if (citations.length === 0) return null;

  return (
    <details className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
      <summary className="cursor-pointer text-[11px] font-semibold text-slate-600">
        {title} {citations.length}건 · 전체 출처 보기
      </summary>
      <div className="mt-2 space-y-2">
        {citations.map((citation) => (
          <div
            key={citation.id}
            className="rounded-md border border-slate-200 bg-white px-3 py-2"
          >
            <div className="flex flex-wrap items-center gap-2 text-[10px] text-slate-500">
              <span className="font-semibold text-slate-700">
                {citation.sourceTitle}
              </span>
              <span>{citation.sourceMeta}</span>
              <span>{formatDate(citation.observedAt)}</span>
            </div>
            <p className="mt-1 whitespace-pre-wrap text-[11px] leading-5 text-slate-700">
              {citation.text}
            </p>
          </div>
        ))}
      </div>
    </details>
  );
}

function sanitizeOperationalMemoText(text: string): string {
  const shouldHideSegment = (segment: string): boolean =>
    /(?:https?:\/\/)?(?:drive|docs)\.google\.com\//i.test(segment) ||
    /(서류|계약서|사업자등록증|통장사본|법인\s*계약)/i.test(segment);

  const segments = text
    .split(/\n+|\s\/\s/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .filter((segment) => !shouldHideSegment(segment));

  return segments.join("\n");
}

function buildNotionCommentCards(data: InstructorDetailData): NotionCommentCard[] {
  const groupedOperationalNotes = Array.from(
    data.raw_operational_notes.reduce((map, note) => {
      const key =
        note.source_type === "notion_comment"
          ? getNotionCommentBundleKey(note)
          : note.id;
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

  return collapseOperationalNoteGroups(groupedOperationalNotes)
    .filter((note) => note.sourceType === "notion_comment")
    .map((note) => ({
      key: `notion-${note.key}`,
      sourceLabel: "노션 comment",
      observedAt: note.observedAt,
      text: sanitizeOperationalMemoText(note.texts.join("\n")),
    }))
    .filter((note) => note.text.length > 0)
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
const COLLAPSED_TEACHING_HISTORY_COUNT = 5;

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
    label: "만족도",
    max: 15,
    tooltip:
      "최근 6개월 만족도 평균을 15점 만점으로 환산한 값, 데이터가 없으면 전체 강사의 보통 수준 점수를 사용",
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
  return extractDisplayLinesWithoutGoogleLinks(...values).filter(
    (note) => !shouldHideContractNote(note)
  );
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

const OPERATIONAL_SOURCE_LABELS: Record<string, string> = {
  curated_ops: "운영 메모",
  notion_comment: "노션 comment",
  slack_highlight: "슬랙",
  teaching_feedback_qualitative: "강의 피드백",
  teaching_feedback_ops: "운영 피드백",
};

function formatOperationalSource(sourceType: string): string {
  return OPERATIONAL_SOURCE_LABELS[sourceType] ?? sourceType;
}

function getBehavioralPatternSourceIds(
  patternRefs: InstructorDetailData["behavioral_intelligence"]["source_refs"]["risk_patterns"],
  text: string
): string[] {
  const normalizedText = normalizeComparableText(text);
  return (
    patternRefs.find(
      (item) => normalizeComparableText(item.text) === normalizedText
    )?.source_note_ids ?? []
  );
}

function collectOpsIntelligenceSourceNoteIds(args: {
  recommendationSourceNoteIds: string[];
  detailItems: Array<{ sourceNoteIds: string[] }>;
  strengths: string[];
  risks: string[];
  behavioral: InstructorDetailData["behavioral_intelligence"];
}): string[] {
  return Array.from(
    new Set([
      ...args.recommendationSourceNoteIds,
      ...args.detailItems.flatMap((item) => item.sourceNoteIds),
      ...args.strengths.flatMap((item) =>
        getBehavioralPatternSourceIds(args.behavioral.source_refs.strength_patterns, item)
      ),
      ...args.risks.flatMap((item) =>
        getBehavioralPatternSourceIds(args.behavioral.source_refs.risk_patterns, item)
      ),
    ])
  );
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
}

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
  const currentTimelineIndex = getCurrentFeeTimelineIndex(timeline);

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
      isCurrentSegment: index === currentTimelineIndex,
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
  const currentTimelineIndex = getCurrentFeeTimelineIndex(timeline);
  const currentItem = timeline[currentTimelineIndex];
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
          const isCurrentPoint = index === currentTimelineIndex;

          return (
            <g key={`${point.item.start_key}-${point.item.amount}-${index}`}>
              {isCurrentPoint && (
                <circle
                  cx={x}
                  cy={y}
                  r="9"
                  fill="#FFFFFF"
                  stroke="#93C5FD"
                  strokeWidth="2"
                />
              )}
              <circle
                cx={x}
                cy={y}
                r={isCurrentPoint ? 5.5 : 4.5}
                fill="#2563EB"
              />
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
  const [feeHistoryTableExpandedByInstructor, setFeeHistoryTableExpandedByInstructor] =
    useState<Record<string, boolean>>({});
  const [highlightedFeeHistoryState, setHighlightedFeeHistoryState] = useState<{
    instructorId: string;
    targetId: string;
  } | null>(null);
  const [pendingFeeHistoryScrollTarget, setPendingFeeHistoryScrollTarget] =
    useState<{
      instructorId: string;
      targetId: string;
    } | null>(null);
  const feeHistoryHighlightTimerRef = useRef<number | null>(null);
  const teachingHistoryLimit = teachingHistoryLimits[instructorId] ?? 30;
  const isFeeHistoryTableExpanded =
    feeHistoryTableExpandedByInstructor[instructorId] ?? false;
  const highlightedFeeHistoryId =
    highlightedFeeHistoryState?.instructorId === instructorId
      ? highlightedFeeHistoryState.targetId
      : null;

  const { data, isLoading, isError, error, isFetching } = useQuery({
    queryKey: ["instructor", instructorId, teachingHistoryLimit],
    queryFn: () => fetchInstructorDetail(instructorId, teachingHistoryLimit),
    staleTime: 60_000,
  });
  // Step 5 lazy load: 운영 인텔 섹션은 별도 fetch. 메인 detail 첫 페인트 후 OI 도착 시 채움.
  const { data: intel, isLoading: intelLoading } = useQuery({
    queryKey: ["instructor-intel", instructorId],
    queryFn: () => fetchInstructorIntelligence(instructorId),
    enabled: Boolean(data?.data?.id),
    staleTime: 60_000,
  });

  const handleJumpToFeeHistory = useCallback((targetId: string) => {
    setFeeHistoryTableExpandedByInstructor((current) => ({
      ...current,
      [instructorId]: true,
    }));
    setPendingFeeHistoryScrollTarget({ instructorId, targetId });
  }, [instructorId]);

  useEffect(() => {
    if (!pendingFeeHistoryScrollTarget) return;
    if (pendingFeeHistoryScrollTarget.instructorId !== instructorId) return;

    let frameId = 0;
    let retryFrameId = 0;

    const scrollToTarget = () => {
      const target = document.getElementById(pendingFeeHistoryScrollTarget.targetId);
      if (!target) {
        retryFrameId = window.requestAnimationFrame(() => {
          const retriedTarget = document.getElementById(
            pendingFeeHistoryScrollTarget.targetId
          );
          if (!retriedTarget) return;

          retriedTarget.scrollIntoView({ behavior: "smooth", block: "center" });
          setHighlightedFeeHistoryState(pendingFeeHistoryScrollTarget);
          setPendingFeeHistoryScrollTarget(null);
        });
        return;
      }

      target.scrollIntoView({ behavior: "smooth", block: "center" });
      setHighlightedFeeHistoryState(pendingFeeHistoryScrollTarget);
      setPendingFeeHistoryScrollTarget(null);
    };

    frameId = window.requestAnimationFrame(scrollToTarget);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.cancelAnimationFrame(retryFrameId);
    };
  }, [instructorId, pendingFeeHistoryScrollTarget]);

  useEffect(() => {
    if (!highlightedFeeHistoryState) return;

    if (feeHistoryHighlightTimerRef.current !== null) {
      window.clearTimeout(feeHistoryHighlightTimerRef.current);
    }

    feeHistoryHighlightTimerRef.current = window.setTimeout(() => {
      setHighlightedFeeHistoryState(null);
      feeHistoryHighlightTimerRef.current = null;
    }, 2400);

    return () => {
      if (feeHistoryHighlightTimerRef.current !== null) {
        window.clearTimeout(feeHistoryHighlightTimerRef.current);
        feeHistoryHighlightTimerRef.current = null;
      }
    };
  }, [highlightedFeeHistoryState]);

  if (isLoading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center px-8 text-sm font-medium text-[var(--text-muted)]">
        상세 정보를 불러오는 중...
      </div>
    );
  }

  if (isError) {
    return (
      <div className="dashboard-empty">
        <div className="empty-state border-red-200 text-red-500">
          <div className="empty-state-mark bg-red-50 text-red-500">!</div>
          <p className="text-sm font-medium">
            {(error as Error)?.message ?? "상세 정보를 불러오지 못했습니다."}
          </p>
        </div>
      </div>
    );
  }

  if (!data?.data) {
    return (
      <div className="dashboard-empty">
        <div className="empty-state">
          <div className="empty-state-mark">-</div>
          <p className="text-sm font-medium text-slate-500">데이터가 없습니다.</p>
        </div>
      </div>
    );
  }

  // Step 5 lazy load: intel data 도착 시 OI 필드 override (메인 detail은 OI 빈 값).
  const baseInst = data.data;
  const inst: InstructorDetailData = intel
    ? {
        ...baseInst,
        recommended_for: intel.recommended_for,
        avoid_for: intel.avoid_for,
        risk_notes: intel.risk_notes,
        raw_operational_notes: intel.raw_operational_notes,
        classified_notes: intel.classified_notes,
        human_followups: intel.human_followups,
        behavioral_intelligence: intel.behavioral_intelligence,
        operational_intelligence_meta: intel.operational_intelligence_meta,
        operational_evidence_snapshots: intel.operational_evidence_snapshots,
      }
    : baseInst;
  const notionCommentCards = buildNotionCommentCards(inst);
  const handleJumpToNotionComments = () => {
    const target = document.getElementById(NOTION_COMMENT_SECTION_ID);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="dashboard-main-inner">
      <div className="mx-auto max-w-6xl">
        <HeaderSection
          data={inst}
          hasNotionComments={notionCommentCards.length > 0}
          onJumpToNotionComments={handleJumpToNotionComments}
        />
        <MetricsSection data={inst} />
        <FeeHistorySection
          data={inst}
          isTableExpanded={isFeeHistoryTableExpanded}
          onToggleTable={() =>
            setFeeHistoryTableExpandedByInstructor((current) => ({
              ...current,
              [instructorId]: !isFeeHistoryTableExpanded,
            }))
          }
          highlightedFeeHistoryId={highlightedFeeHistoryId}
        />
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
        <section className="grid gap-4 xl:grid-cols-2">
          <ScoreBreakdownSection data={inst} />
          <SatisfactionSection data={inst} />
        </section>
        {intelLoading && !intel ? (
          <section>
            <div className="intel-card animate-pulse">
              <div className="intel-header">
                <span className="intel-title">운영 인텔리전스</span>
                <span className="intel-richness text-[var(--text-muted)]">
                  불러오는 중…
                </span>
              </div>
              <div className="intel-section intel-top-summary">
                <div className="h-4 w-full rounded bg-slate-200 mb-2"></div>
                <div className="h-4 w-5/6 rounded bg-slate-200"></div>
              </div>
              <div className="intel-section intel-rec">
                <div className="h-4 w-2/3 rounded bg-slate-200"></div>
              </div>
              <div className="intel-grid">
                <div>
                  <div className="intel-col-title intel-strength-title">강점</div>
                  <div className="h-12 rounded bg-slate-100"></div>
                </div>
                <div>
                  <div className="intel-col-title intel-risk-title">주의</div>
                  <div className="h-12 rounded bg-slate-100"></div>
                </div>
              </div>
            </div>
          </section>
        ) : (
          <OpsIntelligenceSection
            data={inst}
            notionCommentCards={notionCommentCards}
          />
        )}
        <MemoSection data={inst} />
      </div>
    </div>
  );
}

// --- A. Header Section ---

function HeaderSection({
  data,
  hasNotionComments,
  onJumpToNotionComments,
}: {
  data: InstructorDetailData;
  hasNotionComments: boolean;
  onJumpToNotionComments: () => void;
}) {
  const subtitleParts = Array.from(
    new Map(
      [
        data.categories[0] ?? null,
        data.is_fulltime ? "전임강사" : null,
        data.is_practice_coach ? "실습코치" : null,
      ]
        .filter((value): value is string => Boolean(value && value.trim()))
        .map((value) => [value.replace(/\s+/g, "").toLowerCase(), value])
    ).values()
  );
  const contactItems = [
    {
      label: "이메일",
      value: data.contact.email,
      marker: "@",
      href: data.contact.email ? `mailto:${data.contact.email}` : null,
    },
    {
      label: "연락처",
      value: data.contact.phone,
      marker: "TEL",
      href: data.contact.phone
        ? `tel:${data.contact.phone.replace(/[^0-9+]/g, "")}`
        : null,
    },
    {
      label: "기본 단가",
      value: formatMoneyPerHour(data.base_fee_hourly, data.is_fulltime),
      marker: "W",
      href: null,
    },
    {
      label: "소속",
      value: data.affiliation,
      marker: "A",
      href: null,
    },
  ].filter((item) => item.value && item.value !== "-");

  return (
    <section className="profile-card">
      <div className="profile-top">
        <div className="profile-identity">
          <div className="flex flex-wrap items-center gap-2">
            <h2>
              {data.name}
              {data.is_practice_coach && <span className="rank-label">실습코치</span>}
            </h2>
            {hasNotionComments && (
              <button
                type="button"
                onClick={onJumpToNotionComments}
                className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-1.5 py-px font-medium text-amber-700 transition hover:border-amber-300 hover:bg-amber-100"
                style={{ fontSize: "11px", lineHeight: 1.15 }}
              >
                노션 코멘트 확인 필요
              </button>
            )}
          </div>

          {subtitleParts.length > 0 && (
            <div className="subtitle">{subtitleParts.join(" · ")}</div>
          )}

          {data.profile_summary && (
            <p className="mt-3 max-w-3xl text-[13px] leading-6 text-[var(--text-secondary)]">
              {data.profile_summary}
            </p>
          )}
        </div>

        <div className="profile-score">
          <div
            className="score-value"
            style={{ color: data.score !== null ? "var(--primary)" : "var(--text-muted)" }}
          >
            {formatScore(data.score)}
          </div>
          <div className="score-label">Engagement Score</div>
        </div>
      </div>

      {contactItems.length > 0 && (
        <div className="profile-details">
          {contactItems.map((item) => {
            const content = (
              <>
                <span className="detail-item-mark">{item.marker}</span>
                <div className="min-w-0">
                  <div className="label">{item.label}</div>
                  <div className="value break-all">{item.value}</div>
                </div>
              </>
            );

            if (item.href) {
              return (
                <a key={item.label} href={item.href} className="detail-item">
                  {content}
                </a>
              );
            }

            return (
              <div key={item.label} className="detail-item">
                {content}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// --- B. Key Metrics Section ---

function MetricsSection({ data }: { data: InstructorDetailData }) {
  const feeHistory = data.fee_history as FeeHistoryItem[];
  const feeTimeline = collapseFeeTimeline(feeHistory);
  const firstFee = feeTimeline[0] ?? null;
  const lastFee = feeTimeline[feeTimeline.length - 1] ?? null;
  const feeChange =
    firstFee && lastFee ? lastFee.amount - firstFee.amount : 0;
  const feeChangeValue =
    feeTimeline.length < 2
      ? "변동없음"
      : feeChange > 0
        ? `+${formatMoney(feeChange)}`
        : feeChange < 0
          ? `-${formatMoney(Math.abs(feeChange))}`
          : "변동없음";
  const feeChangeToneClass =
    feeTimeline.length < 2 || feeChange === 0
      ? "text-[var(--text-muted)]"
      : feeChange > 0
        ? "text-[var(--success)]"
        : "text-[var(--danger)]";
  const feeChangeSub = firstFee ? `${firstFee.start_label} ~ 현재` : "-";

  const metrics = [
    {
      label: "총 출강",
      value: `${data.total_courses}회`,
      sub: "전체 기간",
    },
    {
      label: "총 출강시간",
      value: formatHours(data.total_hours),
      sub: "누적 강의 시간",
    },
    {
      label: "최근 6개월",
      value: `${data.recent_courses_6mo}회`,
      sub: "최근 활동",
    },
    {
      label: "누적 지급액",
      value: formatMoney(data.total_paid),
      sub: "기록 기준",
    },
    {
      label: "단가 변동",
      value: feeChangeValue,
      sub: feeChangeSub,
      toneClass: feeChangeToneClass,
    },
  ];

  return (
    <section className="kpi-row">
      {metrics.map((m) => (
        <div key={m.label} className="kpi-card min-w-0">
          <div className="kpi-label">{m.label}</div>
          <div className={`kpi-value truncate ${m.toneClass ?? ""}`}>{m.value}</div>
          <div className="kpi-sub">{m.sub}</div>
        </div>
      ))}
    </section>
  );
}

// --- C. Score Breakdown Section ---

function ScoreBreakdownSection({
  data,
}: {
  data: InstructorDetailData;
}) {
  const breakdown = data.score_breakdown ?? {};
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
    <section className="section-card">
      <div className="section-title">
        <span className="section-title-mark">S</span>
        점수 구성
      </div>
      <div className="mb-4 flex items-end justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <span className="text-[24px] font-bold text-[var(--text-primary)]">
            {formatScore(data.score)}
          </span>
          <span className="text-[12px] text-[var(--text-muted)]">/ 100</span>
        </div>
        <span className="text-[10px] text-[var(--text-muted)]">
          Engagement Score
        </span>
      </div>
      <div className="space-y-2">
        {breakdownItems.map((item) => (
          <div key={item.key} className="flex items-center gap-2 text-[11px]">
            <span className="w-[60px] shrink-0 text-[var(--text-secondary)]">
              {item.label}
            </span>
            <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-[var(--border-light)]">
              <div
                className={`h-full rounded-full ${item.colorClass} opacity-70`}
                style={{
                  width: `${Math.min(100, Math.max(0, (item.value / item.max) * 100))}%`,
                }}
              />
            </div>
            <span className="w-[45px] shrink-0 text-right font-semibold text-[var(--text-primary)]">
              {item.value.toFixed(1)}
            </span>
            <span className="w-[30px] shrink-0 text-[var(--text-muted)]">
              /{item.max}
            </span>
            <InlineTooltip label={item.label} text={item.tooltip} />
          </div>
        ))}
      </div>
    </section>
  );
}

function SatisfactionSection({
  data,
}: {
  data: InstructorDetailData;
}) {
  const recentSatisfactionEntries = buildRecentSatisfactionEntries(data);
  const satisfactionAverage = data.recent_satisfaction_summary.avg;
  const roundedScore =
    satisfactionAverage === null
      ? 0
      : Math.max(0, Math.min(5, Math.round(satisfactionAverage)));
  const stars = `${"★".repeat(roundedScore)}${"☆".repeat(5 - roundedScore)}`;

  return (
    <section className="section-card">
      <div className="section-title">
        <span className="section-title-mark">T</span>
        만족도
      </div>
      <div className="mb-2 flex items-center gap-3">
        <span className="text-[24px] font-bold text-[var(--text-primary)]">
          {satisfactionAverage !== null ? satisfactionAverage.toFixed(1) : "-"}
        </span>
        <span className="text-[16px] tracking-[1.5px] text-[var(--warning)]">
          {stars}
        </span>
        <span className="text-[12px] text-[var(--text-muted)]">
          {data.recent_satisfaction_summary.count}건 조사
        </span>
      </div>
      <div className="text-[12px] text-[var(--text-secondary)]">
        최근 6개월 만족도 결과
        {data.recent_satisfaction_summary.is_imputed && (
          <span className="ml-2 inline-flex items-center rounded bg-yellow-50 px-2 py-0.5 text-[11px] text-yellow-700">
            추정값
          </span>
        )}
      </div>
      {recentSatisfactionEntries.length > 0 && (
        <div className="mt-4 rounded-[var(--radius-xs)] border border-[var(--border)] bg-[var(--bg)] px-3 py-3">
          <div className="text-[11px] font-medium text-[var(--text-primary)]">
            최근 6개월 내역 {recentSatisfactionEntries.length}건
          </div>
          <details className="mt-2">
            <summary className="cursor-pointer text-[11px] font-medium text-[var(--text-secondary)]">
              날짜와 과정 내역 보기
            </summary>
            <div className="mt-2 max-h-72 space-y-2 overflow-y-auto pr-1">
              {recentSatisfactionEntries.map((item) => (
                <div
                  key={item.key}
                  className="rounded-[var(--radius-xs)] bg-white px-3 py-2 text-[11px] text-[var(--text-secondary)]"
                >
                  <div className="text-[10px] font-medium text-[var(--text-muted)]">
                    {formatDate(item.observedAt)}
                  </div>
                  <div className="mt-1 text-[var(--text-primary)]">
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
    </section>
  );
}

// --- D. Operations Intelligence Section ---

function OpsIntelligenceSection({
  data,
  notionCommentCards,
}: {
  data: InstructorDetailData;
  notionCommentCards: NotionCommentCard[];
}) {
  const behavioral = data.behavioral_intelligence;
  const strengths = behavioral.strength_patterns ?? [];
  const risks =
    behavioral.risk_patterns.length > 0
      ? behavioral.risk_patterns
      : data.risk_notes;
  const detailItems = [
    {
      title: "강의 스타일",
      body: behavioral.teaching_style,
      sourceNoteIds: behavioral.source_refs.teaching_style,
    },
    {
      title: "커리큘럼 준수",
      body: behavioral.curriculum_compliance,
      sourceNoteIds: behavioral.source_refs.curriculum_compliance,
    },
    {
      title: "애티튜드",
      body: behavioral.attitude,
      sourceNoteIds: behavioral.source_refs.attitude,
    },
  ].filter(
    (
      item
    ): item is { title: string; body: string; sourceNoteIds: string[] } =>
      Boolean(item.body && item.body.trim())
  );
  const hasTags = data.recommended_for.length > 0 || data.avoid_for.length > 0;
  const richnessTone =
    behavioral.data_richness === "rich"
      ? "text-[var(--success)]"
      : behavioral.data_richness === "moderate"
        ? "text-[var(--primary)]"
        : "text-[var(--text-muted)]";
  const hasNotionComments = notionCommentCards.length > 0;
  const opsSummarySourceNoteIds = collectOpsIntelligenceSourceNoteIds({
    recommendationSourceNoteIds: behavioral.source_refs.recommendation,
    detailItems,
    strengths,
    risks,
    behavioral,
  });

  const labelSuppressionReason =
    data.operational_intelligence_meta?.label_suppression_reason ?? null;
  const hedgeEvidenceCount =
    data.operational_intelligence_meta?.hedge_evidence_count ?? null;

  return (
    <section>
      <div className="intel-card">
        <div className="intel-header">
          <span className="intel-title">운영 인텔리전스</span>
          <span className={`intel-richness ${richnessTone}`}>
            {behavioral.data_richness}
          </span>
        </div>

        {behavioral.top_summary ? (
          <div className="intel-section intel-top-summary">
            <p className="whitespace-pre-line text-[13px] leading-relaxed text-[var(--text-primary)]">
              {behavioral.top_summary}
            </p>
            {labelSuppressionReason === "single_source_hedged" &&
              hedgeEvidenceCount !== null && (
                <p className="mt-2 text-[11px] text-[var(--text-muted)]">
                  단일 출처 {hedgeEvidenceCount}건 기반 — 일반화에 주의 필요.
                </p>
              )}
          </div>
        ) : labelSuppressionReason === "rule_based_fallback" ? (
          <div className="intel-section intel-top-summary">
            <p className="text-[12px] text-[var(--text-muted)]">
              자동 분류 결과로 종합 요약을 노출하지 않습니다. 아래 운영 메모와 피드백 원문을 참고하세요.
            </p>
          </div>
        ) : null}

        <div className="intel-section intel-rec">
          <p className="intel-rec-label">
            {behavioral.recommendation ??
              "운영 근거가 아직 충분히 수집되지 않았습니다. 추가 메모와 피드백이 쌓이면 적합·주의 포인트를 함께 보여줍니다."}
          </p>
          {behavioral.recommendation && (
            <InlineCitation
              text={getInlineCitation(
                behavioral.source_refs.recommendation,
                data.raw_operational_notes
              )}
            />
          )}
          {hasTags && (
            <div className="mt-2 space-y-2">
              {data.recommended_for.length > 0 && (
                <div className="intel-tags">
                  <span className="intel-tag-label good">적합</span>
                  {data.recommended_for.map((tag) => (
                    <span key={`recommended-${tag}`} className="intel-tag good">
                      {tag}
                    </span>
                  ))}
                </div>
              )}
              {data.avoid_for.length > 0 && (
                <div className="intel-tags">
                  <span className="intel-tag-label bad">지양</span>
                  {data.avoid_for.map((tag) => (
                    <span key={`avoid-${tag}`} className="intel-tag bad">
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="intel-grid">
          <div className="space-y-3">
            <div className="intel-col-title intel-strength-title">강점</div>
            {strengths.length > 0 ? (
              strengths.slice(0, 3).map((item) => {
                const patternRef = behavioral.source_refs.strength_patterns?.find(
                  (ref) => ref.text === item
                );
                return (
                  <div key={item} className="intel-pattern intel-strength">
                    <div className="font-medium">{item}</div>
                    <InlineCitation
                      text={getInlineCitation(
                        patternRef?.source_note_ids,
                        data.raw_operational_notes
                      )}
                    />
                  </div>
                );
              })
            ) : (
              <div className="intel-pattern bg-[var(--bg)] text-[var(--text-muted)]">
                강점 정보 없음
              </div>
            )}
          </div>
          <div className="space-y-3">
            <div className="intel-col-title intel-risk-title">주의</div>
            {risks.length > 0 ? (
              risks.slice(0, 3).map((item) => {
                const patternRef = behavioral.source_refs.risk_patterns?.find(
                  (ref) => ref.text === item
                );
                return (
                  <div key={item} className="intel-pattern intel-risk-high">
                    <div className="font-medium">{item}</div>
                    <InlineCitation
                      text={getInlineCitation(
                        patternRef?.source_note_ids,
                        data.raw_operational_notes
                      )}
                    />
                  </div>
                );
              })
            ) : (
              <div className="intel-pattern bg-[var(--bg)] text-[var(--text-muted)]">
                주의 정보 없음
              </div>
            )}
          </div>
        </div>

        {detailItems.length > 0 && (
          <div className="intel-details space-y-3">
            {detailItems.map((item) => (
              <div key={item.title} className="intel-detail">
                <div className="intel-detail-title">{item.title}</div>
                <div className="intel-detail-body">{item.body}</div>
                <InlineCitation
                  text={getInlineCitation(
                    item.sourceNoteIds,
                    data.raw_operational_notes
                  )}
                />
              </div>
            ))}
          </div>
        )}

        <OperationalSourceRefs
          data={data}
          sourceNoteIds={opsSummarySourceNoteIds}
        />

        {hasNotionComments && (
          <div
            id={NOTION_COMMENT_SECTION_ID}
            className="scroll-mt-6 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] px-4 py-3 shadow-sm"
          >
            <p className="text-[11px] font-semibold tracking-wide text-[var(--text-primary)]">
              협업 경험
            </p>
            <div className="mt-4 space-y-3">
              {notionCommentCards.map((card) => (
                <OperationalMemoCard
                  key={card.key}
                  sourceLabel={card.sourceLabel}
                  observedAt={card.observedAt}
                  text={card.text}
                />
              ))}
            </div>
          </div>
        )}
      </div>
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
  const hiddenCount = collapsedCount + data.teaching_history_remaining_count;

  return (
    <section className="section-card">
      <div className="section-title">
        <span className="section-title-mark">H</span>
        강의 상세 이력
        <span className="text-[11px] font-medium text-[var(--text-muted)]">
          (최근 {rawHistory.length}건 / 전체 {totalCount}건)
        </span>
      </div>

      {history.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">강의 이력이 없습니다</p>
      ) : (
        <div className="overflow-hidden rounded-[var(--radius-sm)] border border-[var(--border)] bg-white">
          <div className="overflow-x-auto">
            <table className="history-table min-w-full table-fixed">
              <thead>
                <tr>
                  <th className="px-5 py-4 w-[20%]">시기</th>
                  <th className="px-5 py-4 w-[18%]">기업명</th>
                  <th className="px-5 py-4 w-[46%]">과정명</th>
                  <th className="px-5 py-4 w-[16%]">강사료</th>
                </tr>
              </thead>
              <tbody>
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
                      <td className="px-5 py-4 text-sm text-[var(--text-muted)]">
                        <div>{dateDisplay}</div>
                        {summary && (
                          <div className="mt-1 text-xs text-[var(--text-muted)]">
                            {summary}
                          </div>
                        )}
                      </td>
                      <td className="company px-5 py-4">
                        <div className="break-words text-sm">{company}</div>
                      </td>
                      <td className="course px-5 py-4 text-sm">
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
                              <div className="font-medium text-[var(--text-primary)] underline decoration-blue-200 underline-offset-2 transition hover:text-blue-700">
                                {title}
                              </div>
                            </button>
                          ) : (
                            <div className="font-medium text-[var(--text-primary)]" title={title}>
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
                      <td className="fee px-5 py-4 text-sm">
                        {formatMoney(item.deal_fee_hourly ?? null)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {(collapsedCount > 0 || data.teaching_history_remaining_count > 0) && (
            <div className="border-t border-[var(--border-light)] px-5 py-3 text-center">
              {!isExpanded && hiddenCount > 0 && (
                <button
                  type="button"
                  onClick={() => setIsExpanded(true)}
                  className="text-[11px] font-medium text-[#94A3B8] transition hover:text-[var(--primary)]"
                >
                  + {hiddenCount}건 더 있음
                </button>
              )}

              {isExpanded && collapsedCount > 0 && data.teaching_history_remaining_count === 0 && (
                <button
                  type="button"
                  onClick={() => setIsExpanded(false)}
                  className="text-[11px] font-medium text-[#94A3B8] transition hover:text-[var(--primary)]"
                >
                  접기
                </button>
              )}

              {isExpanded && data.teaching_history_remaining_count > 0 && (
                <button
                  type="button"
                  onClick={onLoadMore}
                  disabled={isLoadingMore}
                  className="text-[11px] font-medium text-[#94A3B8] transition hover:text-[var(--primary)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isLoadingMore
                    ? "불러오는 중..."
                    : `+ ${data.teaching_history_remaining_count}건 더 있음`}
                </button>
              )}
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
  isTableExpanded,
  onToggleTable,
  highlightedFeeHistoryId,
}: {
  data: InstructorDetailData;
  isTableExpanded: boolean;
  onToggleTable: () => void;
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
    <section className="section-card">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="section-title">
          <span className="section-title-mark">F</span>
          강사료 이력
        </div>
        {dateGroups.length > 0 && (
          <button
            type="button"
            onClick={onToggleTable}
            aria-expanded={isTableExpanded}
            className="inline-flex shrink-0 items-center justify-center self-start px-0 py-0 text-[10px] font-medium leading-none text-[var(--text-muted)] transition hover:text-blue-700"
          >
            {isTableExpanded ? "단가 이력 접기" : "단가 이력 보기"}
          </button>
        )}
      </div>
      {history.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">이력 없음</p>
      ) : (
        <div className="space-y-4">
          {timeline.length > 0 && <FeeTrendChart timeline={timeline} />}

          {undatedHourlyCount > 0 && (
            <div className="rounded-[var(--radius-xs)] border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
              날짜를 확정할 수 없는 단가 이력 {undatedHourlyCount}건은 추이에서 제외했습니다.
            </div>
          )}

          {dateGroups.length > 0 && isTableExpanded && (
            <div className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-white">
              <div className="border-b border-[var(--border-light)] px-4 py-3">
                <div className="grid gap-2 md:grid-cols-[120px_minmax(0,1fr)_minmax(0,1fr)]">
                  <div className="text-xs font-medium text-[var(--text-muted)]">시점</div>
                  <div className="text-xs font-medium text-[var(--text-muted)]">
                    시간당 단가 변동
                  </div>
                  <div className="text-xs font-medium text-[var(--text-muted)]">
                    특수 금액 / 참고
                  </div>
                </div>
              </div>
              <div className="divide-y divide-[var(--border-light)]">
                {dateGroups.map((group) => {
                  return (
                    <div key={group.sortKey} className="px-4 py-4">
                      <div className="grid gap-3 md:grid-cols-[120px_minmax(0,1fr)_minmax(0,1fr)]">
                        <div className="text-sm font-semibold text-[var(--text-primary)]">
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
                                  compactFeeContext(item.context),
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
                                        : "border-[var(--border)] bg-[var(--bg)]"
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
                                        <div className="text-xs text-[var(--text-muted)]">
                                          유지 구간:{" "}
                                          {formatFeeSegmentPeriod(
                                            item,
                                            isCurrentSegment
                                          )}
                                        </div>
                                        {contextLine && (
                                          <div className="text-xs text-[var(--text-muted)]">
                                            {contextLine}
                                          </div>
                                        )}
                                        {item.notes.length > 0 && (
                                          <div className="mt-2 space-y-1">
                                            {item.notes.map((note) => (
                                              <div
                                                key={note.id}
                                                className="rounded-[var(--radius-xs)] bg-white px-2 py-1.5 text-xs text-[var(--text-secondary)]"
                                              >
                                                {(note.period || note.context) && (
                                                  <div className="mb-0.5 text-[11px] text-[var(--text-muted)]">
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
                                        <div className="text-sm font-semibold text-[var(--text-primary)]">
                                          {formatMoney(item.amount)}
                                        </div>
                                        {changeAmount !== 0 && (
                                          <div className="mt-1 text-xs text-[var(--text-muted)]">
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
                            <div className="rounded-[var(--radius-xs)] border border-dashed border-[var(--border)] px-3 py-3 text-xs text-[var(--text-muted)]">
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
                                compactFeeContext(item.context, item.effective_label),
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
                                        <div className="text-xs text-[var(--text-muted)]">
                                          {contextLine}
                                        </div>
                                      )}
                                    </div>
                                    <div className="shrink-0 text-right">
                                      <div className="text-sm font-semibold text-[var(--text-primary)]">
                                        {formatMoney(item.amount)}
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              );
                            })
                          ) : (
                            <div className="rounded-[var(--radius-xs)] border border-dashed border-[var(--border)] px-3 py-3 text-xs text-[var(--text-muted)]">
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
            <p className="text-sm text-[var(--text-muted)]">이력 없음</p>
          )}
        </div>
      )}
    </section>
  );
}

// --- H. Operations Memo Section ---

function MemoSection({ data }: { data: InstructorDetailData }) {
  const visibleMemo = extractDisplayLinesWithoutGoogleLinks(data.memo)
    .filter((line) => !line.startsWith("[Notion comment ·"))
    .filter(
      (line) =>
        !/(서류|계약서|사업자등록증|통장사본|법인\s*계약)/i.test(line)
    )
    .join("\n");

  if (!visibleMemo) return null;

  return (
    <section className="section-card">
      <div className="section-title">
        <span className="section-title-mark">M</span>
        운영 메모
      </div>
      <div className="memo-box">
        {visibleMemo}
      </div>
    </section>
  );
}
