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

function dedupeFeeHistoryItems<
  T extends {
    effectiveDate: Date | null;
    effectiveLabel: string | null;
    amount: number | null;
    feeKind: string;
    context: string | null;
    sourceType: string;
    isCurrent: boolean;
    isSpecialAmount: boolean;
  },
>(items: T[]): T[] {
  const deduped = new Map<string, T>();

  for (const item of items) {
    const key = item.isSpecialAmount
      ? [
          item.effectiveDate?.toISOString().split("T")[0] ?? "",
          item.effectiveLabel ?? "",
          item.feeKind,
          item.context ?? "",
          item.sourceType,
          "1",
        ].join("||")
      : [
          item.effectiveDate?.toISOString().split("T")[0] ?? "",
          item.effectiveLabel ?? "",
          item.amount ?? "",
          item.feeKind,
          item.context ?? "",
          item.sourceType,
          "0",
        ].join("||");

    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, item);
      continue;
    }

    if (item.isSpecialAmount) {
      const existingAmount = existing.amount ?? 0;
      const nextAmount = item.amount ?? 0;
      if (nextAmount > existingAmount) {
        deduped.set(key, item);
      }
      continue;
    }

    if (!existing.isCurrent && item.isCurrent) {
      deduped.set(key, item);
    }
  }

  return Array.from(deduped.values()).sort((a, b) => {
    const aDate = a.effectiveDate?.toISOString().split("T")[0] ?? "";
    const bDate = b.effectiveDate?.toISOString().split("T")[0] ?? "";
    return bDate.localeCompare(aDate);
  });
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

    return parsed;
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
  await writeFile(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2), "utf-8");
}

export async function buildStoredFallbackSnapshot(): Promise<StoredFallbackSnapshot> {
  const [instructors, latestFinishedRun, allSyncLogs] = await Promise.all([
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
  ]);

  const generatedAt =
    latestFinishedRun?.finishedAt?.toISOString() ?? new Date().toISOString();
  const today = new Date().toISOString().split("T")[0];
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setUTCMonth(sixMonthsAgo.getUTCMonth() - 6);

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
        fee_extra: h.feeExtra,
        total_hours: h.totalHours !== null ? Number(h.totalHours) : null,
        total_sessions: h.totalSessions,
        contract_type: h.contractType,
        detail_type: h.detailType,
        special_notes: h.specialNotes,
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
        memo: inst.memoRaw,
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
        recent_satisfaction_history: [],
        ...legacyOperationalFields,
        raw_operational_notes: operationalPayload.raw_operational_notes,
        classified_notes: operationalPayload.classified_notes,
        human_followups: operationalPayload.human_followups,
        behavioral_intelligence: operationalPayload.behavioral_intelligence,
        operational_intelligence_meta: {
          generated_at: null,
          generated_by: null,
          generation_model: null,
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
