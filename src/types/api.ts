// 공통 응답 구조 — 05_api_spec.md 3절

import type {
  BehavioralIntelligence,
  ClassifiedOperationalNote,
  HumanFollowup,
  RawOperationalNote,
} from "@/types/operational-intelligence";

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
  teaching_titles: string[];
  specialties: string[];
  rank: number | null;
  score: number | null;
  total_courses: number;
  total_hours: number;
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
  teaching_titles: string[];
  contact: {
    email: string | null;
    phone: string | null;
  };
  specialties: string[];
  profile_summary: string | null;
  memo: string | null;
  notion_memo_diagnostics: NotionMemoDiagnostics;
  is_fulltime: boolean;
  is_practice_coach: boolean;
  total_courses: number;
  total_hours: number;
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
  recent_satisfaction_history: RecentSatisfactionHistoryItem[];
  recommended_for: string[];
  avoid_for: string[];
  risk_notes: string[];
  raw_operational_notes: RawOperationalNote[];
  classified_notes: ClassifiedOperationalNote[];
  human_followups: HumanFollowup[];
  behavioral_intelligence: BehavioralIntelligence;
  operational_intelligence_meta: OperationalIntelligenceMeta;
  operational_evidence_snapshots: OperationalEvidenceSnapshot[];
  fee_history: unknown[];
  teaching_history: unknown[];
  teaching_history_remaining_count: number;
}

export interface OperationalIntelligenceMeta {
  generated_at: string | null;
  generated_by: string | null;
  generation_model: string | null;
}

export interface RecentSatisfactionHistoryItem {
  observed_at: string | null;
  company_name: string | null;
  course_name: string | null;
  session_label: string | null;
}

export interface NotionMemoDiagnostics {
  source_linked: boolean;
  notion_page_id: string | null;
  enrichment_attempted: boolean;
  enrichment_updated: boolean;
  comment_capability: "enabled" | "disabled" | "unknown";
  page_comment_count: number;
  block_comment_count: number;
  block_text_count: number;
  incoming_line_count: number;
  error_message: string | null;
}

export type OperationalEvidenceSource =
  | "curated_ops"
  | "sheet_feedback"
  | "gmail_feedback";

export interface OperationalEvidenceExample {
  kind: "matched_feedback" | "unmapped_feedback" | "curated_note";
  text: string;
  source_type: string | null;
}

export interface OperationalEvidenceSnapshot {
  source: OperationalEvidenceSource;
  title: string;
  total_item_count: number;
  matched_item_count: number;
  matched_feedback_item_count: number;
  unmapped_feedback_item_count: number;
  examples: OperationalEvidenceExample[];
  note: string | null;
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

// 상태 조회 응답 — 05_api_spec.md 8절 확장

export type SourceSyncStatus =
  | "success"
  | "partial"
  | "failed"
  | "never_synced"
  | "running";

export interface StatusSourceItem {
  source_type: string;
  status: SourceSyncStatus;
  last_synced_at: string | null;
  fetched_count: number;
  updated_count: number;
  note: string | null;
}

export interface StatusCurrentRun {
  id: string;
  run_type: string;
  status: string;
  started_at: string;
  stage: string | null;
  stage_started_at: string | null;
  stage_progress: Record<string, unknown> | null;
}

export interface StatusData {
  last_updated_at: string | null;
  refresh_available: boolean;
  latest_run_status: "success" | "partial" | "failed" | "never_synced";
  current_run: StatusCurrentRun | null;
  fallback_ready: boolean;
  sources: StatusSourceItem[];
}

export interface StatusResponse {
  status: "success" | "partial" | "error";
  meta: ApiMeta;
  data: StatusData;
  errors?: ApiError[];
}

// 전체 새로고침 응답

export interface RefreshSummary {
  sources_checked: number;
  sources_updated: number;
  sources_partial?: number;
  sources_failed?: number;
  records_updated: number;
}

export interface RefreshResponse {
  status: "success" | "partial" | "error";
  meta: ApiMeta;
  data?: {
    refresh_status: "success" | "partial" | "failed";
    updated: boolean;
    run_id: string;
    summary: RefreshSummary;
  };
  errors?: ApiError[];
}
