"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useCallback } from "react";
import type {
  InstructorDetailResponse,
  InstructorDetailData,
  SatisfactionCreateResponse,
} from "@/types/api";

// --- Fetch helpers ---

async function fetchInstructorDetail(
  id: string
): Promise<InstructorDetailResponse> {
  const res = await fetch(`/api/instructors/${id}`);
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

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "-";
  return dateStr.replace(/-/g, ".");
}

function parseAffiliationTags(affiliation: string | null): string[] {
  if (!affiliation) return [];
  return affiliation
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
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

function extractDateRangeFromLabel(
  label: string | null
): { start: string | null; end: string | null } {
  if (!label) return { start: null, end: null };

  const dates: string[] = [];

  for (const match of label.matchAll(
    /(\d{4})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{1,2})/g
  )) {
    const [, year, month, day] = match;
    dates.push(`${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`);
  }

  for (const match of label.matchAll(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/g)) {
    const [, year, month, day] = match;
    dates.push(`${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`);
  }

  if (dates.length === 0) return { start: null, end: null };
  return { start: dates[0], end: dates[dates.length - 1] };
}

function formatTeachingPeriod(item: TeachingHistoryItem): string {
  if (item.start_date || item.end_date) {
    return formatDateRange(item.start_date, item.end_date);
  }

  const { start, end } = extractDateRangeFromLabel(item.date_label);
  return formatDateRange(start, end);
}

function formatTeachingSummary(item: TeachingHistoryItem): string {
  const parts: string[] = [];

  if (item.total_sessions && item.total_sessions > 0) {
    parts.push(`${item.total_sessions}회`);
  }

  if (item.total_hours && item.total_hours > 0) {
    const hours =
      item.total_hours % 1 === 0
        ? String(item.total_hours)
        : item.total_hours.toFixed(1);
    parts.push(`${hours}시간`);
  }

  return parts.join(" · ");
}

function isDisplayableTeachingHistory(item: TeachingHistoryItem): boolean {
  return Boolean(
    item.course_name ||
      item.company_name ||
      item.start_date ||
      item.end_date ||
      item.date_label
  );
}

function dedupeTeachingHistory(
  history: TeachingHistoryItem[]
): TeachingHistoryItem[] {
  const seen = new Set<string>();

  return history.filter((item) => {
    const signature = [
      item.course_name ?? "",
      item.company_name ?? "",
      formatTeachingPeriod(item),
    ].join("||");

    if (seen.has(signature)) {
      return false;
    }
    seen.add(signature);
    return true;
  });
}

type FeeChangeDirection = "initial" | "up" | "down";

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

function getFeeDateLabel(item: FeeHistoryItem): string {
  if (item.effective_date) return formatDate(item.effective_date);
  const parsed = extractDateRangeFromLabel(item.effective_label);
  if (parsed.start) return formatDate(parsed.start);
  return item.effective_label ?? "-";
}

function getFeeSortKey(item: FeeHistoryItem): string {
  if (item.effective_date) return item.effective_date;
  const parsed = extractDateRangeFromLabel(item.effective_label);
  return parsed.start ?? item.effective_label ?? "";
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
    (item) =>
      !item.is_special_amount &&
      item.fee_kind === "hourly" &&
      item.amount !== null
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

const SCORE_LABELS: Record<string, { label: string; max: number }> = {
  courses: { label: "출강횟수", max: 35 },
  satisfaction: { label: "만족도", max: 15 },
  slack: { label: "슬랙활동", max: 15 },
  recency: { label: "최근성", max: 15 },
  salesmap: { label: "세일즈맵", max: 10 },
  email: { label: "이메일", max: 5 },
  ops_channel: { label: "운영채널", max: 5 },
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

function FeeTrendChart({ timeline }: { timeline: CollapsedFeeHistoryItem[] }) {
  if (timeline.length === 0) return null;

  const width = 520;
  const height = 120;
  const paddingX = 20;
  const paddingY = 18;
  const amounts = timeline.map((item) => item.amount);
  const maxAmount = Math.max(...amounts);
  const minAmount = Math.min(...amounts);
  const range = Math.max(1, maxAmount - minAmount);
  const usableWidth = width - paddingX * 2;
  const usableHeight = height - paddingY * 2;

  const getX = (index: number) =>
    paddingX +
    (timeline.length === 1
      ? usableWidth / 2
      : (usableWidth * index) / (timeline.length - 1));
  const getY = (amount: number) =>
    paddingY + ((maxAmount - amount) / range) * usableHeight;

  const path = timeline
    .map((item, index) => {
      const x = getX(index);
      const y = getY(item.amount);

      if (index === 0) {
        return `M ${x} ${y}`;
      }

      return `H ${x} V ${y}`;
    })
    .join(" ");

  return (
    <div className="rounded-lg border border-gray-200 bg-white px-4 py-4">
      <div className="mb-3 flex items-end justify-between gap-4">
        <div>
          <div className="text-xs font-medium text-gray-500">단가 추이</div>
          <div className="mt-1 text-sm text-gray-600">
            초기 단가부터 변동 시점만 표시합니다.
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs text-gray-500">변동 횟수</div>
          <div className="text-lg font-semibold text-gray-900">
            {Math.max(0, timeline.length - 1)}회
          </div>
        </div>
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-32 w-full overflow-visible"
        role="img"
        aria-label="단가 추이 그래프"
      >
        <line
          x1={paddingX}
          x2={width - paddingX}
          y1={height - paddingY}
          y2={height - paddingY}
          stroke="#E5E7EB"
          strokeWidth="1"
        />
        <line
          x1={paddingX}
          x2={width - paddingX}
          y1={paddingY}
          y2={paddingY}
          stroke="#F3F4F6"
          strokeWidth="1"
        />
        <path
          d={path}
          fill="none"
          stroke="#2563EB"
          strokeWidth="3"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {timeline.map((item, index) => {
          const x = getX(index);
          const y = getY(item.amount);

          return (
            <g key={`${item.start_key}-${item.amount}-${index}`}>
              <circle cx={x} cy={y} r="5" fill="#2563EB" />
              <text
                x={x}
                y={Math.max(12, y - 10)}
                textAnchor="middle"
                fontSize="11"
                fill="#111827"
                fontWeight="600"
              >
                {formatMoney(item.amount)}
              </text>
              <text
                x={x}
                y={height - 4}
                textAnchor="middle"
                fontSize="10"
                fill="#6B7280"
              >
                {item.start_label.replace(/^(\d{4})\./, "").replace(/\./g, ".")}
              </text>
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
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["instructor", instructorId],
    queryFn: () => fetchInstructorDetail(instructorId),
  });

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
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto px-6 py-6 space-y-6">
        <HeaderSection data={inst} />
        <MetricsSection data={inst} />
        <ScoreSatisfactionSection data={inst} />
        <SatisfactionWriteSection instructorId={instructorId} />
        <OpsIntelligenceSection data={inst} />
        <TeachingHistorySection data={inst} />
        <FeeHistorySection data={inst} />
        <MemoSection data={inst} />
      </div>
    </div>
  );
}

// --- A. Header Section ---

function HeaderSection({ data }: { data: InstructorDetailData }) {
  const affiliationTags = parseAffiliationTags(data.affiliation);

  return (
    <section className="space-y-3">
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-2xl font-bold text-gray-900">{data.name}</h2>
            {data.is_fulltime && (
              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-purple-100 text-purple-700">
                전임강사
              </span>
            )}
            {data.is_practice_coach && (
              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600">
                실습코치
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Categories / Affiliations / Specialties */}
      <div className="flex flex-wrap gap-1.5">
        {affiliationTags.map((tag) => (
          <span
            key={`aff-${tag}`}
            className="inline-flex items-center px-2 py-1 rounded-md text-xs font-medium bg-emerald-50 text-emerald-700"
          >
            {tag}
          </span>
        ))}
        {data.categories.map((cat) => (
          <span
            key={cat}
            className="inline-flex items-center px-2 py-1 rounded-md text-xs font-medium bg-blue-50 text-blue-700"
          >
            {cat}
          </span>
        ))}
        {data.specialties.map((spec) => (
          <span
            key={spec}
            className="inline-flex items-center px-2 py-1 rounded-md text-xs bg-gray-100 text-gray-600"
          >
            {spec}
          </span>
        ))}
      </div>

      {/* Contact */}
      {(data.contact.email || data.contact.phone) && (
        <div className="flex items-center gap-4 text-sm text-gray-600">
          {data.contact.email && <span>{data.contact.email}</span>}
          {data.contact.phone && <span>{data.contact.phone}</span>}
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
    <section className="grid grid-cols-4 gap-3">
      {metrics.map((m) => (
        <div
          key={m.label}
          className="bg-white border border-gray-200 rounded-lg px-4 py-3"
        >
          <div className="text-xs text-gray-500 mb-1">{m.label}</div>
          <div className="text-lg font-semibold text-gray-900">{m.value}</div>
        </div>
      ))}
    </section>
  );
}

// --- C. Score & Satisfaction Section ---

function ScoreSatisfactionSection({ data }: { data: InstructorDetailData }) {
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

  return (
    <section className="grid grid-cols-2 gap-4">
      {/* Left: Total score + breakdown */}
      <div className="bg-white border border-gray-200 rounded-lg px-5 py-4">
        <div className="flex items-baseline gap-2 mb-4">
          <span className="text-3xl font-bold text-gray-900">
            {formatScore(data.score)}
          </span>
          <span className="text-sm text-gray-400">/ 100</span>
        </div>
        <div className="space-y-2">
          {orderedKeys.map((key) => {
            const meta = SCORE_LABELS[key];
            if (!meta) return null;
            const value = typeof breakdown[key] === "number" ? breakdown[key] : 0;
            const pct = meta.max > 0 ? (value / meta.max) * 100 : 0;
            return (
              <div key={key} className="flex items-center gap-2 text-sm">
                <span className="w-16 text-gray-500 text-xs shrink-0">
                  {meta.label}
                </span>
                <div className="flex-1 bg-gray-100 rounded-full h-2 overflow-hidden">
                  <div
                    className="bg-blue-500 h-2 rounded-full transition-all"
                    style={{ width: `${Math.min(100, pct)}%` }}
                  />
                </div>
                <span className="w-14 text-right text-xs text-gray-600 shrink-0">
                  {typeof value === "number" ? value.toFixed(1) : "0"}/{meta.max}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Right: Satisfaction */}
      <div className="bg-white border border-gray-200 rounded-lg px-5 py-4">
        <div className="text-xs text-gray-500 mb-2">만족도</div>
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
      </div>
    </section>
  );
}

// --- D. Satisfaction Write Form ---

function SatisfactionWriteSection({
  instructorId,
}: {
  instructorId: string;
}) {
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const [score, setScore] = useState<number>(3.0);
  const [companyName, setCompanyName] = useState("");
  const [courseName, setCourseName] = useState("");
  const [comment, setComment] = useState("");
  const [responseDate, setResponseDate] = useState("");
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (body: {
      score: number;
      comment?: string;
      company_name?: string;
      course_name?: string;
      response_date?: string;
    }) => postSatisfaction(instructorId, body),
    onSuccess: () => {
      setSuccessMsg("만족도가 저장되었습니다.");
      // Reset form
      setScore(3.0);
      setCompanyName("");
      setCourseName("");
      setComment("");
      setResponseDate("");
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
    <section className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between px-5 py-3 text-left hover:bg-gray-50 transition-colors"
      >
        <span className="text-sm font-semibold text-gray-900">
          만족도 작성
        </span>
        <svg
          className={`w-4 h-4 text-gray-400 transition-transform ${isOpen ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>

      {isOpen && (
        <form onSubmit={handleSubmit} className="px-5 pb-4 space-y-4 border-t border-gray-100">
          {/* Score input */}
          <div className="pt-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              점수 <span className="text-red-500">*</span>
            </label>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={0}
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

          {/* Company name */}
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

          {/* Course name */}
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

          {/* Comment */}
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

          {/* Response date */}
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

          {/* Submit */}
          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={mutation.isPending}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {mutation.isPending ? "저장 중..." : "저장"}
            </button>

            {successMsg && (
              <span className="text-sm text-green-600">{successMsg}</span>
            )}

            {mutation.isError && (
              <span className="text-sm text-red-600">
                {(mutation.error as Error)?.message ??
                  "저장에 실패했습니다."}
              </span>
            )}
          </div>
        </form>
      )}
    </section>
  );
}

// --- E. Operations Intelligence Section ---

function OpsIntelligenceSection({ data }: { data: InstructorDetailData }) {
  const hasData =
    data.recommended_for.length > 0 ||
    data.avoid_for.length > 0 ||
    data.risk_notes.length > 0 ||
    data.ops_check_note !== null;

  if (!hasData) return null;

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-gray-900">운영 인텔리전스</h3>

      {data.recommended_for.length > 0 && (
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
      )}

      {data.avoid_for.length > 0 && (
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
      )}

      {data.risk_notes.length > 0 && (
        <div className="space-y-2">
          {data.risk_notes.map((note, i) => (
            <div
              key={i}
              className="px-3 py-2 text-sm bg-yellow-50 text-yellow-800 border border-yellow-200 rounded-md"
            >
              {note}
            </div>
          ))}
        </div>
      )}

      {data.ops_check_note && (
        <div className="px-3 py-2 text-sm bg-blue-50 text-blue-800 border border-blue-200 rounded-md">
          {data.ops_check_note}
        </div>
      )}
    </section>
  );
}

// --- F. Teaching History Table ---

function TeachingHistorySection({ data }: { data: InstructorDetailData }) {
  const history = data.teaching_history as TeachingHistoryItem[];
  const displayableHistory = history.filter(isDisplayableTeachingHistory);
  const visibleHistory = dedupeTeachingHistory(displayableHistory);
  const hiddenEmptyCount = history.length - displayableHistory.length;
  const hiddenDuplicateCount = displayableHistory.length - visibleHistory.length;
  const remaining = data.teaching_history_remaining_count;

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-gray-900">강의 이력</h3>

      {visibleHistory.length === 0 ? (
        <p className="text-sm text-gray-400">강의 이력이 없습니다</p>
      ) : (
        <div className="space-y-2 rounded-lg border border-gray-200 bg-white p-3">
          {visibleHistory.map((h) => {
            const dateDisplay = formatTeachingPeriod(h);
            const summary = formatTeachingSummary(h);

            return (
              <div
                key={h.id}
                className="rounded-md border border-gray-100 px-4 py-3"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1 space-y-1">
                    {h.course_name && (
                      <div className="text-sm font-medium text-gray-900">
                        {h.course_name}
                      </div>
                    )}
                    {h.company_name && (
                      <div className="text-sm text-gray-500">
                        {h.company_name}
                      </div>
                    )}
                  </div>
                  <div className="shrink-0 text-right">
                    {dateDisplay !== "-" && (
                      <div className="text-sm font-medium text-gray-900">
                        {dateDisplay}
                      </div>
                    )}
                    {summary && (
                      <div className="mt-1 text-xs text-gray-500">{summary}</div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}

          {hiddenEmptyCount > 0 && (
            <div className="px-1 pt-1 text-xs text-gray-400">
              과정명·기업명·기간 정보가 없는 계약 행 {hiddenEmptyCount}건은 숨김 처리했습니다.
            </div>
          )}

          {hiddenDuplicateCount > 0 && (
            <div className="px-1 pt-1 text-xs text-gray-400">
              동일한 강의 이력 {hiddenDuplicateCount}건은 중복 제거했습니다.
            </div>
          )}

          {remaining > 0 && (
            <div className="px-1 pt-1 text-xs text-gray-500">
              {remaining}건 더 있음
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// --- G. Fee History Section — 06_implementation_spec.md Feature J ---

function FeeHistorySection({ data }: { data: InstructorDetailData }) {
  const history = data.fee_history as FeeHistoryItem[];
  const timeline = attachTeachingFeeNotes(
    collapseFeeTimeline(history),
    extractTeachingFeeNotes(data.teaching_history as TeachingHistoryItem[])
  );
  const referenceItems = sortFeeHistoryChronologically(history).filter(
    (item) => item.is_special_amount || item.fee_kind !== "hourly"
  );

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-gray-900">단가 이력</h3>
      {history.length === 0 ? (
        <p className="text-sm text-gray-400">이력 없음</p>
      ) : (
        <div className="space-y-4">
          {timeline.length > 0 && <FeeTrendChart timeline={timeline} />}

          {timeline.length > 0 && (
            <div className="rounded-lg border border-gray-200 bg-white">
              <div className="border-b border-gray-100 px-4 py-3">
                <div className="text-xs font-medium text-gray-500">
                  변동 시점
                </div>
              </div>
              <div className="divide-y divide-gray-100">
                {timeline.map((item, index) => {
                  const previous = index > 0 ? timeline[index - 1] : null;
                  const changeAmount = previous ? item.amount - previous.amount : 0;
                  const isCurrentSegment = index === timeline.length - 1;
                  const sourceDisplay =
                    item.source_type === "contract_sheet"
                      ? null
                      : formatFeeSource(item.source_type);
                  const contextLine = [sourceDisplay, item.context]
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
                      key={`${item.start_key}-${item.amount}-${index}`}
                      className="px-4 py-3"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-semibold text-gray-900">
                              {item.start_label}
                            </span>
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
                            유지 구간: {formatFeeSegmentPeriod(item, isCurrentSegment)}
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
                                  className="rounded bg-gray-100 px-2 py-1.5 text-xs text-gray-600"
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
                          {previous && changeAmount !== 0 && (
                            <div className="mt-1 text-xs text-gray-500">
                              {formatMoneyDelta(changeAmount)}
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

          {referenceItems.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-medium text-gray-500">
                특수 금액 / 참고 이력
              </div>
              <div className="space-y-2">
                {referenceItems.map((item, index) => (
                  (() => {
                    const sourceDisplay =
                      item.source_type === "contract_sheet"
                        ? null
                        : formatFeeSource(item.source_type);
                    const contextLine = [sourceDisplay, item.context]
                      .filter(Boolean)
                      .join(" · ");
                    return (
                  <div
                    key={`${item.source_type}-${index}`}
                    className="rounded-md border border-orange-200 bg-orange-50 px-4 py-3"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium text-gray-900">
                            {getFeeDateLabel(item)}
                          </span>
                          <span className="inline-flex items-center rounded bg-orange-100 px-1.5 py-0.5 text-xs font-medium text-orange-700">
                            특수 금액
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
                  })()
                ))}
              </div>
            </div>
          )}

          {timeline.length === 0 && referenceItems.length === 0 && (
            <p className="text-sm text-gray-400">이력 없음</p>
          )}
        </div>
      )}
    </section>
  );
}

// --- H. Operations Memo Section ---

function MemoSection({ data }: { data: InstructorDetailData }) {
  if (!data.memo) return null;

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-gray-900">운영 메모</h3>
      <div className="px-4 py-3 text-sm text-gray-700 bg-gray-50 border border-gray-200 rounded-lg whitespace-pre-wrap leading-relaxed">
        {data.memo}
      </div>
    </section>
  );
}
