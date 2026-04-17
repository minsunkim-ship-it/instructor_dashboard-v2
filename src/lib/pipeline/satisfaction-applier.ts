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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toInputJsonObject(value: Record<string, unknown>): Prisma.InputJsonObject {
  return value as Prisma.InputJsonObject;
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
      getNumber(item.scoreNormalized) ??
      getNumber(normalized.score_normalized) ??
      getNumber(normalized.scoreNormalized);
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
      sourceRef: true,
    },
  });

  const existingByRegistryKey = new Map<
    string,
    { id: string; instructorDbId: string; sourceType: string }
  >();
  for (const record of existingRecords) {
    const registryKey = getRegistryKeyFromSourceRef(record.sourceRef);
    if (registryKey) {
      existingByRegistryKey.set(registryKey, {
        id: record.id,
        instructorDbId: record.instructorDbId,
        sourceType: record.sourceType,
      });
    }
  }

  const acceptedRegistries = registries.filter(
    (registry) =>
      ACCEPTED_REGISTRY_STATUSES.has(registry.matchStatus) &&
      registry.resolvedInstructorId &&
      registry.avgScore !== null
  );

  const acceptedKeys = new Set(acceptedRegistries.map((registry) => registry.registryKey));
  const touchedInstructorIds = new Set<string>();
  let canonicalRecordsUpserted = 0;

  for (const record of existingRecords) {
    const registryKey = getRegistryKeyFromSourceRef(record.sourceRef);
    if (!registryKey) continue;
    if (acceptedKeys.has(registryKey)) continue;
    touchedInstructorIds.add(record.instructorDbId);
    await prisma.satisfactionRecord.delete({ where: { id: record.id } });
  }

  for (const registry of acceptedRegistries) {
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
      await prisma.satisfactionRecord.update({
        where: { id: existingRecord.id },
        data,
      });
    } else {
      await prisma.satisfactionRecord.create({ data });
    }

    canonicalRecordsUpserted += 1;
    touchedInstructorIds.add(registry.resolvedInstructorId!);
  }

  return {
    affectedInstructorIds: Array.from(touchedInstructorIds),
    canonicalRecordsUpserted,
  };
}

async function refreshSatisfactionAggregates(instructorIds: string[]): Promise<void> {
  if (instructorIds.length === 0) return;

  for (const instructorId of instructorIds) {
    const records = await prisma.satisfactionRecord.findMany({
      where: { instructorDbId: instructorId },
      select: { score: true },
    });
    const count = records.length;
    const avg =
      count > 0
        ? records.reduce((sum, record) => sum + Number(record.score), 0) / count
        : null;

    await prisma.instructor.update({
      where: { id: instructorId },
      data: {
        satisfactionAvg: avg !== null ? Math.round(avg * 100) / 100 : null,
        satisfactionCount: count,
        satisfactionIsImputed: false,
      },
    });
  }
}

export async function applySatisfactionImports({
  runId,
  items,
  recalculateScores = false,
}: ApplySatisfactionImportsInput): Promise<{
  importItemsStored: number;
  registries: {
    autoAcceptedCount: number;
    pendingCount: number;
    approvedCount: number;
    rejectedCount: number;
    invalidCount: number;
  };
  affectedInstructors: number;
  canonicalRecordsUpserted: number;
}> {
  for (const item of items) {
    const normalizedPayload = {
      ...(item.normalizedPayload ?? {}),
      ...(typeof item.respondentCount === "number" && Number.isFinite(item.respondentCount)
        ? { respondent_count: item.respondentCount }
        : {}),
      ...(item.sourceRefKey ? { source_ref_key: item.sourceRefKey } : {}),
    };

    if (item.sourceRefKey) {
      await prisma.satisfactionImportItem.upsert({
        where: {
          sourceType_sourceRefKey: {
            sourceType: item.sourceType,
            sourceRefKey: item.sourceRefKey,
          },
        },
        create: {
          runId,
          sourceType: item.sourceType,
          sourceRefKey: item.sourceRefKey,
          sourceRef: toInputJsonObject(item.sourceRef ?? {}),
          rawPayload: toInputJsonObject(item.rawPayload ?? {}),
          normalizedPayload: toInputJsonObject(normalizedPayload),
          candidateName: item.candidateName ?? null,
          candidateCompanyName: item.candidateCompanyName ?? null,
          candidateCourseName: item.candidateCourseName ?? null,
          scoreRaw: item.scoreRaw ?? null,
          scoreNormalized: item.scoreNormalized ?? null,
          responseDate: toDate(item.responseDate),
        },
        update: {
          runId,
          sourceRef: toInputJsonObject(item.sourceRef ?? {}),
          rawPayload: toInputJsonObject(item.rawPayload ?? {}),
          normalizedPayload: toInputJsonObject(normalizedPayload),
          candidateName: item.candidateName ?? null,
          candidateCompanyName: item.candidateCompanyName ?? null,
          candidateCourseName: item.candidateCourseName ?? null,
          scoreRaw: item.scoreRaw ?? null,
          scoreNormalized: item.scoreNormalized ?? null,
          responseDate: toDate(item.responseDate),
        },
      });
      continue;
    }

    await prisma.satisfactionImportItem.create({
      data: {
        runId,
        sourceType: item.sourceType,
        sourceRef: toInputJsonObject(item.sourceRef ?? {}),
        rawPayload: toInputJsonObject(item.rawPayload ?? {}),
        normalizedPayload: toInputJsonObject(normalizedPayload),
        candidateName: item.candidateName ?? null,
        candidateCompanyName: item.candidateCompanyName ?? null,
        candidateCourseName: item.candidateCourseName ?? null,
        scoreRaw: item.scoreRaw ?? null,
        scoreNormalized: item.scoreNormalized ?? null,
        responseDate: toDate(item.responseDate),
      },
    });
  }

  const allItems = await prisma.satisfactionImportItem.findMany({
    orderBy: { createdAt: "asc" },
  });

  const registryAggregates = resolveGmailSummarySiblingFallback(
    Array.from(buildRegistryAggregates(allItems).values())
  );
  const registryKeys = registryAggregates.map((registry) => registry.registryKey);
  const sourceTypes = Array.from(new Set(registryAggregates.map((registry) => registry.sourceType)));
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

  if (registryKeys.length > 0) {
    await prisma.satisfactionReviewRegistry.deleteMany({
      where: {
        sourceType: { in: sourceTypes },
        registryKey: { notIn: registryKeys },
      },
    });
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

  for (const aggregate of registryAggregates) {
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

    await prisma.satisfactionReviewRegistry.upsert({
      where: { registryKey: aggregate.registryKey },
      update: {
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
      },
      create: {
        runId,
        registryKey: aggregate.registryKey,
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
      },
    });

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

  const { affectedInstructorIds, canonicalRecordsUpserted } =
    await syncSatisfactionCanonical(persistedRegistries);
  await refreshSatisfactionAggregates(affectedInstructorIds);

  if (recalculateScores) {
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
    affectedInstructors: affectedInstructorIds.length,
    canonicalRecordsUpserted,
  };
}
