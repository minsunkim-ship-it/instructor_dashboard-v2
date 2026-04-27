import path from "node:path";
import process from "node:process";

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { loadDotEnv } from "./lib/audit-helpers.ts";
import { recalculateAllScores } from "@/lib/score-recalculator";
import { recomputeAggregatesForInstructors } from "@/lib/pipeline/contract-sheet-store";
import {
  buildCanonicalInstructorByNameMap,
  compareInstructorCanonicalPriority,
} from "@/lib/instructor-name-canonical";

type DbClient = typeof prisma;

interface CliOptions {
  apply: boolean;
  recalculateScores: boolean;
}

interface InstructorRow {
  id: string;
  name: string;
  instructorId: string | null;
  displayName: string;
  affiliation: string | null;
  categories: string[];
  specialties: string[];
  profileSummary: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  isFulltime: boolean;
  isPracticeCoach: boolean;
  flag: string | null;
  baseFeeHourly: number | null;
  feeNote: string | null;
  rank: number | null;
  score: Prisma.Decimal | null;
  scoreBreakdown: Prisma.JsonValue;
  scorePolicyVersion: string | null;
  scoreCalculatedAt: Date | null;
  satisfactionAvg: Prisma.Decimal | null;
  satisfactionCount: number;
  satisfactionIsImputed: boolean;
  contractSheetRows: number;
  totalCourses: number;
  recentCourses6mo: number;
  slackActivityCount: number;
  emailActivityCount: number;
  opsReportActivityCount: number;
  dispatchRequestActivityCount: number;
  lastActivityAt: Date | null;
  salesmapDealCount: number;
  salesmapLastDealAt: Date | null;
  memoRaw: string | null;
  notionRawProperties: Prisma.JsonValue;
  createdAt: Date;
}

interface ContractTeachingHistoryRow {
  id: string;
  instructorDbId: string;
  companyName: string | null;
  courseName: string | null;
  courseId: string | null;
  startDate: Date | null;
  endDate: Date | null;
  dateLabel: string | null;
  dealFeeHourly: number | null;
  feeExtra: string | null;
  totalHours: Prisma.Decimal | null;
  totalSessions: number | null;
  contractType: string | null;
  detailType: string | null;
  specialNotes: string | null;
  sourceRef: Prisma.JsonValue;
  createdAt: Date;
}

function parseArgs(argv: string[]): CliOptions {
  return {
    apply: argv.includes("--apply"),
    recalculateScores: argv.includes("--recalculate-scores"),
  };
}

function toObject(value: Prisma.JsonValue): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function mergeJsonObjects(
  values: Array<Prisma.JsonValue | null | undefined>
): Prisma.InputJsonObject {
  const merged: Record<string, Prisma.InputJsonValue | null | undefined> = {};
  for (const value of values) {
    const objectValue = toObject(value ?? {});
    for (const [key, entryValue] of Object.entries(objectValue)) {
      merged[key] = entryValue as Prisma.InputJsonValue | null | undefined;
    }
  }
  return merged as Prisma.InputJsonObject;
}

function unionStrings(values: string[][]): string[] {
  return Array.from(
    new Set(values.flatMap((items) => items.map((item) => item.trim()).filter(Boolean)))
  );
}

function firstNonEmpty(values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function longestNonEmpty(values: Array<string | null | undefined>): string | null {
  const candidates = values
    .map((value) => value?.trim() ?? "")
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  return candidates[0] ?? null;
}

function maxDate(values: Array<Date | null | undefined>): Date | null {
  return values.reduce<Date | null>((current, candidate) => {
    if (!candidate) return current;
    if (!current || candidate > current) return candidate;
    return current;
  }, null);
}

function maxNumber(values: Array<number | null | undefined>): number | null {
  return values.reduce<number | null>((current, candidate) => {
    if (candidate === null || candidate === undefined) return current;
    if (current === null || candidate > current) return candidate;
    return current;
  }, null);
}

function maxDecimal(
  values: Array<Prisma.Decimal | null | undefined>
): Prisma.Decimal | null {
  return values.reduce<Prisma.Decimal | null>((current, candidate) => {
    if (!candidate) return current;
    if (!current || candidate.greaterThan(current)) return candidate;
    return current;
  }, null);
}

function chooseCanonicalInstructor(rows: InstructorRow[]): InstructorRow {
  const canonicalByName = buildCanonicalInstructorByNameMap(rows);
  return (
    canonicalByName.get(rows[0].name) ??
    [...rows].sort(compareInstructorCanonicalPriority)[0]
  );
}

function buildMergedInstructorData(rows: InstructorRow[]): Prisma.InstructorUpdateInput {
  const canonical = chooseCanonicalInstructor(rows);
  return {
    instructorId: firstNonEmpty(rows.map((row) => row.instructorId)),
    displayName:
      longestNonEmpty([canonical.displayName, ...rows.map((row) => row.displayName)]) ??
      canonical.name,
    affiliation: firstNonEmpty(rows.map((row) => row.affiliation)),
    categories: unionStrings(rows.map((row) => row.categories)),
    specialties: unionStrings(rows.map((row) => row.specialties)),
    profileSummary: longestNonEmpty(rows.map((row) => row.profileSummary)),
    contactEmail: firstNonEmpty(rows.map((row) => row.contactEmail)),
    contactPhone: firstNonEmpty(rows.map((row) => row.contactPhone)),
    isFulltime: rows.some((row) => row.isFulltime),
    isPracticeCoach: rows.some((row) => row.isPracticeCoach),
    flag: firstNonEmpty(rows.map((row) => row.flag)),
    baseFeeHourly: maxNumber(rows.map((row) => row.baseFeeHourly)),
    feeNote: longestNonEmpty(rows.map((row) => row.feeNote)),
    rank: maxNumber(rows.map((row) => row.rank)),
    score: maxDecimal(rows.map((row) => row.score)),
    scoreBreakdown: mergeJsonObjects(rows.map((row) => row.scoreBreakdown)),
    scorePolicyVersion: firstNonEmpty(rows.map((row) => row.scorePolicyVersion)),
    scoreCalculatedAt: maxDate(rows.map((row) => row.scoreCalculatedAt)),
    satisfactionAvg: maxDecimal(rows.map((row) => row.satisfactionAvg)),
    satisfactionCount: maxNumber(rows.map((row) => row.satisfactionCount)) ?? 0,
    satisfactionIsImputed: rows.some((row) => row.satisfactionIsImputed),
    contractSheetRows: maxNumber(rows.map((row) => row.contractSheetRows)) ?? 0,
    totalCourses: maxNumber(rows.map((row) => row.totalCourses)) ?? 0,
    recentCourses6mo: maxNumber(rows.map((row) => row.recentCourses6mo)) ?? 0,
    slackActivityCount: maxNumber(rows.map((row) => row.slackActivityCount)) ?? 0,
    emailActivityCount: maxNumber(rows.map((row) => row.emailActivityCount)) ?? 0,
    opsReportActivityCount:
      maxNumber(rows.map((row) => row.opsReportActivityCount)) ?? 0,
    dispatchRequestActivityCount:
      maxNumber(rows.map((row) => row.dispatchRequestActivityCount)) ?? 0,
    lastActivityAt: maxDate(rows.map((row) => row.lastActivityAt)),
    salesmapDealCount: maxNumber(rows.map((row) => row.salesmapDealCount)) ?? 0,
    salesmapLastDealAt: maxDate(rows.map((row) => row.salesmapLastDealAt)),
    memoRaw: longestNonEmpty(rows.map((row) => row.memoRaw)),
    notionRawProperties: mergeJsonObjects(rows.map((row) => row.notionRawProperties)),
  };
}

async function mergeInstructorIntelligenceRows(
  db: DbClient,
  canonicalId: string,
  duplicateIds: string[]
): Promise<void> {
  const rows = await db.instructorIntelligence.findMany({
    where: {
      instructorDbId: { in: [canonicalId, ...duplicateIds] },
    },
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
  });

  if (rows.length === 0) return;

  const canonicalRow =
    rows.find((row) => row.instructorDbId === canonicalId) ?? rows[0];
  const duplicateRowIds = rows
    .filter((row) => row.id !== canonicalRow.id)
    .map((row) => row.id);

  await db.instructorIntelligence.update({
    where: { id: canonicalRow.id },
    data: {
      instructorDbId: canonicalId,
      recommendedFor: unionStrings(rows.map((row) => row.recommendedFor)),
      avoidFor: unionStrings(rows.map((row) => row.avoidFor)),
      riskNotes: unionStrings(rows.map((row) => row.riskNotes)),
      opsCheckNote: longestNonEmpty(rows.map((row) => row.opsCheckNote)),
      dataRichness: firstNonEmpty(rows.map((row) => row.dataRichness)),
      confidence: firstNonEmpty(rows.map((row) => row.confidence)),
      sourceSummary: mergeJsonObjects(rows.map((row) => row.sourceSummary)),
      generatedBy: firstNonEmpty(rows.map((row) => row.generatedBy)),
      generationModel: firstNonEmpty(rows.map((row) => row.generationModel)),
      promptVersion: firstNonEmpty(rows.map((row) => row.promptVersion)),
      evidenceHash: firstNonEmpty(rows.map((row) => row.evidenceHash)),
      generatedAt: maxDate(rows.map((row) => row.generatedAt)),
    },
  });

  if (duplicateRowIds.length > 0) {
    await db.instructorIntelligence.deleteMany({
      where: { id: { in: duplicateRowIds } },
    });
  }
}

async function reassignInstructorReferences(
  db: DbClient,
  canonicalId: string,
  duplicateIds: string[]
): Promise<void> {
  if (duplicateIds.length === 0) return;

  await db.teachingHistory.updateMany({
    where: { instructorDbId: { in: duplicateIds } },
    data: { instructorDbId: canonicalId },
  });
  await db.satisfactionRecord.updateMany({
    where: { instructorDbId: { in: duplicateIds } },
    data: { instructorDbId: canonicalId },
  });
  await db.satisfactionReviewRegistry.updateMany({
    where: { suggestedInstructorId: { in: duplicateIds } },
    data: { suggestedInstructorId: canonicalId },
  });
  await db.satisfactionReviewRegistry.updateMany({
    where: { resolvedInstructorId: { in: duplicateIds } },
    data: { resolvedInstructorId: canonicalId },
  });
  await db.activityImportItem.updateMany({
    where: { matchedInstructorId: { in: duplicateIds } },
    data: { matchedInstructorId: canonicalId },
  });
  await db.activityReviewRegistry.updateMany({
    where: { suggestedInstructorId: { in: duplicateIds } },
    data: { suggestedInstructorId: canonicalId },
  });
  await db.activityReviewRegistry.updateMany({
    where: { resolvedInstructorId: { in: duplicateIds } },
    data: { resolvedInstructorId: canonicalId },
  });
  await db.sourceLink.updateMany({
    where: { instructorDbId: { in: duplicateIds } },
    data: { instructorDbId: canonicalId },
  });
  await db.validationIssue.updateMany({
    where: { instructorDbId: { in: duplicateIds } },
    data: { instructorDbId: canonicalId },
  });
  await db.feeHistory.updateMany({
    where: { instructorDbId: { in: duplicateIds } },
    data: { instructorDbId: canonicalId },
  });
  await db.feeFixConfig.updateMany({
    where: { instructorDbId: { in: duplicateIds } },
    data: { instructorDbId: canonicalId },
  });
  await db.reviewDecision.updateMany({
    where: { targetInstructorId: { in: duplicateIds } },
    data: { targetInstructorId: canonicalId },
  });
}

function teachingHistoryCompletenessScore(row: ContractTeachingHistoryRow): number {
  let score = 0;
  if (row.companyName) score += 1;
  if (row.courseName) score += 2;
  if (row.courseId) score += 2;
  if (row.startDate) score += 1;
  if (row.endDate) score += 1;
  if (row.dateLabel) score += 2;
  if (row.dealFeeHourly !== null) score += 1;
  if (row.feeExtra) score += 1;
  if (row.totalHours !== null) score += 1;
  if (row.totalSessions !== null) score += 1;
  if (row.contractType) score += 1;
  if (row.detailType) score += 1;
  if (row.specialNotes) score += 1;
  return score;
}

function chooseCanonicalTeachingHistoryRow(
  rows: ContractTeachingHistoryRow[]
): ContractTeachingHistoryRow {
  return [...rows].sort((left, right) => {
    const byCompleteness =
      teachingHistoryCompletenessScore(right) - teachingHistoryCompletenessScore(left);
    if (byCompleteness !== 0) return byCompleteness;
    const byCreatedAt = left.createdAt.getTime() - right.createdAt.getTime();
    if (byCreatedAt !== 0) return byCreatedAt;
    return left.id.localeCompare(right.id);
  })[0];
}

function buildMergedTeachingHistoryData(
  canonical: ContractTeachingHistoryRow,
  rows: ContractTeachingHistoryRow[]
): Prisma.TeachingHistoryUpdateManyMutationInput {
  const pickText = (selector: (row: ContractTeachingHistoryRow) => string | null) =>
    firstNonEmpty([selector(canonical), ...rows.map(selector)]);

  return {
    companyName: pickText((row) => row.companyName),
    courseName: pickText((row) => row.courseName),
    courseId: pickText((row) => row.courseId),
    startDate:
      rows
        .map((row) => row.startDate)
        .filter((value): value is Date => Boolean(value))
        .sort((left, right) => left.getTime() - right.getTime())[0] ?? null,
    endDate:
      rows
        .map((row) => row.endDate)
        .filter((value): value is Date => Boolean(value))
        .sort((left, right) => right.getTime() - left.getTime())[0] ?? null,
    dateLabel: longestNonEmpty(rows.map((row) => row.dateLabel)),
    dealFeeHourly: maxNumber(rows.map((row) => row.dealFeeHourly)),
    feeExtra: longestNonEmpty(rows.map((row) => row.feeExtra)),
    totalHours: rows.find((row) => row.totalHours !== null)?.totalHours ?? null,
    totalSessions: maxNumber(rows.map((row) => row.totalSessions)),
    contractType: pickText((row) => row.contractType),
    detailType: pickText((row) => row.detailType),
    specialNotes: longestNonEmpty(rows.map((row) => row.specialNotes)),
    sourceRef: canonical.sourceRef as Prisma.InputJsonValue,
  };
}

async function dedupeContractTeachingHistories(
  apply: boolean
): Promise<{
  duplicateGroups: number;
  deletedRows: number;
  affectedInstructorIds: string[];
}> {
  const duplicateGroups = await prisma.$queryRaw<
    Array<{
      spreadsheetId: string;
      worksheetGid: number;
      rowNumber: number;
    }>
  >(Prisma.sql`
    SELECT
      source_ref->>'spreadsheet_id' AS "spreadsheetId",
      (source_ref->>'worksheet_gid')::int AS "worksheetGid",
      (source_ref->>'row_number')::int AS "rowNumber"
    FROM teaching_histories
    WHERE source_type = 'contract_sheet'
      AND source_ref ? 'spreadsheet_id'
      AND source_ref ? 'worksheet_gid'
      AND source_ref ? 'row_number'
    GROUP BY 1, 2, 3
    HAVING count(*) > 1
  `);

  const affectedInstructorIds = new Set<string>();
  let deletedRows = 0;

  for (const group of duplicateGroups) {
    const rows = await prisma.$queryRaw<ContractTeachingHistoryRow[]>(Prisma.sql`
      SELECT
        id,
        instructor_db_id AS "instructorDbId",
        company_name AS "companyName",
        course_name AS "courseName",
        course_id AS "courseId",
        start_date AS "startDate",
        end_date AS "endDate",
        date_label AS "dateLabel",
        deal_fee_hourly AS "dealFeeHourly",
        fee_extra AS "feeExtra",
        total_hours AS "totalHours",
        total_sessions AS "totalSessions",
        contract_type AS "contractType",
        detail_type AS "detailType",
        special_notes AS "specialNotes",
        source_ref AS "sourceRef",
        created_at AS "createdAt"
      FROM teaching_histories
      WHERE source_type = 'contract_sheet'
        AND source_ref->>'spreadsheet_id' = ${group.spreadsheetId}
        AND (source_ref->>'worksheet_gid')::int = ${group.worksheetGid}
        AND (source_ref->>'row_number')::int = ${group.rowNumber}
      ORDER BY created_at ASC, id ASC
    `);

    if (rows.length <= 1) continue;

    const canonical = chooseCanonicalTeachingHistoryRow(rows);
    const duplicateIds = rows
      .filter((row) => row.id !== canonical.id)
      .map((row) => row.id);
    rows.forEach((row) => affectedInstructorIds.add(row.instructorDbId));

    if (!apply) {
      deletedRows += duplicateIds.length;
      continue;
    }

    await prisma.teachingHistory.updateMany({
      where: { id: canonical.id },
      data: buildMergedTeachingHistoryData(canonical, rows),
    });
    await prisma.teachingHistory.deleteMany({
      where: { id: { in: duplicateIds } },
    });
    deletedRows += duplicateIds.length;
  }

  return {
    duplicateGroups: duplicateGroups.length,
    deletedRows,
    affectedInstructorIds: Array.from(affectedInstructorIds),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await loadDotEnv(path.join(process.cwd(), ".env"));

  const instructors = await prisma.instructor.findMany({
    orderBy: [{ name: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      name: true,
      instructorId: true,
      displayName: true,
      affiliation: true,
      categories: true,
      specialties: true,
      profileSummary: true,
      contactEmail: true,
      contactPhone: true,
      isFulltime: true,
      isPracticeCoach: true,
      flag: true,
      baseFeeHourly: true,
      feeNote: true,
      rank: true,
      score: true,
      scoreBreakdown: true,
      scorePolicyVersion: true,
      scoreCalculatedAt: true,
      satisfactionAvg: true,
      satisfactionCount: true,
      satisfactionIsImputed: true,
      contractSheetRows: true,
      totalCourses: true,
      recentCourses6mo: true,
      slackActivityCount: true,
      emailActivityCount: true,
      opsReportActivityCount: true,
      dispatchRequestActivityCount: true,
      lastActivityAt: true,
      salesmapDealCount: true,
      salesmapLastDealAt: true,
      memoRaw: true,
      notionRawProperties: true,
      createdAt: true,
    },
  });

  const rowsByName = new Map<string, InstructorRow[]>();
  for (const row of instructors) {
    const bucket = rowsByName.get(row.name) ?? [];
    bucket.push(row);
    rowsByName.set(row.name, bucket);
  }

  const duplicateGroups = Array.from(rowsByName.entries())
    .filter(([, rows]) => rows.length > 1)
    .map(([name, rows]) => ({
      name,
      rows,
      canonical: chooseCanonicalInstructor(rows),
    }));

  const affectedInstructorIds = new Set<string>();
  let mergedInstructorRows = 0;

  for (const group of duplicateGroups) {
    const duplicateIds = group.rows
      .filter((row) => row.id !== group.canonical.id)
      .map((row) => row.id);
    affectedInstructorIds.add(group.canonical.id);

    if (!options.apply) continue;

    await mergeInstructorIntelligenceRows(prisma, group.canonical.id, duplicateIds);
    await prisma.instructor.update({
      where: { id: group.canonical.id },
      data: buildMergedInstructorData(group.rows),
    });
    await reassignInstructorReferences(prisma, group.canonical.id, duplicateIds);
    await prisma.instructor.deleteMany({
      where: { id: { in: duplicateIds } },
    });

    mergedInstructorRows += duplicateIds.length;
  }

  const contractDedupe = await dedupeContractTeachingHistories(options.apply);
  contractDedupe.affectedInstructorIds.forEach((id) => affectedInstructorIds.add(id));

  let aggregatesUpdated = 0;
  let scoreRecalcSummary:
    | {
        updatedInstructors: number;
        totalInstructors: number;
      }
    | null = null;

  if (options.apply && affectedInstructorIds.size > 0) {
    aggregatesUpdated = await recomputeAggregatesForInstructors(affectedInstructorIds);
  }

  if (options.apply && options.recalculateScores) {
    const recalc = await recalculateAllScores();
    scoreRecalcSummary = {
      updatedInstructors: recalc.updatedInstructors,
      totalInstructors: recalc.totalInstructors,
    };
  }

  console.log(
    JSON.stringify(
      {
        apply: options.apply,
        duplicateInstructorNames: duplicateGroups.length,
        duplicateInstructorRows:
          duplicateGroups.reduce((sum, group) => sum + group.rows.length - 1, 0),
        mergedInstructorRows,
        sampleInstructorGroups: duplicateGroups.slice(0, 10).map((group) => ({
          name: group.name,
          canonicalId: group.canonical.id,
          duplicateIds: group.rows
            .filter((row) => row.id !== group.canonical.id)
            .map((row) => row.id),
        })),
        contractTeachingHistoryDuplicateGroups: contractDedupe.duplicateGroups,
        contractTeachingHistoryDeletedRows: contractDedupe.deletedRows,
        affectedInstructors: affectedInstructorIds.size,
        aggregatesUpdated,
        scoreRecalcSummary,
      },
      null,
      2
    )
  );
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
