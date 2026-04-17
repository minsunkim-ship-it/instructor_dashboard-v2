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
          {data.affiliation && (
            <p className="text-sm text-gray-500">{data.affiliation}</p>
          )}
        </div>
      </div>

      {/* Categories & Specialties */}
      <div className="flex flex-wrap gap-1.5">
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
  const remaining = data.teaching_history_remaining_count;

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-gray-900">강의 이력</h3>

      {history.length === 0 ? (
        <p className="text-sm text-gray-400">강의 이력이 없습니다</p>
      ) : (
        <div className="overflow-x-auto border border-gray-200 rounded-lg">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-left text-xs text-gray-500 uppercase tracking-wider">
                <th className="px-4 py-2 font-medium">기업명</th>
                <th className="px-4 py-2 font-medium">과정명</th>
                <th className="px-4 py-2 font-medium">일정</th>
                <th className="px-4 py-2 font-medium text-right">출강단가</th>
                <th className="px-4 py-2 font-medium">특이사항</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {history.map((h) => {
                const dateDisplay = h.date_label
                  ? h.date_label
                  : h.start_date && h.end_date
                    ? `${formatDate(h.start_date)} ~ ${formatDate(h.end_date)}`
                    : h.start_date
                      ? formatDate(h.start_date)
                      : "-";

                const feeDisplay =
                  h.deal_fee_hourly !== null
                    ? formatMoney(h.deal_fee_hourly)
                    : "-";

                return (
                  <tr key={h.id} className="hover:bg-gray-50">
                    <td className="px-4 py-2 text-gray-900">
                      {h.company_name ?? "-"}
                    </td>
                    <td className="px-4 py-2 text-gray-600">
                      {h.course_name ?? "-"}
                    </td>
                    <td className="px-4 py-2 text-gray-600 whitespace-nowrap">
                      {dateDisplay}
                    </td>
                    <td className="px-4 py-2 text-gray-900 text-right whitespace-nowrap">
                      {feeDisplay}
                    </td>
                    <td className="px-4 py-2 text-gray-500 text-xs">
                      {h.special_notes ?? "-"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {remaining > 0 && (
            <div className="px-4 py-2 text-xs text-gray-500 bg-gray-50 border-t border-gray-200">
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

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-gray-900">단가 이력</h3>
      {history.length === 0 ? (
        <p className="text-sm text-gray-400">이력 없음</p>
      ) : (
        <div className="space-y-2">
          {history.map((item, i) => {
            // Feature J: 날짜 — effective_date 우선, 없으면 effective_label, 둘 다 없으면 `-`
            const dateDisplay = item.effective_date
              ? formatDate(item.effective_date)
              : item.effective_label ?? "-";

            // Feature J: 금액 — 특수금액은 원 단위 그대로 + 라벨, 일반은 N만원 형식
            const amountDisplay = item.amount === null
              ? "-"
              : item.is_special_amount
                ? formatMoney(item.amount)
                : formatMoney(item.amount);

            // Feature J: 변경 사유/컨텍스트 — 없으면 `-`
            const contextDisplay = item.context ?? "-";

            // Feature J: 출처
            const sourceDisplay = formatFeeSource(item.source_type);

            return (
              <div
                key={i}
                className={`px-3 py-2.5 border rounded-md ${
                  item.is_current
                    ? "bg-blue-50 border-blue-200"
                    : item.is_special_amount
                      ? "bg-orange-50 border-orange-200"
                      : "bg-white border-gray-200"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-gray-900">
                        {dateDisplay}
                      </span>
                      {item.is_current && (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-700">
                          현재
                        </span>
                      )}
                      {item.is_special_amount && (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-orange-100 text-orange-700">
                          특수 금액
                        </span>
                      )}
                      {item.fee_kind !== "hourly" && (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-gray-100 text-gray-600">
                          {item.fee_kind}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 text-xs text-gray-500">
                      {contextDisplay}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-sm font-semibold text-gray-900">
                      {amountDisplay}
                    </div>
                    <div className="mt-0.5 text-xs text-gray-400">
                      {sourceDisplay}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
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
