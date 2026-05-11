import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { buildCanonicalInstructorByNameMap } from "@/lib/instructor-name-canonical";
import type { SatisfactionImportItemInput } from "@/lib/pipeline/satisfaction-applier";
import { normalizeFeedbackNotesInImportItems } from "@/lib/pipeline/feedback-note-llm";
import {
  shouldForcePendingReviewForSourceKind,
  type SatisfactionSheetCollectResult,
  type SatisfactionSheetSourceDefinition,
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
  /**
   * Phase B/C — generic forms 파서가 강사명 미상으로 emit한 draft.
   * Phase C resolveInstructorByCourseAndDate 매칭 후 fan-out 시 사용.
   */
  needsInstructorResolution?: boolean;
  /** Phase B에서 catalog에서 자동 추출한 차수 라벨 (registry_key/응답일자 fallback에 사용) */
  sessionLabel?: string | null;
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
      // Phase C 다중 강사 fan-out 활성화
      // catalog의 expectedInstructors=[유종훈, 김정수A, 정민수A]가 L0 super-priority로 작동
      needsInstructorResolution: true,
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

// ===========================================================================
// Phase B — 일반 google_forms 파서 (회사·과정 무관 다중 강사 시트)
// ===========================================================================

/**
 * 시트 title에서 회사명을 자동 추출. 첫 `_` 또는 `(`/`[` 앞까지를 회사로 본다.
 * "(공유용)" 같은 접두 marker는 stripping. catalog의 companyName이 있으면 그 값을 우선.
 */
function deriveCompanyFromTitle(title: string): string {
  let cleaned = title.trim();
  cleaned = cleaned.replace(/^[★\(\[]?\s*공유용\s*[\)\]]?\s*[_\s-]*/u, "");
  cleaned = cleaned.replace(/^[★\(\[]?\s*공유\s*[\)\]]?\s*[_\s-]*/u, "");
  cleaned = cleaned.replace(/^[★]+\s*/u, "");
  cleaned = cleaned.replace(/^\(([^)]+)\)\s*/u, "$1 "); // "(JB우리캐피탈)..." → "JB우리캐피탈 ..."
  cleaned = cleaned.replace(/^\[([^\]]+)\]\s*/u, "$1 ");
  // 첫 토큰: `_` 우선, 없으면 공백
  const underscoreIndex = cleaned.indexOf("_");
  if (underscoreIndex > 0) {
    return cleaned.slice(0, underscoreIndex).trim();
  }
  const spaceIndex = cleaned.indexOf(" ");
  if (spaceIndex > 0) {
    return cleaned.slice(0, spaceIndex).trim();
  }
  return cleaned;
}

/**
 * 시트 title에서 과정명을 자동 추출. 회사 prefix를 제거하고, "만족도조사", "(응답)" 등 trailing meta 제거.
 */
function deriveCourseFromTitle(title: string, companyName: string): string {
  let cleaned = title.trim();
  cleaned = cleaned.replace(/^[★\(\[]?\s*공유용\s*[\)\]]?\s*[_\s-]*/u, "");
  cleaned = cleaned.replace(/^[★\(\[]?\s*공유\s*[\)\]]?\s*[_\s-]*/u, "");
  cleaned = cleaned.replace(/^[★]+\s*/u, "");
  cleaned = cleaned.replace(/^\(([^)]+)\)\s*/u, "");
  cleaned = cleaned.replace(/^\[([^\]]+)\]\s*/u, "");
  if (companyName && cleaned.startsWith(companyName)) {
    cleaned = cleaned.slice(companyName.length).replace(/^[_\s-]+/u, "");
  }
  cleaned = cleaned.replace(/\s*\(응답\)\s*$/u, "");
  cleaned = cleaned.replace(/\s*만족도\s*(조사|평가|설문)?(\s*결과)?(\s*\(응답\))?\s*$/u, "");
  cleaned = cleaned.replace(/\s*설문\s*결과\s*$/u, "");
  return cleaned.trim();
}

/**
 * 시트 title에서 차수 라벨 자동 추출. catalog의 sessionLabel이 있으면 그 값을 우선.
 *  - "Basic-6차수", "Basic 6차수" → "Basic-6차수"
 *  - "6회차"
 *  - "6기"
 *  - 없으면 null (단일 차수로 처리)
 */
function deriveSessionLabelFromTitle(title: string): string | null {
  const basicMatch = title.match(/(Basic|Pro|Plus|기본|심화|초급|중급|고급)\s*-?\s*(\d+)\s*(차수|기|회차)/iu);
  if (basicMatch) {
    return `${basicMatch[1]}-${basicMatch[2]}${basicMatch[3]}`;
  }
  const sessionMatch = title.match(/(\d+)\s*(차수|회차|기)/u);
  if (sessionMatch) {
    return `${sessionMatch[1]}${sessionMatch[2]}`;
  }
  return null;
}

/**
 * 시트 헤더에서 score 컬럼 인덱스 찾기. 우선순위:
 *   1. "전반적으로 만족|종합 만족도|전체 만족도|overall satisfaction"
 *   2. "만족도" 포함 (단 "운영" 등 제외)
 */
function findScoreColumn(headerRow: string[]): number {
  const priority1 = headerRow.findIndex((h) =>
    /전반적으로\s*만족|종합\s*만족도|전체\s*만족도|overall\s*satisfaction/i.test(h)
  );
  if (priority1 !== -1) return priority1;
  const priority2 = headerRow.findIndex((h) => /만족도/.test(h) && !/운영|관리/.test(h));
  return priority2;
}

/**
 * Phase B — 일반 google_forms 다중 강사 시트 파서.
 *
 * 입력: SatisfactionSheetCollectResult (sourceType === "google_forms")
 * 처리:
 *   - companyName/courseName/sessionLabel 자동 추출 (catalog 명시 우선)
 *   - 응답 행마다 timestamp + score 추출 → DraftSatisfactionItem (candidateName=null)
 *   - needsInstructorResolution=true 표시. Phase C가 resolveInstructorByCourseAndDate로 fan-out.
 */
function buildGenericGoogleFormsDraftItems(
  result: SatisfactionSheetCollectResult
): DraftSatisfactionItem[] {
  const rows = result.rows;
  if (rows.length < 2) return [];

  const headerRow = rows[0] ?? [];
  const timestampIndex = headerRow.findIndex((h) => /타임스탬프|timestamp/i.test(h));
  const scoreIndex = findScoreColumn(headerRow);
  if (timestampIndex === -1 || scoreIndex === -1) return [];

  const definition = result.definition;
  const companyName =
    definition.companyName?.trim() || deriveCompanyFromTitle(definition.title);
  const courseName =
    definition.courseName?.trim() || deriveCourseFromTitle(definition.title, companyName);
  const sessionLabel =
    definition.sessionLabel?.trim() || deriveSessionLabelFromTitle(definition.title);

  if (!companyName || !courseName) return [];

  const items: DraftSatisfactionItem[] = [];
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] ?? [];
    const timestampRaw = getCell(row, timestampIndex);
    const scoreRaw = getCell(row, scoreIndex);
    if (!timestampRaw && !scoreRaw) continue;

    const scoreNormalized = parseNumber(scoreRaw);
    const responseDate = parseDateValue(timestampRaw);
    if (scoreNormalized === null || !responseDate) continue;

    const feedbackNotes = dedupeFeedbackNotes(
      extractRowFeedbackNotes({
        headerRow,
        row,
        rowIndex: rowIndex + 1,
      })
    );

    const sessionOrDate = sessionLabel ?? responseDate.toISOString().slice(0, 10);

    // candidateName=null → Phase C가 채움. registry_key는 fan-out 시 instructorName 포함하여 재계산.
    items.push({
      sourceKey: definition.key,
      sourceType: definition.sourceType,
      sourceRefKey: `${definition.sourceType}:${definition.spreadsheetId}:${definition.worksheetGid}:r${rowIndex + 1}`,
      sourceRef: {
        spreadsheet_id: definition.spreadsheetId,
        worksheet_gid: definition.worksheetGid,
        row_number: rowIndex + 1,
        source_key: definition.key,
        session_label: sessionLabel ?? null,
      },
      rawPayload: {
        timestamp_raw: timestampRaw,
        score_raw: scoreRaw,
        feedback_notes: feedbackNotes,
      },
      normalizedPayload: {
        company_name: companyName,
        course_name: courseName,
        session_label: sessionLabel ?? null,
        response_date: responseDate.toISOString().slice(0, 10),
        respondent_count: 1,
        source_family: "generic_google_forms",
      },
      candidateCompanyName: companyName,
      candidateCourseName: courseName,
      scoreRaw,
      scoreNormalized,
      respondentCount: 1,
      responseDate,
      needsInstructorResolution: true,
      sessionLabel,
    });
  }

  return items;
}

/**
 * Phase B 확장 — 강의관리 시트 (sheet_summary, 회사 전용 파서 없음) 일반 파서.
 *
 * 강의관리 시트 구조: 강사명/만족도/일자 컬럼이 있는 row-based summary 시트.
 *  - 차수 또는 일자 column이 row identity
 *  - 강사 column이 candidateName
 *  - 만족도 column이 score
 *  - companyName/courseName은 catalog 또는 title에서 derive
 */
function buildGenericSheetSummaryDraftItems(
  result: SatisfactionSheetCollectResult
): DraftSatisfactionItem[] {
  const rows = result.rows;
  if (rows.length < 2) return [];

  // 헤더 row 찾기 — 첫 5 row 중 "강사" 또는 "만족도" 또는 "차수" 키워드가 가장 많이 나오는 row.
  let headerRowIndex = -1;
  let bestScore = 0;
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    const row = rows[i] ?? [];
    let score = 0;
    for (const cell of row) {
      const c = (cell ?? "").trim();
      if (/강사/.test(c)) score += 2;
      if (/만족도/.test(c)) score += 2;
      if (/차수|회차|기수/.test(c)) score += 1;
      if (/일자|일정|날짜/.test(c)) score += 1;
      if (/응답|인원|점수/.test(c)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      headerRowIndex = i;
    }
  }
  if (headerRowIndex === -1 || bestScore < 4) return [];

  const headerRow = rows[headerRowIndex] ?? [];
  const findCol = (re: RegExp): number =>
    headerRow.findIndex((h) => re.test((h ?? "").trim()));

  const instructorCol = findCol(/^강사(?:명)?$/);
  const scoreCol =
    findCol(/^전체\s*만족도|^종합\s*만족도|^전반적/) >= 0
      ? findCol(/^전체\s*만족도|^종합\s*만족도|^전반적/)
      : findCol(/만족도/);
  const sessionCol = findCol(/차수|회차|기수/);
  const dateCol = findCol(/교육\s*일자|일정\s*시작|시작\s*일|일자|날짜/);
  const respondentCol = findCol(/응답.*인원|만족도.*인원|참여.*인원|인원/);

  if (instructorCol === -1 || scoreCol === -1) return [];

  const definition = result.definition;
  const companyName =
    definition.companyName?.trim() || deriveCompanyFromTitle(definition.title);
  const courseName =
    definition.courseName?.trim() || deriveCourseFromTitle(definition.title, companyName);
  if (!companyName || !courseName) return [];

  const items: DraftSatisfactionItem[] = [];
  for (let rowIndex = headerRowIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] ?? [];
    const instructorRaw = getCell(row, instructorCol);
    const scoreRaw = getCell(row, scoreCol);
    if (!instructorRaw || !scoreRaw) continue;

    const scoreNormalized = parseNumber(scoreRaw);
    if (scoreNormalized === null) continue;

    const sessionLabel =
      sessionCol >= 0 ? getCell(row, sessionCol) : null;
    const dateRaw = dateCol >= 0 ? getCell(row, dateCol) : null;
    const responseDate = dateRaw ? parseDateValue(dateRaw) : null;
    const respondentCount =
      respondentCol >= 0 ? parseNumber(getCell(row, respondentCol)) : null;

    const sessionOrDate =
      (sessionLabel && sessionLabel.length > 0
        ? sessionLabel
        : responseDate?.toISOString().slice(0, 10)) ?? `r${rowIndex + 1}`;

    const registryKey = buildSatisfactionRegistryKey({
      sourceFamily: definition.key,
      companyName,
      courseName,
      sessionOrDate,
      instructorName: instructorRaw,
    });

    const feedbackNotes = dedupeFeedbackNotes(
      extractRowFeedbackNotes({
        headerRow,
        row,
        rowIndex: rowIndex + 1,
      })
    );

    items.push({
      sourceKey: definition.key,
      sourceType: definition.sourceType,
      sourceRefKey: `${definition.sourceType}:${definition.spreadsheetId}:${definition.worksheetGid}:r${rowIndex + 1}`,
      sourceRef: {
        spreadsheet_id: definition.spreadsheetId,
        worksheet_gid: definition.worksheetGid,
        row_number: rowIndex + 1,
        source_key: definition.key,
        session_label: sessionLabel,
      },
      rawPayload: {
        instructor_raw: instructorRaw,
        score_raw: scoreRaw,
        date_raw: dateRaw,
        session_raw: sessionLabel,
        feedback_notes: feedbackNotes,
      },
      normalizedPayload: {
        registry_key: registryKey,
        company_name: companyName,
        course_name: courseName,
        session_label: sessionLabel,
        response_date: responseDate?.toISOString().slice(0, 10) ?? null,
        instructor_name: instructorRaw,
        respondent_count: respondentCount ?? 1,
        source_family: "generic_sheet_summary",
      },
      candidateName: instructorRaw,
      candidateCompanyName: companyName,
      candidateCourseName: courseName,
      scoreRaw,
      scoreNormalized,
      respondentCount: respondentCount ?? 1,
      responseDate,
      sessionLabel,
    });
  }

  return items;
}

/**
 * dispatchSheetParser — 시트 sourceKey/sourceType에 따라 적절한 파서 라우터.
 *  우선순위: KT > 현대모비스 > 우리은행 > generic google_forms > generic sheet_summary
 *
 *  generic 파서가 처리한 시트는 reports/satisfaction-coverage 에 generic_dispatch=true 표시 가능.
 */
function dispatchSheetParser(
  result: SatisfactionSheetCollectResult
): {
  items: DraftSatisfactionItem[];
  parserUsed: string;
  note?: string;
  status?: "success" | "partial" | "skipped";
} {
  const key = result.definition.key;

  if (key === "kt_ai_campus") {
    return { items: buildKtDraftItems(result), parserUsed: "kt" };
  }

  if (key === "woori_ax_forms") {
    return {
      items: buildWooriDraftItems(result),
      parserUsed: "woori",
      note: "다중 강사 fan-out (catalog expectedInstructors L0 super-priority)",
    };
  }

  if (key.startsWith("hyundai_mobis_llm")) {
    const items =
      key === "hyundai_mobis_llm" || key === "hyundai_mobis_llm_2"
        ? buildHyundaiSummaryDraftItems(result)
        : buildHyundaiFormsDraftItems(result);
    return {
      items,
      parserUsed: "hyundai",
      note:
        items.length > 0
          ? "만족도 폴더 차수별 파일을 강의관리 시트의 김인섭/LLM 과정 메타와 연결"
          : "현대모비스 파일 구조 파싱 실패",
      status: items.length > 0 ? "success" : "partial",
    };
  }

  // 일반 google_forms 다중 강사 시트
  if (result.definition.sourceType === "google_forms") {
    const items = buildGenericGoogleFormsDraftItems(result);
    return {
      items,
      parserUsed: "generic_google_forms",
      note:
        items.length > 0
          ? "일반 google_forms 파서로 처리 — Phase C에서 강사 매칭"
          : "일반 google_forms 파서 — 헤더(타임스탬프/만족도) 인식 실패",
      status: items.length > 0 ? "success" : "partial",
    };
  }

  // 일반 강의관리 시트 (sheet_summary, 회사 전용 파서 없음)
  if (result.definition.sourceType === "sheet_summary") {
    const items = buildGenericSheetSummaryDraftItems(result);
    return {
      items,
      parserUsed: "generic_sheet_summary",
      note:
        items.length > 0
          ? "일반 강의관리 시트 파서 — 강사+만족도 헤더 매칭"
          : "일반 강의관리 시트 — 헤더(강사/만족도) 인식 실패",
      status: items.length > 0 ? "success" : "partial",
    };
  }

  return { items: [], parserUsed: "none", note: "지원 안 되는 시트", status: "skipped" };
}

// ===========================================================================
// Phase C — 다중 강사 차수 자동 매칭 알고리즘 (회사·과정 무관 일반화)
// ===========================================================================

interface ResolveByCourseAndDateArgs {
  candidateCompanyName: string | null;
  candidateCourseName: string | null;
  responseDate: Date | string | null;
  /** catalog instructorHint (L4 폴백, 단일 강사) */
  instructorHint?: string | null;
  /** catalog expectedInstructors (L4 폴백, 다중 강사 명시) */
  expectedInstructors?: string[];
  /** catalog companyAliases (L1/L3 매칭 보강) */
  companyAliases?: string[];
}

interface ResolveByCourseAndDateResult {
  instructorIds: string[];
  /** L0~L5 단계명 — reports에 표시 (L0 = catalog expectedInstructors super-priority) */
  resolutionLevel: "L0" | "L1" | "L2" | "L3" | "L4" | "L5";
  resolutionBasis: string;
  /**
   * Expert P0-2/P0-3: 자동 수락 여부.
   *  true  → SatisfactionRecord 자동 생성 (auto_accepted)
   *  false → ReviewRegistry pending_review로 적재. Record 안 만듦.
   *
   * 정책 (정확성 우선):
   *  - L0 단일 expectedInstructor (length=1) → auto-accept (강사별 평균 신뢰)
   *  - L0 다중 (length>=2) → pending_review (다중 강사 시 강사별 만족도 왜곡)
   *  - L1 단일 강사 일정 정확 매칭 → auto-accept
   *  - L1 다중 강사 → pending_review (P0-3)
   *  - L2/L3/L4 모두 → pending_review (자동 매칭 신뢰 X)
   *  - L5 → 빈 배열
   */
  shouldAutoAccept: boolean;
}

/**
 * normalizeFeeLinkText 와 같은 텍스트 정규화 (대소문자/공백/특수문자 제거).
 */
function normalizeForMatch(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[\s()[\]{}.,:;'"`~!?+\-_/\\|]+/g, "")
    .trim();
}

/**
 * 강사 매칭 자동 알고리즘 — 회사·과정 무관, 다중 강사 일반화.
 *
 * L1 (정확): contract sheet 행 중 [startDate, endDate] ⊇ responseDate 만족 강사 후보 ≥ 1명 → 모두 매칭
 * L2 (일정 근접): L1 0명 → responseDate 와 가장 가까운 일정 강사 매칭 (14일 이내)
 * L3 (텍스트 부분): L2 0명 → companyName/courseName 부분 매칭 강사 모두 (광범위 폴백)
 * L4 (catalog hint): L3 0명 → instructorHint 단일 강사 매칭
 * L5 (실패 보고): 모두 실패 → 빈 배열 + 사유
 */
async function resolveInstructorByCourseAndDate(
  args: ResolveByCourseAndDateArgs
): Promise<ResolveByCourseAndDateResult> {
  const companyName = args.candidateCompanyName?.trim() ?? "";
  const courseName = args.candidateCourseName?.trim() ?? "";
  const responseDateStr = toDateOnlyString(args.responseDate);
  if (!responseDateStr || (!companyName && !courseName)) {
    return {
      instructorIds: [],
      resolutionLevel: "L5",
      resolutionBasis: "missing_input",
      shouldAutoAccept: false,
    };
  }
  const targetDate = new Date(`${responseDateStr}T00:00:00.000Z`);

  // Expert P0-2: L0 super-priority 제거.
  // 변경 전: expectedInstructors가 있으면 L1 평가 전에 즉시 매칭 (단일은 auto-accept).
  // 변경 후: expectedInstructors는 candidate set 생성 용도만. L4 fallback에서만 사용.
  // 이유:
  //   - 전문가 권고 (line 374-378): "expectedInstructors는 candidate set 생성에만 사용. 자동 반영 금지."
  //   - L1 일정 매칭 기회 보존: e.g., 박상훈만 동국제강 일정 매칭되면 L1 단일 auto-accept 가능.
  //   - 다중 강사 시트(satisfactionLevel=course)는 일정 기반 L1/L2 매칭 후 pending이 정확.

  // L1 — companyName/courseName 정규화 매칭 + 일정 포함 (companyAliases 포함)
  const companyContains: string[] = [];
  const courseTokens: string[] = [];
  if (companyName) companyContains.push(companyName);
  if (args.companyAliases) companyContains.push(...args.companyAliases.filter((a) => a.trim()));
  if (courseName) {
    // 토큰화: 길이 ≥ 2인 토큰만 추출
    courseTokens.push(...courseName.split(/\s+/).filter((t) => t.length >= 2));
  }

  const orFilters: Array<Record<string, unknown>> = [];
  for (const company of companyContains) {
    orFilters.push({ companyName: { contains: company } });
  }
  if (courseName) orFilters.push({ courseName: { contains: courseName } });

  const courseTokenAndFilter =
    courseTokens.length >= 2
      ? courseTokens.slice(0, 4).map((t) => ({ courseName: { contains: t } }))
      : [];

  // L1 후보: 응답일자 포함 일정
  const l1Rows = await prisma.teachingHistory.findMany({
    where: {
      AND: [
        ...(orFilters.length > 0 ? [{ OR: orFilters }] : []),
        { OR: [{ startDate: null }, { startDate: { lte: targetDate } }] },
        { OR: [{ endDate: null }, { endDate: { gte: targetDate } }] },
        ...(courseTokenAndFilter.length > 0 ? [{ AND: courseTokenAndFilter }] : []),
      ],
    },
    select: {
      instructorDbId: true,
      instructor: { select: { isPracticeCoach: true } },
    },
  });
  const l1Ids = Array.from(
    new Set(
      l1Rows
        .filter((r) => !r.instructor.isPracticeCoach)
        .map((r) => r.instructorDbId)
        .filter(Boolean)
    )
  );
  if (l1Ids.length >= 1) {
    // Expert P0-3: L1 단일 강사만 auto-accept. 다중이면 pending_review.
    return {
      instructorIds: l1Ids,
      resolutionLevel: "L1",
      resolutionBasis:
        l1Ids.length === 1
          ? "schedule_overlap_single_instructor"
          : "schedule_overlap_multi_instructor_pending",
      shouldAutoAccept: l1Ids.length === 1,
    };
  }

  // L2 — 일정 근접 (14일 이내)
  const candidateRows = await prisma.teachingHistory.findMany({
    where: {
      AND: [
        ...(orFilters.length > 0 ? [{ OR: orFilters }] : []),
        ...(courseTokenAndFilter.length > 0 ? [{ AND: courseTokenAndFilter }] : []),
      ],
    },
    select: {
      instructorDbId: true,
      startDate: true,
      endDate: true,
      instructor: { select: { isPracticeCoach: true } },
    },
  });
  const filteredCandidates = candidateRows.filter(
    (r) => !r.instructor.isPracticeCoach
  );
  const targetMs = targetDate.getTime();
  let bestDist = Number.MAX_SAFE_INTEGER;
  const bestIds = new Set<string>();
  for (const r of filteredCandidates) {
    const startMs = r.startDate?.getTime() ?? null;
    const endMs = r.endDate?.getTime() ?? null;
    let dist = Number.MAX_SAFE_INTEGER;
    if (startMs !== null && endMs !== null) {
      if (targetMs < startMs) dist = startMs - targetMs;
      else if (targetMs > endMs) dist = targetMs - endMs;
      else dist = 0;
    } else if (startMs !== null) {
      dist = Math.abs(targetMs - startMs);
    } else if (endMs !== null) {
      dist = Math.abs(targetMs - endMs);
    }
    if (dist < bestDist) {
      bestDist = dist;
      bestIds.clear();
      if (r.instructorDbId) bestIds.add(r.instructorDbId);
    } else if (dist === bestDist && r.instructorDbId) {
      bestIds.add(r.instructorDbId);
    }
  }
  const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
  if (bestIds.size >= 1 && bestDist <= fourteenDaysMs) {
    // Expert P0-3: L2 (일정 근접)은 자동 매칭 X. pending_review.
    return {
      instructorIds: Array.from(bestIds),
      resolutionLevel: "L2",
      resolutionBasis: `schedule_proximity_${Math.round(bestDist / (24 * 60 * 60 * 1000))}d_pending`,
      shouldAutoAccept: false,
    };
  }

  // L3 — 회사+과정 부분 매칭 (가장 광범위)
  const l3Rows = await prisma.teachingHistory.findMany({
    where: {
      OR: orFilters.length > 0 ? orFilters : undefined,
    },
    select: {
      instructorDbId: true,
      instructor: { select: { isPracticeCoach: true } },
    },
  });
  const l3Ids = Array.from(
    new Set(
      l3Rows
        .filter((r) => !r.instructor.isPracticeCoach)
        .map((r) => r.instructorDbId)
        .filter(Boolean)
    )
  );
  if (l3Ids.length >= 1) {
    // Expert P0-3: L3 (회사+과정 substring)은 자동 매칭 X. pending_review.
    return {
      instructorIds: l3Ids,
      resolutionLevel: "L3",
      resolutionBasis: "company_course_substring_pending",
      shouldAutoAccept: false,
    };
  }

  // L4 — catalog instructorHint 또는 expectedInstructors 폴백
  const namesToTry = new Set<string>();
  if (args.instructorHint?.trim()) namesToTry.add(args.instructorHint.trim());
  if (args.expectedInstructors) {
    for (const n of args.expectedInstructors) {
      if (n?.trim()) namesToTry.add(n.trim());
    }
  }
  if (namesToTry.size > 0) {
    const hints = await prisma.instructor.findMany({
      where: { name: { in: Array.from(namesToTry) } },
      select: { id: true, name: true, isPracticeCoach: true },
    });
    const ids = hints
      .filter((h) => !h.isPracticeCoach)
      .map((h) => h.id);
    if (ids.length >= 1) {
      // Expert P0-3: L4 (instructorHint/expectedInstructors fallback)은 자동 매칭 X. pending_review.
      return {
        instructorIds: ids,
        resolutionLevel: "L4",
        resolutionBasis:
          ids.length === 1
            ? "catalog_instructor_hint_pending"
            : "catalog_expected_instructors_pending",
        shouldAutoAccept: false,
      };
    }
  }

  // L5 — 실패
  return {
    instructorIds: [],
    resolutionLevel: "L5",
    resolutionBasis: "no_match_after_all_fallbacks",
    shouldAutoAccept: false,
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

    const dispatch = dispatchSheetParser(result);
    draftItems.push(...dispatch.items);
    sourceSummaries.push(
      buildSourceSummary(
        result.definition,
        result.rows.length,
        dispatch.items,
        dispatch.note,
        dispatch.status
      )
    );
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

  // Phase C — 다중 강사 매칭에 필요한 catalog 정보 (instructorHint 등) 매핑
  const catalogByKey = new Map<string, SatisfactionSheetSourceDefinition>();
  for (const result of results) {
    catalogByKey.set(result.definition.key, result.definition);
  }
  // 강사 ID → 이름 lookup (registry_key에 instructorName 인코딩용)
  const allInstructorIdsNeeded = new Set<string>();
  // Phase 1 pass — 모든 draft에 대해 resolution을 미리 수행하여 ID 수집 후 이름 lookup
  const resolutionByDraftIndex: Array<ResolveByCourseAndDateResult | null> = [];
  for (const draft of draftItems) {
    if (!draft.needsInstructorResolution) {
      resolutionByDraftIndex.push(null);
      continue;
    }
    const definition = catalogByKey.get(draft.sourceKey);
    const resolution = await resolveInstructorByCourseAndDate({
      candidateCompanyName: draft.candidateCompanyName ?? null,
      candidateCourseName: draft.candidateCourseName ?? null,
      responseDate: draft.responseDate ?? null,
      instructorHint: definition?.instructorHint ?? null,
      expectedInstructors: definition?.expectedInstructors,
      companyAliases: definition?.companyAliases,
    });
    for (const id of resolution.instructorIds) allInstructorIdsNeeded.add(id);
    resolutionByDraftIndex.push(resolution);
  }
  const resolvedInstructorRecords =
    allInstructorIdsNeeded.size > 0
      ? await prisma.instructor.findMany({
          where: { id: { in: Array.from(allInstructorIdsNeeded) } },
          select: { id: true, name: true },
        })
      : [];
  const instructorNameById = new Map<string, string>(
    resolvedInstructorRecords.map((row) => [row.id, row.name])
  );

  const items: SatisfactionImportItemInput[] = [];
  for (let i = 0; i < draftItems.length; i++) {
    const draft = draftItems[i]!;
    const resolution = resolutionByDraftIndex[i];

    if (resolution && resolution.instructorIds.length > 0) {
      // Expert P0-2/P0-3 정책: shouldAutoAccept=true 만 SatisfactionRecord로 가는 경로 진입.
      // shouldAutoAccept=false면 ImportItem만 생성, suggested_instructor_id 비움 → applier가 pending_review로 적재.
      // Expert P0-7: unknown sourceKind 시트의 매칭은 항상 pending (운영자 검토 강제).
      const definition = catalogByKey.get(draft.sourceKey);
      const forcePending = shouldForcePendingReviewForSourceKind(
        definition?.sourceKind
      );
      const shouldAutoAccept = resolution.shouldAutoAccept && !forcePending;
      for (const instructorId of resolution.instructorIds) {
        const instructorName = instructorNameById.get(instructorId) ?? "";
        const sessionOrDate =
          draft.sessionLabel ??
          (draft.responseDate
            ? toDateOnlyString(draft.responseDate) ?? "unknown"
            : "unknown");
        const registryKey = buildSatisfactionRegistryKey({
          sourceFamily: draft.sourceKey,
          companyName: draft.candidateCompanyName ?? "",
          courseName: draft.candidateCourseName ?? "",
          sessionOrDate,
          // pending_review 케이스는 instructor 별 registry 분리 (운영자 검토 시 candidate별 결정 가능)
          instructorName,
        });
        items.push({
          sourceType: draft.sourceType,
          sourceRefKey: `${draft.sourceRefKey}:i${instructorId}`,
          sourceRef: {
            ...draft.sourceRef,
            resolved_instructor_id: instructorId,
            resolution_level: resolution.resolutionLevel,
            resolution_basis: resolution.resolutionBasis,
            should_auto_accept: shouldAutoAccept,
          },
          rawPayload: draft.rawPayload,
          normalizedPayload: {
            ...draft.normalizedPayload,
            registry_key: registryKey,
            instructor_name: instructorName,
            // shouldAutoAccept=true 만 suggested_instructor_id 채움 → applier가 auto_accepted 처리.
            // false면 candidate만 적재 → pending_review.
            ...(shouldAutoAccept ? { suggested_instructor_id: instructorId } : {}),
            resolution_basis: resolution.resolutionBasis,
            resolution_level: resolution.resolutionLevel,
            should_auto_accept: shouldAutoAccept,
          },
          candidateName: instructorName,
          candidateCompanyName: draft.candidateCompanyName ?? null,
          candidateCourseName: draft.candidateCourseName ?? null,
          scoreRaw: draft.scoreRaw ?? null,
          scoreNormalized: draft.scoreNormalized ?? null,
          respondentCount: draft.respondentCount ?? null,
          responseDate: draft.responseDate ?? null,
        });
      }
      continue;
    }

    if (resolution && resolution.instructorIds.length === 0) {
      // L5 — 실패 보고. pending으로 적재 (운영팀 catalog 정정 인계).
      items.push({
        sourceType: draft.sourceType,
        sourceRefKey: draft.sourceRefKey,
        sourceRef: {
          ...draft.sourceRef,
          resolution_level: "L5",
          resolution_basis: resolution.resolutionBasis,
        },
        rawPayload: draft.rawPayload,
        normalizedPayload: {
          ...draft.normalizedPayload,
          resolution_level: "L5",
          resolution_basis: resolution.resolutionBasis,
        },
        candidateName: draft.candidateName ?? null,
        candidateCompanyName: draft.candidateCompanyName ?? null,
        candidateCourseName: draft.candidateCourseName ?? null,
        scoreRaw: draft.scoreRaw ?? null,
        scoreNormalized: draft.scoreNormalized ?? null,
        respondentCount: draft.respondentCount ?? null,
        responseDate: draft.responseDate ?? null,
      });
      continue;
    }

    // 기존 회사 전용 파서 경로 (KT/현대모비스/우리은행) — candidateName 또는 woori 폴백
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
