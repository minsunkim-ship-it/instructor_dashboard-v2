export type OperationalNoteFamily =
  | "data_gap"
  | "environment_issue"
  | "material_delivery"
  | "delivery_quality"
  | "curriculum_compliance"
  | "responsiveness_or_schedule"
  | "commercial_constraint"
  | "positive_signal"
  | "unknown";

export type OperationalNoteOwner =
  | "instructor"
  | "client_or_env"
  | "ops_or_data"
  | "commercial"
  | "unknown";

export type OperationalNotePolarity =
  | "positive"
  | "negative"
  | "neutral"
  | "mixed";

export type OperationalNoteConfidence = "high" | "medium" | "low";

export type OperationalDataRichness =
  | "rich"
  | "moderate"
  | "sparse"
  | "minimal";

export interface BehavioralPatternSourceRef {
  text: string;
  source_note_ids: string[];
}

export interface BehavioralIntelligenceSourceRefs {
  teaching_style: string[];
  curriculum_compliance: string[];
  attitude: string[];
  recommendation: string[];
  key_question_for_humans: string[];
  strength_patterns: BehavioralPatternSourceRef[];
  risk_patterns: BehavioralPatternSourceRef[];
}

export interface RawOperationalNote {
  id: string;
  instructor_id: string;
  source_type: string;
  source_ref: Record<string, unknown>;
  client_name: string | null;
  course_name: string | null;
  round_label: string | null;
  observed_at: string | null;
  raw_text: string;
  ingested_at: string;
}

export interface ClassifiedOperationalNote {
  raw_note_id: string;
  family: OperationalNoteFamily;
  owner: OperationalNoteOwner;
  polarity: OperationalNotePolarity;
  auto_confidence: OperationalNoteConfidence;
  needs_followup: boolean;
  why_flagged: string;
}

export interface HumanFollowup {
  raw_note_id: string;
  family: OperationalNoteFamily;
  owner: OperationalNoteOwner;
  polarity: OperationalNotePolarity;
  why_flagged: string;
  review_status: "open" | "resolved" | "dismissed";
  review_priority: "high" | "medium" | "low";
  source_type: string;
  raw_text: string;
}

export interface BehavioralIntelligence {
  teaching_style: string | null;
  curriculum_compliance: string | null;
  attitude: string | null;
  risk_patterns: string[];
  strength_patterns: string[];
  recommendation: string | null;
  data_richness: OperationalDataRichness;
  data_richness_reason: string | null;
  confidence: OperationalNoteConfidence;
  confidence_reason: string | null;
  key_question_for_humans: string | null;
  source_refs: BehavioralIntelligenceSourceRefs;
}

export interface OperationalIntelligencePayload {
  raw_operational_notes: RawOperationalNote[];
  classified_notes: ClassifiedOperationalNote[];
  human_followups: HumanFollowup[];
  behavioral_intelligence: BehavioralIntelligence;
}
