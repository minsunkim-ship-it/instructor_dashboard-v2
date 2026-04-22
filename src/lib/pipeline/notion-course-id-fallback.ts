import { prisma } from "@/lib/prisma";
import { collectNotionPageContentLines } from "@/lib/notion-enrichment";
import {
  sanitizeCourseNameCandidate,
  type CourseIdFallbackEntry,
} from "./course-id-fallback.ts";
import type { NormalizedContractRow } from "./contract-sheet-normalizer.ts";

const PAGE_FETCH_CONCURRENCY = 2;
const CLUSTER_SIMILARITY_THRESHOLD = 0.6;
const CLUSTER_ACCEPT_SCORE_MARGIN = 20;

const COURSE_HISTORY_SECTION_PATTERN = /(주요 강의이력|\[강의 ?이력\])/u;
const SECTION_END_PATTERN = /세부정보$/u;
const YEAR_MARKER_PATTERN = /^(20\d{2})Y(?:\s*-\s*(20\d{2})Y)?$/u;

const TOKEN_STOPWORDS = new Set([
  "과정",
  "교육",
  "특강",
  "세미나",
  "과정과",
  "아카데미",
  "업무",
  "활용",
  "대상",
  "기초",
  "입문",
  "심화",
  "현업",
  "직무",
  "양성",
  "양성과정",
  "강화",
  "역량강화",
  "업무활용",
  "생성형",
  "디지털",
  "멘토",
  "채점",
  "문항",
  "개발",
  "평가",
  "평가문항",
  "계약서",
  "프로젝트",
  "용역",
  "자문",
  "운영",
  "연간",
  "년",
]);

const globalForNotionCourseIdFallback = globalThis as typeof globalThis & {
  __notionCourseHistoryEntryCache?:
    | Map<string, Promise<NotionTeachingHistoryEntry[]> | NotionTeachingHistoryEntry[]>
    | undefined;
};

export interface NotionTeachingHistoryEntry {
  courseName: string;
  tokens: string[];
  years: number[];
}

export interface NotionCourseIdFallbackInput {
  courseId: string;
  notionPageId: string;
  instructorName: string;
  referenceYears: number[];
}

interface NotionClusterEntry extends NotionTeachingHistoryEntry {
  notionPageId: string;
  instructorName: string;
  yearMatched: boolean;
}

interface NotionCluster {
  representative: NotionClusterEntry;
  entries: NotionClusterEntry[];
  pageIds: Set<string>;
  yearMatchedPageIds: Set<string>;
  instructorNames: Set<string>;
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function parseYearMarker(line: string): number[] {
  if (!YEAR_MARKER_PATTERN.test(line)) return [];
  const matches = line.match(/20\d{2}/g) ?? [];
  return Array.from(
    new Set(matches.map((value) => Number.parseInt(value, 10)).filter(Number.isFinite))
  );
}

function tokenizeCourseName(courseName: string): string[] {
  const rawTokens = courseName.match(/[A-Za-z]+|[가-힣0-9]+/gu) ?? [];
  const normalizedTokens = rawTokens
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 2)
    .filter((token) => !TOKEN_STOPWORDS.has(token))
    .filter((token) => !/^\d+$/.test(token))
    .filter((token) => !/^20\d{2}$/.test(token))
    .filter((token) => !/^\d{2}년$/.test(token));

  return Array.from(new Set(normalizedTokens));
}

function looksLikeTeachingHistoryEntry(courseName: string): boolean {
  if (!courseName) return false;
  if (courseName.length < 6) return false;
  if (/^(현|前)\s/u.test(courseName)) return false;
  if (/^(강사 프로필|주요 경력사항)$/u.test(courseName)) return false;
  if (!/[가-힣A-Za-z]/u.test(courseName)) return false;

  return /[_|ㅣ]|과정|교육|특강|세미나|해커톤|캠프|워크숍|워크샵|Citizen|Developer|Agent|AI|AX|DX|ChatGPT|SQL|Python|마케팅|데이터/u.test(
    courseName
  );
}

export function extractTeachingHistoryEntriesFromNotionLines(
  lines: string[]
): NotionTeachingHistoryEntry[] {
  const entries: NotionTeachingHistoryEntry[] = [];
  const seen = new Set<string>();
  let inCourseHistorySection = false;
  let currentYears: number[] = [];

  for (const rawLine of lines) {
    const line = normalizeText(rawLine);
    if (!line) continue;

    if (COURSE_HISTORY_SECTION_PATTERN.test(line)) {
      inCourseHistorySection = true;
      currentYears = [];
      continue;
    }

    if (!inCourseHistorySection) continue;
    if (SECTION_END_PATTERN.test(line)) break;

    const yearMarker = parseYearMarker(line);
    if (yearMarker.length > 0) {
      currentYears = yearMarker;
      continue;
    }

    const courseName = sanitizeCourseNameCandidate(line);
    if (!courseName) continue;
    if (!looksLikeTeachingHistoryEntry(courseName)) continue;

    const tokens = tokenizeCourseName(courseName);
    if (tokens.length === 0) continue;

    const dedupeKey = `${courseName}::${currentYears.join(",")}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    entries.push({
      courseName,
      tokens,
      years: [...currentYears],
    });
  }

  return entries;
}

function overlapCoefficient(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const rightSet = new Set(right);
  let intersection = 0;
  for (const token of left) {
    if (rightSet.has(token)) intersection += 1;
  }
  return intersection / Math.min(left.length, right.length);
}

function hasYearMatch(entry: NotionTeachingHistoryEntry, targetYears: Set<number>): boolean {
  if (targetYears.size === 0) return false;
  return entry.years.some((year) => targetYears.has(year));
}

function selectRepresentativeEntry(
  cluster: NotionCluster,
  targetYears: Set<number>
): NotionClusterEntry {
  return [...cluster.entries].sort((left, right) => {
    const leftYearMatch = hasYearMatch(left, targetYears) ? 1 : 0;
    const rightYearMatch = hasYearMatch(right, targetYears) ? 1 : 0;
    if (leftYearMatch !== rightYearMatch) {
      return rightYearMatch - leftYearMatch;
    }
    if (left.courseName.length !== right.courseName.length) {
      return left.courseName.length - right.courseName.length;
    }
    return left.courseName.localeCompare(right.courseName, "ko");
  })[0]!;
}

function scoreCluster(cluster: NotionCluster, targetYears: Set<number>): number {
  const representative = selectRepresentativeEntry(cluster, targetYears);
  return (
    cluster.pageIds.size * 100 +
    cluster.yearMatchedPageIds.size * 30 +
    cluster.entries.length * 5 +
    representative.tokens.length
  );
}

function buildCluster(
  entry: NotionClusterEntry
): NotionCluster {
  return {
    representative: entry,
    entries: [entry],
    pageIds: new Set([entry.notionPageId]),
    yearMatchedPageIds: entry.yearMatched
      ? new Set([entry.notionPageId])
      : new Set<string>(),
    instructorNames: new Set([entry.instructorName]),
  };
}

function addEntryToCluster(
  cluster: NotionCluster,
  entry: NotionClusterEntry,
  targetYears: Set<number>
): void {
  cluster.entries.push(entry);
  cluster.pageIds.add(entry.notionPageId);
  cluster.instructorNames.add(entry.instructorName);
  if (entry.yearMatched) {
    cluster.yearMatchedPageIds.add(entry.notionPageId);
  }
  cluster.representative = selectRepresentativeEntry(cluster, targetYears);
}

function shouldAcceptCluster(
  clusters: NotionCluster[],
  bestCluster: NotionCluster,
  targetYears: Set<number>,
  distinctInputPages: number
): boolean {
  const scored = clusters
    .map((cluster) => ({
      cluster,
      score: scoreCluster(cluster, targetYears),
    }))
    .sort((left, right) => right.score - left.score);

  const best = scored[0];
  if (!best) return false;
  const second = scored[1];

  if (
    bestCluster.pageIds.size >= 2 &&
    (!second || best.score - second.score >= CLUSTER_ACCEPT_SCORE_MARGIN)
  ) {
    return true;
  }

  if (
    distinctInputPages === 1 &&
    bestCluster.pageIds.size === 1 &&
    bestCluster.entries.length === 1 &&
    bestCluster.yearMatchedPageIds.size === 1
  ) {
    return true;
  }

  return false;
}

export function buildNotionCourseIdFallbackRegistryFromEntries(args: {
  inputs: NotionCourseIdFallbackInput[];
  entriesByPageId: ReadonlyMap<string, NotionTeachingHistoryEntry[]>;
}): Map<string, CourseIdFallbackEntry> {
  const registry = new Map<string, CourseIdFallbackEntry>();
  const grouped = new Map<string, NotionCourseIdFallbackInput[]>();

  for (const input of args.inputs) {
    const bucket = grouped.get(input.courseId) ?? [];
    bucket.push(input);
    grouped.set(input.courseId, bucket);
  }

  for (const [courseId, inputs] of grouped) {
    const targetYears = new Set(
      inputs.flatMap((input) => input.referenceYears).filter(Number.isFinite)
    );
    const distinctInputPages = new Set(inputs.map((input) => input.notionPageId)).size;
    const clusters: NotionCluster[] = [];

    for (const input of inputs) {
      const pageEntries = args.entriesByPageId.get(input.notionPageId) ?? [];
      for (const pageEntry of pageEntries) {
        const clusterEntry: NotionClusterEntry = {
          ...pageEntry,
          notionPageId: input.notionPageId,
          instructorName: input.instructorName,
          yearMatched:
            input.referenceYears.length > 0 &&
            pageEntry.years.some((year) => input.referenceYears.includes(year)),
        };

        let bestCluster: NotionCluster | null = null;
        let bestSimilarity = 0;
        for (const cluster of clusters) {
          const similarity = overlapCoefficient(
            cluster.representative.tokens,
            clusterEntry.tokens
          );
          if (
            similarity >= CLUSTER_SIMILARITY_THRESHOLD &&
            similarity > bestSimilarity
          ) {
            bestSimilarity = similarity;
            bestCluster = cluster;
          }
        }

        if (bestCluster) {
          addEntryToCluster(bestCluster, clusterEntry, targetYears);
        } else {
          clusters.push(buildCluster(clusterEntry));
        }
      }
    }

    if (clusters.length === 0) continue;

    const rankedClusters = clusters
      .map((cluster) => ({
        cluster,
        score: scoreCluster(cluster, targetYears),
      }))
      .sort((left, right) => right.score - left.score);

    const bestCluster = rankedClusters[0]?.cluster;
    if (!bestCluster) continue;
    if (!shouldAcceptCluster(clusters, bestCluster, targetYears, distinctInputPages)) {
      continue;
    }

    const representative = selectRepresentativeEntry(bestCluster, targetYears);
    const acceptedByConsensus = bestCluster.pageIds.size >= 2;

    registry.set(courseId, {
      courseName: representative.courseName,
      score: acceptedByConsensus ? 70 : 50,
      fileName: representative.instructorName,
      modifiedTime: null,
      reportPath: representative.notionPageId,
      reason: acceptedByConsensus
        ? `notion_body_consensus:${bestCluster.pageIds.size}pages`
        : "notion_body_single_page_year_match",
    });
  }

  return registry;
}

function getReferenceYears(row: NormalizedContractRow): number[] {
  const years = new Set<number>();
  if (row.startDate) years.add(row.startDate.getUTCFullYear());
  if (row.recordedAt) years.add(row.recordedAt.getUTCFullYear());
  return Array.from(years).sort((left, right) => left - right);
}

async function mapWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;
  const safeConcurrency = Math.max(1, Math.min(concurrency, items.length));
  let index = 0;

  async function runWorker() {
    while (true) {
      const current = index;
      index += 1;
      if (current >= items.length) break;
      await worker(items[current]);
    }
  }

  await Promise.all(
    Array.from({ length: safeConcurrency }, () => runWorker())
  );
}

async function loadTeachingHistoryEntriesForPage(
  notionPageId: string
): Promise<NotionTeachingHistoryEntry[]> {
  const cache =
    globalForNotionCourseIdFallback.__notionCourseHistoryEntryCache ??
    new Map<string, Promise<NotionTeachingHistoryEntry[]> | NotionTeachingHistoryEntry[]>();
  globalForNotionCourseIdFallback.__notionCourseHistoryEntryCache = cache;

  const cached = cache.get(notionPageId);
  if (cached) {
    return await Promise.resolve(cached);
  }

  const pending = (async () => {
    try {
      const content = await collectNotionPageContentLines({
        notionPageId,
      });
      return extractTeachingHistoryEntriesFromNotionLines([
        ...content.pageTitleLines,
        ...content.blockLines,
        ...content.pageCommentLines,
        ...content.blockCommentLines,
      ]);
    } catch {
      return [];
    }
  })();

  cache.set(notionPageId, pending);
  const resolved = await pending;
  cache.set(notionPageId, resolved);
  return resolved;
}

export async function loadNotionCourseIdFallbackRegistry(args: {
  rows: NormalizedContractRow[];
  instructorsByName: ReadonlyMap<string, { id: string }>;
  existingFallbacks: ReadonlyMap<string, CourseIdFallbackEntry>;
  maxDistinctPageIds?: number;
}): Promise<Map<string, CourseIdFallbackEntry>> {
  const dedupedInputs = new Map<string, NotionCourseIdFallbackInput>();

  for (const row of args.rows) {
    if (!row.name || !row.courseId || row.courseName) continue;
    if (args.existingFallbacks.has(row.courseId)) continue;

    const instructor = args.instructorsByName.get(row.name);
    if (!instructor) continue;

    const dedupeKey = `${row.courseId}::${instructor.id}`;
    const existing = dedupedInputs.get(dedupeKey);
    const referenceYears = getReferenceYears(row);
    if (existing) {
      existing.referenceYears = Array.from(
        new Set([...existing.referenceYears, ...referenceYears])
      ).sort((left, right) => left - right);
      continue;
    }

    dedupedInputs.set(dedupeKey, {
      courseId: row.courseId,
      notionPageId: "",
      instructorName: row.name,
      referenceYears,
    });
  }

  if (dedupedInputs.size === 0) {
    return new Map();
  }

  const instructorIds = Array.from(
    new Set(
      Array.from(dedupedInputs.keys()).map((key) => key.split("::")[1]!).filter(Boolean)
    )
  );

  const sourceLinks = await prisma.sourceLink.findMany({
    where: {
      instructorDbId: { in: instructorIds },
      sourceType: "notion",
      externalKey: { not: null },
    },
    select: {
      instructorDbId: true,
      externalKey: true,
      updatedAt: true,
    },
    orderBy: [{ instructorDbId: "asc" }, { updatedAt: "desc" }],
  });

  const notionPageIdByInstructorId = new Map<string, string>();
  for (const sourceLink of sourceLinks) {
    if (!sourceLink.externalKey) continue;
    if (!notionPageIdByInstructorId.has(sourceLink.instructorDbId)) {
      notionPageIdByInstructorId.set(sourceLink.instructorDbId, sourceLink.externalKey);
    }
  }

  const resolvedInputs: NotionCourseIdFallbackInput[] = [];
  for (const [dedupeKey, input] of dedupedInputs) {
    const instructorId = dedupeKey.split("::")[1];
    if (!instructorId) continue;
    const notionPageId = notionPageIdByInstructorId.get(instructorId);
    if (!notionPageId) continue;
    resolvedInputs.push({
      ...input,
      notionPageId,
    });
  }

  if (resolvedInputs.length === 0) {
    return new Map();
  }

  let scopedInputs = resolvedInputs;
  if (
    typeof args.maxDistinctPageIds === "number" &&
    args.maxDistinctPageIds > 0
  ) {
    const pageFrequency = new Map<string, number>();
    for (const input of resolvedInputs) {
      pageFrequency.set(
        input.notionPageId,
        (pageFrequency.get(input.notionPageId) ?? 0) + 1
      );
    }

    const distinctPageIds = Array.from(pageFrequency.keys());
    if (distinctPageIds.length > args.maxDistinctPageIds) {
      const allowedPageIds = new Set(
        distinctPageIds
          .sort((left, right) => {
            const countDiff =
              (pageFrequency.get(right) ?? 0) - (pageFrequency.get(left) ?? 0);
            return countDiff !== 0 ? countDiff : left.localeCompare(right);
          })
          .slice(0, args.maxDistinctPageIds)
      );
      scopedInputs = resolvedInputs.filter((input) =>
        allowedPageIds.has(input.notionPageId)
      );
    }
  }

  if (scopedInputs.length === 0) {
    return new Map();
  }

  const entriesByPageId = new Map<string, NotionTeachingHistoryEntry[]>();
  const notionPageIds = Array.from(
    new Set(scopedInputs.map((input) => input.notionPageId))
  );

  await mapWithConcurrency(
    notionPageIds,
    PAGE_FETCH_CONCURRENCY,
    async (notionPageId) => {
      entriesByPageId.set(
        notionPageId,
        await loadTeachingHistoryEntriesForPage(notionPageId)
      );
    }
  );

  return buildNotionCourseIdFallbackRegistryFromEntries({
    inputs: scopedInputs,
    entriesByPageId,
  });
}
