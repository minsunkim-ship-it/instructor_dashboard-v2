import { createHash } from "node:crypto";
import type { Instructor, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  loadOpsNotesJson,
  type OpsNotesLoadResult,
} from "@/lib/pipeline/ops-notes-loader";
import type {
  BehavioralIntelligence,
  BehavioralIntelligenceSourceRefs,
  BehavioralPatternSourceRef,
  ClassifiedOperationalNote,
  HumanFollowup,
  OperationalDataRichness,
  OperationalIntelligencePayload,
  OperationalNoteConfidence,
  OperationalNoteFamily,
  OperationalNoteOwner,
  OperationalNotePolarity,
  RawOperationalNote,
} from "@/types/operational-intelligence";

const SOURCE_SUMMARY_KEY = "operational_intelligence_phase1";
const SPEC_REF = "docs/15_operational_intelligence_classification_spec.md";
const PROMPT_VERSION = "ops-intel-v3.3-silent-filter-2026-05-20";
export const CURRENT_OPERATIONAL_INTELLIGENCE_PROMPT_VERSION = PROMPT_VERSION;
const STORAGE_PROJECTION_VERSION = "ops-intel-storage-v2";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_OPERATIONAL_INTELLIGENCE_MODEL = "gpt-5.2";
const LLM_BATCH_SIZE = 40;
const OPERATIONAL_INTELLIGENCE_CONCURRENCY = 8;
const BEHAVIORAL_SUMMARY_NOTE_LIMIT = 40;

const DATA_GAP_KEYWORDS = [
  "미기재",
  "미작성",
  "누락",
  "불일치",
  "확인 필요",
  "재확인",
  "수집 필요",
  "확인 불가",
];

const ENVIRONMENT_ISSUE_KEYWORDS = [
  "접근불가",
  "오류",
  "권한",
  "인터넷",
  "zoom",
  "hdmi",
  "전원",
  "마이크",
  "fabrix",
  "supabase",
  "vercel",
  "make 한도",
];

const MATERIAL_DELIVERY_KEYWORDS = ["교안", "자료", "전달 지연", "미전달"];

const DELIVERY_QUALITY_KEYWORDS = [
  "전달력",
  "설명",
  "속도",
  "흡입력",
  "몰입",
  "따라가기 어려움",
  "구두 설명",
  "눈높이",
  "쉽게 풀어 설명",
  "밀착 케어",
];

const CURRICULUM_COMPLIANCE_KEYWORDS = [
  "커리큘럼",
  "시간 배분",
  "마무리",
  "준수",
  "이론 편중",
  "실습 위주 요청",
];

const RESPONSIVENESS_OR_SCHEDULE_KEYWORDS = [
  "응답",
  "조율",
  "연락",
  "가능 시간",
  "출장 가능",
  "일정 제한",
];

const COMMERCIAL_CONSTRAINT_KEYWORDS = [
  "강사료",
  "단가",
  "상향 요청",
  "암묵적 합의",
];

const POSITIVE_SIGNAL_KEYWORDS = [
  "우수",
  "극찬",
  "만점",
  "핵심 강사",
  "반복 출강",
  "장기 과정 핵심",
  "만족도 4.8",
  "좋았습니다",
  "좋았음",
  "만족스러운",
  "도움이",
  "유익",
  "인상적",
  "흥미",
];

const POSITIVE_POLARITY_KEYWORDS = [
  ...POSITIVE_SIGNAL_KEYWORDS,
  "쉽게 풀어 설명",
  "밀착 케어",
  "좋았습니다",
  "좋았음",
  "만족스러운",
  "도움이",
  "유익",
  "인상적",
  "흥미",
];

const NEGATIVE_POLARITY_KEYWORDS = [
  ...DATA_GAP_KEYWORDS,
  ...ENVIRONMENT_ISSUE_KEYWORDS,
  "전달 지연",
  "미전달",
  "따라가기 어려움",
  "이론 편중",
  "응답 지연",
  "일정 제한",
  "지연",
  "부족",
  "어려움",
  "어렵",
  "아쉬",
  "짧",
  "불편",
  "걱정",
  "상이함",
  "편중",
  "급락",
];

const FOLLOWUP_KEYWORDS = [
  "확인 필요",
  "재확인",
  "불일치",
  "미작성",
  "미기재",
  "수집 필요",
  "확인 불가",
];

const AVOID_DIRECTIVE_KEYWORDS = [
  /섭외\s*지양/,
  /섭외지양/,
  /재섭외\s*지양/,
  /비추천/,
  /추천하지\s*않/,
  /지양/,
];

const RECOMMEND_DIRECTIVE_KEYWORDS = [
  /섭외\s*추천/,
  /재섭외\s*추천/,
  /우선\s*섭외/,
  /추천/,
  /강추/,
];

const MEANINGLESS_FEEDBACK_MARKERS = new Set([
  "미기재",
  "미작성",
  "빈 템플릿",
  "확인 불가",
  "데이터 입력 전 상태",
]);

const FAMILY_ORDER: Array<{
  family: OperationalNoteFamily;
  keywords: string[];
}> = [
  { family: "data_gap", keywords: DATA_GAP_KEYWORDS },
  { family: "environment_issue", keywords: ENVIRONMENT_ISSUE_KEYWORDS },
  { family: "material_delivery", keywords: MATERIAL_DELIVERY_KEYWORDS },
  { family: "delivery_quality", keywords: DELIVERY_QUALITY_KEYWORDS },
  { family: "curriculum_compliance", keywords: CURRICULUM_COMPLIANCE_KEYWORDS },
  {
    family: "responsiveness_or_schedule",
    keywords: RESPONSIVENESS_OR_SCHEDULE_KEYWORDS,
  },
  {
    family: "commercial_constraint",
    keywords: COMMERCIAL_CONSTRAINT_KEYWORDS,
  },
  { family: "positive_signal", keywords: POSITIVE_SIGNAL_KEYWORDS },
];

type InstructorWithSignals = Instructor;

interface StructuredSignals {
  satisfactionAvg: number | null;
  satisfactionCount: number;
  slackActivityCount: number;
  totalCourses: number;
  recentCourses6mo: number;
}

interface GeneratorStats {
  curatedOpsNoteCount: number;
  meaningfulFeedbackCount: number;
  importedFeedbackNoteCount: number;
  slackHighlightCount: number;
  llmAppliedCount: number;
}

type NotionCommentMemoLine = {
  author: string;
  observedAt: string | null;
  text: string;
};

interface EvidenceProfile {
  relevantNoteCount: number;
  relevantSourceCount: number;
  notionCommentCount: number;
  negativeNoteCount: number;
  positiveNoteCount: number;
}

function getOperationalEvidenceBundleKey(raw: RawOperationalNote): string {
  const sourceRef = asRecord(raw.source_ref);
  const satisfactionImportItemId = getSourceRefField(sourceRef, [
    "satisfaction_import_item_id",
  ]);
  if (satisfactionImportItemId) {
    return `${raw.source_type}:satisfaction_import_item:${satisfactionImportItemId}`;
  }

  const activityImportItemId = getSourceRefField(sourceRef, [
    "activity_import_item_id",
  ]);
  if (activityImportItemId) {
    return `${raw.source_type}:activity_import_item:${activityImportItemId}`;
  }

  const entryIndex = getSourceRefField(sourceRef, ["entry_index"]);
  if (entryIndex) {
    return `${raw.source_type}:entry_index:${entryIndex}`;
  }

  return raw.id;
}

interface ClassificationResult {
  classified: ClassifiedOperationalNote;
  raw: RawOperationalNote;
}

interface LlmClassificationPatch {
  raw_note_id: string;
  family: OperationalNoteFamily;
  owner: OperationalNoteOwner;
  polarity: OperationalNotePolarity;
  auto_confidence: OperationalNoteConfidence;
  needs_followup: boolean;
  why_flagged: string;
}

type BehavioralSummaryFields = Pick<
  BehavioralIntelligence,
  | "top_summary"
  | "teaching_style"
  | "curriculum_compliance"
  | "attitude"
  | "risk_patterns"
  | "strength_patterns"
  | "recommendation"
  | "key_question_for_humans"
  | "source_refs"
>;

interface GenerateOperationalIntelligenceOptions {
  instructorIds?: string[];
  loadedOpsNotes?: OpsNotesLoadResult | null;
}

export interface GenerateOperationalIntelligenceResult {
  updatedCount: number;
  sourceCounts: {
    instructors: number;
    rawOperationalNotes: number;
    humanFollowups: number;
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeKeywordText(value: string | null | undefined): string {
  return normalizeText(value).toLowerCase();
}

function includesKeyword(text: string, keyword: string): boolean {
  return text.includes(keyword.toLowerCase());
}

function containsAny(text: string, keywords: string[]): boolean {
  return keywords.some((keyword) => includesKeyword(text, keyword));
}

function buildStableId(prefix: string, ...parts: Array<string | null | undefined>): string {
  const hash = createHash("sha1");
  for (const part of parts) {
    hash.update(part ?? "");
    hash.update("\u0000");
  }
  return `${prefix}_${hash.digest("hex").slice(0, 16)}`;
}

function toDateOnly(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function toOperationalJsonObject(
  payload: OperationalIntelligencePayload,
  stats: GeneratorStats
): Prisma.InputJsonObject {
  return {
    spec_ref: SPEC_REF,
    phase: "phase1_demo",
    source_counts: {
      curated_ops_note_count: stats.curatedOpsNoteCount,
      meaningful_feedback_count: stats.meaningfulFeedbackCount,
      imported_feedback_note_count: stats.importedFeedbackNoteCount,
      slack_highlight_count: stats.slackHighlightCount,
      llm_applied_count: stats.llmAppliedCount,
      raw_operational_note_count: payload.raw_operational_notes.length,
      human_followup_count: payload.human_followups.length,
    },
    [SOURCE_SUMMARY_KEY]: payload as unknown as Prisma.InputJsonObject,
  };
}

function isMeaningfulFeedback(text: string | null | undefined): boolean {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  return !MEANINGLESS_FEEDBACK_MARKERS.has(normalized);
}

function getSourceRefField(
  sourceRef: Record<string, unknown>,
  keys: string[]
): string | null {
  for (const key of keys) {
    const value = sourceRef[key];
    if (typeof value === "string" && normalizeText(value)) {
      return normalizeText(value);
    }
  }
  return null;
}

function createEmptyBehavioralSourceRefs(): BehavioralIntelligenceSourceRefs {
  return {
    teaching_style: [],
    curriculum_compliance: [],
    attitude: [],
    recommendation: [],
    key_question_for_humans: [],
    strength_patterns: [],
    risk_patterns: [],
  };
}

function createEmptyBehavioralIntelligence(): BehavioralIntelligence {
  return {
    top_summary: null,
    teaching_style: null,
    curriculum_compliance: null,
    attitude: null,
    risk_patterns: [],
    strength_patterns: [],
    recommendation: null,
    data_richness: "minimal",
    data_richness_reason: null,
    confidence: "low",
    confidence_reason: null,
    key_question_for_humans: null,
    source_refs: createEmptyBehavioralSourceRefs(),
  };
}

export function createEmptyOperationalIntelligencePayload(): OperationalIntelligencePayload {
  return {
    raw_operational_notes: [],
    classified_notes: [],
    human_followups: [],
    behavioral_intelligence: createEmptyBehavioralIntelligence(),
  };
}

function resolveOpsNotesLoadResult(
  loadedOpsNotes?: OpsNotesLoadResult | null
): OpsNotesLoadResult {
  if (loadedOpsNotes) return loadedOpsNotes;

  try {
    return loadOpsNotesJson();
  } catch {
    return {
      notesByName: new Map<string, string[]>(),
      acceptedEntries: [],
      totalEntries: 0,
      acceptedCount: 0,
      filteredOutCount: 0,
      sourcePath: "",
      version: 1,
      updatedAt: "",
    };
  }
}

interface SatisfactionImportSignalRow {
  id: string;
  sourceType: string;
  sourceRef: Prisma.JsonValue;
  rawPayload: Prisma.JsonValue;
  normalizedPayload: Prisma.JsonValue;
  candidateName: string | null;
  candidateCompanyName: string | null;
  candidateCourseName: string | null;
  responseDate: Date | null;
  createdAt: Date;
}

interface ActivitySignalRow {
  id: string;
  sourceType: string;
  matchedInstructorId: string | null;
  candidateName: string | null;
  rawPayload: Prisma.JsonValue;
  activityAt: Date | null;
  isOpsReport: boolean;
  isDispatchRequest: boolean;
  createdAt: Date;
}

interface RawNoteBuildContext {
  instructorIds: Set<string>;
  instructorIdByName: Map<string, string>;
  satisfactionImportsByInstructor: Map<string, SatisfactionImportSignalRow[]>;
  activitySignalsByInstructor: Map<string, ActivitySignalRow[]>;
}

function addMapEntry<T>(map: Map<string, T[]>, key: string | null, value: T): void {
  if (!key) return;
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

function stripBulletPrefix(value: string): string {
  return value
    .replace(/^[>\-*•\s]+/, "")
    .replace(/^\d+(?:[.)]|-\d+\.)\s*/, "")
    .replace(/^\[[^\]]+\]\s*/, "")
    .trim();
}

function splitFeedbackCandidateParts(value: string): string[] {
  return value
    .replace(/\r/g, "\n")
    .split(/\n+|\s*\/\s*/)
    .map((part) => normalizeText(part))
    .filter(Boolean);
}

function hasFeedbackSignal(value: string): boolean {
  return /(습니다|했습니다|였습니다|좋았|아쉬|유익|도움|만족|불편|어려웠|어렵|필요|추천|인상적|흥미|몰입|평가|반응|의견|긍정|부정|개선|문제|이슈|로그인|실습|설명|강의|업무|활용)/.test(
    value
  );
}

function isLikelyNameOnlyText(value: string): boolean {
  const original = normalizeText(value);
  if (!original) return false;
  if (/@/.test(original)) return true;

  const cleaned = original
    .replace(/^(from|to|cc|bcc|subject|작성자|보낸사람|받는사람|참조)\s*:\s*/i, "")
    .replace(/[()[\]",']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return false;

  const tokens = cleaned.split(/\s+/).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 3) return false;

  const isNameToken = (token: string): boolean =>
    /^[가-힣]{2,5}$/.test(token) ||
    /^[A-Z][a-z]{1,20}$/.test(token) ||
    /^[A-Z][a-z]+(?:[-'][A-Z][a-z]+)?$/.test(token);

  return tokens.every(isNameToken);
}

function isLikelyActionRequestFragment(value: string): boolean {
  return /^(확인|공유|전달|회신|검토|참고|반영|답변|연락)\s*(부탁드리|부탁|요청드리|요청|드립니|드립니다)/.test(
    value
  );
}

function isLikelyTruncatedFeedbackFragment(value: string): boolean {
  return (
    /\b[A-Z]$/.test(value) ||
    /(부탁드리|요청드리|드리겠|확인해주|공유해주|전달해주)$/.test(value)
  );
}

function isLikelyShortNonFeedbackFragment(value: string): boolean {
  return value.length < 12 && !/[.!?]/.test(value) && !hasFeedbackSignal(value);
}

function isSkippableExtractedLine(value: string): boolean {
  if (value.length < 4) return true;
  if (/^(객관식|주관식|평가 항목 점수|평가 항목|주요 주관식 의견|긍정 의견|개선 요청 의견|운영진 의견|운영 의견)$/i.test(value)) {
    return true;
  }
  if (/^(교육 운영\/방식 관련|교육 내용 관련|강의 내용 관련|강의, 커리큘럼 관련|후속과정 관련 제안 의견|개선 요청 - 강의 시간 관련)$/i.test(value)) {
    return true;
  }
  if (
    /^(강의요약|강의관리|관리 이슈사항|운영\/관리 이슈사항|운영\/관리 이슈|강의내용 정리|특이사항)\s*:?\s*$/i.test(
      value
    )
  ) {
    return true;
  }
  if (/^<.*(의견|관련).*>$/i.test(value)) {
    return true;
  }
  if (/^(강의 만족도|전체 만족도|과정 만족도|난이도|추천지수|교육 참여 인원|설문 응답 인원)/.test(value)) {
    return true;
  }
  if (/^[0-9./:()\s-]+$/.test(value)) {
    return true;
  }
  return false;
}

function isBoilerplateEmailLine(value: string): boolean {
  return /^(안녕하세요|감사합니다|좋은 하루|남은 하루|패스트캠퍼스|기업교육 매니저|기업교육 1팀|서울시 |https?:\/\/|E |M |From:|To:|Cc:|Bcc:|Subject:|보낸사람:|받는사람:|참조:|\d{4}년 \d{1,2}월 \d{1,2}일|.*님이 작성:|This message)/i.test(
    value
  );
}

function sanitizeFeedbackTextPart(value: string): string | null {
  const normalized = stripBulletPrefix(normalizeText(value));
  if (!normalized) return null;
  if (isSkippableExtractedLine(normalized)) return null;
  if (isBoilerplateEmailLine(normalized)) return null;
  if (isLikelyNameOnlyText(normalized)) return null;
  if (isLikelyActionRequestFragment(normalized)) return null;
  if (isLikelyTruncatedFeedbackFragment(normalized)) return null;
  if (isLikelyShortNonFeedbackFragment(normalized)) return null;
  if (
    /본 과정 진행 시 .*작성해 주십시오/.test(normalized) ||
    /(운영 매니저|컨설팅팀|\(주)/.test(normalized) ||
    /드림$/.test(normalized)
  ) {
    return null;
  }

  return normalized;
}

function sanitizeFeedbackBlockText(text: string): string | null {
  const parts = splitFeedbackCandidateParts(text)
    .map((part) => sanitizeFeedbackTextPart(part))
    .filter((part): part is string => Boolean(part));

  if (parts.length === 0) return null;
  return parts.join(" / ");
}

function isBehavioralJudgmentRelevant(
  raw: RawOperationalNote,
  classified: ClassifiedOperationalNote
): boolean {
  const text = normalizeKeywordText(raw.raw_text);

  if (
    raw.source_type === "slack_highlight" &&
    /(출강문의|문의드립니다|강의 내용 공유|강의내용 공유|결과 공유|자료 공유|공유해달|요청해주세요|디엠으로도|슬랙 디엠|출강 문의)/.test(
      text
    )
  ) {
    return false;
  }

  if (
    classified.family === "commercial_constraint" ||
    (classified.family === "unknown" &&
      /(계약|법인|출장비|항공료|금액|출강문의|문의드립니다|강의 내용 공유|강의내용 공유)/.test(
        text
      ))
  ) {
    return false;
  }

  return true;
}

function addRawNote(
  map: Map<string, RawOperationalNote>,
  note: RawOperationalNote
): void {
  if (!normalizeText(note.raw_text)) return;
  if (!map.has(note.id)) {
    map.set(note.id, note);
  }
}

function buildInstructorIdByNameMap(
  instructors: Instructor[]
): Map<string, string> {
  const map = new Map<string, string>();
  for (const instructor of instructors) {
    const normalized = normalizeText(instructor.name);
    if (normalized) {
      map.set(normalized, instructor.id);
      map.set(normalized.replace(/\s+/g, ""), instructor.id);
    }
  }
  return map;
}

function resolveInstructorIdFromSatisfactionImport(
  row: SatisfactionImportSignalRow,
  instructorIdByName: Map<string, string>
): string | null {
  const normalizedPayload = asRecord(row.normalizedPayload);
  const sourceRef = asRecord(row.sourceRef);
  const suggestedInstructorId = getSourceRefField(normalizedPayload, [
    "suggested_instructor_id",
    "resolved_instructor_id",
    "instructor_id",
  ]);
  if (suggestedInstructorId) return suggestedInstructorId;

  const sourceInstructorId = getSourceRefField(sourceRef, ["instructor_id"]);
  if (sourceInstructorId) return sourceInstructorId;

  const candidateNames = [
    row.candidateName,
    getSourceRefField(normalizedPayload, ["instructor_name"]),
  ];

  for (const name of candidateNames) {
    const normalized = normalizeText(name);
    if (!normalized) continue;
    const resolved =
      instructorIdByName.get(normalized) ??
      instructorIdByName.get(normalized.replace(/\s+/g, ""));
    if (resolved) return resolved;
  }

  return null;
}

function extractSlackHighlightText(text: string): string {
  const trimmed = normalizeText(text);
  const markdownLinkMatch = trimmed.match(/^(\*+)?<[^|>]+\|(.+?)>(\*+)?$/);
  return markdownLinkMatch?.[2]?.trim() ?? trimmed;
}

function extractInstructorHintFromSlackText(text: string): string | null {
  const matches = Array.from(
    extractSlackHighlightText(text).matchAll(/([가-힣A-Za-z]{2,20})\s*강사님/g)
  );
  const last = matches[matches.length - 1];
  return last?.[1]?.trim() ?? null;
}

function resolveInstructorIdFromActivity(
  row: ActivitySignalRow,
  instructorIdByName: Map<string, string>
): string | null {
  if (row.matchedInstructorId) return row.matchedInstructorId;

  const rawPayload = asRecord(row.rawPayload);
  const rawText = typeof rawPayload.text === "string" ? rawPayload.text : null;
  const candidateNames = [
    row.isDispatchRequest ? row.candidateName : null,
    rawText ? extractInstructorHintFromSlackText(rawText) : null,
  ];

  for (const name of candidateNames) {
    const normalized = normalizeText(name);
    if (!normalized) continue;
    const resolved =
      instructorIdByName.get(normalized) ??
      instructorIdByName.get(normalized.replace(/\s+/g, ""));
    if (resolved) return resolved;
  }

  return null;
}

function buildRawNoteBuildContext(
  instructors: Instructor[],
  satisfactionImports: SatisfactionImportSignalRow[],
  activitySignals: ActivitySignalRow[]
): RawNoteBuildContext {
  const instructorIds = new Set(instructors.map((instructor) => instructor.id));
  const instructorIdByName = buildInstructorIdByNameMap(instructors);
  const satisfactionImportsByInstructor = new Map<string, SatisfactionImportSignalRow[]>();
  const activitySignalsByInstructor = new Map<string, ActivitySignalRow[]>();

  for (const row of satisfactionImports) {
    const instructorId = resolveInstructorIdFromSatisfactionImport(
      row,
      instructorIdByName
    );
    if (!instructorId || !instructorIds.has(instructorId)) continue;
    addMapEntry(satisfactionImportsByInstructor, instructorId, row);
  }

  for (const row of activitySignals) {
    const instructorId = resolveInstructorIdFromActivity(
      row,
      instructorIdByName
    );
    if (!instructorId || !instructorIds.has(instructorId)) continue;
    addMapEntry(activitySignalsByInstructor, instructorId, row);
  }

  return {
    instructorIds,
    instructorIdByName,
    satisfactionImportsByInstructor,
    activitySignalsByInstructor,
  };
}

function extractGmailSummaryNotes(
  row: SatisfactionImportSignalRow
): Array<{
  sourceType: "teaching_feedback_qualitative" | "teaching_feedback_ops";
  text: string;
  noteIndex: number;
}> {
  const rawPayload = asRecord(row.rawPayload);
  const bodyExcerpt =
    typeof rawPayload.body_excerpt === "string" ? rawPayload.body_excerpt : null;
  const hasLlmExtractedFeedback = rawPayload.feedback_notes_llm_extracted === true;

  const notes: Array<{
    sourceType: "teaching_feedback_qualitative" | "teaching_feedback_ops";
    text: string;
    noteIndex: number;
  }> = [];
  if (bodyExcerpt && !hasLlmExtractedFeedback) {
    const lines = bodyExcerpt
      .replace(/\r/g, "")
      .split("\n")
      .map((line) => ({
        raw: line,
        normalized: normalizeText(line),
      }));

    let currentSection: "qualitative" | "ops" | null = null;
    let currentParts: string[] = [];

    const flushCurrentParts = () => {
      const text = sanitizeFeedbackBlockText(currentParts.join(" / "));
      if (!text) {
        currentParts = [];
        return;
      }
      notes.push({
        sourceType:
          currentSection === "ops"
            ? "teaching_feedback_ops"
            : "teaching_feedback_qualitative",
        text,
        noteIndex: notes.length + 1,
      });
      currentParts = [];
    };

    for (const line of lines) {
      if (!line.normalized) {
        flushCurrentParts();
        continue;
      }

      if (
        /^(=|-){3,}$/.test(line.normalized) ||
        /\d{4}년 \d{1,2}월 \d{1,2}일.+작성:/.test(line.normalized)
      ) {
        flushCurrentParts();
        break;
      }

      if (isBoilerplateEmailLine(line.normalized)) {
        flushCurrentParts();
        continue;
      }

      if (
        /(주관식 주요 의견|오늘 강의에서 가장 좋았던 점|가장 기억에 남는 학습 내용|좋았던 점|긍정 의견|아쉬운 점|개선 요청 의견|개선이 필요한 점)/i.test(
          line.normalized
        )
      ) {
        flushCurrentParts();
        currentSection = "qualitative";
        continue;
      }

      if (/(운영진 의견|운영 의견)/i.test(line.normalized)) {
        flushCurrentParts();
        currentSection = "ops";
        continue;
      }

      if (
        /^(객관식|주관식|평가 항목 점수|1\. 객관식|2\. 주관식|3\. 운영진 의견)/.test(
          line.normalized
        )
      ) {
        flushCurrentParts();
        continue;
      }

      const cleaned = stripBulletPrefix(line.normalized);
      if (isSkippableExtractedLine(cleaned)) continue;
      if (!currentSection) continue;
      currentParts.push(cleaned);
    }

    flushCurrentParts();
  }

  appendEmbeddedFeedbackNotes(notes, rawPayload.drive_sheet_notes);
  appendEmbeddedFeedbackNotes(notes, rawPayload.feedback_notes);

  // Step 6 fallback: 정형 헤더 매칭 실패한 경우 body_excerpt에서 의미 있는 한국어 문장 추출.
  if (notes.length === 0 && bodyExcerpt) {
    const fallbackLines = bodyExcerpt
      .replace(/\r/g, "")
      .split("\n")
      .map((line) => normalizeText(line))
      .filter((line) => {
        if (!line) return false;
        if (line.length < 16) return false;
        if (isBoilerplateEmailLine(line)) return false;
        if (isSkippableExtractedLine(line)) return false;
        // 자동 알림/메타 라인 reject
        if (/(no-?reply|noreply|automated|발송된 메일|수신을 원치)/i.test(line)) {
          return false;
        }
        // 한글 비율 50% 이상 (영문 자동 메일 reject)
        const koreanChars = (line.match(/[가-힣]/g) ?? []).length;
        if (koreanChars / line.length < 0.3) return false;
        return true;
      });

    // 최대 5개 의미 줄을 1개 evidence note로 합침
    const joined = fallbackLines.slice(0, 5).join(" / ");
    const sanitized = sanitizeFeedbackBlockText(joined);
    if (sanitized && sanitized.length >= 16) {
      notes.push({
        sourceType: "teaching_feedback_qualitative",
        text: sanitized,
        noteIndex: notes.length + 1,
      });
    }
  }

  return dedupeFeedbackBlocks(notes);
}

function appendEmbeddedFeedbackNotes(
  notes: Array<{
    sourceType: "teaching_feedback_qualitative" | "teaching_feedback_ops";
    text: string;
    noteIndex: number;
  }>,
  embeddedNotes: unknown
): void {
  const items = Array.isArray(embeddedNotes) ? embeddedNotes : [];

  for (const note of items) {
    const record = asRecord(note);
    const text =
      typeof record.text === "string"
        ? sanitizeFeedbackBlockText(record.text)
        : null;
    const sourceType =
      record.note_type === "teaching_feedback_ops"
        ? "teaching_feedback_ops"
        : "teaching_feedback_qualitative";
    if (!text || isSkippableExtractedLine(text)) continue;
    if (
      notes.some(
        (existing) =>
          existing.sourceType === sourceType &&
          normalizeText(existing.text).toLowerCase() === text.toLowerCase()
      )
    ) {
      continue;
    }
    notes.push({
      sourceType,
      text,
      noteIndex: notes.length + 1,
    });
  }
}

function dedupeFeedbackBlocks(
  notes: Array<{
    sourceType: "teaching_feedback_qualitative" | "teaching_feedback_ops";
    text: string;
    noteIndex: number;
  }>
): Array<{
  sourceType: "teaching_feedback_qualitative" | "teaching_feedback_ops";
  text: string;
  noteIndex: number;
}> {
  const deduped: Array<{
    sourceType: "teaching_feedback_qualitative" | "teaching_feedback_ops";
    text: string;
    noteIndex: number;
  }> = [];
  const seen = new Set<string>();

  for (const note of notes) {
    const normalized = sanitizeFeedbackBlockText(note.text);
    if (!normalized) continue;
    const key = `${note.sourceType}::${normalized.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({
      sourceType: note.sourceType,
      text: normalized,
      noteIndex: deduped.length + 1,
    });
  }

  return deduped;
}

function extractStructuredFeedbackNotes(
  row: SatisfactionImportSignalRow
): Array<{
  sourceType: "teaching_feedback_qualitative" | "teaching_feedback_ops";
  text: string;
  noteIndex: number;
}> {
  const rawPayload = asRecord(row.rawPayload);
  const notes: Array<{
    sourceType: "teaching_feedback_qualitative" | "teaching_feedback_ops";
    text: string;
    noteIndex: number;
  }> = [];

  appendEmbeddedFeedbackNotes(notes, rawPayload.feedback_notes);
  appendEmbeddedFeedbackNotes(notes, rawPayload.drive_sheet_notes);

  return notes;
}

export function extractOperationalFeedbackNotesFromImport(input: {
  sourceType: string;
  rawPayload: unknown;
}): Array<{
  sourceType: "teaching_feedback_qualitative" | "teaching_feedback_ops";
  text: string;
  noteIndex: number;
}> {
  const row = {
    sourceType: input.sourceType,
    rawPayload: asRecord(input.rawPayload),
  } as SatisfactionImportSignalRow;

  if (row.sourceType === "gmail_summary") {
    return extractGmailSummaryNotes(row);
  }

  if (row.sourceType === "manual") {
    return extractManualFeedbackNotes(row);
  }

  return extractStructuredFeedbackNotes(row);
}

function getOperationalIntelligenceLlmConfig():
  | {
      apiKey: string;
      model: string;
      url: string;
    }
  | null {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;

  return {
    apiKey,
    model:
      process.env.OPERATIONAL_INTELLIGENCE_LLM_MODEL?.trim() ||
      process.env.OPENAI_MODEL?.trim() ||
      DEFAULT_OPERATIONAL_INTELLIGENCE_MODEL,
    url:
      process.env.OPENAI_RESPONSES_URL?.trim() ||
      process.env.OPENAI_BASE_URL?.trim() ||
      OPENAI_RESPONSES_URL,
  };
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];

  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (true) {
        const current = nextIndex++;
        if (current >= items.length) return;
        results[current] = await worker(items[current], current);
      }
    })
  );

  return results;
}

function isRetryablePrismaError(error: unknown): boolean {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  return code === "P1001" || code === "P1002" || code === "P1017";
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withPrismaRetry<T>(
  fn: () => Promise<T>,
  retries = 3
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryablePrismaError(error) || attempt === retries) {
        throw error;
      }
      await prisma.$disconnect().catch(() => undefined);
      await sleep(attempt * 1_000);
    }
  }

  throw lastError;
}

function extractResponseText(responseBody: Record<string, unknown>): string {
  const output = Array.isArray(responseBody.output) ? responseBody.output : [];
  const texts: string[] = [];

  for (const item of output) {
    const content = Array.isArray(asRecord(item).content)
      ? (asRecord(item).content as unknown[])
      : [];
    for (const chunk of content) {
      const record = asRecord(chunk);
      if (record.type === "output_text" && typeof record.text === "string") {
        texts.push(record.text);
      }
    }
  }

  return texts.join("\n").trim();
}

function buildLlmClassificationPrompt(notes: ClassificationResult[]): string {
  return [
    "You classify operational intelligence notes for instructor_db.",
    "Use only the evidence in each raw_text. Do not invent facts.",
    "If ambiguous, keep family=unknown or owner=unknown and set needs_followup=true.",
    "Do not turn a single incident into a repeated pattern.",
    "environment_issue and data_gap must not be escalated to instructor risk unless explicit instructor fault is stated.",
    "Return JSON only.",
    "",
    "Allowed families: data_gap, environment_issue, material_delivery, delivery_quality, curriculum_compliance, responsiveness_or_schedule, commercial_constraint, positive_signal, unknown",
    "Allowed owners: instructor, client_or_env, ops_or_data, commercial, unknown",
    "Allowed polarity: positive, negative, neutral, mixed",
    "Allowed auto_confidence: high, medium, low",
    "",
    "Notes:",
    JSON.stringify(
      notes.map((item) => ({
        raw_note_id: item.raw.id,
        source_type: item.raw.source_type,
        client_name: item.raw.client_name,
        course_name: item.raw.course_name,
        round_label: item.raw.round_label,
        observed_at: item.raw.observed_at,
        raw_text: item.raw.raw_text,
        rule_guess: item.classified,
      })),
      null,
      2
    ),
  ].join("\n");
}

function getLlmClassificationSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      classifications: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            raw_note_id: { type: "string" },
            family: {
              type: "string",
              enum: [
                "data_gap",
                "environment_issue",
                "material_delivery",
                "delivery_quality",
                "curriculum_compliance",
                "responsiveness_or_schedule",
                "commercial_constraint",
                "positive_signal",
                "unknown",
              ],
            },
            owner: {
              type: "string",
              enum: [
                "instructor",
                "client_or_env",
                "ops_or_data",
                "commercial",
                "unknown",
              ],
            },
            polarity: {
              type: "string",
              enum: ["positive", "negative", "neutral", "mixed"],
            },
            auto_confidence: {
              type: "string",
              enum: ["high", "medium", "low"],
            },
            needs_followup: { type: "boolean" },
            why_flagged: { type: "string" },
          },
          required: [
            "raw_note_id",
            "family",
            "owner",
            "polarity",
            "auto_confidence",
            "needs_followup",
            "why_flagged",
          ],
        },
      },
    },
    required: ["classifications"],
  };
}

function createEmptyBehavioralSummary(): BehavioralSummaryFields {
  return {
    top_summary: null,
    teaching_style: null,
    curriculum_compliance: null,
    attitude: null,
    risk_patterns: [],
    strength_patterns: [],
    recommendation: null,
    key_question_for_humans: null,
    source_refs: createEmptyBehavioralSourceRefs(),
  };
}

function getBehavioralPatternSourceRefSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      text: { type: "string" },
      source_note_ids: {
        type: "array",
        items: { type: "string" },
      },
    },
    required: ["text", "source_note_ids"],
  };
}

function getBehavioralSourceRefsSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      teaching_style: {
        type: "array",
        items: { type: "string" },
      },
      curriculum_compliance: {
        type: "array",
        items: { type: "string" },
      },
      attitude: {
        type: "array",
        items: { type: "string" },
      },
      recommendation: {
        type: "array",
        items: { type: "string" },
      },
      key_question_for_humans: {
        type: "array",
        items: { type: "string" },
      },
      strength_patterns: {
        type: "array",
        items: getBehavioralPatternSourceRefSchema(),
      },
      risk_patterns: {
        type: "array",
        items: getBehavioralPatternSourceRefSchema(),
      },
    },
    required: [
      "teaching_style",
      "curriculum_compliance",
      "attitude",
      "recommendation",
      "key_question_for_humans",
      "strength_patterns",
      "risk_patterns",
    ],
  };
}

function getBehavioralSummarySchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      top_summary: { type: "string" },
      teaching_style: { type: "string" },
      curriculum_compliance: { type: "string" },
      attitude: { type: "string" },
      risk_patterns: {
        type: "array",
        items: { type: "string" },
      },
      strength_patterns: {
        type: "array",
        items: { type: "string" },
      },
      recommendation: { type: "string" },
      key_question_for_humans: { type: "string" },
      source_refs: getBehavioralSourceRefsSchema(),
    },
    required: [
      "top_summary",
      "teaching_style",
      "curriculum_compliance",
      "attitude",
      "risk_patterns",
      "strength_patterns",
      "recommendation",
      "key_question_for_humans",
      "source_refs",
    ],
  };
}

function buildBehavioralSummaryPrompt(args: {
  notes: ClassificationResult[];
  humanFollowups: HumanFollowup[];
  signals: StructuredSignals;
  riskPatterns: string[];
  strengthPatterns: string[];
  dataRichness: OperationalDataRichness;
  confidence: OperationalNoteConfidence;
}): string {
  return [
    "You summarize operational intelligence for an instructor dashboard in Korean.",
    "LANGUAGE: All output text MUST be in natural Korean only. Do not use Russian, Cyrillic, Chinese, Japanese, or any other non-Korean script. English loanwords commonly used in Korean (e.g. AI, SQL) are OK; otherwise stick to Korean. If you are about to write a non-Korean word like 'audience' or 'аудитory', use the Korean equivalent ('대상' / '청중') instead.",
    "Use the raw notes as the primary evidence. Do not invent facts.",
    "Do not generalize a stable trait from a single isolated incident.",
    "If evidence is weak or ambiguous, return an empty string for that field.",
    "Each field should be concise: one short sentence, except recommendation can be one or two short sentences.",
    "strength_patterns and risk_patterns should each contain up to 3 short Korean phrases summarizing repeated feedback themes.",
    "",
    "ATTRIBUTION RULES (critical — output must reflect only the instructor's own conduct):",
    "- The following are NEVER instructor risks or attitudes. They are operations / curriculum / client-side concerns and must not be surfaced in risk_patterns, attitude, teaching_style, or curriculum_compliance:",
    "  • 수강생 구성·수준 편차·인원 변동 (learner composition / level mix)",
    "  • 과정 설계 부적합·시수 부족·콘텐츠 범위 (course design, hours, scope)",
    "  • 자료 배포 지연·환경 이슈·일정 변경 (material delivery, env, schedule by client/ops)",
    "  • 수강생 참여도·집중도·과제 미제출 (learner engagement)",
    "- Even if such issues appear in the notes, attribute them to the operations or curriculum design side, NOT to the instructor.",
    "- risk_patterns and attitude reflect ONLY the instructor's own actions, preparation, responsiveness, professionalism, or delivery weakness explicitly stated in evidence.",
    "- If the only \"risk\" evidence is about learner composition, course design, or ops logistics, return risk_patterns: [] and leave attitude empty.",
    "- recommendation may mention what kind of audience/program the instructor is well suited for, but should NOT recommend curriculum changes or ops actions.",
    "- SILENT FILTERING: Do NOT mention the attribution rule itself in the user-facing text. Do not write phrases like '운영 측 사안이 섞여 있어 강사 단정이 어렵다' or '데이터 한계' or '강사 특성으로 보기 어렵다'. Just silently filter out non-instructor evidence and produce output based on what remains. If after filtering there is nothing instructor-specific to say, return empty fields (empty string for text fields, [] for arrays).",
    "",
    "TONE:",
    "- Conservative and observational. Prefer phrases like '~한 반응이 있었습니다', '~한 평이 다수' over assertive '~를 잘 합니다' or '~가 부족합니다'.",
    "- Avoid evaluator/manager language like '맞춤화가 필요', '운영 측 보완', '난이도 조절' — those are operations decisions, not instructor traits.",
    "- Write reaction-based interpretations, not generic templates. Pick the most distinctive repeated themes for this instructor.",
    "- Avoid boilerplate strengths that could apply to almost anyone, such as '설명을 잘함' or '실습이 좋음', when the notes support something more specific.",
    "- If two candidate themes are both true, prefer the one that better distinguishes this instructor from others.",
    "- Prefer wording that stays close to collected reactions. Avoid abstract evaluator language such as operational maturity, sharpness, or strong adaptability unless the raw notes explicitly say so.",
    "- Structured signals like repeated recent courses or satisfaction counts can support confidence, but should not be surfaced as strength_patterns or risk_patterns by themselves.",
    "",
    "Read all evidence notes provided below before writing the summary.",
    "Use the broader evidence set for reasoning even if source_refs later shows only representative citations.",
    "User-facing text fields must not mention note ids, source systems, raw note wording, or that you are summarizing notes.",
    "Return source_refs for every non-empty field and pattern using only raw_note_id values from the evidence notes below.",
    "source_refs are representative citations for display, not an exhaustive list of every supporting note you considered.",
    "source_refs.strength_patterns and source_refs.risk_patterns must contain one entry per returned pattern text with the same text value.",
    "Prefer 3-6 representative raw_note_id values when evidence is rich. Use only 1-2 when the claim is genuinely supported by very sparse evidence.",
    "If there are multiple relevant evidence notes, do not let the whole summary depend on the same 1-2 raw_note_id values.",
    "Do not cite structured signals alone. Every source_refs entry must point to raw evidence notes.",
    "Return JSON only.",
    "",
    "Fields:",
    "- top_summary: 1~2 short Korean paragraphs summarizing what is known about THIS INSTRUCTOR specifically. Conservative observational tone. Cover only instructor's own delivery style, preparation, professionalism. Mention learner composition / course design / ops issues only if it changed how this instructor delivered (e.g. how they responded to the situation), and clearly frame those as operations concerns, not instructor traits. If you have no instructor-specific evidence, return an empty string.",
    "- teaching_style: teaching/delivery style or how the instructor guides learners",
    "- curriculum_compliance: how the instructor executed the agreed curriculum (pace, examples, materials USED). Do NOT include curriculum design adequacy or learner-level fit — those are design decisions.",
    "- attitude: instructor's own preparation, responsiveness, professionalism. Not learner engagement, not external scheduling.",
    "- strength_patterns: repeated strengths in the instructor's own conduct",
    "- risk_patterns: repeated cautions about the instructor's own conduct. If only learner/design/ops issues appear, return [].",
    "- recommendation: what kind of audience/format/contact this instructor fits best. Do NOT recommend curriculum changes or ops actions.",
    "- key_question_for_humans: one or two short Korean sentences for a user-facing '확인 필요' note. No internal labels, no source/system terms, no counts, no mention of human_followups. If there is nothing worth surfacing separately, return an empty string.",
    "",
    "Structured signals:",
    JSON.stringify(
      {
        satisfaction_avg: args.signals.satisfactionAvg,
        satisfaction_count: args.signals.satisfactionCount,
        slack_activity_count: args.signals.slackActivityCount,
        total_courses: args.signals.totalCourses,
        recent_courses_6mo: args.signals.recentCourses6mo,
        evidence_note_count: args.notes.length,
        data_richness: args.dataRichness,
        confidence: args.confidence,
        risk_patterns: args.riskPatterns,
        strength_patterns: args.strengthPatterns,
        human_followup_count: args.humanFollowups.length,
        human_followups: args.humanFollowups.map((item) => ({
          family: item.family,
          owner: item.owner,
          polarity: item.polarity,
          why_flagged: item.why_flagged,
          raw_text: item.raw_text,
        })),
      },
      null,
      2
    ),
    "",
    "Evidence notes:",
    JSON.stringify(
      args.notes.map((item) => ({
        observed_at: item.raw.observed_at,
        source_type: item.raw.source_type,
        client_name: item.raw.client_name,
        course_name: item.raw.course_name,
        round_label: item.raw.round_label,
        raw_text: item.raw.raw_text,
        family: item.classified.family,
        owner: item.classified.owner,
        polarity: item.classified.polarity,
        auto_confidence: item.classified.auto_confidence,
      })),
      null,
      2
    ),
  ].join("\n");
}

function buildFallbackBehavioralSummary(args: {
  notes: ClassificationResult[];
  humanFollowups: HumanFollowup[];
  riskPatterns: string[];
  strengthPatterns: string[];
}): BehavioralSummaryFields {
  const positiveNotes = args.notes
    .filter((item) => item.classified.polarity === "positive")
    .map((item) => normalizeText(item.raw.raw_text))
    .filter(Boolean);
  const negativeNotes = args.notes
    .filter((item) => item.classified.polarity === "negative")
    .map((item) => normalizeText(item.raw.raw_text))
    .filter(Boolean);

  let recommendation: string | null = null;
  if (args.strengthPatterns[0] && args.riskPatterns[0]) {
    recommendation = `${args.strengthPatterns[0]}. 다만 ${args.riskPatterns[0]}.`;
  } else if (args.strengthPatterns[0]) {
    recommendation = `${args.strengthPatterns[0]}.`;
  } else if (positiveNotes[0] && negativeNotes[0]) {
    recommendation = `${positiveNotes[0]} 다만 ${negativeNotes[0]}`;
  } else if (positiveNotes[0]) {
    recommendation = positiveNotes[0];
  } else if (args.riskPatterns[0]) {
    recommendation = `${args.riskPatterns[0]}.`;
  } else if (negativeNotes[0]) {
    recommendation = negativeNotes[0];
  }

  // Fallback (LLM 미사용)에서는 top_summary는 보수적으로 비움.
  // 단일 evidence를 종합 요약으로 굳히지 않기 위함.
  const summary: BehavioralSummaryFields = {
    top_summary: null,
    teaching_style: null,
    curriculum_compliance: null,
    attitude: null,
    risk_patterns: args.riskPatterns,
    strength_patterns: args.strengthPatterns,
    recommendation,
    key_question_for_humans: buildKeyQuestionForHumans(args.humanFollowups),
    source_refs: createEmptyBehavioralSourceRefs(),
  };

  const sourceRefs = sanitizeBehavioralSourceRefs({
    value: null,
    summary,
    notes: args.notes,
  });

  return alignBehavioralSummaryWithSourceRefs(summary, sourceRefs, args.notes);
}

function sanitizeBehavioralPatternList(
  value: unknown,
  kind: "risk" | "strength"
): string[] {
  if (!Array.isArray(value)) return [];

  return Array.from(
    new Set(
      value
        .map((item) => (typeof item === "string" ? normalizeText(item) : ""))
        .filter(Boolean)
        .map((item) => normalizeLegacyPatternLabel(item, kind))
        .filter(Boolean)
    )
  ).slice(0, 3);
}

const SOURCE_REF_TOKEN_STOPWORDS = new Set([
  "있습니다",
  "있음",
  "합니다",
  "하는",
  "대한",
  "필요",
  "보완",
  "관리",
  "운영",
  "확인",
  "위한",
  "강사",
  "수업",
  "강의",
  "과정",
  "반응",
  "중심",
  "실습",
  "설명",
  "대응",
  "진행",
]);

const BEHAVIORAL_NOVELTY_STOPWORDS = new Set([
  ...SOURCE_REF_TOKEN_STOPWORDS,
  "좋음",
  "좋고",
  "좋아",
  "유익",
  "도움",
  "반응",
  "느낌",
  "많아",
  "많고",
  "높음",
  "높고",
  "빠름",
  "빠르고",
  "부족",
  "부족함",
  "친절",
  "쉬움",
  "쉽고",
]);

type BehavioralSourceRefField =
  keyof Pick<
    BehavioralIntelligenceSourceRefs,
    | "teaching_style"
    | "curriculum_compliance"
    | "attitude"
    | "recommendation"
    | "key_question_for_humans"
  >;

type BehavioralSourceSelectionKind =
  | BehavioralSourceRefField
  | "risk_pattern"
  | "strength_pattern";

type ScoredBehavioralSourceNote = {
  rawNoteId: string;
  score: number;
  sortKey: string;
  bundleKey: string;
};

type ScoredBehavioralPatternRef = {
  ref: BehavioralPatternSourceRef;
  positiveBundleKeys: string[];
  totalScore: number;
  topScore: number;
};

function getBehavioralSourceRefTargetCount(
  kind: BehavioralSourceSelectionKind
): number {
  switch (kind) {
    case "recommendation":
    case "risk_pattern":
    case "strength_pattern":
      return 5;
    case "key_question_for_humans":
      return 3;
    default:
      return 3;
  }
}

function buildClassificationResults(
  rawNotes: RawOperationalNote[],
  classifiedNotes: ClassifiedOperationalNote[]
): ClassificationResult[] {
  const classificationByRawId = new Map(
    classifiedNotes.map((item) => [item.raw_note_id, item] as const)
  );

  return rawNotes.map((raw) => ({
    raw,
    classified:
      classificationByRawId.get(raw.id) ?? {
        raw_note_id: raw.id,
        family: "unknown" as const,
        owner: "unknown" as const,
        polarity: "neutral" as const,
        auto_confidence: "low" as const,
        needs_followup: false,
        why_flagged: "missing_classification",
      },
  }));
}

function tokenizeBehavioralSourceRefText(text: string): string[] {
  return Array.from(
    new Set(
      normalizeKeywordText(text)
        .split(/[^0-9a-zA-Z가-힣]+/u)
        .map((token) => token.trim())
        .filter(
          (token) =>
            token.length >= 2 && !SOURCE_REF_TOKEN_STOPWORDS.has(token)
        )
    )
  );
}

function tokenizeBehavioralNoveltyText(text: string): string[] {
  return Array.from(
    new Set(
      normalizeKeywordText(text)
        .split(/[^0-9a-zA-Z가-힣]+/u)
        .map((token) => token.trim())
        .filter(
          (token) =>
            token.length >= 2 && !BEHAVIORAL_NOVELTY_STOPWORDS.has(token)
        )
    )
  );
}

function sanitizeSourceNoteIds(
  value: unknown,
  availableNoteIds: Set<string>
): string[] {
  if (!Array.isArray(value)) return [];

  return Array.from(
    new Set(
      value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter((item) => item && availableNoteIds.has(item))
    )
  ).slice(0, 6);
}

function pickDiverseSourceNoteIds(args: {
  candidates: ScoredBehavioralSourceNote[];
  targetCount: number;
  usedNoteIds?: Set<string>;
}): string[] {
  const selected: string[] = [];
  const usedBundles = new Set<string>();
  const appendFromPool = (pool: ScoredBehavioralSourceNote[]): void => {
    for (const candidate of pool) {
      if (selected.length >= args.targetCount) return;
      if (selected.includes(candidate.rawNoteId)) continue;
      if (usedBundles.has(candidate.bundleKey)) continue;
      selected.push(candidate.rawNoteId);
      usedBundles.add(candidate.bundleKey);
    }

    for (const candidate of pool) {
      if (selected.length >= args.targetCount) return;
      if (selected.includes(candidate.rawNoteId)) continue;
      selected.push(candidate.rawNoteId);
    }
  };

  if (args.usedNoteIds && args.usedNoteIds.size > 0) {
    appendFromPool(
      args.candidates.filter((candidate) => !args.usedNoteIds?.has(candidate.rawNoteId))
    );
  }

  appendFromPool(args.candidates);

  return selected;
}

function mergeBehavioralSourceNoteIds(args: {
  existing: string[];
  recommended: string[];
  kind: BehavioralSourceSelectionKind;
}): string[] {
  return Array.from(new Set([...args.existing, ...args.recommended])).slice(
    0,
    getBehavioralSourceRefTargetCount(args.kind)
  );
}

function scoreBehavioralSourceCandidates(args: {
  text: string | null;
  notes: ClassificationResult[];
  kind: BehavioralSourceSelectionKind;
}): ScoredBehavioralSourceNote[] {
  if (!args.text) return [];

  const relevantNotes = args.notes.filter((item) => {
    if (!isBehavioralJudgmentRelevant(item.raw, item.classified)) {
      return false;
    }

    if (args.kind === "risk_pattern") {
      return (
        item.classified.owner === "instructor" &&
        item.classified.polarity === "negative"
      );
    }

    if (args.kind === "strength_pattern") {
      return (
        item.classified.owner === "instructor" &&
        ["positive", "mixed"].includes(item.classified.polarity)
      );
    }

    return true;
  });
  const targetTokens = tokenizeBehavioralSourceRefText(args.text);

  return relevantNotes
    .map((item) => {
      const noteText = normalizeKeywordText(item.raw.raw_text);
      let score = 0;

      for (const token of targetTokens) {
        if (noteText.includes(token)) {
          score += token.length >= 4 ? 2 : 1;
        }
      }

      if (args.kind === "risk_pattern") {
        if (
          item.classified.owner === "instructor" &&
          item.classified.polarity === "negative"
        ) {
          score += 3;
        }
      } else if (args.kind === "strength_pattern") {
        if (
          item.classified.owner === "instructor" &&
          ["positive", "mixed"].includes(item.classified.polarity)
        ) {
          score += 3;
        }
      } else if (args.kind === "teaching_style") {
        if (item.classified.family === "delivery_quality") score += 2;
      } else if (args.kind === "curriculum_compliance") {
        if (
          [
            "curriculum_compliance",
            "material_delivery",
            "delivery_quality",
          ].includes(item.classified.family)
        ) {
          score += 2;
        }
      } else if (args.kind === "attitude") {
        if (
          [
            "responsiveness_or_schedule",
            "positive_signal",
            "environment_issue",
          ].includes(item.classified.family)
        ) {
          score += 2;
        }
      } else if (args.kind === "recommendation") {
        if (item.classified.owner === "instructor") score += 1;
      } else if (args.kind === "key_question_for_humans") {
        if (item.classified.needs_followup) score += 3;
        if (item.classified.polarity === "negative") score += 1;
      }

      return {
        rawNoteId: item.raw.id,
        score,
        sortKey: item.raw.observed_at ?? item.raw.ingested_at,
        bundleKey: getOperationalEvidenceBundleKey(item.raw),
      };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.sortKey.localeCompare(a.sortKey);
    });
}

function selectSourceNoteIdsForBehavioralText(args: {
  text: string | null;
  notes: ClassificationResult[];
  kind: BehavioralSourceSelectionKind;
  usedNoteIds?: Set<string>;
}): string[] {
  const scored = scoreBehavioralSourceCandidates(args);
  const targetCount = getBehavioralSourceRefTargetCount(args.kind);
  const positiveScored = scored.filter((item) => item.score > 0);
  const pool = positiveScored.length > 0 ? positiveScored : scored;

  return pickDiverseSourceNoteIds({
    candidates: pool,
    targetCount,
    usedNoteIds: args.usedNoteIds,
  });
}

function getBehavioralSourceCoverageTarget(
  notes: ClassificationResult[]
): number {
  const relevantBundleCount = new Set(
    notes
      .filter((item) => isBehavioralJudgmentRelevant(item.raw, item.classified))
      .map((item) => getOperationalEvidenceBundleKey(item.raw))
  ).size;

  if (relevantBundleCount >= 4) return 4;
  if (relevantBundleCount >= 3) return 3;
  return 0;
}

function collectBehavioralSourceNoteIds(
  sourceRefs: BehavioralIntelligenceSourceRefs
): string[] {
  return Array.from(
    new Set([
      ...sourceRefs.teaching_style,
      ...sourceRefs.curriculum_compliance,
      ...sourceRefs.attitude,
      ...sourceRefs.recommendation,
      ...sourceRefs.key_question_for_humans,
      ...sourceRefs.strength_patterns.flatMap((item) => item.source_note_ids),
      ...sourceRefs.risk_patterns.flatMap((item) => item.source_note_ids),
    ])
  );
}

function enforceBehavioralSourceCoverage(args: {
  sourceRefs: BehavioralIntelligenceSourceRefs;
  summary: BehavioralSummaryFields;
  notes: ClassificationResult[];
}): BehavioralIntelligenceSourceRefs {
  const coverageTarget = getBehavioralSourceCoverageTarget(args.notes);
  const next: BehavioralIntelligenceSourceRefs = {
    ...args.sourceRefs,
    strength_patterns: args.sourceRefs.strength_patterns.map((item) => ({
      ...item,
      source_note_ids: [...item.source_note_ids],
    })),
    risk_patterns: args.sourceRefs.risk_patterns.map((item) => ({
      ...item,
      source_note_ids: [...item.source_note_ids],
    })),
  };

  if (coverageTarget === 0) {
    return next;
  }

  const getUsedNoteIds = (): Set<string> =>
    new Set(collectBehavioralSourceNoteIds(next));
  const hasEnoughCoverage = (): boolean =>
    getUsedNoteIds().size >= coverageTarget;

  const expandField = (
    field: BehavioralSourceRefField,
    text: string | null
  ): void => {
    if (!text || hasEnoughCoverage()) return;
    next[field] = mergeBehavioralSourceNoteIds({
      existing: next[field],
      recommended: selectSourceNoteIdsForBehavioralText({
        text,
        notes: args.notes,
        kind: field,
        usedNoteIds: getUsedNoteIds(),
      }),
      kind: field,
    });
  };

  const expandPatternList = (
    kind: "risk" | "strength",
    patterns: BehavioralPatternSourceRef[]
  ): BehavioralPatternSourceRef[] =>
    patterns.map((pattern) => {
      if (hasEnoughCoverage()) return pattern;

      return {
        ...pattern,
        source_note_ids: mergeBehavioralSourceNoteIds({
          existing: pattern.source_note_ids,
          recommended: selectSourceNoteIdsForBehavioralText({
            text: pattern.text,
            notes: args.notes,
            kind: kind === "risk" ? "risk_pattern" : "strength_pattern",
            usedNoteIds: getUsedNoteIds(),
          }),
          kind: kind === "risk" ? "risk_pattern" : "strength_pattern",
        }),
      };
    });

  expandField("recommendation", args.summary.recommendation);
  next.strength_patterns = expandPatternList("strength", next.strength_patterns);
  next.risk_patterns = expandPatternList("risk", next.risk_patterns);
  expandField("teaching_style", args.summary.teaching_style);
  expandField(
    "curriculum_compliance",
    args.summary.curriculum_compliance
  );
  expandField("attitude", args.summary.attitude);
  expandField(
    "key_question_for_humans",
    args.summary.key_question_for_humans
  );

  return next;
}

function sanitizeBehavioralPatternSourceRefs(args: {
  value: unknown;
  patterns: string[];
  notes: ClassificationResult[];
  kind: "risk" | "strength";
}): BehavioralPatternSourceRef[] {
  const availableNoteIds = new Set(args.notes.map((item) => item.raw.id));
  const refs = Array.isArray(args.value) ? args.value : [];
  const refByText = new Map<string, BehavioralPatternSourceRef>();

  for (const item of refs) {
    const record = asRecord(item);
    const text =
      typeof record.text === "string" ? normalizeText(record.text) : "";
    if (!text) continue;

    refByText.set(text.toLowerCase(), {
      text,
      source_note_ids: sanitizeSourceNoteIds(
        record.source_note_ids,
        availableNoteIds
      ),
    });
  }

  const scoredRefs: ScoredBehavioralPatternRef[] = args.patterns.map((pattern) => {
    const normalizedPattern = normalizeText(pattern);
    const existing = refByText.get(normalizedPattern.toLowerCase());
    const kind =
      args.kind === "risk" ? "risk_pattern" : "strength_pattern";
    const candidates = scoreBehavioralSourceCandidates({
      text: normalizedPattern,
      notes: args.notes,
      kind,
    });
    const recommended = pickDiverseSourceNoteIds({
      candidates: candidates.filter((item) => item.score > 0),
      targetCount: getBehavioralSourceRefTargetCount(kind),
    });
    const source_note_ids = mergeBehavioralSourceNoteIds({
      existing: existing?.source_note_ids ?? [],
      recommended,
      kind,
    });
    const candidateById = new Map(
      candidates.map((item) => [item.rawNoteId, item] as const)
    );
    const positiveBundleKeys = Array.from(
      new Set(
        source_note_ids
          .map((id) => candidateById.get(id))
          .filter((item): item is ScoredBehavioralSourceNote => Boolean(item))
          .filter((item) => item.score > 0)
          .map((item) => item.bundleKey)
      )
    );
    const selectedScores = source_note_ids
      .map((id) => candidateById.get(id)?.score ?? 0)
      .filter((score) => score > 0);

    return {
      ref: {
        text: normalizedPattern,
        source_note_ids,
      },
      positiveBundleKeys,
      totalScore: selectedScores.reduce((sum, score) => sum + score, 0),
      topScore: Math.max(0, ...selectedScores),
    };
  });

  const coveredBundles = new Set<string>();
  const seenSignatures = new Set<string>();

  return scoredRefs
    .filter((item) => item.topScore >= 2 && item.positiveBundleKeys.length > 0)
    .sort((a, b) => {
      if (b.positiveBundleKeys.length !== a.positiveBundleKeys.length) {
        return b.positiveBundleKeys.length - a.positiveBundleKeys.length;
      }
      if (b.totalScore !== a.totalScore) {
        return b.totalScore - a.totalScore;
      }
      return b.topScore - a.topScore;
    })
    .filter((item) => {
      const signature = item.positiveBundleKeys.slice().sort().join("::");
      if (signature && seenSignatures.has(signature)) {
        return false;
      }
      const addsNovelBundle = item.positiveBundleKeys.some(
        (bundleKey) => !coveredBundles.has(bundleKey)
      );
      if (!addsNovelBundle && coveredBundles.size > 0) {
        return false;
      }
      seenSignatures.add(signature);
      item.positiveBundleKeys.forEach((bundleKey) => coveredBundles.add(bundleKey));
      return true;
    })
    .slice(0, 3)
    .map((item) => item.ref);
}

function alignBehavioralPatternsWithSourceRefs(
  patterns: string[],
  refs: BehavioralPatternSourceRef[]
): string[] {
  if (refs.length === 0) {
    return patterns;
  }

  const allowedTexts = new Set(
    refs.map((item) => normalizeComparableText(item.text))
  );

  return patterns.filter((pattern) =>
    allowedTexts.has(normalizeComparableText(pattern))
  );
}

function normalizeComparableText(value: string): string {
  return normalizeText(value).toLowerCase();
}

function getBehavioralSourceBundleKeys(args: {
  sourceNoteIds: string[];
  notes: ClassificationResult[];
}): string[] {
  const rawById = new Map(args.notes.map((item) => [item.raw.id, item.raw] as const));

  return Array.from(
    new Set(
      args.sourceNoteIds
        .map((sourceNoteId) => rawById.get(sourceNoteId))
        .filter((raw): raw is RawOperationalNote => Boolean(raw))
        .map((raw) => getOperationalEvidenceBundleKey(raw))
    )
  );
}

function pruneLowNoveltyBehavioralField(args: {
  text: string | null;
  sourceNoteIds: string[];
  baselineBundleKeys: Set<string>;
  baselineTexts: string[];
  notes: ClassificationResult[];
}): { text: string | null; sourceNoteIds: string[] } {
  if (!args.text || args.sourceNoteIds.length === 0) {
    return {
      text: args.text,
      sourceNoteIds: args.sourceNoteIds,
    };
  }

  if (args.baselineBundleKeys.size === 0) {
    return {
      text: args.text,
      sourceNoteIds: args.sourceNoteIds,
    };
  }

  const bundleKeys = getBehavioralSourceBundleKeys({
    sourceNoteIds: args.sourceNoteIds,
    notes: args.notes,
  });
  const novelBundleCount = bundleKeys.filter(
    (bundleKey) => !args.baselineBundleKeys.has(bundleKey)
  ).length;
  const fieldTokens = tokenizeBehavioralNoveltyText(args.text);
  const baselineTokens = new Set(
    args.baselineTexts.flatMap((text) => tokenizeBehavioralNoveltyText(text))
  );
  const overlapRatio =
    fieldTokens.length === 0
      ? 0
      : fieldTokens.filter((token) => baselineTokens.has(token)).length /
        fieldTokens.length;

  if (bundleKeys.length <= 2 && novelBundleCount <= 1) {
    return {
      text: null,
      sourceNoteIds: [],
    };
  }

  if (args.sourceNoteIds.length <= 2 && overlapRatio >= 0.45) {
    return {
      text: null,
      sourceNoteIds: [],
    };
  }

  return {
    text: args.text,
    sourceNoteIds: args.sourceNoteIds,
  };
}

function alignBehavioralSummaryWithSourceRefs(
  summary: BehavioralSummaryFields,
  sourceRefs: BehavioralIntelligenceSourceRefs,
  notes: ClassificationResult[]
): BehavioralSummaryFields {
  const alignedStrengthPatterns = alignBehavioralPatternsWithSourceRefs(
    summary.strength_patterns,
    sourceRefs.strength_patterns
  );
  const alignedRiskPatterns = alignBehavioralPatternsWithSourceRefs(
    summary.risk_patterns,
    sourceRefs.risk_patterns
  );
  const baselineBundleKeys = new Set(
    [
      ...sourceRefs.strength_patterns.flatMap((item) => item.source_note_ids),
      ...sourceRefs.risk_patterns.flatMap((item) => item.source_note_ids),
    ].flatMap((sourceNoteId) =>
      getBehavioralSourceBundleKeys({
        sourceNoteIds: [sourceNoteId],
        notes,
      })
    )
  );
  const baselineTexts = [...alignedStrengthPatterns, ...alignedRiskPatterns];
  const teachingStyle = pruneLowNoveltyBehavioralField({
    text: summary.teaching_style,
    sourceNoteIds: sourceRefs.teaching_style,
    baselineBundleKeys,
    baselineTexts,
    notes,
  });
  const curriculumCompliance = pruneLowNoveltyBehavioralField({
    text: summary.curriculum_compliance,
    sourceNoteIds: sourceRefs.curriculum_compliance,
    baselineBundleKeys,
    baselineTexts,
    notes,
  });
  const attitude = pruneLowNoveltyBehavioralField({
    text: summary.attitude,
    sourceNoteIds: sourceRefs.attitude,
    baselineBundleKeys,
    baselineTexts,
    notes,
  });
  const alignedSourceRefs: BehavioralIntelligenceSourceRefs = {
    ...sourceRefs,
    teaching_style: teachingStyle.sourceNoteIds,
    curriculum_compliance: curriculumCompliance.sourceNoteIds,
    attitude: attitude.sourceNoteIds,
  };

  return {
    ...summary,
    teaching_style: teachingStyle.text,
    curriculum_compliance: curriculumCompliance.text,
    attitude: attitude.text,
    strength_patterns: alignedStrengthPatterns,
    risk_patterns: alignedRiskPatterns,
    source_refs: alignedSourceRefs,
  };
}

function sanitizeBehavioralSourceRefs(args: {
  value: unknown;
  summary: BehavioralSummaryFields;
  notes: ClassificationResult[];
}): BehavioralIntelligenceSourceRefs {
  const availableNoteIds = new Set(args.notes.map((item) => item.raw.id));
  const record = asRecord(args.value);

  const sanitizeField = (
    field: BehavioralSourceRefField,
    text: string | null
  ): string[] => {
    const existing = sanitizeSourceNoteIds(record[field], availableNoteIds);
    if (!text) {
      return existing;
    }

    return mergeBehavioralSourceNoteIds({
      existing,
      recommended: selectSourceNoteIdsForBehavioralText({
        text,
        notes: args.notes,
        kind: field,
      }),
      kind: field,
    });
  };

  const sourceRefs = {
    teaching_style: sanitizeField(
      "teaching_style",
      args.summary.teaching_style
    ),
    curriculum_compliance: sanitizeField(
      "curriculum_compliance",
      args.summary.curriculum_compliance
    ),
    attitude: sanitizeField("attitude", args.summary.attitude),
    recommendation: sanitizeField(
      "recommendation",
      args.summary.recommendation
    ),
    key_question_for_humans: sanitizeField(
      "key_question_for_humans",
      args.summary.key_question_for_humans
    ),
    strength_patterns: sanitizeBehavioralPatternSourceRefs({
      value: record.strength_patterns,
      patterns: args.summary.strength_patterns,
      notes: args.notes,
      kind: "strength",
    }),
    risk_patterns: sanitizeBehavioralPatternSourceRefs({
      value: record.risk_patterns,
      patterns: args.summary.risk_patterns,
      notes: args.notes,
      kind: "risk",
    }),
  };

  return enforceBehavioralSourceCoverage({
    sourceRefs,
    summary: args.summary,
    notes: args.notes,
  });
}

export async function summarizeBehavioralIntelligenceFromEvidence(args: {
  rawNotes: RawOperationalNote[];
  classifiedNotes: ClassifiedOperationalNote[];
  humanFollowups: HumanFollowup[];
  signals: {
    satisfactionAvg: number | null;
    satisfactionCount: number;
    slackActivityCount: number;
    totalCourses: number;
    recentCourses6mo: number;
  };
  riskPatterns: string[];
  strengthPatterns: string[];
  dataRichness: OperationalDataRichness;
  confidence: OperationalNoteConfidence;
}): Promise<{
  summary: BehavioralSummaryFields;
  usedLlm: boolean;
}> {
  const notes = buildClassificationResults(args.rawNotes, args.classifiedNotes)
    .filter((item) => isBehavioralJudgmentRelevant(item.raw, item.classified))
    .sort((a, b) => {
      const aDate = a.raw.observed_at ?? a.raw.ingested_at;
      const bDate = b.raw.observed_at ?? b.raw.ingested_at;
      return bDate.localeCompare(aDate);
    })
    .slice(0, BEHAVIORAL_SUMMARY_NOTE_LIMIT);

  if (notes.length === 0) {
    return {
      summary: createEmptyBehavioralSummary(),
      usedLlm: false,
    };
  }

  const config = getOperationalIntelligenceLlmConfig();
  if (!config) {
    return {
      summary: buildFallbackBehavioralSummary({
        notes,
        humanFollowups: args.humanFollowups,
        riskPatterns: args.riskPatterns,
        strengthPatterns: args.strengthPatterns,
      }),
      usedLlm: false,
    };
  }

  try {
    const response = await fetch(config.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        reasoning: { effort: "low" },
        input: buildBehavioralSummaryPrompt({
          notes,
          humanFollowups: args.humanFollowups,
          signals: args.signals,
          riskPatterns: args.riskPatterns,
          strengthPatterns: args.strengthPatterns,
          dataRichness: args.dataRichness,
          confidence: args.confidence,
        }),
        text: {
          format: {
            type: "json_schema",
            name: "operational_behavioral_summary",
            schema: getBehavioralSummarySchema(),
          },
        },
      }),
    });

    if (!response.ok) {
      return {
        summary: buildFallbackBehavioralSummary({
          notes,
          humanFollowups: args.humanFollowups,
          riskPatterns: args.riskPatterns,
          strengthPatterns: args.strengthPatterns,
        }),
        usedLlm: false,
      };
    }

    const body = (await response.json()) as Record<string, unknown>;
    const parsed = JSON.parse(extractResponseText(body)) as Record<string, unknown>;
    const llmRiskPatterns = sanitizeBehavioralPatternList(
      parsed.risk_patterns,
      "risk"
    );
    const llmStrengthPatterns = sanitizeBehavioralPatternList(
      parsed.strength_patterns,
      "strength"
    );
    const summary: BehavioralSummaryFields = {
      top_summary: normalizeText(
        typeof parsed.top_summary === "string" ? parsed.top_summary : null
      ) || null,
      teaching_style: normalizeText(
        typeof parsed.teaching_style === "string" ? parsed.teaching_style : null
      ) || null,
      curriculum_compliance: normalizeText(
        typeof parsed.curriculum_compliance === "string"
          ? parsed.curriculum_compliance
          : null
      ) || null,
      attitude: normalizeText(
        typeof parsed.attitude === "string" ? parsed.attitude : null
      ) || null,
      risk_patterns: llmRiskPatterns.length > 0 ? llmRiskPatterns : args.riskPatterns,
      strength_patterns:
        llmStrengthPatterns.length > 0
          ? llmStrengthPatterns
          : args.strengthPatterns,
      recommendation: normalizeText(
        typeof parsed.recommendation === "string"
          ? parsed.recommendation
          : null
      ) || null,
      key_question_for_humans: normalizeText(
        typeof parsed.key_question_for_humans === "string"
          ? parsed.key_question_for_humans
          : null
      ) || null,
      source_refs: createEmptyBehavioralSourceRefs(),
    };

    const sourceRefs = sanitizeBehavioralSourceRefs({
      value: parsed.source_refs,
      summary,
      notes,
    });

    return {
      summary: alignBehavioralSummaryWithSourceRefs(summary, sourceRefs, notes),
      usedLlm: true,
    };
  } catch {
    return {
      summary: buildFallbackBehavioralSummary({
        notes,
        humanFollowups: args.humanFollowups,
        riskPatterns: args.riskPatterns,
        strengthPatterns: args.strengthPatterns,
      }),
      usedLlm: false,
    };
  }
}

async function classifyNotesWithLlm(
  notes: ClassificationResult[]
): Promise<Map<string, LlmClassificationPatch>> {
  const config = getOperationalIntelligenceLlmConfig();
  if (!config || notes.length === 0) {
    return new Map<string, LlmClassificationPatch>();
  }

  const patches = new Map<string, LlmClassificationPatch>();
  const batches = chunkArray(notes, LLM_BATCH_SIZE);

  for (const batch of batches) {
    const response = await fetch(config.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        reasoning: { effort: "low" },
        input: buildLlmClassificationPrompt(batch),
        text: {
          format: {
            type: "json_schema",
            name: "operational_intelligence_classification",
            schema: getLlmClassificationSchema(),
          },
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`operational intelligence LLM failed: ${response.status}`);
    }

    const body = (await response.json()) as Record<string, unknown>;
    const responseText = extractResponseText(body);
    const parsed = JSON.parse(responseText) as {
      classifications?: LlmClassificationPatch[];
    };

    for (const item of parsed.classifications ?? []) {
      if (typeof item.raw_note_id !== "string") continue;
      patches.set(item.raw_note_id, item);
    }
  }

  return patches;
}

async function applyLlmClassificationPatches(
  classifications: ClassificationResult[]
): Promise<{
  classifications: ClassificationResult[];
  llmAppliedCount: number;
  usedLlm: boolean;
}> {
  const candidates = classifications.filter(
    (item) =>
      item.classified.family === "unknown" ||
      item.classified.owner === "unknown" ||
      item.classified.auto_confidence === "low"
  );

  const patches = await classifyNotesWithLlm(candidates);
  if (patches.size === 0) {
    return {
      classifications,
      llmAppliedCount: 0,
      usedLlm: false,
    };
  }

  return {
    classifications: classifications.map((item) => {
      const patch = patches.get(item.raw.id);
      if (!patch) return item;

      return {
        raw: item.raw,
        classified: {
          raw_note_id: item.raw.id,
          family: patch.family,
          owner: patch.owner,
          polarity: patch.polarity,
          auto_confidence: patch.auto_confidence,
          needs_followup: patch.needs_followup,
          why_flagged: patch.why_flagged,
        },
      };
    }),
    llmAppliedCount: patches.size,
    usedLlm: true,
  };
}

function extractManualFeedbackNotes(
  row: SatisfactionImportSignalRow
): Array<{
  sourceType: "teaching_feedback_qualitative";
  text: string;
  noteIndex: number;
}> {
  const rawPayload = asRecord(row.rawPayload);
  const comment =
    typeof rawPayload.comment === "string" ? normalizeText(rawPayload.comment) : "";
  if (!comment) return [];

  return [
    {
      sourceType: "teaching_feedback_qualitative",
      text: comment,
      noteIndex: 1,
    },
  ];
}

function buildRawNoteFromSatisfactionImport(
  row: SatisfactionImportSignalRow,
  instructorId: string,
  note: {
    sourceType: "teaching_feedback_qualitative" | "teaching_feedback_ops";
    text: string;
    noteIndex: number;
  }
): RawOperationalNote {
  const normalizedPayload = asRecord(row.normalizedPayload);
  const sourceRef = {
    satisfaction_import_item_id: row.id,
    source_type: row.sourceType,
    note_index: note.noteIndex,
    ...asRecord(row.sourceRef),
  };

  return {
    id: buildStableId(
      "rawop",
      instructorId,
      row.id,
      note.sourceType,
      String(note.noteIndex),
      note.text
    ),
    instructor_id: instructorId,
    source_type: note.sourceType,
    source_ref: sourceRef,
    client_name:
      row.candidateCompanyName ??
      getSourceRefField(normalizedPayload, ["company_name"]),
    course_name:
      row.candidateCourseName ??
      getSourceRefField(normalizedPayload, ["course_name"]),
    round_label: getSourceRefField(normalizedPayload, [
      "session_label",
      "round_label",
      "round",
    ]),
    observed_at: toDateOnly(row.responseDate),
    raw_text: note.text,
    ingested_at: row.createdAt.toISOString(),
  };
}

function buildSlackHighlightRawNote(
  row: ActivitySignalRow,
  instructorId: string
): RawOperationalNote[] {
  const rawPayload = asRecord(row.rawPayload);
  const rawText =
    typeof rawPayload.text === "string"
      ? normalizeText(extractSlackHighlightText(rawPayload.text))
      : "";
  if (!rawText) return [];

  const buildNote = (
    text: string,
    noteIndex: number,
    clientName: string | null,
    courseName: string | null,
    roundLabel: string | null
  ): RawOperationalNote => ({
    id: buildStableId(
      "rawop",
      instructorId,
      row.id,
      "slack_highlight",
      String(noteIndex),
      text
    ),
    instructor_id: instructorId,
    source_type: "slack_highlight",
    source_ref: {
      activity_import_item_id: row.id,
      source_type: row.sourceType,
      note_index: noteIndex,
      is_ops_report: row.isOpsReport,
      is_dispatch_request: row.isDispatchRequest,
    },
    client_name: clientName,
    course_name: courseName,
    round_label: roundLabel,
    observed_at: toDateOnly(row.activityAt),
    raw_text: text,
    ingested_at: row.createdAt.toISOString(),
  });

  const metadata = rawText.split("_").map((part) => normalizeText(part));
  const clientName =
    metadata.length >= 3
      ? metadata[0]
          .replace(/^\(B2B\)\s*/i, "")
          .replace(/^주요 고객사:\s*/i, "")
      : null;
  const courseName = metadata.length >= 3 ? metadata[1] : null;
  const roundLabel =
    metadata.find((part) => /(회차|차수|일차)/.test(part)) ?? null;

  // slack ops_report — section parsing (기존)
  if (row.isOpsReport) {
    const normalizedSlackText = rawText.replace(/```/g, "\n");
    const lines = normalizedSlackText
      .split("\n")
      .map((line) => stripBulletPrefix(normalizeText(line)))
      .filter(Boolean);
    const extractedNotes: string[] = [];
    let section: "ops" | "content" | "ignore" | null = null;

    for (const line of lines) {
      if (/(운영\/관리 이슈사항|운영\/관리 이슈|운영진 의견|운영 의견|이슈 사항)/.test(line)) {
        section = "ops";
        continue;
      }
      if (/(강의내용정리|강의 내용 정리)/.test(line)) {
        section = "content";
        continue;
      }
      if (
        /(강의내용 공유드립니다|강의내용 공유 드립니다|강의 내용 공유드립니다|강의 내용 공유 드립니다|공유 드립니다)/.test(
          line
        )
      ) {
        section = "ignore";
        continue;
      }

      if (section !== "ops" && section !== "content") continue;
      if (isSkippableExtractedLine(line) || isBoilerplateEmailLine(line)) continue;
      extractedNotes.push(line);
    }

    // Step 6 fallback: section keyword 매칭 실패 시 본문 중 의미 있는 라인 1~2개라도 추출.
    if (extractedNotes.length === 0) {
      for (const line of lines) {
        if (isSkippableExtractedLine(line) || isBoilerplateEmailLine(line)) continue;
        if (line.length < 12) continue;
        extractedNotes.push(line);
        if (extractedNotes.length >= 2) break;
      }
    }

    if (extractedNotes.length === 0) {
      return [];
    }

    return extractedNotes.map((text, index) =>
      buildNote(text, index + 1, clientName, courseName, roundLabel)
    );
  }

  // Step 6: gmail activity (is_ops_report=false). matchedInstructorId 신뢰.
  // 신중한 추출: 자동 메일/짧은 알림 reject. body 본문에서 강사 관련 의미 줄만.
  if (row.sourceType === "gmail") {
    return buildGmailActivityRawNotes(row, instructorId, rawText);
  }

  return [];
}

function buildGmailActivityRawNotes(
  row: ActivitySignalRow,
  instructorId: string,
  rawText: string
): RawOperationalNote[] {
  const rawPayload = asRecord(row.rawPayload);
  const subject = typeof rawPayload.subject === "string" ? rawPayload.subject : "";
  const body =
    typeof rawPayload.body_excerpt === "string"
      ? rawPayload.body_excerpt
      : typeof rawPayload.body === "string"
        ? rawPayload.body
        : rawText;

  if (!body || body.length < 50) return [];

  // 자동 알림 메일 reject
  if (/no-?reply|noreply|automated|메일 수신을 원치 않으|발송된 메일/i.test(body)) {
    return [];
  }
  // forwarded/template-only reject
  if (/^-+\s*(Original Message|Forwarded message)/im.test(body)) {
    // forwarded라도 forwarded 메시지 본문 자체는 evidence일 수 있으므로 reject 안 함.
  }

  const lines = body
    .split("\n")
    .map((line) => normalizeText(line))
    .filter(Boolean);

  // boilerplate 라인 제거
  const meaningful = lines.filter(
    (line) =>
      line.length >= 12 &&
      !isBoilerplateEmailLine(line) &&
      !isSkippableExtractedLine(line)
  );

  if (meaningful.length === 0) return [];

  // 최대 3개 의미 라인 → 1개 evidence note로 묶음
  const joined = meaningful.slice(0, 3).join(" / ");
  const sanitized = sanitizeFeedbackBlockText(joined);
  if (!sanitized || sanitized.length < 12) return [];

  return [
    {
      id: buildStableId(
        "rawop",
        instructorId,
        row.id,
        "gmail_activity",
        "1",
        sanitized
      ),
      instructor_id: instructorId,
      source_type: "gmail_activity",
      source_ref: {
        activity_import_item_id: row.id,
        source_type: row.sourceType,
        subject: subject || null,
        is_ops_report: row.isOpsReport,
      },
      client_name: null,
      course_name: null,
      round_label: null,
      observed_at: toDateOnly(row.activityAt),
      raw_text: sanitized,
      ingested_at: row.createdAt.toISOString(),
    },
  ];
}

function buildRawOperationalNotes(
  instructor: InstructorWithSignals,
  loadedOpsNotes: OpsNotesLoadResult,
  context: RawNoteBuildContext
): { rawNotes: RawOperationalNote[]; stats: GeneratorStats } {
  const rawNotes = new Map<string, RawOperationalNote>();
  const nowIso = new Date().toISOString();
  let meaningfulFeedbackCount = 0;
  let curatedOpsNoteCount = 0;
  let importedFeedbackNoteCount = 0;
  let slackHighlightCount = 0;

  const curatedNotes = loadedOpsNotes.acceptedEntries.filter(
    (entry) => entry.name === instructor.name
  );

  for (const entry of curatedNotes) {
    const sourceRef = {
      source_file: loadedOpsNotes.sourcePath,
      ops_notes_version: loadedOpsNotes.version,
      ops_notes_updated_at: loadedOpsNotes.updatedAt,
      entry_index: entry.entryIndex,
      ...entry.sourceRef,
    };
    const clientName = getSourceRefField(sourceRef, [
      "client_name",
      "client",
      "company_name",
      "organization_name",
    ]);
    const courseName = getSourceRefField(sourceRef, [
      "course_name",
      "course",
      "title",
    ]);
    const roundLabel = getSourceRefField(sourceRef, [
      "round_label",
      "round",
      "session_label",
    ]);

    addRawNote(rawNotes, {
      id: buildStableId(
        "rawop",
        instructor.id,
        "curated_ops",
        String(entry.entryIndex),
        entry.memo
      ),
      instructor_id: instructor.id,
      source_type: "curated_ops",
      source_ref: sourceRef,
      client_name: clientName,
      course_name: courseName,
      round_label: roundLabel,
      observed_at: getSourceRefField(sourceRef, [
        "observed_at",
        "date",
        "event_date",
      ]),
      raw_text: entry.memo,
      ingested_at: nowIso,
    });
    curatedOpsNoteCount += 1;
  }

  const notionCommentNotes = extractNotionCommentNotesFromMemo(instructor.memoRaw);
  for (const [index, note] of notionCommentNotes.entries()) {
    addRawNote(rawNotes, {
      id: buildStableId(
        "rawop",
        instructor.id,
        "notion_comment",
        String(index + 1),
        note.text
      ),
      instructor_id: instructor.id,
      source_type: "notion_comment",
      source_ref: {
        author: note.author,
        observed_at: note.observedAt,
        source: "memo_raw",
      },
      client_name: null,
      course_name: null,
      round_label: null,
      observed_at: note.observedAt,
      raw_text: note.text,
      ingested_at: nowIso,
    });
  }

  const satisfactionImports =
    context.satisfactionImportsByInstructor.get(instructor.id) ?? [];
  for (const row of satisfactionImports) {
    const extractedNotes = extractOperationalFeedbackNotesFromImport(row);

    for (const note of extractedNotes) {
      addRawNote(
        rawNotes,
        buildRawNoteFromSatisfactionImport(row, instructor.id, note)
      );
      importedFeedbackNoteCount += 1;
      if (
        note.sourceType === "teaching_feedback_qualitative" &&
        isMeaningfulFeedback(note.text)
      ) {
        meaningfulFeedbackCount += 1;
      }
    }
  }

  const activitySignals = context.activitySignalsByInstructor.get(instructor.id) ?? [];
  for (const row of activitySignals) {
    for (const note of buildSlackHighlightRawNote(row, instructor.id)) {
      addRawNote(rawNotes, note);
      slackHighlightCount += 1;
    }
  }

  return {
    rawNotes: Array.from(rawNotes.values()),
    stats: {
      curatedOpsNoteCount,
      meaningfulFeedbackCount,
      importedFeedbackNoteCount,
      slackHighlightCount,
      llmAppliedCount: 0,
    },
  };
}

function mergeNotionCommentText(
  existingText: string,
  nextText: string
): string {
  const merged = new Map<string, string>();
  for (const segment of [existingText, nextText]
    .flatMap((value) => value.split(" / "))
    .map((value) => normalizeText(value))
    .filter(Boolean)) {
    const key = segment.toLowerCase();
    if (!merged.has(key)) {
      merged.set(key, segment);
    }
  }

  return Array.from(merged.values()).join(" / ");
}

export function extractNotionCommentNotesFromMemo(
  memoRaw: string | null
): NotionCommentMemoLine[] {
  if (!memoRaw) return [];

  const lines = memoRaw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const notes: NotionCommentMemoLine[] = [];
  for (const line of lines) {
    const match = line.match(/^\[Notion comment · (.+?) · ([^\]]+)\] (.+)$/);
    if (!match) continue;

    const [, author, observedAt, text] = match;
    const normalizedText = normalizeText(text);
    if (!normalizedText) continue;

    const normalizedAuthor = normalizeText(author);
    const normalizedObservedAt =
      observedAt && /^\d{4}-\d{2}-\d{2}$/.test(observedAt)
        ? observedAt
        : null;
    const previous = notes[notes.length - 1];

    if (
      previous &&
      previous.author === normalizedAuthor &&
      previous.observedAt === normalizedObservedAt
    ) {
      previous.text = mergeNotionCommentText(previous.text, normalizedText);
      continue;
    }

    notes.push({
      author: normalizedAuthor,
      observedAt: normalizedObservedAt,
      text: normalizedText,
    });
  }

  return notes;
}

function matchFamilies(text: string): OperationalNoteFamily[] {
  const matches: OperationalNoteFamily[] = [];
  for (const rule of FAMILY_ORDER) {
    if (containsAny(text, rule.keywords)) {
      matches.push(rule.family);
    }
  }
  return Array.from(new Set(matches));
}

function getDefaultOwner(family: OperationalNoteFamily): OperationalNoteOwner {
  switch (family) {
    case "data_gap":
      return "ops_or_data";
    case "environment_issue":
      return "client_or_env";
    case "material_delivery":
    case "delivery_quality":
    case "curriculum_compliance":
    case "responsiveness_or_schedule":
    case "positive_signal":
      return "instructor";
    case "commercial_constraint":
      return "commercial";
    default:
      return "unknown";
  }
}

function classifyNote(raw: RawOperationalNote): ClassificationResult {
  const normalizedText = normalizeKeywordText(raw.raw_text);
  const matchedFamilies = matchFamilies(normalizedText);
  let family: OperationalNoteFamily = matchedFamilies[0] ?? "unknown";

  if (
    containsAny(normalizedText, [
      "강사명 불일치",
      "만족도 미기재",
      "시트 미작성",
    ])
  ) {
    family = "data_gap";
  } else if (
    family === "unknown" &&
    containsAny(normalizedText, POSITIVE_POLARITY_KEYWORDS)
  ) {
    family = "positive_signal";
  }

  let owner = getDefaultOwner(family);
  let whyFlagged = matchedFamilies.length > 0
    ? `family_keyword_match:${family}`
    : "keyword_no_match";

  if (
    containsAny(normalizedText, ["강사 미숙", "준비 부족", "교안 미전달", "사전 점검 안함"])
  ) {
    owner = "instructor";
    whyFlagged = "owner_override:instructor";
  } else if (
    containsAny(normalizedText, [
      "고객사 시스템",
      "현장 장비",
      "계정 오류",
      "환경 이슈",
    ])
  ) {
    owner = "client_or_env";
    whyFlagged = "owner_override:client_or_env";
  } else if (
    containsAny(normalizedText, ["강사명 불일치", "만족도 미기재", "시트 미작성"])
  ) {
    owner = "ops_or_data";
    whyFlagged = "owner_override:ops_or_data";
  }

  const hasPositiveCue = containsAny(normalizedText, POSITIVE_POLARITY_KEYWORDS);
  const hasNegativeCue = containsAny(normalizedText, NEGATIVE_POLARITY_KEYWORDS);

  let polarity: OperationalNotePolarity;
  if (hasPositiveCue && hasNegativeCue) {
    polarity = "mixed";
  } else if (hasPositiveCue) {
    polarity = "positive";
  } else if (hasNegativeCue) {
    polarity = family === "data_gap" || family === "commercial_constraint"
      ? "neutral"
      : "negative";
  } else if (family === "positive_signal") {
    polarity = "positive";
  } else if (
    family === "data_gap" ||
    family === "commercial_constraint" ||
    family === "unknown"
  ) {
    polarity = "neutral";
  } else {
    // Doc 15 does not require family-only defaulting to negative.
    // When polarity cue is absent, stay neutral to avoid false risk escalation.
    polarity = "neutral";
  }

  let autoConfidence: OperationalNoteConfidence = "medium";
  if (
    family === "unknown" ||
    matchedFamilies.length > 1 ||
    owner === "unknown" ||
    polarity === "mixed"
  ) {
    autoConfidence = "low";
  } else {
    const keywordHitCount = FAMILY_ORDER.reduce((count, rule) => {
      if (rule.family !== family) return count;
      return count + rule.keywords.filter((keyword) => includesKeyword(normalizedText, keyword)).length;
    }, 0);
    autoConfidence = keywordHitCount >= 2 ? "high" : "medium";
  }

  const needsFollowup =
    family === "data_gap" ||
    owner === "unknown" ||
    autoConfidence === "low" ||
    containsAny(normalizedText, FOLLOWUP_KEYWORDS);

  if (matchedFamilies.length > 1) {
    whyFlagged = "multiple_family_matches";
  } else if (needsFollowup && containsAny(normalizedText, FOLLOWUP_KEYWORDS)) {
    whyFlagged = "followup_keyword";
  }

  return {
    raw,
    classified: {
      raw_note_id: raw.id,
      family,
      owner,
      polarity,
      auto_confidence: autoConfidence,
      needs_followup: needsFollowup,
      why_flagged: whyFlagged,
    },
  };
}

function buildHumanFollowups(
  classifications: ClassificationResult[]
): HumanFollowup[] {
  const followups: HumanFollowup[] = [];

  for (const item of classifications) {
    const { raw, classified } = item;
    if (!isBehavioralJudgmentRelevant(raw, classified)) {
      continue;
    }
    if (
      !classified.needs_followup &&
      classified.family !== "unknown" &&
      classified.owner !== "unknown" &&
      classified.auto_confidence !== "low" &&
      classified.polarity !== "mixed"
    ) {
      continue;
    }

    followups.push({
      raw_note_id: raw.id,
      family: classified.family,
      owner: classified.owner,
      polarity: classified.polarity,
      why_flagged: classified.why_flagged,
      review_status: "open",
      review_priority:
        classified.family === "data_gap"
          ? "low"
          : classified.polarity === "negative"
            ? "high"
            : "medium",
      source_type: raw.source_type,
      raw_text: raw.raw_text,
    });
  }

  return followups;
}

function hasStructuredSignal(signals: StructuredSignals): boolean {
  return (
    signals.satisfactionAvg !== null ||
    signals.slackActivityCount >= 3 ||
    signals.totalCourses >= 5
  );
}

function buildEvidenceProfile(
  classifications: ClassificationResult[]
): EvidenceProfile {
  const relevant = classifications.filter((item) =>
    isBehavioralJudgmentRelevant(item.raw, item.classified)
  );
  const grouped = new Map<
    string,
    {
      sourceType: string;
      hasNegative: boolean;
      hasPositive: boolean;
    }
  >();

  for (const item of relevant) {
    const key = getOperationalEvidenceBundleKey(item.raw);
    const existing = grouped.get(key) ?? {
      sourceType: item.raw.source_type,
      hasNegative: false,
      hasPositive: false,
    };
    if (item.classified.polarity === "negative") {
      existing.hasNegative = true;
    }
    if (item.classified.polarity === "positive") {
      existing.hasPositive = true;
    }
    grouped.set(key, existing);
  }

  return {
    relevantNoteCount: grouped.size,
    relevantSourceCount: new Set(
      Array.from(grouped.values()).map((item) => item.sourceType)
    ).size,
    notionCommentCount: Array.from(grouped.values()).filter(
      (item) => item.sourceType === "notion_comment"
    ).length,
    negativeNoteCount: Array.from(grouped.values()).filter(
      (item) => item.hasNegative
    ).length,
    positiveNoteCount: Array.from(grouped.values()).filter(
      (item) => item.hasPositive
    ).length,
  };
}

function selectDataRichness(
  stats: GeneratorStats,
  signals: StructuredSignals,
  evidence: EvidenceProfile
): OperationalDataRichness {
  const hasDenseMultiSourceFeedback =
    stats.meaningfulFeedbackCount >= 4 &&
    evidence.relevantSourceCount >= 2 &&
    evidence.positiveNoteCount > 0 &&
    evidence.negativeNoteCount > 0;

  if (stats.curatedOpsNoteCount > 0 && stats.meaningfulFeedbackCount > 0) {
    return "rich";
  }
  if (hasDenseMultiSourceFeedback) {
    return "rich";
  }
  if (stats.curatedOpsNoteCount > 0) {
    return "moderate";
  }
  if (
    stats.meaningfulFeedbackCount > 0 &&
    evidence.relevantNoteCount >= 2
  ) {
    return "moderate";
  }
  if (hasStructuredSignal(signals)) {
    return "sparse";
  }
  if (evidence.relevantNoteCount > 0) {
    return "sparse";
  }
  return "minimal";
}

function buildRiskPatterns(
  classifications: ClassificationResult[]
): string[] {
  const normalizedTextByRawId = new Map<string, string>();
  const riskItems = classifications.filter((item) => {
    const { family, owner, polarity } = item.classified;
    if (!isBehavioralJudgmentRelevant(item.raw, item.classified)) return false;
    if (owner !== "instructor" || polarity !== "negative") return false;
    if (family === "data_gap" || family === "commercial_constraint") return false;
    if (family === "environment_issue" && owner !== "instructor") return false;
    normalizedTextByRawId.set(
      item.raw.id,
      normalizeKeywordText(item.raw.raw_text)
    );
    return true;
  });

  const patterns: string[] = [];
  const pushPattern = (label: string): void => {
    if (!patterns.includes(label)) {
      patterns.push(label);
    }
  };
  const hasKeyword = (text: string, keywords: string[]): boolean =>
    keywords.some((keyword) => includesKeyword(text, keyword));
  const countEvidence = (
    predicate: (item: ClassificationResult, normalizedText: string) => boolean
  ): number => {
    const keys = new Set<string>();
    for (const item of riskItems) {
      const normalizedText =
        normalizedTextByRawId.get(item.raw.id) ??
        normalizeKeywordText(item.raw.raw_text);
      if (!predicate(item, normalizedText)) continue;
      keys.add(getOperationalEvidenceBundleKey(item.raw));
    }
    return keys.size;
  };

  if (
    countEvidence(
      (item, text) =>
        item.classified.family === "responsiveness_or_schedule" &&
        hasKeyword(text, [
          "fgi",
          "긴급 일정",
          "급한 일정",
          "비정기 요청",
          "급한 요청",
          "응답 지연",
          "회신 지연",
          "연락 지연",
        ])
    ) >= 2
  ) {
    pushPattern("비정기 요청(FGI, 긴급 일정)에 대한 응답 지연");
  }

  if (
    countEvidence(
      (item, text) =>
        item.classified.family === "delivery_quality" &&
        hasKeyword(text, [
          "속도",
          "빠르",
          "따라가기 어려움",
          "어려움",
          "난이도",
          "눈높이",
        ])
    ) >= 2
  ) {
    pushPattern("강의 난이도·속도 조절에 대한 보완 필요");
  }

  const fallbackLabels = new Map<OperationalNoteFamily, string>([
    ["delivery_quality", "강의 전달력과 학습자 이해도 점검 보완 필요"],
    ["material_delivery", "교안·실습 자료 전달 타이밍 관리 보완 필요"],
    ["curriculum_compliance", "시간 배분과 커리큘럼 마무리 완성도 보완 필요"],
    ["responsiveness_or_schedule", "일정 조율과 응답 속도 관리 보완 필요"],
    ["environment_issue", "환경 이슈 발생 시 사전 점검과 운영 안내 보완 필요"],
  ]);

  for (const [family, label] of fallbackLabels.entries()) {
    const evidenceCount = countEvidence(
      (item) => item.classified.family === family
    );
    if (evidenceCount >= 2) {
      pushPattern(label);
    }
  }

  return patterns;
}

function buildStrengthPatterns(classifications: ClassificationResult[]): string[] {
  const patterns: string[] = [];
  const normalizedTextByRawId = new Map<string, string>();
  const strengthItems = classifications.filter((item) => {
    if (!isBehavioralJudgmentRelevant(item.raw, item.classified)) return false;
    if (
      item.classified.owner !== "instructor" ||
      !["positive", "mixed"].includes(item.classified.polarity)
    ) {
      return false;
    }
    normalizedTextByRawId.set(
      item.raw.id,
      normalizeKeywordText(item.raw.raw_text)
    );
    return true;
  });
  const grouped = new Map<OperationalNoteFamily, ClassificationResult[]>();

  for (const item of strengthItems) {
    const list = grouped.get(item.classified.family) ?? [];
    list.push(item);
    grouped.set(item.classified.family, list);
  }

  const pushPattern = (label: string): void => {
    if (!patterns.includes(label)) {
      patterns.push(label);
    }
  };
  const hasKeyword = (text: string, keywords: string[]): boolean =>
    keywords.some((keyword) => includesKeyword(text, keyword));
  const countEvidence = (
    predicate: (item: ClassificationResult, normalizedText: string) => boolean
  ): number => {
    const keys = new Set<string>();
    for (const item of strengthItems) {
      const normalizedText =
        normalizedTextByRawId.get(item.raw.id) ??
        normalizeKeywordText(item.raw.raw_text);
      if (!predicate(item, normalizedText)) continue;
      keys.add(getOperationalEvidenceBundleKey(item.raw));
    }
    return keys.size;
  };

  if (
    countEvidence(
      (_item, text) =>
        hasKeyword(text, [
          "재요청",
          "재요청 의견",
          "만족도 상승",
          "합격률",
          "합격자 비율",
        ])
    ) >= 2
  ) {
    pushPattern("반복 회차에서 만족도 상승과 재요청 반응이 함께 확인됨");
  }

  if (
    countEvidence(
      (_item, text) =>
        hasKeyword(text, ["장애", "오류", "계정", "환경 이슈", "재접속"]) &&
        hasKeyword(text, ["침착", "대체", "대응", "대처", "우회", "신속", "유연"])
    ) >= 2
  ) {
    pushPattern("기술 장애 발생 시 침착 대체 운영");
  }

  if (
    countEvidence(
      (_item, text) =>
        hasKeyword(text, [
          "비전공자",
          "고연령",
          "눈높이",
          "쉽게",
          "초보",
          "입문",
          "공감",
          "이해하기 쉬",
          "연령대",
        ])
    ) >= 2
  ) {
    pushPattern("비전공자·고연령층 공감대 형성");
  }

  const fallbackLabels = new Map<OperationalNoteFamily, string>([
    ["delivery_quality", "수강생 눈높이에 맞춘 설명과 몰입도 높은 진행"],
    ["curriculum_compliance", "실습 중심 커리큘럼과 시간 운영 완성도 높음"],
    ["material_delivery", "교안·실습 자료 준비와 전달이 안정적"],
  ]);

  for (const [family, items] of grouped.entries()) {
    const uniqueBundles = new Set(
      items.map((item) => getOperationalEvidenceBundleKey(item.raw))
    );
    const label = fallbackLabels.get(family);
    if (label && uniqueBundles.size >= 2) {
      pushPattern(label);
    }
  }

  return patterns;
}

export function deriveBehavioralPatternLists(args: {
  rawNotes: RawOperationalNote[];
  classifiedNotes: ClassifiedOperationalNote[];
  signals: {
    satisfactionAvg: number | null;
    satisfactionCount: number;
    slackActivityCount: number;
    totalCourses: number;
    recentCourses6mo: number;
  };
}): {
  riskPatterns: string[];
  strengthPatterns: string[];
} {
  const classifications = args.rawNotes.map((raw) => ({
    raw,
    classified:
      args.classifiedNotes.find((item) => item.raw_note_id === raw.id) ?? {
        raw_note_id: raw.id,
        family: "unknown" as const,
        owner: "unknown" as const,
        polarity: "neutral" as const,
        auto_confidence: "low" as const,
        needs_followup: false,
        why_flagged: "missing_classification",
      },
  }));

  return {
    riskPatterns: buildRiskPatterns(classifications),
    strengthPatterns: buildStrengthPatterns(classifications),
  };
}

function normalizeLegacyPatternLabel(
  pattern: string,
  kind: "risk" | "strength"
): string {
  const normalized = normalizeText(pattern);
  if (!normalized) return normalized;

  if (kind === "risk") {
    if (/^delivery_quality 반복 근거 \d+건$/i.test(normalized)) {
      return "강의 전달력과 학습자 이해도 점검 보완 필요";
    }
    if (/^material_delivery 반복 근거 \d+건$/i.test(normalized)) {
      return "교안·실습 자료 전달 타이밍 관리 보완 필요";
    }
    if (/^curriculum_compliance 반복 근거 \d+건$/i.test(normalized)) {
      return "시간 배분과 커리큘럼 마무리 완성도 보완 필요";
    }
    if (/^responsiveness_or_schedule 반복 근거 \d+건$/i.test(normalized)) {
      return "일정 조율과 응답 속도 관리 보완 필요";
    }
    if (/^environment_issue 반복 근거 \d+건$/i.test(normalized)) {
      return "환경 이슈 발생 시 사전 점검과 운영 안내 보완 필요";
    }
    return normalized;
  }

  if (/^delivery_quality positive 근거 \d+건$/i.test(normalized)) {
    return "수강생 눈높이에 맞춘 설명과 몰입도 높은 진행";
  }
  if (/^positive_signal positive 근거 \d+건$/i.test(normalized)) {
    return "";
  }
  if (/^curriculum_compliance positive 근거 \d+건$/i.test(normalized)) {
    return "실습 중심 커리큘럼과 시간 운영 완성도 높음";
  }
  if (/^material_delivery positive 근거 \d+건$/i.test(normalized)) {
    return "교안·실습 자료 준비와 전달이 안정적";
  }
  if (/^만족도 평균 [\d.]+ 이상 근거 확인$/i.test(normalized)) {
    return "";
  }
  if (
    /^출강 이력 \d+건 이상$/i.test(normalized) ||
    /^최근 6개월 출강 \d+건 이상$/i.test(normalized) ||
    normalized === "다수 회차 운영 경험으로 현장 적응력이 높음" ||
    normalized === "최근에도 출강이 꾸준해 운영 감각이 유지됨" ||
    normalized === "다수 회차 출강 이력이 확인됨" ||
    normalized === "최근 6개월에도 반복 출강 이력이 확인됨"
  ) {
    return "";
  }

  return normalized;
}

export function normalizeOperationalPatternLabels(
  patterns: string[],
  kind: "risk" | "strength"
): string[] {
  return Array.from(
    new Set(
      patterns
        .map((pattern) => normalizeLegacyPatternLabel(pattern, kind))
        .filter((pattern) => Boolean(pattern))
    )
  );
}

function buildConfidence(
  dataRichness: OperationalDataRichness,
  humanFollowups: HumanFollowup[],
  riskPatterns: string[],
  strengthPatterns: string[]
): OperationalNoteConfidence {
  const hasPatternEvidence = riskPatterns.length > 0 || strengthPatterns.length > 0;
  if (
    (dataRichness === "rich" || dataRichness === "moderate") &&
    humanFollowups.length === 0 &&
    hasPatternEvidence
  ) {
    return "medium";
  }
  return "low";
}

function describeEvidenceProfile(profile: EvidenceProfile): string {
  const parts: string[] = [];

  if (profile.relevantNoteCount > 0) {
    parts.push(`운영 note ${profile.relevantNoteCount}건`);
  }

  if (profile.notionCommentCount > 0) {
    parts.push(`노션 comment ${profile.notionCommentCount}건`);
  }

  if (profile.relevantSourceCount > 0) {
    parts.push(`근거 source ${profile.relevantSourceCount}개`);
  }

  if (profile.negativeNoteCount > 0) {
    parts.push(`부정 신호 ${profile.negativeNoteCount}건`);
  }

  if (profile.positiveNoteCount > 0) {
    parts.push(`긍정 신호 ${profile.positiveNoteCount}건`);
  }

  return parts.join(", ");
}

function describeStructuredSignalEvidence(
  signals?: StructuredSignals | null,
  strengthPatterns: string[] = []
): string {
  if (signals) {
    const parts: string[] = [];

    if (signals.satisfactionAvg !== null) {
      const formattedAverage = Number.isInteger(signals.satisfactionAvg)
        ? signals.satisfactionAvg.toString()
        : signals.satisfactionAvg.toFixed(1);
      const countSuffix =
        signals.satisfactionCount > 0 ? ` (${signals.satisfactionCount}건)` : "";
      parts.push(`만족도 ${formattedAverage}${countSuffix}`);
    }

    if (signals.slackActivityCount >= 3) {
      parts.push(`슬랙 활동 ${signals.slackActivityCount}건`);
    }

    if (signals.totalCourses >= 5) {
      parts.push(`출강 이력 ${signals.totalCourses}건`);
    }

    if (parts.length > 0) {
      return parts.join(", ");
    }
  }

  const storedStructuredPatterns = strengthPatterns.filter(
    (pattern) =>
      pattern.includes("만족도") ||
      pattern.includes("출강") ||
      pattern.includes("회차") ||
      pattern.includes("운영 경험") ||
      pattern.includes("최근")
  );

  if (storedStructuredPatterns.length > 0) {
    return storedStructuredPatterns.slice(0, 2).join(", ");
  }

  return "만족도/출강/활동 같은 구조화 신호";
}

function buildDataRichnessReason(
  dataRichness: OperationalDataRichness,
  stats: Pick<
    GeneratorStats,
    "curatedOpsNoteCount" | "meaningfulFeedbackCount"
  >,
  options?: {
    signals?: StructuredSignals | null;
    strengthPatterns?: string[];
    evidenceProfile?: EvidenceProfile;
  }
): string {
  const structuredEvidence = describeStructuredSignalEvidence(
    options?.signals,
    options?.strengthPatterns ?? []
  );
  const noteEvidence = describeEvidenceProfile(
    options?.evidenceProfile ?? {
      relevantNoteCount: 0,
      relevantSourceCount: 0,
      notionCommentCount: 0,
      negativeNoteCount: 0,
      positiveNoteCount: 0,
    }
  );

  if (dataRichness === "rich") {
    if (stats.curatedOpsNoteCount === 0) {
      const profile = options?.evidenceProfile ?? {
        relevantNoteCount: 0,
        relevantSourceCount: 0,
        notionCommentCount: 0,
        negativeNoteCount: 0,
        positiveNoteCount: 0,
      };
      return `의미 있는 피드백 ${stats.meaningfulFeedbackCount}건과 근거 source ${profile.relevantSourceCount}개에서 긍정/주의 패턴이 함께 확인돼 rich로 분류했습니다.`;
    }
    return `큐레이션 운영 메모 ${stats.curatedOpsNoteCount}건과 의미 있는 피드백 ${stats.meaningfulFeedbackCount}건이 함께 있어 rich로 분류했습니다.`;
  }

  if (dataRichness === "moderate") {
    if (stats.curatedOpsNoteCount > 0) {
      return "큐레이션 운영 메모가 있어 moderate로 분류했습니다.";
    }

    if (stats.meaningfulFeedbackCount > 0 && noteEvidence) {
      return "정성 운영 근거가 확인돼 moderate로 분류했습니다.";
    }

    return "운영 근거는 있으나 밀도가 제한적이라 moderate로 분류했습니다.";
  }

  if (dataRichness === "sparse") {
    if (noteEvidence) {
      return "정성 운영 근거는 있으나 밀도가 제한적이라 sparse로 분류했습니다.";
    }
    return `큐레이션 운영 메모는 없고, ${structuredEvidence}만 확인돼 sparse로 분류했습니다.`;
  }

  if (stats.meaningfulFeedbackCount > 0) {
    return `의미 있는 피드백 ${stats.meaningfulFeedbackCount}건은 있지만, 큐레이션 운영 메모와 구조화 신호가 부족해 minimal로 분류했습니다.`;
  }

  if (noteEvidence) {
    return `구조화 신호는 약하지만 ${noteEvidence} 확인되어 minimal로 분류했습니다.`;
  }

  return "큐레이션 운영 메모와 구조화 신호가 거의 없어 minimal로 분류했습니다.";
}

function buildConfidenceReason(
  dataRichness: OperationalDataRichness,
  confidence: OperationalNoteConfidence,
  humanFollowups: HumanFollowup[],
  riskPatterns: string[],
  strengthPatterns: string[],
  evidenceProfile?: EvidenceProfile
): string {
  const patternEvidenceCount = riskPatterns.length + strengthPatterns.length;
  const noteEvidence = describeEvidenceProfile(
    evidenceProfile ?? {
      relevantNoteCount: 0,
      relevantSourceCount: 0,
      notionCommentCount: 0,
      negativeNoteCount: 0,
      positiveNoteCount: 0,
    }
  );

  if (confidence === "medium") {
    return `근거 밀도가 ${dataRichness}이고 ${noteEvidence || "운영 note 근거"}를 바탕으로 사람 검토가 필요한 followup이 없고 반복 패턴 근거 ${patternEvidenceCount}건이 있어 confidence를 medium으로 올렸습니다.`;
  }

  const blockers: string[] = [];

  if (dataRichness === "sparse" || dataRichness === "minimal") {
    blockers.push(`근거 밀도가 ${dataRichness}`);
  }

  if (humanFollowups.length > 0) {
    blockers.push(`사람 검토가 필요한 followup ${humanFollowups.length}건`);
  }

  if (patternEvidenceCount === 0) {
    blockers.push("반복적으로 확인된 risk/strength 패턴이 부족");
  }

  if (noteEvidence) {
    blockers.unshift(noteEvidence);
  }

  if (blockers.length === 0) {
    blockers.push("medium으로 올릴 조건을 모두 충족하지 못함");
  }

  return `confidence를 low로 유지했습니다. 사유: ${blockers.join(", ")}.`;
}

function buildKeyQuestionForHumans(
  humanFollowups: HumanFollowup[]
): string | null {
  if (humanFollowups.length === 0) return null;
  const themeBuckets = new Map<
    string,
    { label: string; examples: string[]; count: number }
  >();

  const themeRules: Array<{ key: string; label: string; keywords: string[] }> = [
    {
      key: "hands_on_curriculum",
      label: "실습 위주의 커리큘럼",
      keywords: ["실습", "예제", "직접", "따라", "hands-on"],
    },
    {
      key: "delivery_preparation",
      label: "강사의 전문성 및 준비성",
      keywords: ["전달력", "설명", "전문성", "준비", "교재", "자료", "몰입도"],
    },
    {
      key: "difficulty_pacing",
      label: "강의 난이도와 속도",
      keywords: ["어려", "난이도", "속도", "빠르", "천천히", "짧", "시간 부족"],
    },
    {
      key: "ops_environment",
      label: "운영 및 수강 환경",
      keywords: ["환경", "네트워크", "장비", "화면", "zoom", "계정", "재접속"],
    },
    {
      key: "curriculum_fit",
      label: "커리큘럼 적합성",
      keywords: ["커리큘럼", "현업 적용", "실무", "인사이트", "기대했던 것"],
    },
  ];

  const getTheme = (text: string): { key: string; label: string } => {
    const normalized = normalizeKeywordText(text);
    for (const rule of themeRules) {
      if (rule.keywords.some((keyword) => normalized.includes(keyword))) {
        return { key: rule.key, label: rule.label };
      }
    }
    return { key: "misc", label: "기타 확인 필요 사항" };
  };

  for (const item of humanFollowups) {
    const normalized = normalizeText(item.raw_text);
    if (!normalized) continue;
    const theme = getTheme(normalized);
    const existing = themeBuckets.get(theme.key) ?? {
      label: theme.label,
      examples: [],
      count: 0,
    };
    existing.count += 1;
    if (
      existing.examples.length < 2 &&
      !existing.examples.some(
        (example) => normalizeText(example).toLowerCase() === normalized.toLowerCase()
      )
    ) {
      existing.examples.push(item.raw_text);
    }
    themeBuckets.set(theme.key, existing);
  }

  const topThemes = Array.from(themeBuckets.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 2)
    .map((bucket) => {
      const example =
        bucket.examples[0] ??
        bucket.label;
      return `${bucket.label}: ${example}`;
    });

  if (topThemes.length === 0) return null;

  return `확인 포인트: ${topThemes.join(" / ")}`;
}

function buildEvidenceHash(
  instructor: Instructor,
  payload: OperationalIntelligencePayload
): string {
  const hash = createHash("sha1");
  hash.update(
    JSON.stringify({
      storage_projection_version: STORAGE_PROJECTION_VERSION,
      instructor_id: instructor.id,
      total_courses: instructor.totalCourses,
      recent_courses_6mo: instructor.recentCourses6mo,
      satisfaction_avg: instructor.satisfactionAvg?.toString() ?? null,
      satisfaction_count: instructor.satisfactionCount,
      slack_activity_count: instructor.slackActivityCount,
      raw_operational_notes: payload.raw_operational_notes,
      classified_notes: payload.classified_notes,
      human_followups: payload.human_followups,
      behavioral_intelligence: payload.behavioral_intelligence,
    })
  );
  return hash.digest("hex");
}

async function buildPayloadForInstructor(
  instructor: InstructorWithSignals,
  loadedOpsNotes: OpsNotesLoadResult,
  context: RawNoteBuildContext
): Promise<{
  payload: OperationalIntelligencePayload;
  stats: GeneratorStats;
  usedLlm: boolean;
}> {
  const { rawNotes, stats } = buildRawOperationalNotes(
    instructor,
    loadedOpsNotes,
    context
  );
  const ruleClassifications = rawNotes.map(classifyNote);
  const llmResult = await applyLlmClassificationPatches(ruleClassifications);
  const classifications = llmResult.classifications;
  const humanFollowups = buildHumanFollowups(classifications);
  const evidenceProfile = buildEvidenceProfile(classifications);
  const signals: StructuredSignals = {
    satisfactionAvg:
      instructor.satisfactionAvg !== null
        ? Number(instructor.satisfactionAvg)
        : null,
    satisfactionCount: instructor.satisfactionCount,
    slackActivityCount: instructor.slackActivityCount,
    totalCourses: instructor.totalCourses,
    recentCourses6mo: instructor.recentCourses6mo,
  };
  const dataRichness = selectDataRichness(stats, signals, evidenceProfile);
  const riskPatterns = buildRiskPatterns(classifications);
  const strengthPatterns = buildStrengthPatterns(classifications);
  const confidence = buildConfidence(
    dataRichness,
    humanFollowups,
    riskPatterns,
    strengthPatterns
  );
  const behavioralSummaryResult =
    await summarizeBehavioralIntelligenceFromEvidence({
      rawNotes,
      classifiedNotes: classifications.map((item) => item.classified),
      humanFollowups,
      signals,
      riskPatterns,
      strengthPatterns,
      dataRichness,
      confidence,
    });

  const behavioralIntelligence: BehavioralIntelligence = {
    top_summary: behavioralSummaryResult.summary.top_summary,
    teaching_style: behavioralSummaryResult.summary.teaching_style,
    curriculum_compliance:
      behavioralSummaryResult.summary.curriculum_compliance,
    attitude: behavioralSummaryResult.summary.attitude,
    risk_patterns: behavioralSummaryResult.summary.risk_patterns,
    strength_patterns: behavioralSummaryResult.summary.strength_patterns,
    recommendation: behavioralSummaryResult.summary.recommendation,
    data_richness: dataRichness,
    data_richness_reason: buildDataRichnessReason(dataRichness, stats, {
      signals,
      strengthPatterns: behavioralSummaryResult.summary.strength_patterns,
      evidenceProfile,
    }),
    confidence,
    confidence_reason: buildConfidenceReason(
      dataRichness,
      confidence,
      humanFollowups,
      behavioralSummaryResult.summary.risk_patterns,
      behavioralSummaryResult.summary.strength_patterns,
      evidenceProfile
    ),
    key_question_for_humans:
      behavioralSummaryResult.summary.key_question_for_humans,
    source_refs: behavioralSummaryResult.summary.source_refs,
  };

  return {
    payload: {
      raw_operational_notes: rawNotes,
      classified_notes: classifications.map((item) => item.classified),
      human_followups: humanFollowups,
      behavioral_intelligence: behavioralIntelligence,
    },
    stats: {
      ...stats,
      llmAppliedCount:
        llmResult.llmAppliedCount + (behavioralSummaryResult.usedLlm ? 1 : 0),
    },
    usedLlm: llmResult.usedLlm || behavioralSummaryResult.usedLlm,
  };
}

export async function generateOperationalIntelligence(
  options: GenerateOperationalIntelligenceOptions = {}
): Promise<GenerateOperationalIntelligenceResult> {
  const loadedOpsNotes = resolveOpsNotesLoadResult(options.loadedOpsNotes);
  const instructorWhere = options.instructorIds
    ? { id: { in: options.instructorIds } }
    : undefined;
  const [instructors, satisfactionImports, activitySignals, existingIntelligenceRows] =
    await Promise.all([
      prisma.instructor.findMany({
        where: instructorWhere,
      }),
      prisma.satisfactionImportItem.findMany({
        orderBy: [{ responseDate: "desc" }, { createdAt: "desc" }],
        select: {
          id: true,
          sourceType: true,
          sourceRef: true,
          rawPayload: true,
          normalizedPayload: true,
          candidateName: true,
          candidateCompanyName: true,
          candidateCourseName: true,
          responseDate: true,
          createdAt: true,
        },
      }),
      prisma.activityImportItem.findMany({
        orderBy: [{ activityAt: "desc" }, { createdAt: "desc" }],
        select: {
          id: true,
          sourceType: true,
          matchedInstructorId: true,
          candidateName: true,
          rawPayload: true,
          activityAt: true,
          isOpsReport: true,
          isDispatchRequest: true,
          createdAt: true,
        },
      }),
      prisma.instructorIntelligence.findMany({
        where: options.instructorIds
          ? { instructorDbId: { in: options.instructorIds } }
          : undefined,
        select: {
          instructorDbId: true,
          evidenceHash: true,
          promptVersion: true,
        },
      }),
    ]);
  const context = buildRawNoteBuildContext(
    instructors,
    satisfactionImports,
    activitySignals
  );

  let rawOperationalNotes = 0;
  let humanFollowups = 0;
  let updatedCount = 0;
  const existingByInstructorId = new Map(
    existingIntelligenceRows.map((row) => [row.instructorDbId, row])
  );
  const llmConfig = getOperationalIntelligenceLlmConfig();

  const payloads = await mapWithConcurrency(
    instructors,
    OPERATIONAL_INTELLIGENCE_CONCURRENCY,
    async (instructor) => {
      try {
        const { payload, stats, usedLlm } = await buildPayloadForInstructor(
          instructor,
          loadedOpsNotes,
          context
        );
        const evidenceHash = buildEvidenceHash(instructor, payload);
        return {
          instructor,
          payload,
          stats,
          usedLlm,
          evidenceHash,
        };
      } catch (error) {
        // 강사별 generate 실패가 batch 전체 죽이지 않도록 빈 payload로 진행.
        console.error(
          `[generateOperationalIntelligence] payload build failed for ${instructor.id} (${instructor.name}):`,
          error instanceof Error ? error.message : error
        );
        const payload = createEmptyOperationalIntelligencePayload();
        const evidenceHash = buildEvidenceHash(instructor, payload);
        return {
          instructor,
          payload,
          stats: {
            curatedOpsNoteCount: 0,
            meaningfulFeedbackCount: 0,
            importedFeedbackNoteCount: 0,
            slackHighlightCount: 0,
            llmAppliedCount: 0,
          } as GeneratorStats,
          usedLlm: false,
          evidenceHash,
        };
      }
    }
  );

  rawOperationalNotes = payloads.reduce(
    (sum, entry) => sum + entry.payload.raw_operational_notes.length,
    0
  );
  humanFollowups = payloads.reduce(
    (sum, entry) => sum + entry.payload.human_followups.length,
    0
  );

  const upsertCandidates = payloads.filter((entry) => {
    const existing = existingByInstructorId.get(entry.instructor.id);
    if (!existing) return true;
    if (existing.evidenceHash !== entry.evidenceHash) return true;
    // prompt 업그레이드 시 evidence 변경 없어도 새 prompt_version으로 갱신 필요.
    if (existing.promptVersion !== PROMPT_VERSION) return true;
    return false;
  });

  await mapWithConcurrency(
    upsertCandidates,
    OPERATIONAL_INTELLIGENCE_CONCURRENCY,
    async (entry) => {
      const legacyFields = getLegacyOperationalFields(entry.payload);
      await withPrismaRetry(() =>
        prisma.instructorIntelligence.upsert({
          where: { instructorDbId: entry.instructor.id },
          update: {
            recommendedFor: legacyFields.recommended_for,
            avoidFor: legacyFields.avoid_for,
            riskNotes: entry.payload.behavioral_intelligence.risk_patterns,
            opsCheckNote:
              entry.payload.behavioral_intelligence.key_question_for_humans,
            dataRichness: entry.payload.behavioral_intelligence.data_richness,
            confidence: entry.payload.behavioral_intelligence.confidence,
            sourceSummary: toOperationalJsonObject(entry.payload, entry.stats),
            generatedBy: entry.usedLlm ? "mixed" : "rule_based",
            generationModel: entry.usedLlm ? llmConfig?.model ?? null : null,
            promptVersion: PROMPT_VERSION,
            evidenceHash: entry.evidenceHash,
            generatedAt: new Date(),
          },
          create: {
            instructorDbId: entry.instructor.id,
            recommendedFor: legacyFields.recommended_for,
            avoidFor: legacyFields.avoid_for,
            riskNotes: entry.payload.behavioral_intelligence.risk_patterns,
            opsCheckNote:
              entry.payload.behavioral_intelligence.key_question_for_humans,
            dataRichness: entry.payload.behavioral_intelligence.data_richness,
            confidence: entry.payload.behavioral_intelligence.confidence,
            sourceSummary: toOperationalJsonObject(entry.payload, entry.stats),
            generatedBy: entry.usedLlm ? "mixed" : "rule_based",
            generationModel: entry.usedLlm ? llmConfig?.model ?? null : null,
            promptVersion: PROMPT_VERSION,
            evidenceHash: entry.evidenceHash,
            generatedAt: new Date(),
          },
        })
      );
    }
  );
  updatedCount = upsertCandidates.length;

  return {
    updatedCount,
    sourceCounts: {
      instructors: instructors.length,
      rawOperationalNotes,
      humanFollowups,
    },
  };
}

function asPayloadCandidate(value: unknown): Partial<OperationalIntelligencePayload> {
  const record = asRecord(value);
  const nested = asRecord(record[SOURCE_SUMMARY_KEY]);
  if (nested.behavioral_intelligence !== undefined) {
    return nested as Partial<OperationalIntelligencePayload>;
  }
  if (record.behavioral_intelligence !== undefined) {
    return record as Partial<OperationalIntelligencePayload>;
  }
  return {};
}

function toNonNegativeCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value));
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.trunc(parsed));
    }
  }

  return 0;
}

function extractStoredGeneratorStats(sourceSummary: unknown): GeneratorStats {
  const record = asRecord(sourceSummary);
  const counts = asRecord(record.source_counts);

  return {
    curatedOpsNoteCount: toNonNegativeCount(counts.curated_ops_note_count),
    meaningfulFeedbackCount: toNonNegativeCount(counts.meaningful_feedback_count),
    importedFeedbackNoteCount: toNonNegativeCount(
      counts.imported_feedback_note_count
    ),
    slackHighlightCount: toNonNegativeCount(counts.slack_highlight_count),
    llmAppliedCount: toNonNegativeCount(counts.llm_applied_count),
  };
}

export function extractOperationalIntelligencePayload(
  sourceSummary: unknown
): OperationalIntelligencePayload {
  const candidate = asPayloadCandidate(sourceSummary);
  const stats = extractStoredGeneratorStats(sourceSummary);
  const rawOperationalNotes = Array.isArray(candidate.raw_operational_notes)
    ? (candidate.raw_operational_notes as RawOperationalNote[])
    : [];
  const classifiedNotes = Array.isArray(candidate.classified_notes)
    ? (candidate.classified_notes as ClassifiedOperationalNote[])
    : [];
  const humanFollowups = Array.isArray(candidate.human_followups)
    ? (candidate.human_followups as HumanFollowup[])
    : [];
  const classifications = buildClassificationResults(
    rawOperationalNotes,
    classifiedNotes
  );
  const behavioralIntelligence =
    candidate.behavioral_intelligence &&
    typeof candidate.behavioral_intelligence === "object"
      ? ({
          ...createEmptyBehavioralIntelligence(),
          ...candidate.behavioral_intelligence,
          risk_patterns: normalizeOperationalPatternLabels(
            Array.isArray(candidate.behavioral_intelligence.risk_patterns)
              ? candidate.behavioral_intelligence.risk_patterns
              : [],
            "risk"
          ),
          strength_patterns: normalizeOperationalPatternLabels(
            Array.isArray(candidate.behavioral_intelligence.strength_patterns)
              ? candidate.behavioral_intelligence.strength_patterns
              : [],
            "strength"
          ),
        } as BehavioralIntelligence)
      : createEmptyBehavioralIntelligence();

  const normalizedDataRichnessReason = normalizeText(
    behavioralIntelligence.data_richness_reason
  );
  const normalizedConfidenceReason = normalizeText(
    behavioralIntelligence.confidence_reason
  );

  return {
    raw_operational_notes: rawOperationalNotes,
    classified_notes: classifiedNotes,
    human_followups: humanFollowups,
    behavioral_intelligence: {
      ...behavioralIntelligence,
      ...(() => {
        const evidenceProfile = buildEvidenceProfile(
          classifications
        );
        const summary: BehavioralSummaryFields = {
          top_summary: behavioralIntelligence.top_summary,
          teaching_style: behavioralIntelligence.teaching_style,
          curriculum_compliance: behavioralIntelligence.curriculum_compliance,
          attitude: behavioralIntelligence.attitude,
          risk_patterns: behavioralIntelligence.risk_patterns,
          strength_patterns: behavioralIntelligence.strength_patterns,
          recommendation: behavioralIntelligence.recommendation,
          key_question_for_humans:
            behavioralIntelligence.key_question_for_humans,
          source_refs: createEmptyBehavioralSourceRefs(),
        };
        const sourceRefs = sanitizeBehavioralSourceRefs({
          value: asRecord(candidate.behavioral_intelligence).source_refs,
          summary,
          notes: classifications,
        });
        const alignedSummary = alignBehavioralSummaryWithSourceRefs(
          summary,
          sourceRefs,
          classifications
        );

        return {
          data_richness_reason:
            normalizedDataRichnessReason ||
            buildDataRichnessReason(
              behavioralIntelligence.data_richness,
              {
                curatedOpsNoteCount: stats.curatedOpsNoteCount,
                meaningfulFeedbackCount: stats.meaningfulFeedbackCount,
              },
              {
                strengthPatterns: behavioralIntelligence.strength_patterns,
                evidenceProfile,
              }
            ),
          confidence_reason:
            normalizedConfidenceReason ||
            buildConfidenceReason(
              behavioralIntelligence.data_richness,
              behavioralIntelligence.confidence,
              humanFollowups,
              alignedSummary.risk_patterns,
              alignedSummary.strength_patterns,
              evidenceProfile
            ),
          teaching_style: alignedSummary.teaching_style,
          curriculum_compliance: alignedSummary.curriculum_compliance,
          attitude: alignedSummary.attitude,
          risk_patterns: alignedSummary.risk_patterns,
          strength_patterns: alignedSummary.strength_patterns,
          source_refs: alignedSummary.source_refs,
        };
      })(),
    },
  };
}

export function getLegacyOperationalFields(
  payload: OperationalIntelligencePayload
): {
  recommended_for: string[];
  avoid_for: string[];
  risk_notes: string[];
} {
  return {
    recommended_for: extractOperationalDirectiveLines(
      payload,
      RECOMMEND_DIRECTIVE_KEYWORDS,
      AVOID_DIRECTIVE_KEYWORDS
    ),
    avoid_for: extractOperationalDirectiveLines(
      payload,
      AVOID_DIRECTIVE_KEYWORDS,
      RECOMMEND_DIRECTIVE_KEYWORDS
    ),
    risk_notes: payload.behavioral_intelligence.risk_patterns,
  };
}

function extractOperationalDirectiveLines(
  payload: OperationalIntelligencePayload,
  includePatterns: RegExp[],
  excludePatterns: RegExp[]
): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();

  for (const note of payload.raw_operational_notes) {
    const text = normalizeText(note.raw_text);
    if (!text) continue;
    if (!includePatterns.some((pattern) => pattern.test(text))) continue;
    if (excludePatterns.some((pattern) => pattern.test(text))) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    lines.push(text);
    if (lines.length >= 5) break;
  }

  return lines;
}
