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

import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";

import type { NormalizedSlackActivity } from "./slack-activity-normalizer";
import type { NormalizedGmailActivity } from "./gmail-activity-normalizer";
import {
  courseContextOverlapScore,
  extractInstructorMentionsFromOpsReportText,
  extractOpsReportCourseContext,
} from "./ops-report-text";

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
const REGISTRY_EVIDENCE_SAMPLE_LIMIT = 5;
const REGISTRY_SOURCE_REF_LIMIT = 20;

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

export interface ApplyActivityTimings {
  loadExistingMs: number;
  upsertItemsMs: number;
  registryRebuildMs: number;
  registryUpsertMs: number;
  aggregateUpdateMs: number;
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
  /** apply 단계별 소요 시간(ms). 진단용 — 성공 종료 후에도 최종 summary에 보존된다. */
  timings: ApplyActivityTimings;
}

interface ApplyActivitiesOptions {
  onProgress?: (
    stage: string,
    detail?: Record<string, unknown>
  ) => Promise<void> | void;
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
  courseSignalsByInstructor: Map<
    string,
    Array<{
      comparableText: string;
      companyName: string | null;
      startDate: Date | null;
      endDate: Date | null;
    }>
  >;
}

function extractOpsReportInstructorIdsFromText(
  text: string | null,
  index: InstructorIndex
): { ids: string[]; matchedNames: string[] } {
  if (!text) return { ids: [], matchedNames: [] };

  const matched = new Map<string, string>();
  for (const extractedName of extractInstructorMentionsFromOpsReportText(text)) {
    const candidates = index.nameMap.get(normalizeName(extractedName) ?? "");
    if (!candidates || candidates.length !== 1) continue;
    matched.set(candidates[0].id, extractedName);
  }
  const sortedNames = Array.from(index.nameMap.keys()).sort(
    (a, b) => b.length - a.length
  );

  for (const name of sortedNames) {
    if (!name || name.length < 2) continue;
    if (!text.includes(name)) continue;

    const candidates = index.nameMap.get(name) ?? [];
    if (candidates.length !== 1) continue;
    matched.set(candidates[0].id, name);
  }

  return {
    ids: Array.from(matched.keys()),
    matchedNames: Array.from(matched.values()),
  };
}

function getRawPayloadText(rawPayload: Prisma.InputJsonObject): string | null {
  const value = rawPayload.text;
  return typeof value === "string" && value.trim() ? value : null;
}

export interface StoredActivityRow {
  id: string;
  sourceType: "slack" | "gmail";
  sourceRefKey: string | null;
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

export interface HeavyActivityRow {
  id: string;
  sourceRef: Prisma.JsonValue;
  sourceRefKey: string | null;
  rawPayload: Prisma.JsonValue;
  activityAt: Date | null;
}

export interface MutableRegistryGroup {
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
  /** Phase-1 light scan에서 이 group에 속한 activityImportItem id 목록. Phase-2 heavy fetch 대상. */
  rowIds: string[];
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

type ParsedRegistrySelector =
  | {
      sourceType: "slack" | "gmail";
      kind: "instructor";
      instructorId: string;
    }
  | {
      sourceType: "slack" | "gmail";
      kind: "candidate";
      candidateName: string | null;
      candidateEmail: string | null;
    }
  | {
      sourceType: "slack" | "gmail";
      kind: "invalid";
      errorReason: string;
    };

function parseRegistryKey(key: string): ParsedRegistrySelector | null {
  const firstColon = key.indexOf(":");
  if (firstColon === -1) return null;
  const sourceType = key.slice(0, firstColon);
  if (sourceType !== "slack" && sourceType !== "gmail") return null;

  const remainder = key.slice(firstColon + 1);
  if (remainder.startsWith("instructor:")) {
    const instructorId = remainder.slice("instructor:".length);
    return instructorId
      ? {
          sourceType,
          kind: "instructor",
          instructorId,
        }
      : null;
  }

  if (remainder.startsWith("candidate:")) {
    const raw = remainder.slice("candidate:".length);
    const splitAt = raw.indexOf("|");
    if (splitAt === -1) return null;
    const candidateName = raw.slice(0, splitAt) || null;
    const candidateEmail = raw.slice(splitAt + 1) || null;
    return {
      sourceType,
      kind: "candidate",
      candidateName,
      candidateEmail,
    };
  }

  if (remainder.startsWith("invalid:")) {
    const errorReason = remainder.slice("invalid:".length);
    return errorReason
      ? {
          sourceType,
          kind: "invalid",
          errorReason,
        }
      : null;
  }

  return null;
}

async function loadLightRowsForAffectedRegistries(
  registryKeys: readonly string[]
): Promise<StoredActivityRow[]> {
  if (registryKeys.length === 0) return [];

  const selectors = registryKeys
    .map(parseRegistryKey)
    .filter((selector): selector is ParsedRegistrySelector => Boolean(selector));
  if (selectors.length === 0) return [];

  const orClauses: Prisma.ActivityImportItemWhereInput[] = selectors.map(
    (selector) => {
      if (selector.kind === "instructor") {
        return {
          sourceType: selector.sourceType,
          matchStatus: "matched",
          matchedInstructorId: selector.instructorId,
        };
      }

      if (selector.kind === "candidate") {
        return {
          sourceType: selector.sourceType,
          matchStatus: { not: "matched" },
          candidateName: selector.candidateName,
          candidateEmail: selector.candidateEmail,
        };
      }

      return {
        sourceType: selector.sourceType,
        matchStatus: { not: "matched" },
        candidateName: null,
        candidateEmail: null,
        errorReason: selector.errorReason,
      };
    }
  );

  return (await prisma.activityImportItem.findMany({
    where: {
      OR: orClauses,
    },
    select: {
      id: true,
      sourceType: true,
      sourceRefKey: true,
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
}

async function buildInstructorIndex(filters?: {
  names?: string[];
  emails?: string[];
  includeCourseSignals?: boolean;
}): Promise<InstructorIndex> {
  const names = Array.from(new Set((filters?.names ?? []).filter(Boolean)));
  const emails = Array.from(new Set((filters?.emails ?? []).filter(Boolean)));
  const includeCourseSignals = Boolean(filters?.includeCourseSignals);

  const all =
    names.length === 0 && emails.length === 0
      ? await prisma.instructor.findMany({
          select: {
            id: true,
            name: true,
            contactEmail: true,
            teachingHistories: includeCourseSignals
              ? {
                  select: {
                    companyName: true,
                    courseName: true,
                    startDate: true,
                    endDate: true,
                  },
                }
              : false,
          },
        })
      : await prisma.instructor.findMany({
          where: {
            OR: [
              ...(names.length > 0 ? [{ name: { in: names } }] : []),
              ...(emails.length > 0
                ? [{ contactEmail: { in: emails } }]
                : []),
            ],
          },
          select: {
            id: true,
            name: true,
            contactEmail: true,
            teachingHistories: includeCourseSignals
              ? {
                  select: {
                    companyName: true,
                    courseName: true,
                    startDate: true,
                    endDate: true,
                  },
                }
              : false,
          },
        });

  const nameMap = new Map<string, { id: string }[]>();
  const emailMap = new Map<string, { id: string }[]>();
  const courseSignalsByInstructor = new Map<
    string,
    Array<{
      comparableText: string;
      companyName: string | null;
      startDate: Date | null;
      endDate: Date | null;
    }>
  >();

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

    if (includeCourseSignals && Array.isArray(instructor.teachingHistories)) {
      const signals = instructor.teachingHistories
        .map((history) => {
          const comparableText = [history.companyName, history.courseName]
            .filter((value): value is string => Boolean(value && value.trim()))
            .join(" ");
          if (!comparableText.trim()) return null;
          return {
            comparableText,
            companyName: history.companyName ?? null,
            startDate: history.startDate ?? null,
            endDate: history.endDate ?? null,
          };
        })
        .filter((value): value is NonNullable<typeof value> => Boolean(value));

      if (signals.length > 0) {
        courseSignalsByInstructor.set(instructor.id, signals);
      }
    }
  }

  return { nameMap, emailMap, courseSignalsByInstructor };
}

function getOpsReportDateBonus(
  activityAt: Date | null,
  signal: { startDate: Date | null; endDate: Date | null }
): number {
  if (!activityAt) return 0;
  const candidates = [signal.startDate, signal.endDate].filter(
    (value): value is Date => Boolean(value)
  );
  if (candidates.length === 0) return 0;

  const diffDays = Math.min(
    ...candidates.map((date) =>
      Math.abs(activityAt.getTime() - date.getTime()) / (1000 * 60 * 60 * 24)
    )
  );
  if (diffDays <= 30) return 3;
  if (diffDays <= 90) return 2;
  if (diffDays <= 180) return 1;
  return 0;
}

function resolveOpsReportInstructorByCourseContext(
  item: PendingItem,
  index: InstructorIndex,
  instructorIds: string[]
): string | null {
  const text = getRawPayloadText(item.rawPayload);
  const courseContext = extractOpsReportCourseContext(text);
  if (!courseContext) return null;

  const scored = instructorIds
    .map((instructorId) => {
      const signals = index.courseSignalsByInstructor.get(instructorId) ?? [];
      let bestScore = 0;

      for (const signal of signals) {
        const score =
          courseContextOverlapScore(
            courseContext,
            signal.comparableText,
            signal.companyName
          ) + getOpsReportDateBonus(item.activityAt, signal);
        bestScore = Math.max(bestScore, score);
      }

      return { instructorId, score: bestScore };
    })
    .sort((left, right) => right.score - left.score);

  const best = scored[0];
  const second = scored[1];
  if (!best || best.score < 4) return null;
  if (second && best.score - second.score < 1.5) return null;
  return best.instructorId;
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

  if (item.isOpsReport) {
    const text = getRawPayloadText(item.rawPayload);
    const mentioned = extractOpsReportInstructorIdsFromText(text, index);
    if (mentioned.ids.length === 1) {
      return {
        status: "matched",
        instructorId: mentioned.ids[0],
        basis: "ops_report_text",
        errorReason: null,
      };
    }
    if (mentioned.ids.length > 1) {
      const resolvedByCourse = resolveOpsReportInstructorByCourseContext(
        item,
        index,
        mentioned.ids
      );
      if (resolvedByCourse) {
        return {
          status: "matched",
          instructorId: resolvedByCourse,
          basis: "ops_report_course_context",
          errorReason: null,
        };
      }
      return {
        status: "ambiguous",
        instructorId: null,
        basis: "ops_report_text",
        errorReason: `multiple_ops_report_name_matches:${mentioned.matchedNames.join(",")}`,
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
    rowIds: [],
  };

  groups.set(registryKey, group);
  return group;
}

/**
 * Phase-1: scalar 컬럼만 가진 light rows로 registry group counts + rowIds를 빌드한다.
 * sourceRefs/evidenceSamples는 여기서 비어 있다. Phase-2에서 affected group만 채운다.
 */
export function buildRegistryGroups(rows: StoredActivityRow[]): Map<string, MutableRegistryGroup> {
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

    group.rowIds.push(row.id);
  }

  return groups;
}

/**
 * Phase-2: affected registry group에 한정해 heavy JSON(rawPayload, sourceRef)을 붙인다.
 * upsert에 필요한 sourceRefs dedup list + evidenceSamples(top 5 by activityAt)를 여기서 채운다.
 */
export function augmentAffectedGroupsWithHeavy(
  groups: Map<string, MutableRegistryGroup>,
  affectedKeys: readonly string[],
  heavyRows: readonly HeavyActivityRow[]
): void {
  if (affectedKeys.length === 0 || heavyRows.length === 0) return;

  const heavyById = new Map(heavyRows.map((row) => [row.id, row]));

  for (const key of affectedKeys) {
    const group = groups.get(key);
    if (!group) continue;

    for (const rowId of group.rowIds) {
      const heavy = heavyById.get(rowId);
      if (!heavy) continue;

      if (heavy.sourceRefKey && !group.sourceRefSeen.has(heavy.sourceRefKey)) {
        group.sourceRefSeen.add(heavy.sourceRefKey);
        group.sourceRefs.push(heavy.sourceRef as Prisma.InputJsonValue);
      }

      group.evidenceSamples.push({
        activity_at: heavy.activityAt ? heavy.activityAt.toISOString() : null,
        source_ref: heavy.sourceRef as Prisma.InputJsonValue,
        raw_payload: heavy.rawPayload as Prisma.InputJsonValue,
      });
    }

    // sort by activity_at desc, keep top 5 (addEvidenceSample의 이전 동작과 동일)
    group.evidenceSamples.sort((a, b) => {
      const aTs = typeof a.activity_at === "string" ? a.activity_at : "";
      const bTs = typeof b.activity_at === "string" ? b.activity_at : "";
      return aTs < bTs ? 1 : aTs > bTs ? -1 : 0;
    });
    if (group.evidenceSamples.length > 5) {
      group.evidenceSamples.length = 5;
    }
  }
}

function collectHeavyRowIdsForAffectedGroups(
  groups: Map<string, MutableRegistryGroup>,
  affectedKeys: readonly string[],
  lightRowsById: ReadonlyMap<string, StoredActivityRow>
): Set<string> {
  const selectedIds = new Set<string>();

  for (const key of affectedKeys) {
    const group = groups.get(key);
    if (!group) continue;

    const rows = group.rowIds
      .map((id) => lightRowsById.get(id))
      .filter((row): row is StoredActivityRow => Boolean(row))
      .sort((a, b) => {
        const aTs = a.activityAt?.getTime() ?? 0;
        const bTs = b.activityAt?.getTime() ?? 0;
        return bTs - aTs;
      });

    const evidenceRows = rows.slice(0, REGISTRY_EVIDENCE_SAMPLE_LIMIT);
    for (const row of evidenceRows) {
      selectedIds.add(row.id);
    }

    const seenSourceRefKeys = new Set<string>();
    for (const row of rows) {
      if (!row.sourceRefKey || seenSourceRefKeys.has(row.sourceRefKey)) continue;
      seenSourceRefKeys.add(row.sourceRefKey);
      selectedIds.add(row.id);
      if (seenSourceRefKeys.size >= REGISTRY_SOURCE_REF_LIMIT) break;
    }
  }

  return selectedIds;
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
  gmailItems: NormalizedGmailActivity[],
  options?: ApplyActivitiesOptions
): Promise<ApplyActivityResult> {
  const emitProgress = async (
    stage: string,
    detail?: Record<string, unknown>
  ) => {
    if (!options?.onProgress) return;
    try {
      await options.onProgress(stage, detail);
    } catch (err) {
      console.warn(
        `[applyActivities] onProgress callback failed at stage=${stage}:`,
        err
      );
    }
  };

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
    timings: {
      loadExistingMs: 0,
      upsertItemsMs: 0,
      registryRebuildMs: 0,
      registryUpsertMs: 0,
      aggregateUpdateMs: 0,
    },
  };

  const pending: PendingItem[] = [];
  for (const item of slackItems) pending.push(slackToPending(item));
  for (const item of gmailItems) pending.push(gmailToPending(item));

  if (pending.length === 0) return result;

  const currentSourceTypes = Array.from(
    new Set(pending.map((item) => item.sourceType))
  );
  const pendingNames = Array.from(
    new Set(
      pending
        .map((item) => normalizeName(item.candidateName))
        .filter((value): value is string => Boolean(value))
    )
  );
  const pendingEmails = Array.from(
    new Set(
      pending
        .map((item) => normalizeEmail(item.candidateEmail))
        .filter((value): value is string => Boolean(value))
    )
  );
  await emitProgress("load_existing_items_start", {
    pending_items: pending.length,
    source_types: currentSourceTypes.join(","),
    candidate_names: pendingNames.length,
    candidate_emails: pendingEmails.length,
  });
  const loadExistingStartedAt = Date.now();
  const hasOpsReportItems = pending.some((item) => item.isOpsReport);
  const instructorIndex = await buildInstructorIndex(
    hasOpsReportItems
      ? { includeCourseSignals: true }
      : {
          names: pendingNames,
          emails: pendingEmails,
        }
  );
  const affectedRegistryKeys = new Set<string>();
  const existingItems = await prisma.activityImportItem.findMany({
    where: {
      sourceType: { in: currentSourceTypes },
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
  result.timings.loadExistingMs = Date.now() - loadExistingStartedAt;
  await emitProgress("load_existing_items_done", {
    load_existing_ms: result.timings.loadExistingMs,
    existing_items: existingItems.length,
  });

  await emitProgress("upsert_items_start", {
    pending_items: pending.length,
  });
  const upsertItemsStartedAt = Date.now();

  // Step 1 (pure in-memory): 모든 pending item에 대해 match 결과와 previousRegistryKey를 미리 계산.
  // DB 접근이 없어 빠르고, batched UPSERT에 필요한 모든 값을 확보한다.
  const prepared = pending.map((item) => {
    const match = matchCandidate(item, instructorIndex);
    const registryKey = buildRegistryKeyFromMatch(item, match);
    const existing = existingMap.get(
      itemCompositeKey(item.sourceType, item.sourceRefKey)
    );
    const previousRegistryKey = existing
      ? buildRegistryKeyFromStored({
          id: existing.id,
          sourceType: existing.sourceType as "slack" | "gmail",
          sourceRefKey: item.sourceRefKey,
          candidateName: existing.candidateName,
          candidateEmail: existing.candidateEmail,
          activityAt: null,
          isOpsReport: false,
          isDispatchRequest: false,
          matchStatus: existing.matchStatus,
          matchedInstructorId: existing.matchedInstructorId,
          matchBasis: null,
          errorReason: existing.errorReason,
        })
      : null;
    return { item, match, registryKey, previousRegistryKey };
  });

  // Step 2 (batched DB): INSERT ... ON CONFLICT DO UPDATE via raw SQL.
  // 2113개 pending이어도 ~5 roundtrip(500/batch)으로 처리된다.
  // Postgres 전용 idiom: RETURNING (xmax = 0) AS inserted — 새로 삽입된 row는 xmax=0, update된 row는 non-zero.
  // 이 한 줄 덕분에 insert/update 구분을 위한 추가 SELECT가 필요 없다.
  const UPSERT_BATCH_SIZE = 500;
  type UpsertedRow = { id: string; source_ref_key: string; inserted: boolean };
  const upsertedResults: UpsertedRow[] = [];
  for (let i = 0; i < prepared.length; i += UPSERT_BATCH_SIZE) {
    const batch = prepared.slice(i, i + UPSERT_BATCH_SIZE);
    const rows = await prisma.$queryRaw<UpsertedRow[]>`
      INSERT INTO activity_import_items (
        id, run_id, source_type, source_ref, source_ref_key, raw_payload,
        candidate_name, candidate_email, activity_at,
        is_ops_report, is_dispatch_request,
        match_status, matched_instructor_id, match_basis, error_reason,
        created_at, updated_at
      )
      VALUES ${Prisma.join(
        batch.map(
          (p) => Prisma.sql`(
            ${randomUUID()}::uuid,
            ${runId}::uuid,
            ${p.item.sourceType},
            ${JSON.stringify(p.item.sourceRef)}::jsonb,
            ${p.item.sourceRefKey},
            ${JSON.stringify(p.item.rawPayload)}::jsonb,
            ${p.item.candidateName},
            ${p.item.candidateEmail},
            ${p.item.activityAt},
            ${p.item.isOpsReport},
            ${p.item.isDispatchRequest},
            ${p.match.status},
            ${p.match.instructorId}::uuid,
            ${p.match.basis},
            ${p.match.errorReason},
            NOW(),
            NOW()
          )`
        )
      )}
      ON CONFLICT (source_type, source_ref_key) DO UPDATE SET
        run_id = EXCLUDED.run_id,
        source_ref = EXCLUDED.source_ref,
        raw_payload = EXCLUDED.raw_payload,
        candidate_name = EXCLUDED.candidate_name,
        candidate_email = EXCLUDED.candidate_email,
        activity_at = EXCLUDED.activity_at,
        is_ops_report = EXCLUDED.is_ops_report,
        is_dispatch_request = EXCLUDED.is_dispatch_request,
        match_status = EXCLUDED.match_status,
        matched_instructor_id = EXCLUDED.matched_instructor_id,
        match_basis = EXCLUDED.match_basis,
        error_reason = EXCLUDED.error_reason,
        updated_at = NOW()
      RETURNING id, source_ref_key, (xmax = 0) AS inserted
    `;
    upsertedResults.push(...rows);
  }

  // Step 3 (in-memory join): sourceRefKey로 DB 결과를 pending 순서에 매핑 → itemResults 재구성
  const upsertedBySourceRefKey = new Map(
    upsertedResults.map((row) => [row.source_ref_key, row])
  );
  const itemResults = prepared.map((p) => {
    const upserted = upsertedBySourceRefKey.get(p.item.sourceRefKey);
    if (!upserted) {
      throw new Error(
        `Batch upsert missing result for sourceRefKey=${p.item.sourceRefKey}`
      );
    }
    return {
      matchStatus: p.match.status,
      candidateName: p.item.candidateName,
      candidateEmail: p.item.candidateEmail,
      registryKey: p.registryKey,
      previousRegistryKey: p.previousRegistryKey,
      upsertedId: upserted.id,
      operation: (upserted.inserted ? "inserted" : "updated") as
        | "inserted"
        | "updated",
    };
  });

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
  result.timings.upsertItemsMs = Date.now() - upsertItemsStartedAt;
  await emitProgress("upsert_items_done", {
    upsert_items_ms: result.timings.upsertItemsMs,
    inserted: result.items.inserted,
    updated: result.items.updated,
    matched: result.items.matched,
    unmatched: result.items.unmatched,
    ambiguous: result.items.ambiguous,
    invalid: result.items.invalid,
  });

  // Phase-1 light scan: heavy JSON(rawPayload, sourceRef) 제외하고 scalar만 읽는다.
  // 전체 count + rowIds만 필요한 단계라 payload를 가져올 이유가 없다.
  await emitProgress("registry_rebuild_start", {
    source_types: currentSourceTypes.join(","),
    affected_registry_keys: affectedRegistryKeys.size,
  });
  const registryRebuildStartedAt = Date.now();
  const affectedRegistryKeyList = Array.from(affectedRegistryKeys);
  const loadLightRowsStartedAt = Date.now();
  const allRows = await loadLightRowsForAffectedRegistries(
    affectedRegistryKeyList
  );
  const lightRowsById = new Map(allRows.map((row) => [row.id, row]));
  const buildGroupsStartedAt = Date.now();
  const groups = buildRegistryGroups(allRows);

  // Phase-2 heavy fetch: affected registry group에 속한 rowIds만 heavy JSON을 읽는다.
  const affectedRowIds = collectHeavyRowIdsForAffectedGroups(
    groups,
    affectedRegistryKeyList,
    lightRowsById
  );
  const loadHeavyRowsStartedAt = Date.now();
  const heavyRows =
    affectedRowIds.size === 0
      ? []
      : ((await prisma.activityImportItem.findMany({
          where: { id: { in: Array.from(affectedRowIds) } },
          select: {
            id: true,
            sourceRef: true,
            sourceRefKey: true,
            rawPayload: true,
            activityAt: true,
          },
        })) as HeavyActivityRow[]);
  const augmentGroupsStartedAt = Date.now();
  augmentAffectedGroupsWithHeavy(groups, affectedRegistryKeyList, heavyRows);
  result.timings.registryRebuildMs = Date.now() - registryRebuildStartedAt;
  await emitProgress("registry_rebuild_done", {
    registry_rebuild_ms: result.timings.registryRebuildMs,
    load_light_rows_ms: Date.now() - loadLightRowsStartedAt,
    build_groups_ms: Date.now() - buildGroupsStartedAt,
    load_heavy_rows_ms: Date.now() - loadHeavyRowsStartedAt,
    augment_groups_ms: Date.now() - augmentGroupsStartedAt,
    scanned_rows: allRows.length,
    group_count: groups.size,
    affected_registry_keys: affectedRegistryKeyList.length,
    affected_row_ids: affectedRowIds.size,
    heavy_rows: heavyRows.length,
  });

  await emitProgress("registry_upsert_start", {
    affected_registry_keys: affectedRegistryKeyList.length,
  });
  const registryUpsertStartedAt = Date.now();
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

  const registryResults: ActivityRegistryUpdate[] = [];
  const missingRegistryKeys = affectedRegistryKeyList.filter(
    (registryKey) => !groups.has(registryKey)
  );
  if (missingRegistryKeys.length > 0) {
    await prisma.activityReviewRegistry.deleteMany({
      where: { registryKey: { in: missingRegistryKeys } },
    });
  }

  const registryPayloads = affectedRegistryKeyList
    .map((registryKey) => {
      const group = groups.get(registryKey);
      if (!group) return null;

      const decision = latestDecisions.get(registryKey);
      const resolved = resolveRegistryStatus(group, decision);

      return {
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
      };
    })
    .filter((payload): payload is NonNullable<typeof payload> => Boolean(payload));

  const REGISTRY_UPSERT_BATCH_SIZE = 500;
  for (let i = 0; i < registryPayloads.length; i += REGISTRY_UPSERT_BATCH_SIZE) {
    const batch = registryPayloads.slice(i, i + REGISTRY_UPSERT_BATCH_SIZE);
    if (batch.length === 0) continue;

    await prisma.$executeRaw`
      INSERT INTO activity_review_registries (
        id, run_id, registry_key, source_type, source_refs,
        candidate_name, candidate_email,
        slack_activity_count, email_activity_count,
        ops_report_activity_count, dispatch_request_activity_count,
        last_activity_at, evidence_samples,
        match_status, suggested_instructor_id, resolved_instructor_id, resolution_basis,
        created_at, updated_at
      )
      VALUES ${Prisma.join(
        batch.map(
          (payload) => Prisma.sql`(
            ${randomUUID()}::uuid,
            ${runId}::uuid,
            ${payload.registryKey},
            ${payload.sourceType},
            ${JSON.stringify(payload.sourceRefs)}::jsonb,
            ${payload.candidateName},
            ${payload.candidateEmail},
            ${payload.slackActivityCount},
            ${payload.emailActivityCount},
            ${payload.opsReportActivityCount},
            ${payload.dispatchRequestActivityCount},
            ${payload.lastActivityAt},
            ${JSON.stringify(payload.evidenceSamples)}::jsonb,
            ${payload.matchStatus},
            ${payload.suggestedInstructorId}::uuid,
            ${payload.resolvedInstructorId}::uuid,
            ${payload.resolutionBasis},
            NOW(),
            NOW()
          )`
        )
      )}
      ON CONFLICT (registry_key) DO UPDATE SET
        run_id = EXCLUDED.run_id,
        source_type = EXCLUDED.source_type,
        source_refs = EXCLUDED.source_refs,
        candidate_name = EXCLUDED.candidate_name,
        candidate_email = EXCLUDED.candidate_email,
        slack_activity_count = EXCLUDED.slack_activity_count,
        email_activity_count = EXCLUDED.email_activity_count,
        ops_report_activity_count = EXCLUDED.ops_report_activity_count,
        dispatch_request_activity_count = EXCLUDED.dispatch_request_activity_count,
        last_activity_at = EXCLUDED.last_activity_at,
        evidence_samples = EXCLUDED.evidence_samples,
        match_status = EXCLUDED.match_status,
        suggested_instructor_id = EXCLUDED.suggested_instructor_id,
        resolved_instructor_id = EXCLUDED.resolved_instructor_id,
        resolution_basis = EXCLUDED.resolution_basis,
        updated_at = NOW()
    `;

    for (const payload of batch) {
      registryResults.push({
        registryKey: payload.registryKey,
        sourceType: payload.sourceType,
        matchStatus: payload.matchStatus,
        suggestedInstructorId: payload.suggestedInstructorId,
        resolvedInstructorId: payload.resolvedInstructorId,
        resolutionBasis: payload.resolutionBasis,
        slackActivityCount: payload.slackActivityCount,
        emailActivityCount: payload.emailActivityCount,
        opsReportActivityCount: payload.opsReportActivityCount,
        dispatchRequestActivityCount: payload.dispatchRequestActivityCount,
        lastActivityAt: payload.lastActivityAt,
      });
    }
  }

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
  result.timings.registryUpsertMs = Date.now() - registryUpsertStartedAt;
  await emitProgress("registry_upsert_done", {
    registry_upsert_ms: result.timings.registryUpsertMs,
    previous_registries: previousRegistries.length,
    registry_updates: result.registryUpdates.length,
    auto_accepted: result.registries.autoAccepted,
    pending: result.registries.pending,
    approved: result.registries.approved,
    rejected: result.registries.rejected,
    invalid: result.registries.invalid,
  });

  result.affectedInstructorIds = Array.from(affectedInstructorIds);

  await emitProgress("aggregate_update_start", {
    affected_instructors: result.affectedInstructorIds.length,
  });
  const aggregateUpdateStartedAt = Date.now();
  const affectedInstructorIdList = Array.from(affectedInstructorIds);
  const activeRegistries =
    affectedInstructorIdList.length > 0
      ? await prisma.activityReviewRegistry.findMany({
          where: {
            resolvedInstructorId: { in: affectedInstructorIdList },
            matchStatus: { in: ACTIVE_REGISTRY_STATUSES },
          },
          select: {
            resolvedInstructorId: true,
            slackActivityCount: true,
            emailActivityCount: true,
            opsReportActivityCount: true,
            dispatchRequestActivityCount: true,
            lastActivityAt: true,
          },
        })
      : [];
  const currentInstructors =
    affectedInstructorIdList.length > 0
      ? await prisma.instructor.findMany({
          where: { id: { in: affectedInstructorIdList } },
          select: { id: true, lastActivityAt: true },
        })
      : [];
  const currentInstructorById = new Map(
    currentInstructors.map((instructor) => [instructor.id, instructor])
  );
  const activeRegistriesByInstructor = new Map<
    string,
    typeof activeRegistries
  >();
  for (const registry of activeRegistries) {
    if (!registry.resolvedInstructorId) continue;
    const bucket =
      activeRegistriesByInstructor.get(registry.resolvedInstructorId) ?? [];
    bucket.push(registry);
    activeRegistriesByInstructor.set(registry.resolvedInstructorId, bucket);
  }

  await mapWithConcurrency(
    affectedInstructorIdList,
    DB_WRITE_CONCURRENCY,
    async (instructorId) => {
      const registries = activeRegistriesByInstructor.get(instructorId) ?? [];

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

      let finalLastActivityAt =
        currentInstructorById.get(instructorId)?.lastActivityAt ?? null;
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
  result.timings.aggregateUpdateMs = Date.now() - aggregateUpdateStartedAt;
  await emitProgress("aggregate_update_done", {
    aggregate_update_ms: result.timings.aggregateUpdateMs,
    affected_instructors: affectedInstructorIdList.length,
    active_registries: activeRegistries.length,
    aggregate_updates: result.aggregateUpdates.length,
  });

  await emitProgress("done", {
    inserted: result.items.inserted,
    updated: result.items.updated,
    registry_updates: result.registryUpdates.length,
    aggregate_updates: result.aggregateUpdates.length,
  });
  return result;
}
