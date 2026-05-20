/**
 * GET /api/instructors/{id} — 05_api_spec.md 6절
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  calculateTeachingHistoryTotalPaid,
  countGroupedTeachingHistories,
  normalizeCompanyKey,
  sumGroupedTeachingHistoryHours,
  dedupeTeachingHistories,
} from "@/lib/teaching-history-display";
import { dedupeFeeHistoryItems } from "@/lib/fee-history-dedupe";
import {
  FALLBACK_LAST_UPDATED_AT,
  getFallbackInstructorDetail,
} from "@/lib/fallback-data";
import { readStoredFallbackSnapshot } from "@/lib/fallback-snapshot";
import { stripGoogleLinks } from "@/lib/google-link-sanitizer";
import { shouldIncludeInInstructorList } from "@/lib/instructor-list-visibility";
import { extractNotionPropertyTextList } from "@/lib/notion-property-utils";
import {
  extractOperationalFeedbackNotesFromImport,
  extractOperationalIntelligencePayload,
  getLegacyOperationalFields,
  normalizeOperationalPatternLabels,
} from "@/lib/operational-intelligence";
import { applyOperationalIntelligenceSuppressions } from "@/lib/operational-intelligence-suppression";
import { enrichMemoFromNotionPage } from "@/lib/notion-enrichment";
import { loadOpsNotesJson } from "@/lib/pipeline/ops-notes-loader";
import type {
  NotionMemoDiagnostics,
  OperationalEvidenceSnapshot,
} from "@/types/api";

function sanitizeTeachingHistoryTextFields<
  T extends {
    fee_extra?: string | null;
    special_notes?: string | null;
  },
>(items: T[]): T[] {
  return items.map((item) => ({
    ...item,
    fee_extra: stripGoogleLinks(item.fee_extra),
    special_notes: stripGoogleLinks(item.special_notes),
  }));
}

type MatchedSatisfactionImportRow = {
  id: string;
  sourceType: string;
  sourceRefKey: string | null;
  candidateName: string | null;
  candidateCompanyName: string | null;
  candidateCourseName: string | null;
  scoreNormalized: number | null;
  responseDate: string | null;
  createdAt: Date;
  rawPayload: Record<string, unknown>;
  normalizedPayload: Record<string, unknown>;
};

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function dedupeStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const value of values) {
    const normalized = normalizeText(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(normalized);
  }

  return deduped;
}

function normalizeOperationalDataRichness(
  value: string | null | undefined
): "rich" | "moderate" | "sparse" | "minimal" | null {
  switch (value) {
    case "rich":
    case "moderate":
    case "sparse":
    case "minimal":
      return value;
    default:
      return null;
  }
}

function normalizeOperationalConfidence(
  value: string | null | undefined
): "high" | "medium" | "low" | null {
  switch (value) {
    case "high":
    case "medium":
    case "low":
      return value;
    default:
      return null;
  }
}

function getRecentSatisfactionCutoffDate(now = new Date()): string {
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - 6);
  return cutoff.toISOString().slice(0, 10);
}

function getRecordString(
  record: Record<string, unknown>,
  keys: string[]
): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && normalizeText(value)) {
      return normalizeText(value);
    }
  }
  return null;
}

function countOperationalFeedbackNotes(
  row: Pick<MatchedSatisfactionImportRow, "sourceType" | "rawPayload">
): number {
  return extractOperationalFeedbackNotesFromImport({
    sourceType: row.sourceType,
    rawPayload: row.rawPayload,
  }).length;
}

function matchesTeachingContext(
  row: MatchedSatisfactionImportRow,
  teachingCompanies: Set<string>,
  teachingCourses: Set<string>
): boolean {
  const companyName =
    normalizeText(row.candidateCompanyName) ||
    normalizeText(
      getRecordString(row.normalizedPayload, ["company_name", "companyName"])
    );
  const courseName =
    normalizeText(row.candidateCourseName) ||
    normalizeText(
      getRecordString(row.normalizedPayload, ["course_name", "courseName"])
    );

  const companyMatch = companyName ? teachingCompanies.has(companyName) : false;
  const courseMatch = courseName
    ? Array.from(teachingCourses).some(
        (value) => value === courseName || value.includes(courseName) || courseName.includes(value)
      )
    : false;

  return companyMatch && courseMatch;
}

function matchesInstructorImportRow(args: {
  row: MatchedSatisfactionImportRow;
  instructorId: string;
  instructorName: string;
}): boolean {
  const suggestedInstructorId = getRecordString(args.row.normalizedPayload, [
    "suggested_instructor_id",
    "suggestedInstructorId",
    "resolved_instructor_id",
    "instructor_id",
  ]);
  if (suggestedInstructorId === args.instructorId) return true;

  const normalizedInstructorName = normalizeText(args.instructorName);
  const candidateNames = [
    args.row.candidateName,
    getRecordString(args.row.normalizedPayload, [
      "instructor_name",
      "instructorName",
    ]),
  ];

  return candidateNames.some(
    (name) => normalizeText(name) === normalizedInstructorName
  );
}

function buildFeedbackEvidenceSnapshot(args: {
  source: OperationalEvidenceSnapshot["source"];
  title: string;
  rows: MatchedSatisfactionImportRow[];
  instructorId: string;
  instructorName: string;
  teachingCompanies: Set<string>;
  teachingCourses: Set<string>;
}): OperationalEvidenceSnapshot {
  const matchedRows = args.rows.filter((row) =>
    matchesInstructorImportRow({
      row,
      instructorId: args.instructorId,
      instructorName: args.instructorName,
    })
  );
  const matchedFeedbackRows = matchedRows.filter(
    (row) => countOperationalFeedbackNotes(row) > 0
  );
  const possiblyUnmappedRows = args.rows.filter((row) => {
    const suggestedInstructorId = getRecordString(row.normalizedPayload, [
      "suggested_instructor_id",
      "suggestedInstructorId",
      "resolved_instructor_id",
      "instructor_id",
    ]);
    if (suggestedInstructorId) return false;
    if (normalizeText(row.candidateName)) return false;
    if (countOperationalFeedbackNotes(row) === 0) return false;
    return matchesTeachingContext(
      row,
      args.teachingCompanies,
      args.teachingCourses
    );
  });

  const examples: OperationalEvidenceSnapshot["examples"] = [];

  for (const row of matchedFeedbackRows.slice(0, 2)) {
    const notes = extractOperationalFeedbackNotesFromImport(row);
    for (const note of notes.slice(0, 2)) {
      examples.push({
        kind: "matched_feedback",
        text: note.text,
        source_type: row.sourceType,
      });
      if (examples.length >= 4) break;
    }
    if (examples.length >= 4) break;
  }

  if (examples.length < 4) {
    for (const row of possiblyUnmappedRows.slice(0, 2)) {
      const notes = extractOperationalFeedbackNotesFromImport(row);
      for (const note of notes.slice(0, 2)) {
        examples.push({
          kind: "unmapped_feedback",
          text: note.text,
          source_type: row.sourceType,
        });
        if (examples.length >= 4) break;
      }
      if (examples.length >= 4) break;
    }
  }

  let note: string | null = null;
  if (matchedRows.length > 0 && matchedFeedbackRows.length === 0) {
    note = "연결된 row는 있지만 자유서술/특이사항은 비어 있습니다.";
  } else if (matchedRows.length === 0 && possiblyUnmappedRows.length > 0) {
    note = "강의 이력상 관련 있어 보이는 정성 피드백이 있지만 현재 강사 매핑은 없습니다.";
  } else if (args.rows.length === 0) {
    note = "이 소스 자체의 수집 row가 없습니다.";
  }

  return {
    source: args.source,
    title: args.title,
    total_item_count: args.rows.length,
    matched_item_count: matchedRows.length,
    matched_feedback_item_count: matchedFeedbackRows.length,
    unmapped_feedback_item_count: possiblyUnmappedRows.length,
    examples,
    note,
  };
}

function buildRecentSatisfactionHistory(args: {
  rows: Array<{
    observedAt: string | null;
    companyName: string | null;
    courseName: string | null;
    score: number;
    respondentCount?: number;
    sourceType?: string;
    sourceKey?: string | null;
    resolutionLevel?: string | null;
    resolutionBasis?: string | null;
    sessionLabel?: string | null;
    registryKey?: string | null;
  }>;
}): Array<{
  observed_at: string | null;
  company_name: string | null;
  course_name: string | null;
  session_label: string | null;
  score: number;
  respondent_count: number;
  source_type: string | null;
  source_key: string | null;
  resolution_level: string | null;
  resolution_basis: string | null;
  registry_key: string | null;
}> {
  // P0-5: summary와 동일 row set 사용. 모든 record 1:1 노출 (dedupe 안 함 — 평균 근거 추적).
  return args.rows
    .filter((row) => row.observedAt !== null)
    .map((row) => ({
      observed_at: row.observedAt,
      company_name: row.companyName,
      course_name: row.courseName,
      session_label: row.sessionLabel ?? null,
      score: row.score,
      respondent_count: row.respondentCount ?? 1,
      source_type: row.sourceType ?? null,
      source_key: row.sourceKey ?? null,
      resolution_level: row.resolutionLevel ?? null,
      resolution_basis: row.resolutionBasis ?? null,
      registry_key: row.registryKey ?? null,
    }))
    .sort((a, b) => (b.observed_at ?? "").localeCompare(a.observed_at ?? ""));
}

function buildOperationalEvidenceSnapshots(args: {
  instructorId: string;
  instructorName: string;
  teachingCompanies: Set<string>;
  teachingCourses: Set<string>;
  satisfactionImportRows: MatchedSatisfactionImportRow[];
}): OperationalEvidenceSnapshot[] {
  const sheetRows = args.satisfactionImportRows.filter((row) =>
    ["sheet_summary", "google_forms"].includes(row.sourceType)
  );
  const gmailRows = args.satisfactionImportRows.filter(
    (row) => row.sourceType === "gmail_summary"
  );

  let curatedOpsSnapshot: OperationalEvidenceSnapshot;
  try {
    const loadedOpsNotes = loadOpsNotesJson();
    const matchedEntries = loadedOpsNotes.acceptedEntries.filter(
      (entry) => normalizeText(entry.name) === normalizeText(args.instructorName)
    );
    curatedOpsSnapshot = {
      source: "curated_ops",
      title: "Curated Ops",
      total_item_count: loadedOpsNotes.acceptedEntries.length,
      matched_item_count: matchedEntries.length,
      matched_feedback_item_count: matchedEntries.length,
      unmapped_feedback_item_count: 0,
      examples: matchedEntries.slice(0, 3).map((entry) => ({
        kind: "curated_note" as const,
        text: entry.memo,
        source_type: "curated_ops",
      })),
      note:
        loadedOpsNotes.totalEntries === 0
          ? "입력 파일이 비어 있습니다."
          : matchedEntries.length === 0
            ? "현재 강사에 연결된 curated ops note는 없습니다."
            : null,
    };
  } catch {
    curatedOpsSnapshot = {
      source: "curated_ops",
      title: "Curated Ops",
      total_item_count: 0,
      matched_item_count: 0,
      matched_feedback_item_count: 0,
      unmapped_feedback_item_count: 0,
      examples: [],
      note: "입력 파일을 읽지 못했습니다.",
    };
  }

  return [
    curatedOpsSnapshot,
    buildFeedbackEvidenceSnapshot({
      source: "sheet_feedback",
      title: "강의관리 시트",
      rows: sheetRows,
      instructorId: args.instructorId,
      instructorName: args.instructorName,
      teachingCompanies: args.teachingCompanies,
      teachingCourses: args.teachingCourses,
    }),
    buildFeedbackEvidenceSnapshot({
      source: "gmail_feedback",
      title: "Gmail 만족도",
      rows: gmailRows,
      instructorId: args.instructorId,
      instructorName: args.instructorName,
      teachingCompanies: args.teachingCompanies,
      teachingCourses: args.teachingCourses,
    }),
  ];
}

function buildInstructorNotFoundResponse(args: {
  requestId: string;
  dataMode: "live" | "stored" | "fallback";
  isFallback: boolean;
}) {
  return NextResponse.json(
    {
      status: "error",
      meta: {
        request_id: args.requestId,
        data_mode: args.dataMode,
        is_fallback: args.isFallback,
      },
      errors: [
        {
          code: "INSTRUCTOR_NOT_FOUND",
          message: "강사 정보를 찾을 수 없습니다.",
        },
      ],
    },
    { status: 404 }
  );
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const requestId = `req_${crypto.randomUUID()}`;
  const searchParams = new URL(request.url).searchParams;
  const requestedLimit = Number.parseInt(
    searchParams.get("teaching_history_limit") ?? "30",
    10
  );
  const teachingHistoryLimit =
    Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, 300)
      : 30;
  // Step 5 lazy load: include_oi=0 시 응답에서 운영 인텔 필드 모두 빈 값으로 클리어.
  // 진짜 비용 절감을 위해 라인 580 부근 Notion enrich도 skip + satisfactionImportRows fetch skip.
  // (build 자체는 그대로 두되 응답 단계에서만 클리어할 수도 있지만,
  //  여기서는 Notion enrich와 satisfaction fetch를 skip해 main 응답을 가볍게.)
  const includeOperationalIntelligence =
    searchParams.get("include_oi") !== "0";

  try {
    const inst = await prisma.instructor.findUnique({
      where: { id },
      include: {
        teachingHistories: {
          orderBy: [{ startDate: "desc" }, { createdAt: "desc" }],
        },
        // T8: fee_histories — effectiveDate desc, createdAt desc
        feeHistories: {
          orderBy: [
            { effectiveDate: "desc" },
            { createdAt: "desc" },
          ],
        },
        instructorIntelligence: true,
        sourceLinks: true,
      },
    });

    if (!inst || !shouldIncludeInInstructorList(inst)) {
      // 6-6: 404 INSTRUCTOR_NOT_FOUND
      return buildInstructorNotFoundResponse({
        requestId,
        dataMode: "live",
        isFallback: false,
      });
    }

    // 6-4: 전임강사 규칙
    const isFulltime = inst.isFulltime;
    const today = new Date().toISOString().split("T")[0];
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setUTCMonth(sixMonthsAgo.getUTCMonth() - 6);

    const teachingHistoryAllRaw = inst.teachingHistories.map((h) => ({
      id: h.id,
      company_name: h.companyName,
      course_name: h.courseName,
      course_id: h.courseId,
      start_date: h.startDate?.toISOString().split("T")[0] ?? null,
      end_date: h.endDate?.toISOString().split("T")[0] ?? null,
      date_label: h.dateLabel,
      deal_fee_hourly: h.dealFeeHourly,
      fee_extra: h.feeExtra,
      total_hours: h.totalHours !== null ? Number(h.totalHours) : null,
      total_sessions: h.totalSessions,
      contract_type: h.contractType,
      detail_type: h.detailType,
      special_notes: h.specialNotes,
      source_type: h.sourceType,
    }));

    // NULL 보강: 같은 course_id의 다른 행에서 회사/과정명/단가 추출해 채움.
    // 단가 칩 매칭(textmatch)이 회사/과정명 substring을 사용하므로 NULL이면 매칭 자체 불가.
    // 단가도 NULL이면 amount+date 폴백, fee_history 매칭 폴백 모두 작동 안 함 → 단가 칩 누락.
    const courseIdLookup = new Map<
      string,
      { company: string | null; course: string | null; fee: number | null }
    >();
    for (const h of teachingHistoryAllRaw) {
      if (!h.course_id) continue;
      const existing = courseIdLookup.get(h.course_id);
      const company = h.company_name ?? existing?.company ?? null;
      const course = h.course_name ?? existing?.course ?? null;
      const fee =
        (typeof h.deal_fee_hourly === "number" ? h.deal_fee_hourly : null) ??
        existing?.fee ??
        null;
      courseIdLookup.set(h.course_id, { company, course, fee });
    }
    const teachingHistoryAll = teachingHistoryAllRaw.map((h) => {
      if (!h.course_id) return h;
      const hasAll =
        h.company_name &&
        h.course_name &&
        typeof h.deal_fee_hourly === "number";
      if (hasAll) return h;
      const same = courseIdLookup.get(h.course_id);
      if (!same) return h;
      return {
        ...h,
        company_name: h.company_name ?? same.company,
        course_name: h.course_name ?? same.course,
        deal_fee_hourly:
          typeof h.deal_fee_hourly === "number" ? h.deal_fee_hourly : same.fee,
      };
    });

    const totalPaid = calculateTeachingHistoryTotalPaid(teachingHistoryAll, {
      fromDate: "2025-01-01",
      untilDate: today,
    });

    const teachingHistory = dedupeTeachingHistories(teachingHistoryAll, {
      fromDate: "2025-01-01",
      untilDate: today,
    });
    const feeHistory = dedupeFeeHistoryItems(inst.feeHistories);
    const teachingHistoryVisible = teachingHistory.slice(0, teachingHistoryLimit);
    const sanitizedTeachingHistoryVisible =
      sanitizeTeachingHistoryTextFields(teachingHistoryVisible);
    const teachingHistoryRemainingCount = Math.max(
      0,
      teachingHistory.length - teachingHistoryVisible.length
    );

    const totalCourses = countGroupedTeachingHistories(teachingHistory, {
      fromDate: "2025-01-01",
      untilDate: today,
    });
    const totalHours = sumGroupedTeachingHistoryHours(teachingHistory, {
      fromDate: "2025-01-01",
      untilDate: today,
    });
    const recentCourses6mo = countGroupedTeachingHistories(teachingHistory, {
      fromDate: sixMonthsAgo.toISOString().split("T")[0],
      untilDate: today,
    });
    let memoRaw = inst.memoRaw;
    let notionPageBodyRaw: string | null = inst.notionPageBodyRaw ?? null;
    const notionMemoDiagnostics: NotionMemoDiagnostics = {
      source_linked: Boolean(
        inst.sourceLinks.find((item) => item.sourceType === "notion" && item.externalKey)
      ),
      notion_page_id: null,
      enrichment_attempted: false,
      enrichment_updated: false,
      comment_capability: "unknown",
      page_comment_count: 0,
      block_comment_count: 0,
      block_text_count: 0,
      incoming_line_count: 0,
      page_body_updated: false,
      page_title_line_count: 0,
      block_text_line_count: 0,
      error_message: null,
    };
    const notionSourceLink = inst.sourceLinks.find(
      (item) => item.sourceType === "notion" && item.externalKey
    );
    if (notionSourceLink?.externalKey) {
      notionMemoDiagnostics.notion_page_id = notionSourceLink.externalKey;
    }
    const shouldAttemptNotionEnrichment =
      includeOperationalIntelligence &&
      Boolean(notionSourceLink?.externalKey) &&
      (searchParams.get("include_notion_enrichment") === "1" || !memoRaw);

    if (notionSourceLink?.externalKey && shouldAttemptNotionEnrichment) {
      notionMemoDiagnostics.enrichment_attempted = true;
      try {
        const enriched = await enrichMemoFromNotionPage({
          existingMemo: memoRaw,
          notionPageId: notionSourceLink.externalKey,
        });
        notionMemoDiagnostics.enrichment_updated = enriched.updated;
        notionMemoDiagnostics.comment_capability = enriched.commentCapability;
        notionMemoDiagnostics.page_comment_count = enriched.pageCommentCount;
        notionMemoDiagnostics.block_comment_count = enriched.blockCommentCount;
        notionMemoDiagnostics.block_text_count = enriched.blockTextCount;
        notionMemoDiagnostics.incoming_line_count = enriched.incomingLineCount;
        notionMemoDiagnostics.page_title_line_count = enriched.pageTitleLineCount;
        notionMemoDiagnostics.block_text_line_count = enriched.blockTextLineCount;

        const memoChanged = enriched.updated;
        const bodyChanged =
          enriched.incomingPageBody !== null &&
          enriched.incomingPageBody !== notionPageBodyRaw;

        if (memoChanged || bodyChanged) {
          await prisma.instructor.update({
            where: { id: inst.id },
            data: {
              ...(memoChanged ? { memoRaw: enriched.mergedMemo } : {}),
              ...(bodyChanged
                ? { notionPageBodyRaw: enriched.incomingPageBody }
                : {}),
            },
          });
          if (memoChanged) memoRaw = enriched.mergedMemo;
          if (bodyChanged) {
            notionPageBodyRaw = enriched.incomingPageBody;
            notionMemoDiagnostics.page_body_updated = true;
          }
        }
      } catch (error) {
        notionMemoDiagnostics.error_message =
          error instanceof Error ? error.message : String(error);
        // 상세 조회 자체는 DB 저장 memoRaw로 계속 응답한다.
      }
    }

    const operationalPayload = extractOperationalIntelligencePayload(
      inst.instructorIntelligence?.sourceSummary
    );
    const legacyOperationalFields =
      getLegacyOperationalFields(operationalPayload);
    const payloadHasBehavioralSignals =
      operationalPayload.raw_operational_notes.length > 0 ||
      operationalPayload.classified_notes.length > 0 ||
      operationalPayload.human_followups.length > 0 ||
      operationalPayload.behavioral_intelligence.risk_patterns.length > 0 ||
      operationalPayload.behavioral_intelligence.strength_patterns.length > 0 ||
      operationalPayload.behavioral_intelligence.recommendation !== null ||
      operationalPayload.behavioral_intelligence.key_question_for_humans !== null ||
      operationalPayload.behavioral_intelligence.teaching_style !== null ||
      operationalPayload.behavioral_intelligence.curriculum_compliance !== null ||
      operationalPayload.behavioral_intelligence.attitude !== null;
    const storedDataRichness = normalizeOperationalDataRichness(
      inst.instructorIntelligence?.dataRichness
    );
    const storedConfidence = normalizeOperationalConfidence(
      inst.instructorIntelligence?.confidence
    );
    const normalizedStoredRiskNotes = normalizeOperationalPatternLabels(
      inst.instructorIntelligence?.riskNotes ?? [],
      "risk"
    );
    const hasSourceBackedRiskPatterns =
      operationalPayload.behavioral_intelligence.source_refs.risk_patterns
        .length > 0;
    const mergedRiskPatterns = hasSourceBackedRiskPatterns
      ? operationalPayload.behavioral_intelligence.risk_patterns
      : dedupeStrings([
          ...operationalPayload.behavioral_intelligence.risk_patterns,
          ...normalizedStoredRiskNotes,
        ]);
    const baseBehavioralIntelligence = {
      ...operationalPayload.behavioral_intelligence,
      risk_patterns: mergedRiskPatterns,
      key_question_for_humans:
        operationalPayload.behavioral_intelligence.key_question_for_humans ??
        inst.instructorIntelligence?.opsCheckNote ??
        null,
      data_richness:
        payloadHasBehavioralSignals
          ? operationalPayload.behavioral_intelligence.data_richness
          : storedDataRichness ??
            operationalPayload.behavioral_intelligence.data_richness,
      confidence:
        payloadHasBehavioralSignals
          ? operationalPayload.behavioral_intelligence.confidence
          : storedConfidence ??
            operationalPayload.behavioral_intelligence.confidence,
    };
    // Step 3-A + 3-C: 단일 source hedging / rule_based fallback 라벨 미노출
    const suppression = applyOperationalIntelligenceSuppressions({
      behavioralIntelligence: baseBehavioralIntelligence,
      rawNotes: operationalPayload.raw_operational_notes,
      generatedBy: inst.instructorIntelligence?.generatedBy ?? null,
    });
    const mergedBehavioralIntelligence = suppression.behavioral_intelligence;
    const recommendedFor = dedupeStrings([
      ...(inst.instructorIntelligence?.recommendedFor ?? []),
      ...legacyOperationalFields.recommended_for,
    ]);
    const avoidFor = dedupeStrings([
      ...(inst.instructorIntelligence?.avoidFor ?? []),
      ...legacyOperationalFields.avoid_for,
    ]);
    // Step 3-B: legacyOperationalFields.risk_notes merge 차단 — source-backed 또는
    // 현재 cycle InstructorIntelligence column만 사용. (과거 굳은 라벨 영구 노출 방지)
    const riskNotes = hasSourceBackedRiskPatterns
      ? mergedBehavioralIntelligence.risk_patterns
      : dedupeStrings([
          ...normalizedStoredRiskNotes,
          ...mergedBehavioralIntelligence.risk_patterns,
        ]);
    const rawTeachingCompanies = Array.from(
      new Set(
        teachingHistoryAll
          .map((row) => normalizeText(row.company_name))
          .filter(Boolean)
      )
    );
    const rawTeachingCourses = Array.from(
      new Set(
        teachingHistoryAll
          .map((row) => normalizeText(row.course_name))
          .filter(Boolean)
      )
    );
    const teachingCompanies = new Set(
      teachingHistoryAll
        .map((row) => normalizeCompanyKey(row.company_name))
        .filter(Boolean)
    );
    const teachingCourses = new Set(
      teachingHistoryAll
        .map((row) => normalizeText(row.course_name))
        .filter(Boolean)
    );
    const recentSatisfactionCutoffDate = getRecentSatisfactionCutoffDate();
    const recentSatisfactionRecords = await prisma.satisfactionRecord.findMany({
      where: {
        instructorDbId: inst.id,
        // D1 fix (Phase α): drive_satisfaction 포함. 50건이 정상 만족도 source인데
        // 라이브 응답에서 누락되어 history 빈 케이스(서용구 등)가 발생했음.
        // `manual`은 운영자 수기 입력 또는 test data가 섞일 수 있어 제외 유지.
        sourceType: {
          in: [
            "sheet_summary",
            "google_forms",
            "gmail_summary",
            "drive_satisfaction",
          ],
        },
      },
      select: {
        score: true,
        companyName: true,
        courseName: true,
        responseDate: true,
        respondentCount: true,
        sourceType: true,
        sourceRef: true,
        createdAt: true,
      },
      orderBy: [{ responseDate: "desc" }, { createdAt: "desc" }],
    });
    const recentCanonicalSatisfactionRows = recentSatisfactionRecords
      .map((row) => {
        const ref =
          row.sourceRef && typeof row.sourceRef === "object" && !Array.isArray(row.sourceRef)
            ? (row.sourceRef as Record<string, unknown>)
            : {};
        const sourceRefs = Array.isArray(ref.source_refs) ? ref.source_refs : [];
        const firstNested =
          sourceRefs.length > 0 && typeof sourceRefs[0] === "object" && sourceRefs[0]
            ? ((sourceRefs[0] as Record<string, unknown>).source_ref as
                | Record<string, unknown>
                | undefined)
            : undefined;
        return {
          score: Number(row.score),
          observedAt:
            row.responseDate?.toISOString().slice(0, 10) ??
            row.createdAt.toISOString().slice(0, 10),
          companyName: row.companyName,
          courseName: row.courseName,
          respondentCount: row.respondentCount ?? 1,
          sourceType: row.sourceType,
          sourceKey:
            typeof firstNested?.source_key === "string"
              ? (firstNested.source_key as string)
              : null,
          resolutionLevel:
            typeof firstNested?.resolution_level === "string"
              ? (firstNested.resolution_level as string)
              : null,
          resolutionBasis:
            typeof firstNested?.resolution_basis === "string"
              ? (firstNested.resolution_basis as string)
              : null,
          sessionLabel:
            typeof firstNested?.session_label === "string"
              ? (firstNested.session_label as string)
              : null,
          registryKey:
            typeof ref.registry_key === "string" ? (ref.registry_key as string) : null,
        };
      })
      .filter((row) => row.observedAt >= recentSatisfactionCutoffDate);
    const satisfactionImportSearchClauses = [
      { candidateName: inst.name },
      ...(rawTeachingCompanies.length > 0
        ? [{ candidateCompanyName: { in: rawTeachingCompanies } }]
        : []),
      ...(rawTeachingCourses.length > 0
        ? [{ candidateCourseName: { in: rawTeachingCourses } }]
        : []),
    ];
    // Step 5 lazy load: include_oi=0이면 satisfactionImportItem fetch skip (OI evidence snapshots용).
    const satisfactionImportRows =
      !includeOperationalIntelligence || satisfactionImportSearchClauses.length === 0
        ? []
        : (
            await prisma.satisfactionImportItem.findMany({
              where: {
                sourceType: {
                  in: ["sheet_summary", "google_forms", "gmail_summary"],
                },
                OR: satisfactionImportSearchClauses,
              },
              select: {
                id: true,
                sourceType: true,
                sourceRefKey: true,
                candidateName: true,
                candidateCompanyName: true,
                candidateCourseName: true,
                scoreNormalized: true,
                responseDate: true,
                createdAt: true,
                rawPayload: true,
                normalizedPayload: true,
              },
            })
          ).map((row) => ({
            id: row.id,
            sourceType: row.sourceType,
            sourceRefKey: row.sourceRefKey,
            candidateName: row.candidateName,
            candidateCompanyName: row.candidateCompanyName,
            candidateCourseName: row.candidateCourseName,
            scoreNormalized:
              row.scoreNormalized !== null ? Number(row.scoreNormalized) : null,
            responseDate:
              row.responseDate?.toISOString().slice(0, 10) ?? null,
            createdAt: row.createdAt,
            rawPayload:
              row.rawPayload &&
              typeof row.rawPayload === "object" &&
              !Array.isArray(row.rawPayload)
                ? (row.rawPayload as Record<string, unknown>)
                : {},
            normalizedPayload:
              row.normalizedPayload &&
              typeof row.normalizedPayload === "object" &&
              !Array.isArray(row.normalizedPayload)
                ? (row.normalizedPayload as Record<string, unknown>)
                : {},
          }));
    const recentSatisfactionHistory = buildRecentSatisfactionHistory({
      rows: recentCanonicalSatisfactionRows,
    });
    // P0-5: respondentCount 가중 평균. 25응답 × 4.5는 1응답 × 5.0 보다 무거워야.
    let weightedScoreSum = 0;
    let totalRespondents = 0;
    for (const row of recentCanonicalSatisfactionRows) {
      const w = row.respondentCount > 0 ? row.respondentCount : 1;
      weightedScoreSum += row.score * w;
      totalRespondents += w;
    }
    const recentSatisfactionSummary = {
      avg:
        totalRespondents > 0
          ? Math.round((weightedScoreSum / totalRespondents) * 100) / 100
          : null,
      count: recentCanonicalSatisfactionRows.length,
      is_imputed: false,
    };
    // Step 5 lazy load: include_oi=0이면 snapshot build skip — 빈 배열로 응답.
    const operationalEvidenceSnapshots = includeOperationalIntelligence
      ? buildOperationalEvidenceSnapshots({
          instructorId: inst.id,
          instructorName: inst.name,
          teachingCompanies,
          teachingCourses,
          satisfactionImportRows,
        })
      : [];

    const response = {
      status: "success",
      meta: {
        request_id: requestId,
        data_mode: "live",
        is_fallback: false,
        last_updated_at: inst.updatedAt.toISOString(),
      },
      data: {
        id: inst.id,
        name: inst.name,
        affiliation: inst.affiliation,
        categories: inst.categories,
        teaching_titles: extractNotionPropertyTextList(
          inst.notionRawProperties,
          "담당 강의 정보"
        ),
        contact: {
          email: inst.contactEmail,
          phone: inst.contactPhone,
        },
        specialties: inst.specialties,
        profile_summary: inst.profileSummary,
        memo: stripGoogleLinks(memoRaw),
        notion_page_body: notionPageBodyRaw,
        notion_memo_diagnostics: notionMemoDiagnostics,
        is_fulltime: isFulltime,
        is_practice_coach: inst.isPracticeCoach,
        total_courses: totalCourses,
        total_hours: totalHours,
        recent_courses_6mo: recentCourses6mo,
        // 6-4: total_paid — teaching_histories 기반 추정 누적 지급액
        total_paid: totalPaid,
        // 6-4: 전임강사는 base_fee_hourly = null
        base_fee_hourly: isFulltime ? null : inst.baseFeeHourly,
        score: inst.score !== null ? Number(inst.score) : null,
        score_breakdown: inst.scoreBreakdown,
        satisfaction: {
          avg: inst.satisfactionAvg !== null ? Number(inst.satisfactionAvg) : null,
          count: inst.satisfactionCount,
          is_imputed: inst.satisfactionIsImputed,
        },
        recent_satisfaction_summary: recentSatisfactionSummary,
        recent_satisfaction_history: recentSatisfactionHistory,
        // Step 5 lazy load: include_oi=0이면 OI 필드 모두 빈 값 (frontend /intelligence로 별도 fetch).
        recommended_for: includeOperationalIntelligence ? recommendedFor : [],
        avoid_for: includeOperationalIntelligence ? avoidFor : [],
        risk_notes: includeOperationalIntelligence ? riskNotes : [],
        raw_operational_notes: includeOperationalIntelligence
          ? operationalPayload.raw_operational_notes
          : [],
        classified_notes: includeOperationalIntelligence
          ? operationalPayload.classified_notes
          : [],
        human_followups: includeOperationalIntelligence
          ? operationalPayload.human_followups
          : [],
        behavioral_intelligence: includeOperationalIntelligence
          ? mergedBehavioralIntelligence
          : {
              ...mergedBehavioralIntelligence,
              top_summary: null,
              teaching_style: null,
              curriculum_compliance: null,
              attitude: null,
              risk_patterns: [],
              strength_patterns: [],
              recommendation: null,
              key_question_for_humans: null,
            },
        operational_intelligence_meta: {
          generated_at:
            inst.instructorIntelligence?.generatedAt?.toISOString() ?? null,
          generated_by: inst.instructorIntelligence?.generatedBy ?? null,
          generation_model:
            inst.instructorIntelligence?.generationModel ?? null,
          label_suppression_reason: suppression.label_suppression_reason,
          hedge_evidence_count: suppression.hedge_evidence_count,
        },
        operational_evidence_snapshots: operationalEvidenceSnapshots,
        // 6-4: 전임강사는 fee_history 빈 배열. T8: 비전임 강사는 fee_histories 테이블에서 조회.
        fee_history: isFulltime
          ? []
          : feeHistory.map((f) => ({
              effective_date: f.effectiveDate
                ? f.effectiveDate.toISOString().split("T")[0]
                : null,
              effective_label: f.effectiveLabel,
              amount: f.amount,
              fee_kind: f.feeKind,
              context: f.context,
              source_type: f.sourceType,
              is_current: f.isCurrent,
              is_special_amount: f.isSpecialAmount,
            })),
        teaching_history: sanitizedTeachingHistoryVisible,
        teaching_history_remaining_count: teachingHistoryRemainingCount,
      },
    };

    return NextResponse.json(response);
  } catch {
    const snapshot = await readStoredFallbackSnapshot();
    const snapshotDetail = snapshot?.details[id] ?? null;
    const fallbackDetail = snapshotDetail ?? getFallbackInstructorDetail(id);

    if (fallbackDetail && !shouldIncludeInInstructorList(fallbackDetail)) {
      return buildInstructorNotFoundResponse({
        requestId,
        dataMode: snapshotDetail ? "stored" : "fallback",
        isFallback: true,
      });
    }

    if (fallbackDetail) {
      const teachingHistoryVisible = (
        fallbackDetail.teaching_history as unknown[]
      ).slice(0, teachingHistoryLimit);
      const teachingHistoryRemainingCount = Math.max(
        0,
        (fallbackDetail.teaching_history as unknown[]).length -
          teachingHistoryVisible.length
      );

      return NextResponse.json({
        status: "success",
        meta: {
          request_id: requestId,
          data_mode: snapshotDetail ? "stored" : "fallback",
          is_fallback: true,
          last_updated_at: snapshot?.generated_at ?? FALLBACK_LAST_UPDATED_AT,
        },
        data: {
          ...fallbackDetail,
          total_hours: fallbackDetail.total_hours ?? 0,
          teaching_history: teachingHistoryVisible,
          teaching_history_remaining_count: teachingHistoryRemainingCount,
        },
        errors: [
          {
            code: snapshotDetail ? "DETAIL_STORED_FALLBACK" : "DETAIL_FALLBACK",
            message: snapshotDetail
              ? "상세 조회 실패로 마지막 정상 스냅샷 데이터를 표시합니다."
              : "상세 조회 실패로 정적 fallback 데이터를 표시합니다.",
          },
        ],
      });
    }

    return NextResponse.json(
      {
        status: "error",
        meta: {
          request_id: requestId,
          data_mode: "live",
          is_fallback: false,
          last_updated_at: null,
        },
        errors: [
          {
            code: "DETAIL_FETCH_FAILED",
            message: "강사 상세 조회에 실패했습니다.",
          },
        ],
      },
      { status: 500 }
    );
  }
}
