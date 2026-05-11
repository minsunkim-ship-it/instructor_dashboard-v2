import { Prisma, type ReviewDecision, type SatisfactionImportItem } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { recalculateAllScores } from "@/lib/score-recalculator";

export interface SatisfactionImportItemInput {
  sourceType: string;
  sourceRefKey?: string | null;
  sourceRef?: Record<string, unknown>;
  rawPayload?: Record<string, unknown>;
  normalizedPayload?: Record<string, unknown>;
  candidateName?: string | null;
  candidateCompanyName?: string | null;
  candidateCourseName?: string | null;
  scoreRaw?: string | null;
  scoreNormalized?: number | null;
  respondentCount?: number | null;
  responseDate?: Date | string | null;
}

interface ApplySatisfactionImportsInput {
  runId: string;
  items: SatisfactionImportItemInput[];
  recalculateScores?: boolean;
  onProgress?: (
    stage:
      | "import_items"
      | "load_items"
      | "build_registries"
      | "upsert_registries"
      | "sync_canonical"
      | "refresh_aggregates"
      | "recalculate_scores",
    detail?: Record<string, unknown>
  ) => Promise<void> | void;
}

interface RegistryAggregate {
  registryKey: string;
  sourceType: string;
  sourceRefs: Prisma.InputJsonValue[];
  candidateName: string | null;
  companyName: string | null;
  courseName: string | null;
  weightedScoreSum: number;
  responseCount: number;
  suggestedInstructorId: string | null;
  resolutionBasis: string | null;
  seenEventKeys: Set<string>;
}

const ACCEPTED_REGISTRY_STATUSES = new Set(["auto_accepted", "approved"]);
const SATISFACTION_WRITE_BATCH_SIZE = 5;
const SATISFACTION_CREATE_BATCH_SIZE = 100;
const SATISFACTION_LOOKBACK_MONTHS = 6;
const REPLACEABLE_SATISFACTION_SOURCE_TYPES = new Set([
  "sheet_summary",
  "google_forms",
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toInputJsonObject(value: Record<string, unknown>): Prisma.InputJsonObject {
  return value as Prisma.InputJsonObject;
}

function jsonEquals(a: Prisma.JsonValue | Prisma.InputJsonValue, b: Prisma.JsonValue | Prisma.InputJsonValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function getString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value instanceof Prisma.Decimal) {
    return Number(value);
  }
  return null;
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toDateOnlyString(value: Date | string | null | undefined): string | null {
  const date = toDate(value);
  return date ? date.toISOString().slice(0, 10) : null;
}

function getRecentSatisfactionCutoffDate(now = new Date()): string {
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - SATISFACTION_LOOKBACK_MONTHS);
  return cutoff.toISOString().slice(0, 10);
}

function sanitizeSatisfactionScore(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 1 || value > 5) return null;
  return Math.round(value * 100) / 100;
}

async function processInBatches<T>(
  items: T[],
  batchSize: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  for (let index = 0; index < items.length; index += batchSize) {
    const batch = items.slice(index, index + batchSize);
    await Promise.all(batch.map((item) => worker(item)));
  }
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

function buildImportItemStorageKey(item: {
  sourceType: string;
  sourceRefKey?: string | null;
}): string | null {
  return item.sourceRefKey ? `${item.sourceType}::${item.sourceRefKey}` : null;
}

function buildRegistryKey(item: SatisfactionImportItem): string {
  const sourceRef = asRecord(item.sourceRef);
  const normalized = asRecord(item.normalizedPayload);
  const explicitRegistryKey =
    getString(normalized.registry_key) ?? getString(normalized.registryKey);
  if (explicitRegistryKey) {
    return explicitRegistryKey;
  }
  const requestId = getString(sourceRef.request_id);
  if (item.sourceType === "manual" && requestId) {
    return `manual:request:${requestId}`;
  }

  const suggestedInstructorId =
    getString(normalized.suggested_instructor_id) ??
    getString(normalized.suggestedInstructorId);
  const candidateName =
    item.candidateName ??
    getString(normalized.candidate_name) ??
    getString(normalized.candidateName);
  const companyName =
    item.candidateCompanyName ??
    getString(normalized.company_name) ??
    getString(normalized.companyName);
  const courseName =
    item.candidateCourseName ??
    getString(normalized.course_name) ??
    getString(normalized.courseName);
  const responseDate =
    toDateOnlyString(item.responseDate) ??
    getString(normalized.response_date) ??
    getString(normalized.responseDate);

  if (suggestedInstructorId) {
    return `${item.sourceType}:instructor:${suggestedInstructorId}:${companyName ?? ""}|${courseName ?? ""}|${responseDate ?? ""}`;
  }

  if (candidateName || companyName || courseName) {
    return `${item.sourceType}:candidate:${candidateName ?? ""}|${companyName ?? ""}|${courseName ?? ""}|${responseDate ?? ""}`;
  }

  return `${item.sourceType}:invalid:${responseDate ?? "unknown"}:${item.id}`;
}

function applyDecision(
  baseStatus: string,
  aggregate: RegistryAggregate,
  decision: ReviewDecision | undefined
): {
  matchStatus: string;
  resolvedInstructorId: string | null;
  resolutionBasis: string | null;
} {
  const defaultResolvedInstructorId =
    baseStatus === "auto_accepted" ? aggregate.suggestedInstructorId : null;
  const defaultResolutionBasis =
    baseStatus === "auto_accepted" ? aggregate.resolutionBasis : null;

  if (!decision) {
    return {
      matchStatus: baseStatus,
      resolvedInstructorId: defaultResolvedInstructorId,
      resolutionBasis: defaultResolutionBasis,
    };
  }

  if (decision.decisionType === "reject") {
    return {
      matchStatus: "rejected",
      resolvedInstructorId: null,
      resolutionBasis: "manual_decision",
    };
  }

  if (decision.decisionType === "invalidate") {
    return {
      matchStatus: "invalid",
      resolvedInstructorId: null,
      resolutionBasis: "manual_decision",
    };
  }

  if (decision.decisionType === "override_instructor" && decision.targetInstructorId) {
    return {
      matchStatus: "approved",
      resolvedInstructorId: decision.targetInstructorId,
      resolutionBasis: "manual_decision",
    };
  }

  if (decision.decisionType === "approve") {
    return {
      matchStatus: "approved",
      resolvedInstructorId: decision.targetInstructorId ?? aggregate.suggestedInstructorId,
      resolutionBasis: "manual_decision",
    };
  }

  return {
    matchStatus: baseStatus,
    resolvedInstructorId: defaultResolvedInstructorId,
    resolutionBasis: defaultResolutionBasis,
  };
}

function buildRegistryAggregates(items: SatisfactionImportItem[]): Map<string, RegistryAggregate> {
  const registries = new Map<string, RegistryAggregate>();

  for (const item of items) {
    const registryKey = buildRegistryKey(item);
    const normalized = asRecord(item.normalizedPayload);
    const sourceRef = asRecord(item.sourceRef);
    const scoreValue =
      sanitizeSatisfactionScore(
        getNumber(item.scoreNormalized) ??
          getNumber(normalized.score_normalized) ??
          getNumber(normalized.scoreNormalized)
      );
    const respondentCount = Math.max(
      1,
      getNumber(normalized.respondent_count) ??
        getNumber(normalized.respondentCount) ??
        1
    );
    const suggestedInstructorId =
      getString(normalized.suggested_instructor_id) ??
      getString(normalized.suggestedInstructorId);
    const resolutionBasis =
      getString(normalized.resolution_basis) ??
      getString(normalized.resolutionBasis);
    const sourceRefEntry: Prisma.InputJsonObject = {
      source_ref: toInputJsonObject(sourceRef),
      response_date:
        toDateOnlyString(item.responseDate) ??
        getString(normalized.response_date) ??
        getString(normalized.responseDate),
      score_normalized: scoreValue,
    };
    const eventKey =
      getString(normalized.event_key) ??
      getString(normalized.eventKey) ??
      getString(normalized.source_ref_key) ??
      item.id;

    const existing = registries.get(registryKey);
    if (existing) {
      existing.sourceRefs.push(sourceRefEntry);
      if (scoreValue !== null && !existing.seenEventKeys.has(eventKey)) {
        existing.weightedScoreSum += scoreValue * respondentCount;
        existing.responseCount += respondentCount;
      }
      if (!existing.candidateName) {
        existing.candidateName =
          item.candidateName ??
          getString(normalized.candidate_name) ??
          getString(normalized.candidateName);
      }
      if (!existing.companyName) {
        existing.companyName =
          item.candidateCompanyName ??
          getString(normalized.company_name) ??
          getString(normalized.companyName);
      }
      if (!existing.courseName) {
        existing.courseName =
          item.candidateCourseName ??
          getString(normalized.course_name) ??
          getString(normalized.courseName);
      }
      if (!existing.suggestedInstructorId && suggestedInstructorId) {
        existing.suggestedInstructorId = suggestedInstructorId;
      }
      if (!existing.resolutionBasis && resolutionBasis) {
        existing.resolutionBasis = resolutionBasis;
      }
      existing.seenEventKeys.add(eventKey);
      continue;
    }

    registries.set(registryKey, {
      registryKey,
      sourceType: item.sourceType,
      sourceRefs: [sourceRefEntry],
      candidateName:
        item.candidateName ??
        getString(normalized.candidate_name) ??
        getString(normalized.candidateName),
      companyName:
        item.candidateCompanyName ??
        getString(normalized.company_name) ??
        getString(normalized.companyName),
      courseName:
        item.candidateCourseName ??
        getString(normalized.course_name) ??
        getString(normalized.courseName),
      weightedScoreSum: scoreValue !== null ? scoreValue * respondentCount : 0,
      responseCount: respondentCount,
      suggestedInstructorId,
      resolutionBasis,
      seenEventKeys: new Set([eventKey]),
    });
  }

  return registries;
}

function averageWeighted(weightedScoreSum: number, responseCount: number): number | null {
  if (responseCount <= 0) return null;
  return weightedScoreSum / responseCount;
}

function getRegistryKeyFromSourceRef(sourceRef: Prisma.JsonValue): string | null {
  const record = asRecord(sourceRef);
  return getString(record.registry_key);
}

/**
 * SatisfactionImportItem 또는 SatisfactionRecord의 sourceRef에서 시트 source_key 추출.
 *
 * 실제 DB 구조 (snapshot으로 확인):
 *   - SatisfactionImportItem.sourceRef = { source_key, row_number, spreadsheet_id, ... }  (1-depth flat)
 *   - SatisfactionRecord.sourceRef     = { registry_key, source_refs: [{ source_ref: { source_key, ... } }] }  (2-depth nested)
 *   - gmail_summary record             = { source_refs: [{ source_ref: { thread_id, ... } }] }  (source_key 없음)
 *
 * narrow include 안전성 보장: 현재 run에서 처리한 source_key의 record만 sync 대상.
 */
function getSourceKeyFromSourceRef(sourceRef: Prisma.JsonValue): string | null {
  const record = asRecord(sourceRef);

  // Path 1: 1-depth flat (SatisfactionImportItem)
  const direct = getString(record.source_key);
  if (direct) return direct;

  // Path 2: 2-depth nested in source_refs array (SatisfactionRecord)
  const sourceRefs = record.source_refs;
  if (Array.isArray(sourceRefs) && sourceRefs.length > 0) {
    const first = asRecord(sourceRefs[0]);

    // 2a: source_refs[].source_ref.source_key (정상 nested record path)
    const nested = asRecord(first.source_ref);
    const nestedKey = getString(nested.source_key);
    if (nestedKey) return nestedKey;

    // 2b: source_refs[].source_key (안전망 - 미래 변경 대비)
    const flatInArray = getString(first.source_key);
    if (flatInArray) return flatInArray;
  }

  return null;
}

/**
 * 현재 run의 registries에서 처리한 source_key 집합 추출.
 * registry.sourceRefs는 InputJsonValue[] 형태로 각 entry가 1-depth flat 구조이거나 nested일 수 있음.
 * narrow include 시 다른 시트의 record를 보호하기 위한 scope.
 */
function getRunSourceKeys(
  registries: Array<{ sourceRefs: Prisma.InputJsonValue[] }>
): Set<string> {
  const keys = new Set<string>();
  for (const reg of registries) {
    for (const ref of reg.sourceRefs) {
      if (!ref || typeof ref !== "object" || Array.isArray(ref)) continue;
      const refObj = ref as Record<string, unknown>;

      // Path 1: flat
      const direct = getString(refObj.source_key);
      if (direct) {
        keys.add(direct);
        continue;
      }

      // Path 2: nested under source_ref
      const nested = refObj.source_ref;
      if (nested && typeof nested === "object" && !Array.isArray(nested)) {
        const nestedKey = getString(
          (nested as Record<string, unknown>).source_key
        );
        if (nestedKey) keys.add(nestedKey);
      }
    }
  }
  return keys;
}

function inferCompanyFromCourseName(courseName: string | null | undefined): string | null {
  const cleaned = getString(courseName);
  if (!cleaned) return null;

  const prefixPatterns = [
    /^(JB금융지주)\b/,
    /^(CJ올리브네트웍스)\b/,
    /^(효성ITX)\b/i,
    /^(제일기획)\b/,
    /^(우리은행)\b/,
    /^(KB)\b/,
  ];

  for (const pattern of prefixPatterns) {
    const match = cleaned.match(pattern);
    if (match?.[1]) return match[1].trim();
  }

  return null;
}

function getAggregateResponseDate(sourceRefs: Prisma.InputJsonValue[]): string | null {
  const firstResponseRef = sourceRefs[0];
  return getString(asRecord(firstResponseRef).response_date);
}

function resolveGmailSummarySiblingFallback(
  registryAggregates: RegistryAggregate[]
): RegistryAggregate[] {
  for (const aggregate of registryAggregates) {
    if (aggregate.sourceType !== "gmail_summary") continue;
    if (!aggregate.companyName && aggregate.courseName) {
      aggregate.companyName = inferCompanyFromCourseName(aggregate.courseName);
    }
  }

  const acceptedBySignature = new Map<
    string,
    { suggestedInstructorId: string; candidateName: string | null }
  >();

  for (const aggregate of registryAggregates) {
    if (aggregate.sourceType !== "gmail_summary" || !aggregate.suggestedInstructorId) continue;
    const avgScore = averageWeighted(aggregate.weightedScoreSum, aggregate.responseCount);
    const responseDate = getAggregateResponseDate(aggregate.sourceRefs);
    if (avgScore === null || !aggregate.companyName || !aggregate.courseName || !responseDate) {
      continue;
    }

    const signature = [
      aggregate.sourceType,
      aggregate.companyName,
      aggregate.courseName,
      responseDate,
      avgScore.toFixed(2),
      String(aggregate.responseCount),
    ].join("|");

    const existing = acceptedBySignature.get(signature);
    if (existing && existing.suggestedInstructorId !== aggregate.suggestedInstructorId) {
      acceptedBySignature.delete(signature);
      continue;
    }

    acceptedBySignature.set(signature, {
      suggestedInstructorId: aggregate.suggestedInstructorId,
      candidateName: aggregate.candidateName,
    });
  }

  for (const aggregate of registryAggregates) {
    if (aggregate.sourceType !== "gmail_summary" || aggregate.suggestedInstructorId) continue;
    const avgScore = averageWeighted(aggregate.weightedScoreSum, aggregate.responseCount);
    const responseDate = getAggregateResponseDate(aggregate.sourceRefs);
    if (avgScore === null || !aggregate.companyName || !aggregate.courseName || !responseDate) {
      continue;
    }

    const signature = [
      aggregate.sourceType,
      aggregate.companyName,
      aggregate.courseName,
      responseDate,
      avgScore.toFixed(2),
      String(aggregate.responseCount),
    ].join("|");
    const sibling = acceptedBySignature.get(signature);
    if (!sibling) continue;

    aggregate.suggestedInstructorId = sibling.suggestedInstructorId;
    aggregate.candidateName = aggregate.candidateName ?? sibling.candidateName;
    aggregate.resolutionBasis =
      aggregate.resolutionBasis ?? "existing_course_event_single_instructor";
  }

  return registryAggregates;
}

async function syncSatisfactionCanonical(
  registries: Array<{
    registryKey: string;
    sourceType: string;
    matchStatus: string;
    resolvedInstructorId: string | null;
    companyName: string | null;
    courseName: string | null;
    avgScore: number | null;
    responseCount: number;
    responseDate: string | null;
    sourceRefs: Prisma.InputJsonValue[];
  }>
): Promise<{ affectedInstructorIds: string[]; canonicalRecordsUpserted: number }> {
  const sourceTypes = Array.from(new Set(registries.map((registry) => registry.sourceType)));
  const existingRecords = await prisma.satisfactionRecord.findMany({
    where: { sourceType: { in: sourceTypes } },
    select: {
      id: true,
      instructorDbId: true,
      sourceType: true,
      score: true,
      companyName: true,
      courseName: true,
      responseDate: true,
      respondentCount: true,
      comment: true,
      createdBy: true,
      sourceRef: true,
    },
  });

  const existingByRegistryKey = new Map<
    string,
    {
      id: string;
      instructorDbId: string;
      sourceType: string;
      score: Prisma.Decimal;
      companyName: string | null;
      courseName: string | null;
      responseDate: Date | null;
      respondentCount: number | null;
      comment: string | null;
      createdBy: string | null;
      sourceRef: Prisma.JsonValue;
    }
  >();
  for (const record of existingRecords) {
    const registryKey = getRegistryKeyFromSourceRef(record.sourceRef);
    if (registryKey) {
      existingByRegistryKey.set(registryKey, record);
    }
  }

  const acceptedRegistries = registries.filter(
    (registry) =>
      ACCEPTED_REGISTRY_STATUSES.has(registry.matchStatus) &&
      registry.resolvedInstructorId &&
      registry.avgScore !== null
  );

  const acceptedKeys = new Set(acceptedRegistries.map((registry) => registry.registryKey));
  // narrow include 안전성: 이번 run에서 처리한 source_key 만 scope.
  // 다른 시트(예: 동국제강)의 record는 절대 건드리지 않는다.
  const runSourceKeys = getRunSourceKeys(registries);
  const touchedInstructorIds = new Set<string>();
  let canonicalRecordsUpserted = 0;
  const recordIdsToDelete = existingRecords
    .filter((record) => {
      const registryKey = getRegistryKeyFromSourceRef(record.sourceRef);
      if (registryKey === null) return false;
      if (acceptedKeys.has(registryKey)) return false;
      // 현재 run의 source_key가 아니면 보존 (다른 시트 record 보호).
      const recordSourceKey = getSourceKeyFromSourceRef(record.sourceRef);
      if (!recordSourceKey || !runSourceKeys.has(recordSourceKey)) return false;
      return true;
    })
    .map((record) => {
      touchedInstructorIds.add(record.instructorDbId);
      return record.id;
    });

  if (recordIdsToDelete.length > 0) {
    await prisma.satisfactionRecord.deleteMany({
      where: { id: { in: recordIdsToDelete } },
    });
  }

  await processInBatches(
    acceptedRegistries,
    SATISFACTION_WRITE_BATCH_SIZE,
    async (registry) => {
      const existingRecord = existingByRegistryKey.get(registry.registryKey);
      const data = {
        instructorDbId: registry.resolvedInstructorId!,
        score: registry.avgScore!,
        companyName: registry.companyName,
        courseName: registry.courseName,
        responseDate: registry.responseDate ? new Date(registry.responseDate) : null,
        respondentCount: registry.responseCount,
        comment: null,
        sourceType: registry.sourceType,
        sourceRef: {
          registry_key: registry.registryKey,
          source_refs: registry.sourceRefs,
        },
        createdBy: "pipeline",
      };

      if (existingRecord) {
        touchedInstructorIds.add(existingRecord.instructorDbId);
        const isSame =
          existingRecord.instructorDbId === data.instructorDbId &&
          Number(existingRecord.score) === data.score &&
          existingRecord.companyName === data.companyName &&
          existingRecord.courseName === data.courseName &&
          toDateOnlyString(existingRecord.responseDate) ===
            toDateOnlyString(data.responseDate) &&
          existingRecord.respondentCount === data.respondentCount &&
          existingRecord.comment === data.comment &&
          existingRecord.sourceType === data.sourceType &&
          existingRecord.createdBy === data.createdBy &&
          jsonEquals(existingRecord.sourceRef, data.sourceRef as Prisma.InputJsonValue);

        if (!isSame) {
          await prisma.satisfactionRecord.update({
            where: { id: existingRecord.id },
            data,
          });
        }
      } else {
        await prisma.satisfactionRecord.create({ data });
      }

      canonicalRecordsUpserted += 1;
      touchedInstructorIds.add(registry.resolvedInstructorId!);
    }
  );

  return {
    affectedInstructorIds: Array.from(touchedInstructorIds),
    canonicalRecordsUpserted,
  };
}

export async function refreshSatisfactionAggregates(
  instructorIds?: string[]
): Promise<void> {
  const uniqueInstructorIds = instructorIds
    ? Array.from(new Set(instructorIds))
    : [];
  if (instructorIds && uniqueInstructorIds.length === 0) return;

  const cutoffDate = getRecentSatisfactionCutoffDate();

  if (uniqueInstructorIds.length > 0) {
    const instructorIdSqlList = Prisma.join(
      uniqueInstructorIds.map((id) => Prisma.sql`${id}::uuid`)
    );
    await prisma.$transaction([
      prisma.$executeRaw`
        UPDATE instructors
        SET
          satisfaction_avg = NULL,
          satisfaction_count = 0,
          satisfaction_is_imputed = FALSE
        WHERE id IN (${instructorIdSqlList})
      `,
      prisma.$executeRaw`
        WITH aggregated AS (
          SELECT
            instructor_db_id,
            ROUND(AVG(score)::numeric, 2) AS avg_score,
            COUNT(*)::int AS response_count
          FROM satisfaction_records
          WHERE instructor_db_id IN (${instructorIdSqlList})
            AND COALESCE(
              response_date,
              (created_at AT TIME ZONE 'UTC')::date
            ) >= ${cutoffDate}::date
          GROUP BY instructor_db_id
        )
        UPDATE instructors AS i
        SET
          satisfaction_avg = aggregated.avg_score,
          satisfaction_count = aggregated.response_count,
          satisfaction_is_imputed = FALSE
        FROM aggregated
        WHERE i.id = aggregated.instructor_db_id
      `,
    ]);
    return;
  }

  await prisma.$transaction([
    prisma.$executeRaw`
      UPDATE instructors
      SET
        satisfaction_avg = NULL,
        satisfaction_count = 0,
        satisfaction_is_imputed = FALSE
    `,
    prisma.$executeRaw`
      WITH aggregated AS (
        SELECT
          instructor_db_id,
          ROUND(AVG(score)::numeric, 2) AS avg_score,
          COUNT(*)::int AS response_count
        FROM satisfaction_records
        WHERE COALESCE(
          response_date,
          (created_at AT TIME ZONE 'UTC')::date
        ) >= ${cutoffDate}::date
        GROUP BY instructor_db_id
      )
      UPDATE instructors AS i
      SET
        satisfaction_avg = aggregated.avg_score,
        satisfaction_count = aggregated.response_count,
        satisfaction_is_imputed = FALSE
      FROM aggregated
      WHERE i.id = aggregated.instructor_db_id
    `,
  ]);
}

export async function applySatisfactionImports({
  runId,
  items,
  recalculateScores = false,
  onProgress,
}: ApplySatisfactionImportsInput): Promise<{
  importItemsStored: number;
  registries: {
    autoAcceptedCount: number;
    pendingCount: number;
    approvedCount: number;
    rejectedCount: number;
    invalidCount: number;
  };
  affectedInstructorIds: string[];
  affectedInstructors: number;
  canonicalRecordsUpserted: number;
}> {
  await onProgress?.("import_items", { items: items.length });
  const preparedItems = items.map((item) => {
    const sanitizedScore = sanitizeSatisfactionScore(item.scoreNormalized ?? null);
    const normalizedPayload = {
      ...(item.normalizedPayload ?? {}),
      ...(typeof item.respondentCount === "number" && Number.isFinite(item.respondentCount)
        ? { respondent_count: item.respondentCount }
        : {}),
      ...(item.sourceRefKey ? { source_ref_key: item.sourceRefKey } : {}),
      ...(sanitizedScore !== null
        ? { score_normalized: sanitizedScore }
        : {}),
    };
    return {
      ...item,
      sanitizedScore,
      normalizedPayload,
      responseDateValue: toDate(item.responseDate),
      storageKey: buildImportItemStorageKey(item),
    };
  });

  const itemSourceTypes = Array.from(
    new Set(preparedItems.map((item) => item.sourceType))
  );
  const replaceableSourceTypes = itemSourceTypes.filter((sourceType) =>
    REPLACEABLE_SATISFACTION_SOURCE_TYPES.has(sourceType)
  );
  const persistentSourceTypes = itemSourceTypes.filter(
    (sourceType) => !REPLACEABLE_SATISFACTION_SOURCE_TYPES.has(sourceType)
  );
  const replaceableItems = preparedItems.filter((item) =>
    replaceableSourceTypes.includes(item.sourceType)
  );
  const persistentItems = preparedItems.filter((item) =>
    persistentSourceTypes.includes(item.sourceType)
  );
  const persistentSourceRefKeys = Array.from(
    new Set(
      persistentItems
        .map((item) => item.sourceRefKey)
        .filter((value): value is string => Boolean(value))
    )
  );

  if (replaceableSourceTypes.length > 0) {
    // P0-4: replace 범위를 (sourceType, sourceKey) 단위로 축소.
    // 현재 run의 source_key만 삭제 → 다른 시트 ImportItem 보존.
    const replaceableSourceKeys = Array.from(
      new Set(
        replaceableItems
          .map((item) => {
            const ref = (item.sourceRef ?? {}) as Record<string, unknown>;
            const key = ref.source_key;
            return typeof key === "string" && key.length > 0 ? key : null;
          })
          .filter((value): value is string => Boolean(value))
      )
    );
    if (replaceableSourceKeys.length > 0) {
      await prisma.satisfactionImportItem.deleteMany({
        where: {
          sourceType: { in: replaceableSourceTypes },
          sourceKey: { in: replaceableSourceKeys },
        },
      });
    }
    // source_key 없는 replaceable item은 안전망: 삭제하지 않음 (현재 데이터 없음, 미래 source_key missing 케이스 발생 시 별도 alarm)

    for (let index = 0; index < replaceableItems.length; index += SATISFACTION_CREATE_BATCH_SIZE) {
      const batch = replaceableItems.slice(index, index + SATISFACTION_CREATE_BATCH_SIZE);
      await prisma.satisfactionImportItem.createMany({
        data: batch.map((item) => {
          const ref = (item.sourceRef ?? {}) as Record<string, unknown>;
          const sourceKey =
            typeof ref.source_key === "string" && ref.source_key.length > 0
              ? ref.source_key
              : null;
          return {
            runId,
            sourceType: item.sourceType,
            sourceKey,
            sourceRefKey: item.sourceRefKey ?? null,
            sourceRef: toInputJsonObject(item.sourceRef ?? {}),
            rawPayload: toInputJsonObject(item.rawPayload ?? {}),
            normalizedPayload: toInputJsonObject(item.normalizedPayload),
            candidateName: item.candidateName ?? null,
            candidateCompanyName: item.candidateCompanyName ?? null,
            candidateCourseName: item.candidateCourseName ?? null,
            scoreRaw: item.scoreRaw ?? null,
            scoreNormalized: item.sanitizedScore,
            responseDate: item.responseDateValue,
          };
        }),
        skipDuplicates: true,
      });
    }
  }

  if (persistentItems.length > 0) {
    const existingImportItems =
      persistentSourceRefKeys.length > 0
        ? await prisma.satisfactionImportItem.findMany({
            where: {
              sourceType: { in: persistentSourceTypes },
              sourceRefKey: { in: persistentSourceRefKeys },
            },
            select: {
              id: true,
              sourceType: true,
              sourceRefKey: true,
            },
          })
        : [];

    const existingImportItemsByKey = new Map(
      existingImportItems.map((item) => [
        `${item.sourceType}::${item.sourceRefKey}`,
        item.id,
      ])
    );

    const createItems = persistentItems.filter(
      (item) => !item.storageKey || !existingImportItemsByKey.has(item.storageKey)
    );
    const updateItems = persistentItems
      .filter(
        (item): item is typeof item & { storageKey: string } =>
          Boolean(item.storageKey && existingImportItemsByKey.has(item.storageKey))
      )
      .map((item) => ({
        id: existingImportItemsByKey.get(item.storageKey)!,
        item,
      }));

    const keyedCreateItems = createItems.filter((item) => item.sourceRefKey);
    const unkeyedCreateItems = createItems.filter((item) => !item.sourceRefKey);

    for (let index = 0; index < keyedCreateItems.length; index += SATISFACTION_CREATE_BATCH_SIZE) {
      const batch = keyedCreateItems.slice(index, index + SATISFACTION_CREATE_BATCH_SIZE);
      await prisma.satisfactionImportItem.createMany({
        data: batch.map((item) => ({
          runId,
          sourceType: item.sourceType,
          sourceRefKey: item.sourceRefKey ?? null,
          sourceRef: toInputJsonObject(item.sourceRef ?? {}),
          rawPayload: toInputJsonObject(item.rawPayload ?? {}),
          normalizedPayload: toInputJsonObject(item.normalizedPayload),
          candidateName: item.candidateName ?? null,
          candidateCompanyName: item.candidateCompanyName ?? null,
          candidateCourseName: item.candidateCourseName ?? null,
          scoreRaw: item.scoreRaw ?? null,
          scoreNormalized: item.sanitizedScore,
          responseDate: item.responseDateValue,
        })),
        skipDuplicates: true,
      });
    }

    for (let index = 0; index < unkeyedCreateItems.length; index += SATISFACTION_CREATE_BATCH_SIZE) {
      const batch = unkeyedCreateItems.slice(index, index + SATISFACTION_CREATE_BATCH_SIZE);
      await prisma.satisfactionImportItem.createMany({
        data: batch.map((item) => ({
          runId,
          sourceType: item.sourceType,
          sourceRef: toInputJsonObject(item.sourceRef ?? {}),
          rawPayload: toInputJsonObject(item.rawPayload ?? {}),
          normalizedPayload: toInputJsonObject(item.normalizedPayload),
          candidateName: item.candidateName ?? null,
          candidateCompanyName: item.candidateCompanyName ?? null,
          candidateCourseName: item.candidateCourseName ?? null,
          scoreRaw: item.scoreRaw ?? null,
          scoreNormalized: item.sanitizedScore,
          responseDate: item.responseDateValue,
        })),
      });
    }

    await processInBatches(updateItems, SATISFACTION_WRITE_BATCH_SIZE, async ({ id, item }) => {
      await prisma.satisfactionImportItem.updateMany({
        where: { id },
        data: {
          runId,
          sourceRef: toInputJsonObject(item.sourceRef ?? {}),
          rawPayload: toInputJsonObject(item.rawPayload ?? {}),
          normalizedPayload: toInputJsonObject(item.normalizedPayload),
          candidateName: item.candidateName ?? null,
          candidateCompanyName: item.candidateCompanyName ?? null,
          candidateCourseName: item.candidateCourseName ?? null,
          scoreRaw: item.scoreRaw ?? null,
          scoreNormalized: item.sanitizedScore,
          responseDate: item.responseDateValue,
        },
      });
    });
  }

  await onProgress?.("load_items");
  const registrySource = await prisma.satisfactionImportItem.findMany({
    where: {
      sourceType: { in: itemSourceTypes },
    },
    orderBy: { createdAt: "asc" },
  });

  await onProgress?.("build_registries", {
    items: registrySource.length,
  });
  const registryAggregates = resolveGmailSummarySiblingFallback(
    Array.from(
      buildRegistryAggregates(registrySource as SatisfactionImportItem[]).values()
    )
  );
  const registryKeys = registryAggregates.map((registry) => registry.registryKey);
  const registrySourceTypes = Array.from(
    new Set(registryAggregates.map((registry) => registry.sourceType))
  );
  const decisions = await prisma.reviewDecision.findMany({
    where: {
      registryType: "satisfaction",
      registryKey: { in: registryKeys },
    },
    orderBy: [{ registryKey: "asc" }, { createdAt: "desc" }],
  });

  const latestDecisions = new Map<string, ReviewDecision>();
  for (const decision of decisions) {
    if (!latestDecisions.has(decision.registryKey)) {
      latestDecisions.set(decision.registryKey, decision);
    }
  }

  const existingRegistries = registryKeys.length
    ? await prisma.satisfactionReviewRegistry.findMany({
        where: {
          registryKey: { in: registryKeys },
        },
        select: {
          registryKey: true,
          sourceType: true,
          sourceRefs: true,
          candidateName: true,
          companyName: true,
          courseName: true,
          avgScore: true,
          responseCount: true,
          matchStatus: true,
          suggestedInstructorId: true,
          resolvedInstructorId: true,
          resolutionBasis: true,
        },
      })
    : [];
  const existingRegistriesByKey = new Map(
    existingRegistries.map((registry) => [registry.registryKey, registry])
  );

  if (registryKeys.length > 0) {
    await withPrismaRetry(() =>
      prisma.satisfactionReviewRegistry.deleteMany({
        where: {
          sourceType: { in: registrySourceTypes },
          registryKey: { notIn: registryKeys },
        },
      })
    );
  }

  let autoAcceptedCount = 0;
  let pendingCount = 0;
  let approvedCount = 0;
  let rejectedCount = 0;
  let invalidCount = 0;

  const persistedRegistries: Array<{
    registryKey: string;
    sourceType: string;
    matchStatus: string;
    resolvedInstructorId: string | null;
    companyName: string | null;
    courseName: string | null;
    avgScore: number | null;
    responseCount: number;
    responseDate: string | null;
    sourceRefs: Prisma.InputJsonValue[];
  }> = [];

  await onProgress?.("upsert_registries", { registries: registryAggregates.length });
  await processInBatches(
    registryAggregates,
    SATISFACTION_WRITE_BATCH_SIZE,
    async (aggregate) => {
    const avgScore = averageWeighted(
      aggregate.weightedScoreSum,
      aggregate.responseCount
    );
    const firstResponseRef = aggregate.sourceRefs[0];
    const firstResponseDate = getString(asRecord(firstResponseRef).response_date);
    const baseStatus =
      avgScore === null ||
      aggregate.responseCount === 0 ||
      avgScore < 1 ||
      avgScore > 5
        ? "invalid"
        : aggregate.suggestedInstructorId
          ? "auto_accepted"
          : "pending";
    const decision = latestDecisions.get(aggregate.registryKey);
    const resolved = applyDecision(baseStatus, aggregate, decision);

      if (resolved.matchStatus === "auto_accepted") autoAcceptedCount += 1;
      else if (resolved.matchStatus === "pending") pendingCount += 1;
      else if (resolved.matchStatus === "approved") approvedCount += 1;
      else if (resolved.matchStatus === "rejected") rejectedCount += 1;
      else invalidCount += 1;

      const registryData = {
        runId,
        sourceType: aggregate.sourceType,
        sourceRefs: aggregate.sourceRefs as Prisma.InputJsonValue,
        candidateName: aggregate.candidateName,
        companyName: aggregate.companyName,
        courseName: aggregate.courseName,
        avgScore,
        responseCount: aggregate.responseCount,
        matchStatus: resolved.matchStatus,
        suggestedInstructorId: aggregate.suggestedInstructorId,
        resolvedInstructorId: resolved.resolvedInstructorId,
        resolutionBasis: resolved.resolutionBasis,
      };
      const existingRegistry = existingRegistriesByKey.get(aggregate.registryKey);

      if (!existingRegistry) {
        await withPrismaRetry(() =>
          prisma.satisfactionReviewRegistry.create({
            data: {
              registryKey: aggregate.registryKey,
              ...registryData,
            },
          })
        );
      } else {
        const isSame =
          existingRegistry.sourceType === registryData.sourceType &&
          jsonEquals(existingRegistry.sourceRefs, registryData.sourceRefs) &&
          existingRegistry.candidateName === registryData.candidateName &&
          existingRegistry.companyName === registryData.companyName &&
          existingRegistry.courseName === registryData.courseName &&
          Number(existingRegistry.avgScore ?? 0) === Number(registryData.avgScore ?? 0) &&
          existingRegistry.responseCount === registryData.responseCount &&
          existingRegistry.matchStatus === registryData.matchStatus &&
          existingRegistry.suggestedInstructorId === registryData.suggestedInstructorId &&
          existingRegistry.resolvedInstructorId === registryData.resolvedInstructorId &&
          existingRegistry.resolutionBasis === registryData.resolutionBasis;

        if (!isSame) {
          await withPrismaRetry(() =>
            prisma.satisfactionReviewRegistry.update({
              where: { registryKey: aggregate.registryKey },
              data: registryData,
            })
          );
        }
      }

      persistedRegistries.push({
        registryKey: aggregate.registryKey,
        sourceType: aggregate.sourceType,
        matchStatus: resolved.matchStatus,
        resolvedInstructorId: resolved.resolvedInstructorId,
        companyName: aggregate.companyName,
        courseName: aggregate.courseName,
        avgScore,
        responseCount: aggregate.responseCount,
        responseDate: firstResponseDate,
        sourceRefs: aggregate.sourceRefs,
      });
    }
  );

  await onProgress?.("sync_canonical", { registries: persistedRegistries.length });
  const { affectedInstructorIds, canonicalRecordsUpserted } =
    await syncSatisfactionCanonical(persistedRegistries);
  await onProgress?.("refresh_aggregates", {
    instructors: recalculateScores ? "all" : affectedInstructorIds.length,
  });
  await refreshSatisfactionAggregates(
    recalculateScores ? undefined : affectedInstructorIds
  );

  if (recalculateScores) {
    await onProgress?.("recalculate_scores", { runId });
    await recalculateAllScores({ runId });
  }

  return {
    importItemsStored: items.length,
    registries: {
      autoAcceptedCount,
      pendingCount,
      approvedCount,
      rejectedCount,
      invalidCount,
    },
    affectedInstructorIds,
    affectedInstructors: affectedInstructorIds.length,
    canonicalRecordsUpserted,
  };
}
