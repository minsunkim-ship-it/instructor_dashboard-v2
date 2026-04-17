/**
 * Activity Import Applier — Pilot 4-5 registry flow
 *
 * 03_data_model.md 4-10절 activity_import_items, 4-10-1절 activity_review_registries,
 * 4-10-2절 review_decisions
 * 04_data_pipeline.md 5-4-1절, 5-5-1절, 5-5-2절, 6-1절, 7-1절, 17절, 18-1절
 *
 * 흐름:
 * - source_type + source_ref_key 기준으로 activity_import_items upsert/update
 * - raw item들을 registry_key 기준으로 자동 취합해 activity_review_registries 생성/갱신
 * - review_decisions를 적용해 auto_accepted / approved / pending / rejected / invalid 판정
 * - canonical instructors 집계는 auto_accepted / approved registry만 기준으로 반영
 */

import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";

import type { NormalizedSlackActivity } from "./slack-activity-normalizer";
import type { NormalizedGmailActivity } from "./gmail-activity-normalizer";

export type MatchStatus = "matched" | "unmatched" | "ambiguous" | "ignored" | "invalid";
export type ActivityRegistryStatus =
  | "auto_accepted"
  | "pending"
  | "approved"
  | "rejected"
  | "invalid";

const ACTIVE_REGISTRY_STATUSES: ActivityRegistryStatus[] = [
  "auto_accepted",
  "approved",
];

export interface ApplyItemCounts {
  inserted: number;
  updated: number;
  matched: number;
  unmatched: number;
  ambiguous: number;
  invalid: number;
}

export interface ApplyRegistryCounts {
  autoAccepted: number;
  pending: number;
  approved: number;
  rejected: number;
  invalid: number;
}

export interface ApplyAggregateUpdate {
  instructorId: string;
  slackActivityCount: number;
  emailActivityCount: number;
  opsReportActivityCount: number;
  dispatchRequestActivityCount: number;
  lastActivityAt: Date | null;
}

export interface ActivityRegistryUpdate {
  registryKey: string;
  sourceType: "slack" | "gmail";
  matchStatus: ActivityRegistryStatus;
  suggestedInstructorId: string | null;
  resolvedInstructorId: string | null;
  resolutionBasis: string | null;
  slackActivityCount: number;
  emailActivityCount: number;
  opsReportActivityCount: number;
  dispatchRequestActivityCount: number;
  lastActivityAt: Date | null;
}

export interface ApplyActivityResult {
  items: ApplyItemCounts;
  registries: ApplyRegistryCounts;
  registryUpdates: ActivityRegistryUpdate[];
  affectedInstructorIds: string[];
  aggregateUpdates: ApplyAggregateUpdate[];
  upsertedItemIds: string[];
  unmatchedSamples: Array<{ name: string | null; email: string | null }>;
  ambiguousSamples: Array<{ name: string | null; email: string | null }>;
}

interface PendingItem {
  sourceType: "slack" | "gmail";
  sourceRef: Prisma.InputJsonObject;
  sourceRefKey: string;
  rawPayload: Prisma.InputJsonObject;
  candidateName: string | null;
  candidateEmail: string | null;
  activityAt: Date | null;
  isOpsReport: boolean;
  isDispatchRequest: boolean;
  preInvalidReason: string | null;
  fromChannelMap: boolean;
}

interface MatchCandidateResult {
  status: MatchStatus;
  instructorId: string | null;
  basis: string | null;
  errorReason: string | null;
}

interface InstructorIndex {
  nameMap: Map<string, { id: string }[]>;
  emailMap: Map<string, { id: string }[]>;
}

interface StoredActivityRow {
  id: string;
  sourceType: "slack" | "gmail";
  sourceRef: Prisma.JsonValue;
  sourceRefKey: string | null;
  rawPayload: Prisma.JsonValue;
  candidateName: string | null;
  candidateEmail: string | null;
  activityAt: Date | null;
  isOpsReport: boolean;
  isDispatchRequest: boolean;
  matchStatus: string;
  matchedInstructorId: string | null;
  matchBasis: string | null;
  errorReason: string | null;
}

interface MutableRegistryGroup {
  registryKey: string;
  sourceType: "slack" | "gmail";
  sourceRefs: Prisma.InputJsonValue[];
  sourceRefSeen: Set<string>;
  evidenceSamples: Array<Prisma.InputJsonObject>;
  candidateName: string | null;
  candidateEmail: string | null;
  suggestedInstructorId: string | null;
  suggestedResolutionBasis: string | null;
  slackActivityCount: number;
  emailActivityCount: number;
  opsReportActivityCount: number;
  dispatchRequestActivityCount: number;
  lastActivityAt: Date | null;
}

interface RegistryDecision {
  decisionType: string;
  targetInstructorId: string | null;
}

const DB_WRITE_CONCURRENCY = 16;

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const safeConcurrency = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let index = 0;

  async function runWorker() {
    while (true) {
      const current = index;
      index += 1;
      if (current >= items.length) break;
      results[current] = await worker(items[current]);
    }
  }

  await Promise.all(
    Array.from({ length: safeConcurrency }, () => runWorker())
  );
  return results;
}

function itemCompositeKey(
  sourceType: "slack" | "gmail",
  sourceRefKey: string
): string {
  return `${sourceType}::${sourceRefKey}`;
}

function slackToPending(a: NormalizedSlackActivity): PendingItem {
  return {
    sourceType: "slack",
    sourceRef: a.sourceRef as unknown as Prisma.InputJsonObject,
    sourceRefKey: a.sourceRefKey,
    rawPayload: a.rawPayload as unknown as Prisma.InputJsonObject,
    candidateName: a.candidateName,
    candidateEmail: a.candidateEmail,
    activityAt: a.activityAt,
    isOpsReport: a.isOpsReport,
    isDispatchRequest: a.isDispatchRequest,
    preInvalidReason: a.invalidReason,
    fromChannelMap: a.isDispatchRequest && Boolean(a.candidateName),
  };
}

function gmailToPending(a: NormalizedGmailActivity): PendingItem {
  return {
    sourceType: "gmail",
    sourceRef: a.sourceRef as unknown as Prisma.InputJsonObject,
    sourceRefKey: a.sourceRefKey,
    rawPayload: a.rawPayload as unknown as Prisma.InputJsonObject,
    candidateName: a.candidateName,
    candidateEmail: a.candidateEmail,
    activityAt: a.activityAt,
    isOpsReport: false,
    isDispatchRequest: false,
    preInvalidReason: a.invalidReason,
    fromChannelMap: false,
  };
}

function normalizeName(value: string | null | undefined): string | null {
  const v = value?.trim();
  return v ? v : null;
}

function normalizeEmail(value: string | null | undefined): string | null {
  const v = value?.trim().toLowerCase();
  return v ? v : null;
}

function buildRegistryKeyFromMatch(
  item: PendingItem,
  match: MatchCandidateResult
): string {
  if (match.status === "matched" && match.instructorId) {
    return `${item.sourceType}:instructor:${match.instructorId}`;
  }

  const nameKey = normalizeName(item.candidateName) ?? "";
  const emailKey = normalizeEmail(item.candidateEmail) ?? "";
  if (nameKey || emailKey) {
    return `${item.sourceType}:candidate:${nameKey}|${emailKey}`;
  }

  return `${item.sourceType}:invalid:${match.errorReason ?? "unknown"}`;
}

function buildRegistryKeyFromStored(row: StoredActivityRow): string {
  if (row.matchStatus === "matched" && row.matchedInstructorId) {
    return `${row.sourceType}:instructor:${row.matchedInstructorId}`;
  }

  const nameKey = normalizeName(row.candidateName) ?? "";
  const emailKey = normalizeEmail(row.candidateEmail) ?? "";
  if (nameKey || emailKey) {
    return `${row.sourceType}:candidate:${nameKey}|${emailKey}`;
  }

  return `${row.sourceType}:invalid:${row.errorReason ?? "unknown"}`;
}

async function buildInstructorIndex(): Promise<InstructorIndex> {
  const all = await prisma.instructor.findMany({
    select: { id: true, name: true, contactEmail: true },
  });

  const nameMap = new Map<string, { id: string }[]>();
  const emailMap = new Map<string, { id: string }[]>();

  for (const instructor of all) {
    const name = normalizeName(instructor.name);
    if (name) {
      const list = nameMap.get(name) ?? [];
      list.push({ id: instructor.id });
      nameMap.set(name, list);
    }

    const email = normalizeEmail(instructor.contactEmail);
    if (email) {
      const list = emailMap.get(email) ?? [];
      list.push({ id: instructor.id });
      emailMap.set(email, list);
    }
  }

  return { nameMap, emailMap };
}

function matchCandidate(
  item: PendingItem,
  index: InstructorIndex
): MatchCandidateResult {
  if (item.preInvalidReason) {
    return {
      status: "invalid",
      instructorId: null,
      basis: null,
      errorReason: item.preInvalidReason,
    };
  }

  const nameKey = normalizeName(item.candidateName);
  if (nameKey) {
    const byName = index.nameMap.get(nameKey);
    if (byName && byName.length === 1) {
      return {
        status: "matched",
        instructorId: byName[0].id,
        basis: item.fromChannelMap ? "channel_map" : "name",
        errorReason: null,
      };
    }
    if (byName && byName.length > 1) {
      return {
        status: "ambiguous",
        instructorId: null,
        basis: "name",
        errorReason: `multiple_name_matches:${byName.length}`,
      };
    }
  }

  const emailKey = normalizeEmail(item.candidateEmail);
  if (emailKey) {
    const byEmail = index.emailMap.get(emailKey);
    if (byEmail && byEmail.length === 1) {
      return {
        status: "matched",
        instructorId: byEmail[0].id,
        basis: "email",
        errorReason: null,
      };
    }
    if (byEmail && byEmail.length > 1) {
      return {
        status: "ambiguous",
        instructorId: null,
        basis: "email",
        errorReason: `multiple_email_matches:${byEmail.length}`,
      };
    }
  }

  if (!nameKey && !emailKey) {
    return {
      status: "unmatched",
      instructorId: null,
      basis: null,
      errorReason: "no_candidate_identifier",
    };
  }

  return {
    status: "unmatched",
    instructorId: null,
    basis: null,
    errorReason: "no_instructor_match",
  };
}

function ensureRegistryGroup(
  groups: Map<string, MutableRegistryGroup>,
  registryKey: string,
  row: StoredActivityRow
): MutableRegistryGroup {
  let group = groups.get(registryKey);
  if (group) return group;

  group = {
    registryKey,
    sourceType: row.sourceType,
    sourceRefs: [],
    sourceRefSeen: new Set<string>(),
    evidenceSamples: [],
    candidateName: normalizeName(row.candidateName),
    candidateEmail: normalizeEmail(row.candidateEmail),
    suggestedInstructorId: row.matchStatus === "matched" ? row.matchedInstructorId : null,
    suggestedResolutionBasis: row.matchStatus === "matched" ? row.matchBasis : null,
    slackActivityCount: 0,
    emailActivityCount: 0,
    opsReportActivityCount: 0,
    dispatchRequestActivityCount: 0,
    lastActivityAt: null,
  };

  groups.set(registryKey, group);
  return group;
}

function addEvidenceSample(group: MutableRegistryGroup, row: StoredActivityRow) {
  const sample: Prisma.InputJsonObject = {
    activity_at: row.activityAt ? row.activityAt.toISOString() : null,
    source_ref: row.sourceRef as Prisma.InputJsonValue,
    raw_payload: row.rawPayload as Prisma.InputJsonValue,
  };

  group.evidenceSamples.push(sample);
  group.evidenceSamples.sort((a, b) => {
    const aTs = typeof a.activity_at === "string" ? a.activity_at : "";
    const bTs = typeof b.activity_at === "string" ? b.activity_at : "";
    return aTs < bTs ? 1 : aTs > bTs ? -1 : 0;
  });
  if (group.evidenceSamples.length > 5) {
    group.evidenceSamples.length = 5;
  }
}

function buildRegistryGroups(rows: StoredActivityRow[]): Map<string, MutableRegistryGroup> {
  const groups = new Map<string, MutableRegistryGroup>();

  for (const row of rows) {
    const registryKey = buildRegistryKeyFromStored(row);
    const group = ensureRegistryGroup(groups, registryKey, row);

    if (!group.candidateName && row.candidateName) {
      group.candidateName = normalizeName(row.candidateName);
    }
    if (!group.candidateEmail && row.candidateEmail) {
      group.candidateEmail = normalizeEmail(row.candidateEmail);
    }
    if (!group.suggestedInstructorId && row.matchStatus === "matched") {
      group.suggestedInstructorId = row.matchedInstructorId;
      group.suggestedResolutionBasis = row.matchBasis;
    }

    if (row.sourceType === "slack") group.slackActivityCount += 1;
    if (row.sourceType === "gmail") group.emailActivityCount += 1;
    if (row.isOpsReport) group.opsReportActivityCount += 1;
    if (row.isDispatchRequest) group.dispatchRequestActivityCount += 1;
    if (row.activityAt && (!group.lastActivityAt || row.activityAt > group.lastActivityAt)) {
      group.lastActivityAt = row.activityAt;
    }

    if (row.sourceRefKey && !group.sourceRefSeen.has(row.sourceRefKey)) {
      group.sourceRefSeen.add(row.sourceRefKey);
      group.sourceRefs.push(row.sourceRef as Prisma.InputJsonValue);
    }

    addEvidenceSample(group, row);
  }

  return groups;
}

async function loadLatestReviewDecisions(
  registryKeys: string[]
): Promise<Map<string, RegistryDecision>> {
  if (registryKeys.length === 0) return new Map();

  const decisions = await prisma.reviewDecision.findMany({
    where: {
      registryType: "activity",
      registryKey: { in: registryKeys },
    },
    orderBy: [{ createdAt: "desc" }],
    select: {
      registryKey: true,
      decisionType: true,
      targetInstructorId: true,
    },
  });

  const latest = new Map<string, RegistryDecision>();
  for (const decision of decisions) {
    if (!latest.has(decision.registryKey)) {
      latest.set(decision.registryKey, {
        decisionType: decision.decisionType,
        targetInstructorId: decision.targetInstructorId,
      });
    }
  }
  return latest;
}

function resolveRegistryStatus(
  group: MutableRegistryGroup,
  decision: RegistryDecision | undefined
): Pick<
  ActivityRegistryUpdate,
  "matchStatus" | "suggestedInstructorId" | "resolvedInstructorId" | "resolutionBasis"
> {
  const baseStatus: ActivityRegistryStatus = group.registryKey.includes(":instructor:")
    ? "auto_accepted"
    : group.registryKey.includes(":invalid:")
      ? "invalid"
      : "pending";

  const baseResolvedInstructorId =
    baseStatus === "auto_accepted" ? group.suggestedInstructorId : null;
  const baseResolutionBasis =
    baseStatus === "auto_accepted"
      ? group.suggestedResolutionBasis ?? "auto_match"
      : null;

  if (!decision) {
    return {
      matchStatus: baseStatus,
      suggestedInstructorId: group.suggestedInstructorId,
      resolvedInstructorId: baseResolvedInstructorId,
      resolutionBasis: baseResolutionBasis,
    };
  }

  if (decision.decisionType === "reject") {
    return {
      matchStatus: "rejected",
      suggestedInstructorId: group.suggestedInstructorId,
      resolvedInstructorId: null,
      resolutionBasis: "manual_decision",
    };
  }

  if (
    decision.decisionType === "override_instructor" &&
    decision.targetInstructorId
  ) {
    return {
      matchStatus: "approved",
      suggestedInstructorId: group.suggestedInstructorId,
      resolvedInstructorId: decision.targetInstructorId,
      resolutionBasis: "manual_decision",
    };
  }

  if (decision.decisionType === "approve") {
    const resolvedInstructorId =
      decision.targetInstructorId ?? group.suggestedInstructorId ?? null;
    return {
      matchStatus: resolvedInstructorId ? "approved" : baseStatus,
      suggestedInstructorId: group.suggestedInstructorId,
      resolvedInstructorId,
      resolutionBasis: resolvedInstructorId ? "manual_decision" : baseResolutionBasis,
    };
  }

  return {
    matchStatus: baseStatus,
    suggestedInstructorId: group.suggestedInstructorId,
    resolvedInstructorId: baseResolvedInstructorId,
    resolutionBasis: baseResolutionBasis,
  };
}

function pushSample(
  samples: Array<{ name: string | null; email: string | null }>,
  name: string | null,
  email: string | null
) {
  if (samples.length >= 10) return;
  samples.push({ name, email });
}

export async function applyActivities(
  runId: string,
  slackItems: NormalizedSlackActivity[],
  gmailItems: NormalizedGmailActivity[]
): Promise<ApplyActivityResult> {
  const result: ApplyActivityResult = {
    items: {
      inserted: 0,
      updated: 0,
      matched: 0,
      unmatched: 0,
      ambiguous: 0,
      invalid: 0,
    },
    registries: {
      autoAccepted: 0,
      pending: 0,
      approved: 0,
      rejected: 0,
      invalid: 0,
    },
    registryUpdates: [],
    affectedInstructorIds: [],
    aggregateUpdates: [],
    upsertedItemIds: [],
    unmatchedSamples: [],
    ambiguousSamples: [],
  };

  const pending: PendingItem[] = [];
  for (const item of slackItems) pending.push(slackToPending(item));
  for (const item of gmailItems) pending.push(gmailToPending(item));

  if (pending.length === 0) return result;

  const instructorIndex = await buildInstructorIndex();
  const affectedRegistryKeys = new Set<string>();
  const existingItems = await prisma.activityImportItem.findMany({
    where: {
      sourceType: { in: Array.from(new Set(pending.map((item) => item.sourceType))) },
      sourceRefKey: { in: Array.from(new Set(pending.map((item) => item.sourceRefKey))) },
    },
    select: {
      id: true,
      sourceType: true,
      sourceRefKey: true,
      candidateName: true,
      candidateEmail: true,
      matchStatus: true,
      matchedInstructorId: true,
      errorReason: true,
    },
  });
  const existingMap = new Map(
    existingItems.map((item) => [
      itemCompositeKey(item.sourceType as "slack" | "gmail", item.sourceRefKey ?? ""),
      item,
    ])
  );

  const itemResults = await mapWithConcurrency(
    pending,
    DB_WRITE_CONCURRENCY,
    async (item) => {
      const match = matchCandidate(item, instructorIndex);
      const registryKey = buildRegistryKeyFromMatch(item, match);
      const existing = existingMap.get(
        itemCompositeKey(item.sourceType, item.sourceRefKey)
      );

      const data = {
        runId,
        sourceType: item.sourceType,
        sourceRef: item.sourceRef,
        sourceRefKey: item.sourceRefKey,
        rawPayload: item.rawPayload,
        candidateName: item.candidateName,
        candidateEmail: item.candidateEmail,
        activityAt: item.activityAt,
        isOpsReport: item.isOpsReport,
        isDispatchRequest: item.isDispatchRequest,
        matchStatus: match.status,
        matchedInstructorId: match.instructorId,
        matchBasis: match.basis,
        errorReason: match.errorReason,
      };

      let upsertedId: string;
      let operation: "inserted" | "updated";
      let previousRegistryKey: string | null = null;

      if (existing) {
        const updated = await prisma.activityImportItem.update({
          where: { id: existing.id },
          data,
          select: { id: true },
        });
        upsertedId = updated.id;
        operation = "updated";
        previousRegistryKey = buildRegistryKeyFromStored({
          id: existing.id,
          sourceType: existing.sourceType as "slack" | "gmail",
          sourceRef: {},
          sourceRefKey: item.sourceRefKey,
          rawPayload: {},
          candidateName: existing.candidateName,
          candidateEmail: existing.candidateEmail,
          activityAt: null,
          isOpsReport: false,
          isDispatchRequest: false,
          matchStatus: existing.matchStatus,
          matchedInstructorId: existing.matchedInstructorId,
          matchBasis: null,
          errorReason: existing.errorReason,
        });
      } else {
        const created = await prisma.activityImportItem.create({
          data,
          select: { id: true },
        });
        upsertedId = created.id;
        operation = "inserted";
      }

      return {
        matchStatus: match.status,
        candidateName: item.candidateName,
        candidateEmail: item.candidateEmail,
        registryKey,
        previousRegistryKey,
        upsertedId,
        operation,
      };
    }
  );

  for (const itemResult of itemResults) {
    if (itemResult.operation === "inserted") {
      result.items.inserted += 1;
    } else {
      result.items.updated += 1;
    }

    result.upsertedItemIds.push(itemResult.upsertedId);
    affectedRegistryKeys.add(itemResult.registryKey);
    if (itemResult.previousRegistryKey) {
      affectedRegistryKeys.add(itemResult.previousRegistryKey);
    }

    if (itemResult.matchStatus === "matched") {
      result.items.matched += 1;
    } else if (itemResult.matchStatus === "unmatched") {
      result.items.unmatched += 1;
      pushSample(
        result.unmatchedSamples,
        itemResult.candidateName,
        itemResult.candidateEmail
      );
    } else if (itemResult.matchStatus === "ambiguous") {
      result.items.ambiguous += 1;
      pushSample(
        result.ambiguousSamples,
        itemResult.candidateName,
        itemResult.candidateEmail
      );
    } else if (itemResult.matchStatus === "invalid") {
      result.items.invalid += 1;
    }
  }

  const allRows = (await prisma.activityImportItem.findMany({
    select: {
      id: true,
      sourceType: true,
      sourceRef: true,
      sourceRefKey: true,
      rawPayload: true,
      candidateName: true,
      candidateEmail: true,
      activityAt: true,
      isOpsReport: true,
      isDispatchRequest: true,
      matchStatus: true,
      matchedInstructorId: true,
      matchBasis: true,
      errorReason: true,
    },
  })) as StoredActivityRow[];

  const groups = buildRegistryGroups(allRows);
  const affectedRegistryKeyList = Array.from(affectedRegistryKeys);

  const previousRegistries = await prisma.activityReviewRegistry.findMany({
    where: { registryKey: { in: affectedRegistryKeyList } },
    select: {
      registryKey: true,
      matchStatus: true,
      resolvedInstructorId: true,
    },
  });

  const latestDecisions = await loadLatestReviewDecisions(affectedRegistryKeyList);
  const affectedInstructorIds = new Set<string>();
  for (const prev of previousRegistries) {
    if (
      prev.resolvedInstructorId &&
      ACTIVE_REGISTRY_STATUSES.includes(prev.matchStatus as ActivityRegistryStatus)
    ) {
      affectedInstructorIds.add(prev.resolvedInstructorId);
    }
  }

  const registryResults = await mapWithConcurrency(
    affectedRegistryKeyList,
    DB_WRITE_CONCURRENCY,
    async (registryKey) => {
      const group = groups.get(registryKey);

      if (!group) {
        await prisma.activityReviewRegistry.deleteMany({
          where: { registryKey },
        });
        return null;
      }

      const decision = latestDecisions.get(registryKey);
      const resolved = resolveRegistryStatus(group, decision);

      await prisma.activityReviewRegistry.upsert({
        where: { registryKey },
        create: {
          runId,
          registryKey,
          sourceType: group.sourceType,
          sourceRefs: group.sourceRefs,
          candidateName: group.candidateName,
          candidateEmail: group.candidateEmail,
          slackActivityCount: group.slackActivityCount,
          emailActivityCount: group.emailActivityCount,
          opsReportActivityCount: group.opsReportActivityCount,
          dispatchRequestActivityCount: group.dispatchRequestActivityCount,
          lastActivityAt: group.lastActivityAt,
          evidenceSamples: group.evidenceSamples,
          matchStatus: resolved.matchStatus,
          suggestedInstructorId: resolved.suggestedInstructorId,
          resolvedInstructorId: resolved.resolvedInstructorId,
          resolutionBasis: resolved.resolutionBasis,
        },
        update: {
          runId,
          sourceType: group.sourceType,
          sourceRefs: group.sourceRefs,
          candidateName: group.candidateName,
          candidateEmail: group.candidateEmail,
          slackActivityCount: group.slackActivityCount,
          emailActivityCount: group.emailActivityCount,
          opsReportActivityCount: group.opsReportActivityCount,
          dispatchRequestActivityCount: group.dispatchRequestActivityCount,
          lastActivityAt: group.lastActivityAt,
          evidenceSamples: group.evidenceSamples,
          matchStatus: resolved.matchStatus,
          suggestedInstructorId: resolved.suggestedInstructorId,
          resolvedInstructorId: resolved.resolvedInstructorId,
          resolutionBasis: resolved.resolutionBasis,
        },
      });

      return {
        registryKey,
        sourceType: group.sourceType,
        matchStatus: resolved.matchStatus,
        suggestedInstructorId: resolved.suggestedInstructorId,
        resolvedInstructorId: resolved.resolvedInstructorId,
        resolutionBasis: resolved.resolutionBasis,
        slackActivityCount: group.slackActivityCount,
        emailActivityCount: group.emailActivityCount,
        opsReportActivityCount: group.opsReportActivityCount,
        dispatchRequestActivityCount: group.dispatchRequestActivityCount,
        lastActivityAt: group.lastActivityAt,
      } satisfies ActivityRegistryUpdate;
    }
  );

  for (const registryUpdate of registryResults) {
    if (!registryUpdate) continue;
    if (
      registryUpdate.resolvedInstructorId &&
      ACTIVE_REGISTRY_STATUSES.includes(registryUpdate.matchStatus)
    ) {
      affectedInstructorIds.add(registryUpdate.resolvedInstructorId);
    }

    if (registryUpdate.matchStatus === "auto_accepted") {
      result.registries.autoAccepted += 1;
    }
    if (registryUpdate.matchStatus === "pending") {
      result.registries.pending += 1;
    }
    if (registryUpdate.matchStatus === "approved") {
      result.registries.approved += 1;
    }
    if (registryUpdate.matchStatus === "rejected") {
      result.registries.rejected += 1;
    }
    if (registryUpdate.matchStatus === "invalid") {
      result.registries.invalid += 1;
    }

    result.registryUpdates.push(registryUpdate);
  }

  result.affectedInstructorIds = Array.from(affectedInstructorIds);

  await mapWithConcurrency(
    Array.from(affectedInstructorIds),
    DB_WRITE_CONCURRENCY,
    async (instructorId) => {
      const registries = await prisma.activityReviewRegistry.findMany({
        where: {
          resolvedInstructorId: instructorId,
          matchStatus: { in: ACTIVE_REGISTRY_STATUSES },
        },
        select: {
          slackActivityCount: true,
          emailActivityCount: true,
          opsReportActivityCount: true,
          dispatchRequestActivityCount: true,
          lastActivityAt: true,
        },
      });

      let slackActivityCount = 0;
      let emailActivityCount = 0;
      let opsReportActivityCount = 0;
      let dispatchRequestActivityCount = 0;
      let maxActivityAt: Date | null = null;

      for (const registry of registries) {
        slackActivityCount += registry.slackActivityCount;
        emailActivityCount += registry.emailActivityCount;
        opsReportActivityCount += registry.opsReportActivityCount;
        dispatchRequestActivityCount += registry.dispatchRequestActivityCount;
        if (
          registry.lastActivityAt &&
          (!maxActivityAt || registry.lastActivityAt > maxActivityAt)
        ) {
          maxActivityAt = registry.lastActivityAt;
        }
      }

      const current = await prisma.instructor.findUnique({
        where: { id: instructorId },
        select: { lastActivityAt: true },
      });
      let finalLastActivityAt = current?.lastActivityAt ?? null;
      if (
        maxActivityAt &&
        (!finalLastActivityAt || maxActivityAt > finalLastActivityAt)
      ) {
        finalLastActivityAt = maxActivityAt;
      }

      await prisma.instructor.update({
        where: { id: instructorId },
        data: {
          slackActivityCount,
          emailActivityCount,
          opsReportActivityCount,
          dispatchRequestActivityCount,
          lastActivityAt: finalLastActivityAt,
        },
      });

      result.aggregateUpdates.push({
        instructorId,
        slackActivityCount,
        emailActivityCount,
        opsReportActivityCount,
        dispatchRequestActivityCount,
        lastActivityAt: finalLastActivityAt,
      });
    }
  );

  return result;
}
