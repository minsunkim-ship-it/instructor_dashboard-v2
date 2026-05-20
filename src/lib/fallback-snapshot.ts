import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import type {
  InstructorDetailData,
  InstructorListItem,
  StatusData,
} from "@/types/api";
import {
  calculateTeachingHistoryTotalPaid,
  countGroupedTeachingHistories,
  dedupeTeachingHistories,
  sumGroupedTeachingHistoryHours,
} from "@/lib/teaching-history-display";
import { dedupeFeeHistoryItems } from "@/lib/fee-history-dedupe";
import { stripGoogleLinks } from "@/lib/google-link-sanitizer";
import { extractNotionPropertyTextList } from "@/lib/notion-property-utils";
import {
  extractOperationalIntelligencePayload,
  getLegacyOperationalFields,
} from "@/lib/operational-intelligence";
import { shouldIncludeInInstructorList } from "@/lib/instructor-list-visibility";

const SNAPSHOT_PATH = path.join(
  process.cwd(),
  "data",
  "last-good-snapshot.json"
);

export interface StoredFallbackListItem extends InstructorListItem {
  last_activity_at: string | null;
}

export interface StoredFallbackSnapshot {
  generated_at: string;
  list_items: StoredFallbackListItem[];
  details: Record<string, InstructorDetailData>;
  status_data: StatusData;
}

function sanitizeInstructorDetailData(
  detail: InstructorDetailData
): InstructorDetailData {
  const teachingHistory = Array.isArray(detail.teaching_history)
    ? detail.teaching_history.map((item) => {
        if (!item || typeof item !== "object") return item;
        const record = item as Record<string, unknown>;

        return {
          ...record,
          fee_extra:
            "fee_extra" in record
              ? stripGoogleLinks(record.fee_extra as string | null | undefined)
              : undefined,
          special_notes:
            "special_notes" in record
              ? stripGoogleLinks(record.special_notes as string | null | undefined)
              : undefined,
        };
      })
    : detail.teaching_history;
  const behavioralSourceRefs =
    detail.behavioral_intelligence?.source_refs &&
    typeof detail.behavioral_intelligence.source_refs === "object"
      ? detail.behavioral_intelligence.source_refs
      : null;

  return {
    ...detail,
    memo: stripGoogleLinks(detail.memo),
    notion_page_body: detail.notion_page_body ?? null,
    behavioral_intelligence: {
      ...detail.behavioral_intelligence,
      source_refs: {
        teaching_style: Array.isArray(behavioralSourceRefs?.teaching_style)
          ? behavioralSourceRefs.teaching_style
          : [],
        curriculum_compliance: Array.isArray(
          behavioralSourceRefs?.curriculum_compliance
        )
          ? behavioralSourceRefs.curriculum_compliance
          : [],
        attitude: Array.isArray(behavioralSourceRefs?.attitude)
          ? behavioralSourceRefs.attitude
          : [],
        recommendation: Array.isArray(behavioralSourceRefs?.recommendation)
          ? behavioralSourceRefs.recommendation
          : [],
        key_question_for_humans: Array.isArray(
          behavioralSourceRefs?.key_question_for_humans
        )
          ? behavioralSourceRefs.key_question_for_humans
          : [],
        strength_patterns: Array.isArray(behavioralSourceRefs?.strength_patterns)
          ? behavioralSourceRefs.strength_patterns
          : [],
        risk_patterns: Array.isArray(behavioralSourceRefs?.risk_patterns)
          ? behavioralSourceRefs.risk_patterns
          : [],
      },
    },
    operational_intelligence_meta: {
      generated_at: detail.operational_intelligence_meta?.generated_at ?? null,
      generated_by: detail.operational_intelligence_meta?.generated_by ?? null,
      generation_model:
        detail.operational_intelligence_meta?.generation_model ?? null,
      label_suppression_reason:
        detail.operational_intelligence_meta?.label_suppression_reason ?? null,
      hedge_evidence_count:
        detail.operational_intelligence_meta?.hedge_evidence_count ?? null,
    },
    teaching_history: teachingHistory,
  };
}

function sanitizeStoredFallbackSnapshot(
  snapshot: StoredFallbackSnapshot
): StoredFallbackSnapshot {
  return {
    ...snapshot,
    details: Object.fromEntries(
      Object.entries(snapshot.details).map(([id, detail]) => [
        id,
        sanitizeInstructorDetailData(detail),
      ])
    ),
  };
}

export async function readStoredFallbackSnapshot(): Promise<StoredFallbackSnapshot | null> {
  try {
    const raw = await readFile(SNAPSHOT_PATH, "utf-8");
    const parsed = JSON.parse(raw) as StoredFallbackSnapshot;

    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray(parsed.list_items) ||
      !parsed.details ||
      typeof parsed.details !== "object" ||
      !parsed.status_data ||
      typeof parsed.status_data !== "object"
    ) {
      return null;
    }

    return sanitizeStoredFallbackSnapshot(parsed);
  } catch {
    return null;
  }
}

export async function hasStoredFallbackSnapshot(): Promise<boolean> {
  return (await readStoredFallbackSnapshot()) !== null;
}

export async function writeStoredFallbackSnapshot(
  snapshot: StoredFallbackSnapshot
): Promise<void> {
  await mkdir(path.dirname(SNAPSHOT_PATH), { recursive: true });
  await writeFile(
    SNAPSHOT_PATH,
    JSON.stringify(sanitizeStoredFallbackSnapshot(snapshot), null, 2),
    "utf-8"
  );
}

export async function buildStoredFallbackSnapshot(): Promise<StoredFallbackSnapshot> {
  const [instructors, latestFinishedRun, allSyncLogs, allSatisfactionRecords] =
    await Promise.all([
      prisma.instructor.findMany({
        include: {
          teachingHistories: {
            orderBy: [{ startDate: "desc" }, { createdAt: "desc" }],
          },
          feeHistories: {
            orderBy: [{ effectiveDate: "desc" }, { createdAt: "desc" }],
          },
          instructorIntelligence: true,
        },
        orderBy: [{ score: "desc" }, { rank: "asc" }, { name: "asc" }],
      }),
      prisma.pipelineRun.findFirst({
        where: { status: { in: ["success", "partial", "failed"] } },
        orderBy: { finishedAt: "desc" },
      }),
      prisma.sourceSyncLog.findMany({
        orderBy: [{ startedAt: "desc" }, { finishedAt: "desc" }],
      }),
      // P0-5: summary/history 동일 row set 사용 — record 일괄 로드.
      prisma.satisfactionRecord.findMany({
        select: {
          id: true,
          instructorDbId: true,
          score: true,
          companyName: true,
          courseName: true,
          responseDate: true,
          respondentCount: true,
          comment: true,
          sourceType: true,
          sourceRef: true,
          createdAt: true,
        },
        orderBy: [{ responseDate: "desc" }, { createdAt: "desc" }],
      }),
    ]);

  const generatedAt =
    latestFinishedRun?.finishedAt?.toISOString() ?? new Date().toISOString();
  const today = new Date().toISOString().split("T")[0];
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setUTCMonth(sixMonthsAgo.getUTCMonth() - 6);
  const sixMonthsAgoIso = sixMonthsAgo.toISOString().split("T")[0];

  // 강사별 record map (cutoff 안만)
  const recordsByInstructor = new Map<string, typeof allSatisfactionRecords>();
  for (const r of allSatisfactionRecords) {
    const inWindow = r.responseDate ? r.responseDate >= sixMonthsAgo : true;
    if (!inWindow) continue;
    const list = recordsByInstructor.get(r.instructorDbId) ?? [];
    list.push(r);
    recordsByInstructor.set(r.instructorDbId, list);
  }

  const listItems: StoredFallbackListItem[] = instructors
    .filter((inst) => shouldIncludeInInstructorList(inst))
    .map((inst) => {
      const teachingHistoryAll = inst.teachingHistories.map((h) => ({
        course_name: h.courseName,
        company_name: h.companyName,
        course_id: h.courseId,
        detail_type: h.detailType,
        fee_extra: h.feeExtra,
        special_notes: h.specialNotes,
        start_date: h.startDate?.toISOString().split("T")[0] ?? null,
        end_date: h.endDate?.toISOString().split("T")[0] ?? null,
        date_label: h.dateLabel,
        total_sessions: h.totalSessions,
        total_hours: h.totalHours !== null ? Number(h.totalHours) : null,
      }));
      return {
        id: inst.id,
        name: inst.name,
        affiliation: inst.affiliation,
        categories: inst.categories,
        teaching_titles: extractNotionPropertyTextList(
          inst.notionRawProperties,
          "담당 강의 정보"
        ),
        specialties: inst.specialties,
        rank: inst.rank,
        score: inst.score !== null ? Number(inst.score) : null,
        total_courses: countGroupedTeachingHistories(teachingHistoryAll, {
          fromDate: "2025-01-01",
          untilDate: today,
        }),
        total_hours: sumGroupedTeachingHistoryHours(teachingHistoryAll, {
          fromDate: "2025-01-01",
          untilDate: today,
        }),
        base_fee_hourly: inst.isFulltime ? null : inst.baseFeeHourly,
        is_fulltime: inst.isFulltime,
        flag: inst.flag,
        last_activity_at: inst.lastActivityAt?.toISOString() ?? null,
      };
    });

  const details = Object.fromEntries(
    instructors.map((inst) => {
      const teachingHistoryAll = inst.teachingHistories.map((h) => ({
        id: h.id,
        company_name: h.companyName,
        course_name: h.courseName,
        course_id: h.courseId,
        start_date: h.startDate?.toISOString().split("T")[0] ?? null,
        end_date: h.endDate?.toISOString().split("T")[0] ?? null,
        date_label: h.dateLabel,
        deal_fee_hourly: h.dealFeeHourly,
        fee_extra: stripGoogleLinks(h.feeExtra),
        total_hours: h.totalHours !== null ? Number(h.totalHours) : null,
        total_sessions: h.totalSessions,
        contract_type: h.contractType,
        detail_type: h.detailType,
        special_notes: stripGoogleLinks(h.specialNotes),
        source_type: h.sourceType,
      }));

      const teachingHistory = dedupeTeachingHistories(teachingHistoryAll, {
        fromDate: "2025-01-01",
        untilDate: today,
      });

      const feeHistory = dedupeFeeHistoryItems(inst.feeHistories);
      const operationalPayload = extractOperationalIntelligencePayload(
        inst.instructorIntelligence?.sourceSummary
      );
      const legacyOperationalFields =
        getLegacyOperationalFields(operationalPayload);

      const detail: InstructorDetailData = {
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
        memo: stripGoogleLinks(inst.memoRaw),
        notion_page_body: inst.notionPageBodyRaw ?? null,
        notion_memo_diagnostics: {
          source_linked: false,
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
        },
        is_fulltime: inst.isFulltime,
        is_practice_coach: inst.isPracticeCoach,
        total_courses: countGroupedTeachingHistories(teachingHistory, {
          fromDate: "2025-01-01",
          untilDate: today,
        }),
        total_hours: sumGroupedTeachingHistoryHours(teachingHistory, {
          fromDate: "2025-01-01",
          untilDate: today,
        }),
        recent_courses_6mo: countGroupedTeachingHistories(teachingHistory, {
          fromDate: sixMonthsAgo.toISOString().split("T")[0],
          untilDate: today,
        }),
        total_paid: calculateTeachingHistoryTotalPaid(teachingHistoryAll, {
          fromDate: "2025-01-01",
          untilDate: today,
        }),
        base_fee_hourly: inst.isFulltime ? null : inst.baseFeeHourly,
        score: inst.score !== null ? Number(inst.score) : null,
        score_breakdown:
          inst.scoreBreakdown &&
          typeof inst.scoreBreakdown === "object" &&
          !Array.isArray(inst.scoreBreakdown)
            ? (inst.scoreBreakdown as Record<string, number>)
            : {},
        satisfaction: {
          avg: inst.satisfactionAvg !== null ? Number(inst.satisfactionAvg) : null,
          count: inst.satisfactionCount,
          is_imputed: inst.satisfactionIsImputed,
        },
        // P0-5: summary와 history는 동일 record set에서 생성 + respondentCount 가중 평균.
        ...(() => {
          const myRecords = recordsByInstructor.get(inst.id) ?? [];
          const history = myRecords.map((r) => {
            const ref =
              r.sourceRef && typeof r.sourceRef === "object" && !Array.isArray(r.sourceRef)
                ? (r.sourceRef as Record<string, unknown>)
                : {};
            const sourceRefs = Array.isArray(ref.source_refs) ? ref.source_refs : [];
            const firstSourceRef =
              sourceRefs.length > 0 && typeof sourceRefs[0] === "object" && sourceRefs[0]
                ? ((sourceRefs[0] as Record<string, unknown>).source_ref as
                    | Record<string, unknown>
                    | undefined)
                : undefined;
            return {
              observed_at: r.responseDate?.toISOString().slice(0, 10) ?? null,
              company_name: r.companyName,
              course_name: r.courseName,
              session_label:
                typeof firstSourceRef?.session_label === "string"
                  ? (firstSourceRef.session_label as string)
                  : null,
              score: Number(r.score),
              respondent_count: r.respondentCount ?? 1,
              source_type: r.sourceType,
              source_key:
                typeof firstSourceRef?.source_key === "string"
                  ? (firstSourceRef.source_key as string)
                  : null,
              resolution_level:
                typeof firstSourceRef?.resolution_level === "string"
                  ? (firstSourceRef.resolution_level as string)
                  : null,
              resolution_basis:
                typeof firstSourceRef?.resolution_basis === "string"
                  ? (firstSourceRef.resolution_basis as string)
                  : null,
              registry_key:
                typeof ref.registry_key === "string" ? (ref.registry_key as string) : null,
            };
          });
          // 응답자 가중 평균: sum(score × respondentCount) / sum(respondentCount)
          let totalScore = 0;
          let totalRespondents = 0;
          for (const h of history) {
            const w = h.respondent_count > 0 ? h.respondent_count : 1;
            totalScore += h.score * w;
            totalRespondents += w;
          }
          const weightedAvg =
            totalRespondents > 0
              ? Math.round((totalScore / totalRespondents) * 100) / 100
              : null;
          return {
            recent_satisfaction_summary: {
              avg: weightedAvg,
              count: history.length,
              is_imputed: false,
            },
            recent_satisfaction_history: history,
          };
        })(),
        ...legacyOperationalFields,
        raw_operational_notes: operationalPayload.raw_operational_notes,
        classified_notes: operationalPayload.classified_notes,
        human_followups: operationalPayload.human_followups,
        behavioral_intelligence: operationalPayload.behavioral_intelligence,
        operational_intelligence_meta: {
          generated_at: null,
          generated_by: null,
          generation_model: null,
          label_suppression_reason: null,
          hedge_evidence_count: null,
        },
        operational_evidence_snapshots: [],
        fee_history: inst.isFulltime
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
        teaching_history: teachingHistory,
        teaching_history_remaining_count: 0,
      };

      return [inst.id, detail];
    })
  );

  const standardSourceTypes = [
    "notion",
    "contract_sheet",
    "instructor_dispatch_sheet",
    "salesmap",
    "slack",
    "gmail",
    "satisfaction",
    "fulltime",
    "ops_notes",
  ];

  const latestBySource = new Map<
    string,
    {
      status: string;
      lastSyncedAt: string | null;
      fetchedCount: number;
      updatedCount: number;
      note: string | null;
    }
  >();

  for (const log of allSyncLogs) {
    const standardType = standardSourceTypes.includes(log.sourceType)
      ? log.sourceType
      : log.sourceType.startsWith("satisfaction")
        ? "satisfaction"
        : null;
    if (!standardType || latestBySource.has(standardType)) continue;

    latestBySource.set(standardType, {
      status: log.status,
      lastSyncedAt: log.finishedAt?.toISOString() ?? log.startedAt.toISOString(),
      fetchedCount: log.fetchedCount,
      updatedCount: log.updatedCount,
      note: log.errorMessage,
    });
  }

  const statusData: StatusData = {
    last_updated_at: generatedAt,
    refresh_available: true,
    latest_run_status:
      latestFinishedRun?.status === "success" ||
      latestFinishedRun?.status === "partial" ||
      latestFinishedRun?.status === "failed"
        ? latestFinishedRun.status
        : "never_synced",
    current_run: null,
    fallback_ready: true,
    sources: standardSourceTypes.map((sourceType) => {
      const entry = latestBySource.get(sourceType);
      return {
        source_type: sourceType,
        status: (entry?.status ?? "never_synced") as StatusData["sources"][number]["status"],
        last_synced_at: entry?.lastSyncedAt ?? null,
        fetched_count: entry?.fetchedCount ?? 0,
        updated_count: entry?.updatedCount ?? 0,
        note: entry?.note ?? null,
      };
    }),
  };

  return {
    generated_at: generatedAt,
    list_items: listItems,
    details,
    status_data: statusData,
  };
}
