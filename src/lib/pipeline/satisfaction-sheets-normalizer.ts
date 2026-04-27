import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { buildCanonicalInstructorByNameMap } from "@/lib/instructor-name-canonical";
import type { SatisfactionImportItemInput } from "@/lib/pipeline/satisfaction-applier";
import { normalizeFeedbackNotesInImportItems } from "@/lib/pipeline/feedback-note-llm";
import type {
  SatisfactionSheetCollectResult,
  SatisfactionSheetSourceDefinition,
} from "@/lib/pipeline/satisfaction-sheets-collector";

interface DraftSatisfactionItem {
  sourceKey: SatisfactionSheetSourceDefinition["key"];
  sourceType: string;
  sourceRefKey: string;
  sourceRef: Record<string, unknown>;
  rawPayload: Record<string, unknown>;
  normalizedPayload: Record<string, unknown>;
  candidateName?: string | null;
  candidateCompanyName?: string | null;
  candidateCourseName?: string | null;
  scoreRaw?: string | null;
  scoreNormalized?: number | null;
  respondentCount?: number | null;
  responseDate?: Date | string | null;
}

type FeedbackNoteType =
  | "teaching_feedback_qualitative"
  | "teaching_feedback_ops";

interface DraftFeedbackNote {
  note_type: FeedbackNoteType;
  text: string;
  header: string;
  row_index: number;
  column_index: number;
}

export interface SatisfactionSourceSummary {
  sourceKey: string;
  sourceType: string;
  fetchedRows: number;
  importedItems: number;
  skippedRows: number;
  autoAcceptedCandidates: number;
  pendingCandidates: number;
  status: "success" | "partial" | "skipped";
  note?: string;
}

function getCell(row: string[] | undefined, index: number): string {
  return row?.[index]?.trim() ?? "";
}

function getNonEmptyCell(row: string[] | undefined, index: number): string | null {
  const value = getCell(row, index);
  return value.length > 0 ? value : null;
}

function parseNumber(value: string | null | undefined): number | null {
  if (!value) return null;
  const normalized = value.replace(/,/g, "").trim();
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDateValue(value: string | null | undefined): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const dateMatch = trimmed.match(/(\d{4})[./-]\s*(\d{1,2})[./-]\s*(\d{1,2})/);
  if (dateMatch) {
    const [, year, month, day] = dateMatch;
    return new Date(
      Date.UTC(Number(year), Number(month) - 1, Number(day), 0, 0, 0)
    );
  }

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toDateOnlyString(value: Date | string | null | undefined): string | null {
  const date = value instanceof Date ? value : parseDateValue(value ?? null);
  return date ? date.toISOString().slice(0, 10) : null;
}

function encodeKeyPart(value: string | null | undefined): string {
  if (!value) return "";
  return encodeURIComponent(value.trim().toLowerCase());
}

function buildSatisfactionRegistryKey(args: {
  sourceFamily: string;
  companyName: string;
  courseName: string;
  sessionOrDate: string;
  instructorName?: string | null;
}): string {
  const normalized = [
    "satisfaction",
    encodeKeyPart(args.sourceFamily),
    encodeKeyPart(args.companyName),
    encodeKeyPart(args.courseName),
    encodeKeyPart(args.sessionOrDate),
    encodeKeyPart(args.instructorName ?? ""),
  ].join(":");

  return `satisfaction:${encodeKeyPart(args.sourceFamily)}:${createHash("sha1")
    .update(normalized)
    .digest("hex")}`;
}

function classifyFeedbackHeader(header: string): FeedbackNoteType | null {
  if (!header) return null;
  if (/(운영진 의견|운영 의견|운영\/관리 이슈사항|운영\/관리 이슈|이슈 사항)/i.test(header)) {
    return "teaching_feedback_ops";
  }
  if (
    /(좋았던 점|아쉬운 점|개선 요청|개선이 필요한 점|주관식 주요 의견|가장 기억에 남는 학습 내용|강사님께 전달|수강생 의견|교육생 의견|피드백)/i.test(
      header
    )
  ) {
    return "teaching_feedback_qualitative";
  }
  return null;
}

function isSkippableFeedbackValue(value: string): boolean {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length < 4) return true;
  if (/^(없음|없습니다|해당 없음|해당없음|없어요|n\/a|na|x|-)$/.test(normalized)) {
    return true;
  }
  if (/^[0-9./:()\s,-]+$/.test(normalized)) return true;
  return false;
}

function dedupeFeedbackNotes(
  notes: DraftFeedbackNote[],
  maxNotes: number = 40
): DraftFeedbackNote[] {
  const seen = new Set<string>();
  const deduped: DraftFeedbackNote[] = [];

  for (const note of notes) {
    const key = `${note.note_type}::${note.text.trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(note);
    if (deduped.length >= maxNotes) break;
  }

  return deduped;
}

function extractRowFeedbackNotes(args: {
  headerRow: string[];
  row: string[];
  rowIndex: number;
  columnStart?: number;
  columnEndExclusive?: number;
}): DraftFeedbackNote[] {
  const columnStart = args.columnStart ?? 0;
  const columnEndExclusive =
    args.columnEndExclusive ?? Math.max(args.headerRow.length, args.row.length);
  const notes: DraftFeedbackNote[] = [];

  for (let column = columnStart; column < columnEndExclusive; column += 1) {
    const header = getCell(args.headerRow, column);
    const noteType = classifyFeedbackHeader(header);
    if (!noteType) continue;

    const text = getCell(args.row, column);
    if (isSkippableFeedbackValue(text)) continue;

    notes.push({
      note_type: noteType,
      text,
      header,
      row_index: args.rowIndex,
      column_index: column + 1,
    });
  }

  return notes;
}

function buildKtDraftItems(result: SatisfactionSheetCollectResult): DraftSatisfactionItem[] {
  const rows = result.rows;
  if (rows.length < 3) return [];

  const headerSearchRows = rows.slice(0, 5);
  const blockStarts = new Set<number>();
  for (const row of headerSearchRows) {
    row.forEach((cell, index) => {
      if (cell.trim() === "회차") {
        blockStarts.add(index);
      }
    });
  }

  const sortedBlockStarts = Array.from(blockStarts).sort((a, b) => a - b);
  const items: DraftSatisfactionItem[] = [];

  for (let blockIndex = 0; blockIndex < sortedBlockStarts.length; blockIndex += 1) {
    const blockStart = sortedBlockStarts[blockIndex];
    const blockEndExclusive =
      sortedBlockStarts[blockIndex + 1] ?? Math.max(...rows.map((row) => row.length));

    let headerRowIndex = -1;
    for (let i = 0; i < headerSearchRows.length; i += 1) {
      if (getCell(headerSearchRows[i], blockStart) === "회차") {
        headerRowIndex = i;
        break;
      }
    }
    if (headerRowIndex === -1) continue;

    const headerRow = rows[headerRowIndex] ?? [];
    const moduleTitle =
      getNonEmptyCell(rows[0], blockStart) ??
      getNonEmptyCell(rows[1], blockStart) ??
      `KT block ${blockIndex + 1}`;
    const blockTitle =
      getNonEmptyCell(rows[0], blockStart + 1) ??
      getNonEmptyCell(rows[1], blockStart + 1) ??
      null;
    const courseName = blockTitle ? `${moduleTitle} / ${blockTitle}` : moduleTitle;

    const columnIndexes = {
      session: blockStart,
      date: -1,
      instructor: -1,
      respondentCount: -1,
      overallScore: -1,
    };

    for (let column = blockStart; column < blockEndExclusive; column += 1) {
      const headerValue = getCell(headerRow, column);
      if (headerValue === "교육일자") columnIndexes.date = column;
      else if (headerValue === "강사") columnIndexes.instructor = column;
      else if (headerValue === "만족도인원" || headerValue === "만족도 인원") {
        columnIndexes.respondentCount = column;
      } else if (headerValue === "전체 만족도") {
        columnIndexes.overallScore = column;
      }
    }

    if (
      columnIndexes.date === -1 ||
      columnIndexes.instructor === -1 ||
      columnIndexes.overallScore === -1
    ) {
      continue;
    }

    for (let rowIndex = headerRowIndex + 1; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex] ?? [];
      const sessionLabel = getCell(row, columnIndexes.session);
      const responseDateRaw = getCell(row, columnIndexes.date);
      const instructorName = getCell(row, columnIndexes.instructor);
      const scoreRaw = getCell(row, columnIndexes.overallScore);
      const respondentCountRaw =
        columnIndexes.respondentCount !== -1
          ? getCell(row, columnIndexes.respondentCount)
          : "";
      const feedbackNotes = dedupeFeedbackNotes(
        extractRowFeedbackNotes({
          headerRow,
          row,
          rowIndex: rowIndex + 1,
          columnStart: blockStart,
          columnEndExclusive: blockEndExclusive,
        })
      );

      if (!sessionLabel && !responseDateRaw && !instructorName && !scoreRaw) {
        continue;
      }

      const scoreNormalized = parseNumber(scoreRaw);
      const responseDate = parseDateValue(responseDateRaw);
      if (scoreNormalized === null || !responseDate || !instructorName) {
        continue;
      }

      const registryKey = buildSatisfactionRegistryKey({
        sourceFamily: result.definition.key,
        companyName: "KT AI Campus",
        courseName,
        sessionOrDate: sessionLabel || responseDate.toISOString().slice(0, 10),
        instructorName,
      });

      items.push({
        sourceKey: result.definition.key,
        sourceType: result.definition.sourceType,
        sourceRefKey: `${result.definition.sourceType}:${result.definition.spreadsheetId}:${result.definition.worksheetGid}:r${rowIndex + 1}:c${blockStart + 1}`,
        sourceRef: {
          spreadsheet_id: result.definition.spreadsheetId,
          worksheet_gid: result.definition.worksheetGid,
          row_number: rowIndex + 1,
          block_start_column: blockStart + 1,
          source_key: result.definition.key,
        },
        rawPayload: {
          session_label: sessionLabel,
          response_date_raw: responseDateRaw,
          instructor_name: instructorName,
          score_raw: scoreRaw,
          respondent_count_raw: respondentCountRaw,
          course_name_raw: courseName,
          feedback_notes: feedbackNotes,
        },
        normalizedPayload: {
          registry_key: registryKey,
          company_name: "KT AI Campus",
          course_name: courseName,
          session_label: sessionLabel,
          response_date: responseDate.toISOString().slice(0, 10),
          instructor_name: instructorName,
          respondent_count: parseNumber(respondentCountRaw) ?? 1,
          source_family: result.definition.key,
        },
        candidateName: instructorName,
        candidateCompanyName: "KT AI Campus",
        candidateCourseName: courseName,
        scoreRaw,
        scoreNormalized,
        respondentCount: parseNumber(respondentCountRaw) ?? 1,
        responseDate,
      });
    }
  }

  return items;
}

function buildWooriDraftItems(result: SatisfactionSheetCollectResult): DraftSatisfactionItem[] {
  const rows = result.rows;
  if (rows.length < 2) return [];

  const headerRow = rows[0] ?? [];
  const timestampIndex = headerRow.findIndex((header) =>
    /타임스탬프|timestamp/i.test(header)
  );
  const scoreIndex = headerRow.findIndex((header) =>
    header.includes("전반적으로 만족")
  );

  if (timestampIndex === -1 || scoreIndex === -1) {
    return [];
  }

  const items: DraftSatisfactionItem[] = [];
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] ?? [];
    const timestampRaw = getCell(row, timestampIndex);
    const scoreRaw = getCell(row, scoreIndex);
    const feedbackNotes = dedupeFeedbackNotes(
      extractRowFeedbackNotes({
        headerRow,
        row,
        rowIndex: rowIndex + 1,
      })
    );

    if (!timestampRaw && !scoreRaw) continue;

    const scoreNormalized = parseNumber(scoreRaw);
    const responseDate = parseDateValue(timestampRaw);
    if (scoreNormalized === null || !responseDate) continue;

    const registryKey = buildSatisfactionRegistryKey({
      sourceFamily: result.definition.key,
      companyName: "우리은행",
      courseName: "AX 기획자 과정",
      sessionOrDate: responseDate.toISOString().slice(0, 10),
    });

    items.push({
      sourceKey: result.definition.key,
      sourceType: result.definition.sourceType,
      sourceRefKey: `${result.definition.sourceType}:${result.definition.spreadsheetId}:${result.definition.worksheetGid}:r${rowIndex + 1}`,
      sourceRef: {
        spreadsheet_id: result.definition.spreadsheetId,
        worksheet_gid: result.definition.worksheetGid,
        row_number: rowIndex + 1,
        source_key: result.definition.key,
      },
      rawPayload: {
        timestamp_raw: timestampRaw,
        score_raw: scoreRaw,
        feedback_notes: feedbackNotes,
      },
      normalizedPayload: {
        registry_key: registryKey,
        company_name: "우리은행",
        course_name: "AX 기획자 과정",
        response_date: responseDate.toISOString().slice(0, 10),
        respondent_count: 1,
        source_family: result.definition.key,
      },
      candidateCompanyName: "우리은행",
      candidateCourseName: "AX 기획자 과정",
      scoreRaw,
      scoreNormalized,
      respondentCount: 1,
      responseDate,
    });
  }

  return items;
}

const HYUNDAI_MOBIS_COMPANY = "현대모비스";
const HYUNDAI_LLM_COURSE = "LLM을 활용한 현업 프로젝트";
const HYUNDAI_LLM_INSTRUCTOR = "김인섭";

function getHyundaiSessionLabel(sourceKey: string): string {
  if (sourceKey === "hyundai_mobis_llm") return "1차수";
  if (sourceKey === "hyundai_mobis_llm_2") return "2차수";
  if (sourceKey === "hyundai_mobis_llm_3") return "3차수";
  if (sourceKey === "hyundai_mobis_llm_4") return "4차수";
  return "unknown";
}

function buildHyundaiSummaryDraftItems(
  result: SatisfactionSheetCollectResult
): DraftSatisfactionItem[] {
  const rows = result.rows;
  if (rows.length < 2) return [];

  const headerRow = rows.find((row) => {
    const firstCell = getCell(row, 0);
    return firstCell === "과정 만족도" || firstCell === "전체 만족도";
  });
  if (!headerRow) return [];

  const scoreColumnIndex = 0;
  const respondentRows: string[][] = [];
  let summaryRow: string[] | null = null;

  for (let rowIndex = rows.indexOf(headerRow) + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] ?? [];
    const firstCell = getCell(row, 0);
    if (!firstCell) {
      continue;
    }

    const parsed = parseNumber(firstCell);
    if (parsed === null) continue;

    const numericCellCount = row.filter((cell) => parseNumber(cell) !== null).length;
    if (firstCell.includes(".") && numericCellCount >= 6) {
      summaryRow = row;
      break;
    }

    if (!firstCell.includes(".") && numericCellCount >= 6) {
      respondentRows.push(row);
    }
  }

  if (!summaryRow || respondentRows.length === 0) {
    return [];
  }

  const scoreNormalized = parseNumber(getCell(summaryRow, scoreColumnIndex));
  if (scoreNormalized === null) {
    return [];
  }

  const sessionLabel = getHyundaiSessionLabel(result.definition.key);
  const registryKey = buildSatisfactionRegistryKey({
    sourceFamily: "hyundai_mobis_llm",
    companyName: HYUNDAI_MOBIS_COMPANY,
    courseName: HYUNDAI_LLM_COURSE,
    sessionOrDate: sessionLabel,
    instructorName: HYUNDAI_LLM_INSTRUCTOR,
  });

  return [
    {
      sourceKey: result.definition.key,
      sourceType: result.definition.sourceType,
      sourceRefKey: `${result.definition.sourceType}:${result.definition.spreadsheetId}:${result.definition.worksheetGid}:${sessionLabel}`,
      sourceRef: {
        spreadsheet_id: result.definition.spreadsheetId,
        worksheet_gid: result.definition.worksheetGid,
        source_key: result.definition.key,
        session_label: sessionLabel,
      },
      rawPayload: {
        title: result.definition.title,
        representative_metric: getCell(headerRow, scoreColumnIndex),
        summary_row: summaryRow,
        respondent_rows: respondentRows.length,
      },
      normalizedPayload: {
        registry_key: registryKey,
        company_name: HYUNDAI_MOBIS_COMPANY,
        course_name: HYUNDAI_LLM_COURSE,
        session_label: sessionLabel,
        instructor_name: HYUNDAI_LLM_INSTRUCTOR,
        respondent_count: respondentRows.length,
        source_family: "hyundai_mobis_llm",
      },
      candidateName: HYUNDAI_LLM_INSTRUCTOR,
      candidateCompanyName: HYUNDAI_MOBIS_COMPANY,
      candidateCourseName: HYUNDAI_LLM_COURSE,
      scoreRaw: getCell(summaryRow, scoreColumnIndex),
      scoreNormalized,
      respondentCount: respondentRows.length,
      responseDate: null,
    },
  ];
}

function buildHyundaiFormsDraftItems(
  result: SatisfactionSheetCollectResult
): DraftSatisfactionItem[] {
  const rows = result.rows;
  if (rows.length < 2) return [];

  const headerRow = rows[0] ?? [];
  const timestampIndex = headerRow.findIndex((header) => /타임스탬프/i.test(header));
  const scoreIndex = headerRow.findIndex((header) => /만족도/.test(header));
  if (timestampIndex === -1 || scoreIndex === -1) {
    return [];
  }

  const respondentRows = rows
    .slice(1)
    .filter((row) => getCell(row, timestampIndex) && parseNumber(getCell(row, scoreIndex)) !== null);

  if (respondentRows.length === 0) {
    return [];
  }

  const scoreTotal = respondentRows.reduce(
    (sum, row) => sum + (parseNumber(getCell(row, scoreIndex)) ?? 0),
    0
  );
  const feedbackNotes = dedupeFeedbackNotes(
    respondentRows.flatMap((row, index) =>
      extractRowFeedbackNotes({
        headerRow,
        row,
        rowIndex: index + 2,
      })
    )
  );
  const scoreNormalized = scoreTotal / respondentRows.length;
  const responseDate = parseDateValue(getCell(respondentRows[0], timestampIndex));
  const sessionLabel = getHyundaiSessionLabel(result.definition.key);
  const registryKey = buildSatisfactionRegistryKey({
    sourceFamily: "hyundai_mobis_llm",
    companyName: HYUNDAI_MOBIS_COMPANY,
    courseName: HYUNDAI_LLM_COURSE,
    sessionOrDate: sessionLabel,
    instructorName: HYUNDAI_LLM_INSTRUCTOR,
  });

  return [
    {
      sourceKey: result.definition.key,
      sourceType: result.definition.sourceType,
      sourceRefKey: `${result.definition.sourceType}:${result.definition.spreadsheetId}:${result.definition.worksheetGid}:${sessionLabel}`,
      sourceRef: {
        spreadsheet_id: result.definition.spreadsheetId,
        worksheet_gid: result.definition.worksheetGid,
        source_key: result.definition.key,
        session_label: sessionLabel,
      },
      rawPayload: {
        title: result.definition.title,
        score_column: getCell(headerRow, scoreIndex),
        respondent_rows: respondentRows.length,
        feedback_notes: feedbackNotes,
      },
      normalizedPayload: {
        registry_key: registryKey,
        company_name: HYUNDAI_MOBIS_COMPANY,
        course_name: HYUNDAI_LLM_COURSE,
        session_label: sessionLabel,
        instructor_name: HYUNDAI_LLM_INSTRUCTOR,
        respondent_count: respondentRows.length,
        source_family: "hyundai_mobis_llm",
      },
      candidateName: HYUNDAI_LLM_INSTRUCTOR,
      candidateCompanyName: HYUNDAI_MOBIS_COMPANY,
      candidateCourseName: HYUNDAI_LLM_COURSE,
      scoreRaw: String(Math.round(scoreNormalized * 10000) / 10000),
      scoreNormalized,
      respondentCount: respondentRows.length,
      responseDate,
    },
  ];
}

function buildSourceSummary(
  definition: SatisfactionSheetSourceDefinition,
  fetchedRows: number,
  items: DraftSatisfactionItem[],
  note?: string,
  status?: "success" | "partial" | "skipped"
): SatisfactionSourceSummary {
  const autoAcceptedCandidates = items.filter(
    (item) => typeof item.normalizedPayload.suggested_instructor_id === "string"
  ).length;
  return {
    sourceKey: definition.key,
    sourceType: definition.sourceType,
    fetchedRows,
    importedItems: items.length,
    skippedRows: Math.max(0, fetchedRows - 1 - items.length),
    autoAcceptedCandidates,
    pendingCandidates: Math.max(0, items.length - autoAcceptedCandidates),
    status: status ?? "success",
    note,
  };
}

async function resolveWooriInstructorSuggestion(args: {
  candidateCompanyName?: string | null;
  candidateCourseName?: string | null;
  sourceKey: string;
  responseDate?: Date | string | null;
}): Promise<{ instructorId: string | null; resolutionBasis: string | null }> {
  if (args.sourceKey !== "woori_ax_forms") {
    return { instructorId: null, resolutionBasis: null };
  }

  const companyName = args.candidateCompanyName?.trim();
  const courseName = args.candidateCourseName?.trim();
  const responseDate = toDateOnlyString(args.responseDate);
  if (!companyName || !responseDate || !courseName) {
    return { instructorId: null, resolutionBasis: null };
  }

  const targetDate = new Date(`${responseDate}T00:00:00.000Z`);
  const courseTokens = courseName.includes("기획")
    ? ["기획", "전문가", "양성"]
    : courseName.split(/\s+/).filter((token) => token.length >= 2);
  const teachingRows = await prisma.teachingHistory.findMany({
    where: {
      companyName,
      AND: [
        { OR: [{ startDate: null }, { startDate: { lte: targetDate } }] },
        { OR: [{ endDate: null }, { endDate: { gte: targetDate } }] },
        ...(courseTokens.length > 0
          ? [
              {
                AND: courseTokens.map((token) => ({
                  courseName: { contains: token },
                })),
              },
            ]
          : []),
      ],
    },
    select: {
      instructorDbId: true,
    },
  });

  const instructorIds = Array.from(
    new Set(teachingRows.map((row) => row.instructorDbId).filter(Boolean))
  );
  if (instructorIds.length !== 1) {
    return { instructorId: null, resolutionBasis: null };
  }

  return {
    instructorId: instructorIds[0]!,
    resolutionBasis: "teaching_history_single_instructor",
  };
}

export async function normalizeSatisfactionSheetResults(
  results: SatisfactionSheetCollectResult[]
): Promise<{
  items: SatisfactionImportItemInput[];
  sourceSummaries: SatisfactionSourceSummary[];
}> {
  const draftItems: DraftSatisfactionItem[] = [];
  const sourceSummaries: SatisfactionSourceSummary[] = [];

  for (const result of results) {
    if (result.error) {
      sourceSummaries.push({
        sourceKey: result.definition.key,
        sourceType: result.definition.sourceType,
        fetchedRows: 0,
        importedItems: 0,
        skippedRows: 0,
        autoAcceptedCandidates: 0,
        pendingCandidates: 0,
        status: "partial",
        note: result.error,
      });
      continue;
    }

    if (result.definition.key === "kt_ai_campus") {
      const items = buildKtDraftItems(result);
      draftItems.push(...items);
      sourceSummaries.push(buildSourceSummary(result.definition, result.rows.length, items));
      continue;
    }

    if (result.definition.key === "woori_ax_forms") {
      const items = buildWooriDraftItems(result);
      draftItems.push(...items);
      sourceSummaries.push(
        buildSourceSummary(
          result.definition,
          result.rows.length,
          items,
          "강사명 없음으로 1차는 pending registry로 적재"
        )
      );
      continue;
    }

    if (result.definition.key.startsWith("hyundai_mobis_llm")) {
      const items =
        result.definition.key === "hyundai_mobis_llm" ||
        result.definition.key === "hyundai_mobis_llm_2"
          ? buildHyundaiSummaryDraftItems(result)
          : buildHyundaiFormsDraftItems(result);
      draftItems.push(...items);
      sourceSummaries.push(
        buildSourceSummary(
          result.definition,
          result.rows.length,
          items,
          items.length > 0
            ? "만족도 폴더 차수별 파일을 강의관리 시트의 김인섭/LLM 과정 메타와 연결"
            : "현대모비스 파일 구조 파싱 실패",
          items.length > 0 ? "success" : "partial"
        )
      );
      continue;
    }
  }

  const candidateNames = Array.from(
    new Set(
      draftItems
        .map((item) => item.candidateName?.trim())
        .filter((value): value is string => Boolean(value))
    )
  );

  const instructors =
    candidateNames.length > 0
      ? await prisma.instructor.findMany({
          where: { name: { in: candidateNames } },
          select: { id: true, name: true, createdAt: true },
        })
      : [];
  const instructorByName = new Map(
    Array.from(buildCanonicalInstructorByNameMap(instructors).entries()).map(
      ([name, row]) => [name, row.id]
    )
  );

  const items: SatisfactionImportItemInput[] = [];
  for (const draft of draftItems) {
    let suggestedInstructorId = draft.candidateName
      ? instructorByName.get(draft.candidateName) ?? null
      : null;
    let resolutionBasis = suggestedInstructorId ? "name_exact" : null;

    if (!suggestedInstructorId) {
      const fallback = await resolveWooriInstructorSuggestion({
        candidateCompanyName: draft.candidateCompanyName,
        candidateCourseName: draft.candidateCourseName,
        sourceKey: draft.sourceKey,
        responseDate: draft.responseDate,
      });
      if (fallback.instructorId) {
        suggestedInstructorId = fallback.instructorId;
        resolutionBasis = fallback.resolutionBasis;
      }
    }

    items.push({
      sourceType: draft.sourceType,
      sourceRefKey: draft.sourceRefKey,
      sourceRef: draft.sourceRef,
      rawPayload: draft.rawPayload,
      normalizedPayload: {
        ...draft.normalizedPayload,
        ...(suggestedInstructorId
          ? {
              suggested_instructor_id: suggestedInstructorId,
              resolution_basis: resolutionBasis,
            }
          : {}),
      },
      candidateName: draft.candidateName ?? null,
      candidateCompanyName: draft.candidateCompanyName ?? null,
      candidateCourseName: draft.candidateCourseName ?? null,
      scoreRaw: draft.scoreRaw ?? null,
      scoreNormalized: draft.scoreNormalized ?? null,
      respondentCount: draft.respondentCount ?? null,
      responseDate: draft.responseDate ?? null,
    });
  }

  const acceptedKeys = new Set(
    items
      .filter(
        (item) =>
          typeof item.normalizedPayload?.suggested_instructor_id === "string"
      )
      .map((item) => item.sourceRef?.source_key)
      .filter((value): value is string => Boolean(value))
  );

  for (const summary of sourceSummaries) {
    if (acceptedKeys.has(summary.sourceKey)) {
      summary.autoAcceptedCandidates = items.filter(
        (item) =>
          item.sourceRef?.source_key === summary.sourceKey &&
          typeof item.normalizedPayload?.suggested_instructor_id === "string"
      ).length;
      summary.pendingCandidates = Math.max(
        0,
        summary.importedItems - summary.autoAcceptedCandidates
      );
    }
  }

  await normalizeFeedbackNotesInImportItems(items);

  return { items, sourceSummaries };
}
