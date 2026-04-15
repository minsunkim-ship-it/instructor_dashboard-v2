// 공통 응답 구조 — 05_api_spec.md 3절

export interface ApiMeta {
  request_id: string;
  data_mode: "live" | "stored" | "fallback";
  is_fallback: boolean;
  last_updated_at: string | null;
}

export interface ApiError {
  code: string;
  message: string;
}

export interface ApiResponse<T> {
  status: "success" | "partial" | "error" | "empty";
  meta: ApiMeta;
  data: T;
  errors?: ApiError[];
}

// 목록 응답 meta 확장 — 05_api_spec.md 5-4절

export interface InstructorListMeta extends ApiMeta {
  total_count: number;
  query: string;
  category: string;
  sort: string;
}

// 목록 아이템 — 05_api_spec.md 5-5절

export interface InstructorListItem {
  id: string;
  name: string;
  affiliation: string | null;
  categories: string[];
  specialties: string[];
  rank: number | null;
  score: number | null;
  total_courses: number;
  base_fee_hourly: number | null;
  is_fulltime: boolean;
  flag: string | null;
}

// 목록 응답 — 05_api_spec.md 5-4절

export interface InstructorListResponse {
  status: "success" | "partial" | "error" | "empty";
  meta: InstructorListMeta;
  data: {
    items: InstructorListItem[];
  };
}

// 상세 응답 — 05_api_spec.md 6-3절

export interface InstructorDetailData {
  id: string;
  name: string;
  affiliation: string | null;
  categories: string[];
  contact: {
    email: string | null;
    phone: string | null;
  };
  specialties: string[];
  profile_summary: string | null;
  memo: string | null;
  is_fulltime: boolean;
  is_practice_coach: boolean;
  total_courses: number;
  recent_courses_6mo: number;
  total_paid: number | null;
  base_fee_hourly: number | null;
  score: number | null;
  score_breakdown: Record<string, number>;
  satisfaction: {
    avg: number | null;
    count: number;
    is_imputed: boolean;
  };
  recommended_for: string[];
  avoid_for: string[];
  risk_notes: string[];
  ops_check_note: string | null;
  fee_history: unknown[];
  teaching_history: unknown[];
  teaching_history_remaining_count: number;
}

export interface InstructorDetailResponse {
  status: "success" | "partial" | "error";
  meta: ApiMeta;
  data: InstructorDetailData;
  errors?: ApiError[];
}

// 만족도 저장 응답 — 05_api_spec.md 7-5절

export interface SatisfactionCreateData {
  id: string;
  instructor_id: string;
  score: number;
  comment: string | null;
  created_at: string;
  updated_satisfaction: {
    avg: number | null;
    count: number;
    is_imputed: boolean;
  };
}

export interface SatisfactionCreateResponse {
  status: "success" | "error";
  meta: ApiMeta;
  data: SatisfactionCreateData;
  errors?: ApiError[];
}
