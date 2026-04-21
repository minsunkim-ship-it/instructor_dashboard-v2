import type {
  InstructorDetailData,
  InstructorListItem,
  StatusData,
} from "@/types/api";

type FallbackInstructorSeed = InstructorListItem &
  Pick<
    InstructorDetailData,
    | "contact"
    | "profile_summary"
    | "memo"
    | "is_practice_coach"
    | "recent_courses_6mo"
    | "total_paid"
    | "score_breakdown"
    | "satisfaction"
  > & {
    last_activity_at: string | null;
  };

export const FALLBACK_LAST_UPDATED_AT = "2026-04-01T00:00:00.000Z";

const EMPTY_BEHAVIORAL_INTELLIGENCE = {
  teaching_style: null,
  curriculum_compliance: null,
  attitude: null,
  risk_patterns: [],
  strength_patterns: [],
  recommendation: null,
  data_richness: "minimal" as const,
  data_richness_reason: null,
  confidence: "low" as const,
  confidence_reason: null,
  key_question_for_humans: null,
};

const EMPTY_NOTION_MEMO_DIAGNOSTICS: InstructorDetailData["notion_memo_diagnostics"] = {
  source_linked: false,
  notion_page_id: null,
  enrichment_attempted: false,
  enrichment_updated: false,
  comment_capability: "unknown",
  page_comment_count: 0,
  block_comment_count: 0,
  block_text_count: 0,
  incoming_line_count: 0,
  error_message: null,
};

const FALLBACK_INSTRUCTOR_SEEDS: FallbackInstructorSeed[] = [
  {
    id: "9aa30a27-0ab7-44cb-9f0b-fallback0001",
    name: "홍길동",
    affiliation: "데이원",
    categories: ["생성형AI"],
    teaching_titles: ["ChatGPT 실무 활용", "업무자동화 입문"],
    specialties: ["ChatGPT", "업무자동화"],
    rank: 1,
    score: 91.5,
    total_courses: 28,
    total_hours: 84,
    base_fee_hourly: 180000,
    is_fulltime: false,
    flag: null,
    contact: { email: null, phone: null },
    profile_summary: "생성형AI와 업무자동화 중심 강의 경력이 있는 기준 강사 데이터입니다.",
    memo: null,
    is_practice_coach: false,
    recent_courses_6mo: 6,
    total_paid: null,
    score_breakdown: {
      courses: 31.2,
      satisfaction: 13.8,
      slack: 14.0,
      recency: 12.9,
      salesmap: 8.0,
      email: 4.1,
      ops_channel: 4.5,
    },
    satisfaction: { avg: 4.6, count: 12, is_imputed: false },
    last_activity_at: "2026-03-20T00:00:00.000Z",
  },
  {
    id: "9aa30a27-0ab7-44cb-9f0b-fallback0002",
    name: "김영희",
    affiliation: "프리랜서",
    categories: ["데이터분석"],
    teaching_titles: ["Python 데이터분석", "데이터시각화 실습"],
    specialties: ["Python", "데이터시각화", "통계분석"],
    rank: 2,
    score: 85.3,
    total_courses: 22,
    total_hours: 66,
    base_fee_hourly: 200000,
    is_fulltime: false,
    flag: null,
    contact: { email: null, phone: null },
    profile_summary: "데이터 분석 및 시각화 강의를 수행하는 fallback 기준 강사입니다.",
    memo: null,
    is_practice_coach: false,
    recent_courses_6mo: 4,
    total_paid: null,
    score_breakdown: {
      courses: 28.0,
      satisfaction: 12.5,
      slack: 12.0,
      recency: 14.0,
      salesmap: 9.0,
      email: 4.8,
      ops_channel: 5.0,
    },
    satisfaction: { avg: 4.3, count: 8, is_imputed: false },
    last_activity_at: "2026-03-15T00:00:00.000Z",
  },
  {
    id: "9aa30a27-0ab7-44cb-9f0b-fallback0003",
    name: "이철수",
    affiliation: "데이원",
    categories: ["리더십"],
    teaching_titles: ["리더십 커뮤니케이션", "조직문화 워크숍"],
    specialties: ["조직문화", "코칭"],
    rank: 3,
    score: 78.2,
    total_courses: 18,
    total_hours: 54,
    base_fee_hourly: null,
    is_fulltime: true,
    flag: null,
    contact: { email: null, phone: null },
    profile_summary: "리더십/조직문화 교육 기준 fallback 강사입니다.",
    memo: null,
    is_practice_coach: false,
    recent_courses_6mo: 3,
    total_paid: null,
    score_breakdown: {
      courses: 25.0,
      satisfaction: 11.0,
      slack: 10.0,
      recency: 13.0,
      salesmap: 7.0,
      email: 3.2,
      ops_channel: 4.0,
    },
    satisfaction: { avg: 4.8, count: 15, is_imputed: false },
    last_activity_at: "2026-02-28T00:00:00.000Z",
  },
  {
    id: "9aa30a27-0ab7-44cb-9f0b-fallback0004",
    name: "박지민",
    affiliation: null,
    categories: ["DX"],
    teaching_titles: ["DX 전략 수립"],
    specialties: ["디지털전환"],
    rank: 4,
    score: 65.0,
    total_courses: 12,
    total_hours: 32,
    base_fee_hourly: 150000,
    is_fulltime: false,
    flag: null,
    contact: { email: null, phone: null },
    profile_summary: "디지털전환 영역 기준 fallback 강사입니다.",
    memo: null,
    is_practice_coach: false,
    recent_courses_6mo: 2,
    total_paid: null,
    score_breakdown: {
      courses: 20.0,
      satisfaction: 10.0,
      slack: 8.0,
      recency: 10.0,
      salesmap: 6.0,
      email: 3.0,
      ops_channel: 3.0,
    },
    satisfaction: { avg: 4.1, count: 5, is_imputed: false },
    last_activity_at: "2026-02-10T00:00:00.000Z",
  },
  {
    id: "9aa30a27-0ab7-44cb-9f0b-fallback0005",
    name: "최수진",
    affiliation: "데이원",
    categories: [],
    teaching_titles: [],
    specialties: [],
    rank: 5,
    score: 42.1,
    total_courses: 7,
    total_hours: 14,
    base_fee_hourly: 120000,
    is_fulltime: false,
    flag: null,
    contact: { email: null, phone: null },
    profile_summary: null,
    memo: null,
    is_practice_coach: false,
    recent_courses_6mo: 1,
    total_paid: null,
    score_breakdown: {
      courses: 12.0,
      satisfaction: 7.0,
      slack: 5.0,
      recency: 8.0,
      salesmap: 4.0,
      email: 2.1,
      ops_channel: 2.0,
    },
    satisfaction: { avg: 3.9, count: 3, is_imputed: false },
    last_activity_at: "2026-01-30T00:00:00.000Z",
  },
];

export function hasStaticFallbackData(): boolean {
  return FALLBACK_INSTRUCTOR_SEEDS.length > 0;
}

export function getFallbackInstructorListItems(): Array<
  InstructorListItem & { lastActivityAt: Date | null }
> {
  return FALLBACK_INSTRUCTOR_SEEDS.map((item) => ({
    id: item.id,
    name: item.name,
    affiliation: item.affiliation,
    categories: item.categories,
    teaching_titles: item.teaching_titles,
    specialties: item.specialties,
    rank: item.rank,
    score: item.score,
    total_courses: item.total_courses,
    total_hours: item.total_hours,
    base_fee_hourly: item.base_fee_hourly,
    is_fulltime: item.is_fulltime,
    flag: item.flag,
    lastActivityAt: item.last_activity_at ? new Date(item.last_activity_at) : null,
  }));
}

export function getFallbackInstructorDetail(
  id: string
): InstructorDetailData | null {
  const item = FALLBACK_INSTRUCTOR_SEEDS.find((seed) => seed.id === id);
  if (!item) return null;

  return {
    id: item.id,
    name: item.name,
    affiliation: item.affiliation,
    categories: item.categories,
    teaching_titles: item.teaching_titles,
    contact: item.contact,
    specialties: item.specialties,
    profile_summary: item.profile_summary,
    memo: item.memo,
    notion_memo_diagnostics: EMPTY_NOTION_MEMO_DIAGNOSTICS,
    is_fulltime: item.is_fulltime,
    is_practice_coach: item.is_practice_coach,
    total_courses: item.total_courses,
    total_hours: item.total_hours,
    recent_courses_6mo: item.recent_courses_6mo,
    total_paid: item.total_paid,
    base_fee_hourly: item.base_fee_hourly,
    score: item.score,
    score_breakdown: item.score_breakdown,
    satisfaction: item.satisfaction,
    recent_satisfaction_history: [],
    recommended_for: [],
    avoid_for: [],
    risk_notes: [],
    raw_operational_notes: [],
    classified_notes: [],
    human_followups: [],
    behavioral_intelligence: EMPTY_BEHAVIORAL_INTELLIGENCE,
    operational_intelligence_meta: {
      generated_at: null,
      generated_by: null,
      generation_model: null,
    },
    operational_evidence_snapshots: [],
    fee_history: [],
    teaching_history: [],
    teaching_history_remaining_count: 0,
  };
}

export function getFallbackStatusData(): StatusData {
  return {
    last_updated_at: FALLBACK_LAST_UPDATED_AT,
    refresh_available: false,
    latest_run_status: "never_synced",
    current_run: null,
    fallback_ready: true,
    sources: [
      "notion",
      "contract_sheet",
      "instructor_dispatch_sheet",
      "salesmap",
      "slack",
      "gmail",
      "satisfaction",
      "fulltime",
      "ops_notes",
    ].map((sourceType) => ({
      source_type: sourceType,
      status: "never_synced" as const,
      last_synced_at: null,
      fetched_count: 0,
      updated_count: 0,
      note: "정적 fallback 기준 데이터 표시 중",
    })),
  };
}
