/**
 * 운영 인텔리전스 일반화 억제 유틸 (Step 3).
 *
 * 두 가지 억제:
 *   3-A. 단일 source 강사 → hedging prefix 강제
 *   3-C. rule_based fallback → 분류 라벨 미노출
 *
 * (3-B legacy risk_notes merge 차단은 route.ts riskNotes 빌드에서 직접 처리)
 *
 * 만족도 가드레일: satisfaction 데이터 자체는 미터치. 출력 빌드 단계에서만 동작.
 */
import type {
  BehavioralIntelligence,
  RawOperationalNote,
} from "@/types/operational-intelligence";

export type LabelSuppressionReason =
  | "rule_based_fallback"
  | "single_source_hedged";

export interface OperationalIntelligenceSuppressionResult {
  behavioral_intelligence: BehavioralIntelligence;
  label_suppression_reason: LabelSuppressionReason | null;
  hedge_evidence_count: number | null;
}

/**
 * raw_operational_notes의 source_type 다양성 계산.
 * 0~1개 distinct source_type with count>0 = single source.
 */
function countDistinctSourceTypes(rawNotes: RawOperationalNote[]): {
  distinct: number;
  total: number;
} {
  const set = new Set<string>();
  for (const note of rawNotes) {
    if (note.source_type && note.source_type.trim().length > 0) {
      set.add(note.source_type);
    }
  }
  return { distinct: set.size, total: rawNotes.length };
}

function hedge(text: string | null, hedgeCount: number): string | null {
  if (!text) return text;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith("[관찰 ")) return text; // 이미 hedged면 중복 방지
  return `[관찰 ${hedgeCount}건 기준] ${trimmed}`;
}

function hedgeArray(items: string[], hedgeCount: number): string[] {
  return items
    .map((item) => hedge(item, hedgeCount))
    .filter((item): item is string => Boolean(item && item.trim().length > 0));
}

/** 빈/null behavioral_intelligence 라벨 필드 (라벨 미노출용). */
function clearLabels(bi: BehavioralIntelligence): BehavioralIntelligence {
  return {
    ...bi,
    top_summary: null,
    teaching_style: null,
    curriculum_compliance: null,
    attitude: null,
    risk_patterns: [],
    strength_patterns: [],
    recommendation: null,
    // key_question_for_humans는 운영자가 확인할 질문이므로 유지.
    // data_richness / confidence / source_refs는 유지.
  };
}

/**
 * 3-A + 3-C 적용.
 *
 * 우선순위:
 *   rule_based이면 → 라벨 전부 미노출 (hedging 무관)
 *   아니면 단일 source면 → hedging
 *   아니면 → 변경 없음
 */
export function applyOperationalIntelligenceSuppressions(args: {
  behavioralIntelligence: BehavioralIntelligence;
  rawNotes: RawOperationalNote[];
  generatedBy: string | null | undefined;
}): OperationalIntelligenceSuppressionResult {
  const { behavioralIntelligence, rawNotes, generatedBy } = args;

  // 3-C: rule_based fallback 라벨 미노출
  if (generatedBy === "rule_based") {
    return {
      behavioral_intelligence: clearLabels(behavioralIntelligence),
      label_suppression_reason: "rule_based_fallback",
      hedge_evidence_count: rawNotes.length,
    };
  }

  // 3-A: 단일 source hedging
  const { distinct, total } = countDistinctSourceTypes(rawNotes);
  if (total > 0 && distinct <= 1) {
    return {
      behavioral_intelligence: {
        ...behavioralIntelligence,
        top_summary: hedge(behavioralIntelligence.top_summary, total),
        teaching_style: hedge(behavioralIntelligence.teaching_style, total),
        curriculum_compliance: hedge(
          behavioralIntelligence.curriculum_compliance,
          total
        ),
        attitude: hedge(behavioralIntelligence.attitude, total),
        recommendation: hedge(behavioralIntelligence.recommendation, total),
        risk_patterns: hedgeArray(
          behavioralIntelligence.risk_patterns,
          total
        ),
        strength_patterns: hedgeArray(
          behavioralIntelligence.strength_patterns,
          total
        ),
      },
      label_suppression_reason: "single_source_hedged",
      hedge_evidence_count: total,
    };
  }

  return {
    behavioral_intelligence: behavioralIntelligence,
    label_suppression_reason: null,
    hedge_evidence_count: null,
  };
}
