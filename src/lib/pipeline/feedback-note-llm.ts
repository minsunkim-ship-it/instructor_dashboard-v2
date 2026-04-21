import type { SatisfactionImportItemInput } from "@/lib/pipeline/satisfaction-applier";

type FeedbackNoteType =
  | "teaching_feedback_qualitative"
  | "teaching_feedback_ops";

type FeedbackNoteRecord = {
  note_type: FeedbackNoteType;
  text: string;
  [key: string]: unknown;
};

type PendingSourceKind = "feedback_note" | "drive_sheet_note" | "gmail_body_excerpt";

type PendingSourceEntry = {
  sourceId: string;
  itemIndex: number;
  kind: PendingSourceKind;
  noteTypeHint: FeedbackNoteType | null;
  text: string;
  companyName: string | null;
  courseName: string | null;
  sessionLabel: string | null;
  responseDate: string | null;
  metadataHint: string | null;
};

type FeedbackNormalizationResult = {
  source_id: string;
  units: Array<{
    note_type: FeedbackNoteType;
    text: string;
  }>;
};

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_FEEDBACK_NOTE_MODEL = "gpt-5.4-mini";
const FEEDBACK_NOTE_BATCH_SIZE = 8;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function sanitizeModelUnitText(value: string | null | undefined): string | null {
  const normalized = normalizeText(value)
    .replace(/^[>\-*•\s]+/, "")
    .replace(/^\d+(?:[.)]|-\d+\.)\s*/, "")
    .trim();
  if (!normalized) return null;
  if (normalized.length < 4) return null;
  if (/^[0-9./:()\s,-]+$/.test(normalized)) return null;
  if (/^(안녕하세요|감사합니다|좋은 하루|남은 하루|From:|To:|Cc:|Bcc:|Subject:|보낸사람:|받는사람:|참조:|확인 부탁드리|공유 부탁드리|전달 부탁드리)/i.test(normalized)) {
    return null;
  }
  return normalized;
}

function dedupeNotes<T extends FeedbackNoteRecord>(notes: T[], maxNotes = 60): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];

  for (const note of notes) {
    const normalized = sanitizeModelUnitText(note.text);
    if (!normalized) continue;
    const key = `${note.note_type}::${normalized.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({
      ...note,
      text: normalized,
    });
    if (deduped.length >= maxNotes) break;
  }

  return deduped;
}

function getString(value: unknown): string | null {
  return typeof value === "string" ? normalizeText(value) || null : null;
}

function getFeedbackLlmConfig():
  | {
      apiKey: string;
      model: string;
      url: string;
    }
  | null {
  const enabled = process.env.SATISFACTION_FEEDBACK_LLM_ENABLED?.trim();
  if (enabled === "false") return null;

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;

  return {
    apiKey,
    model:
      process.env.SATISFACTION_FEEDBACK_LLM_MODEL?.trim() ||
      process.env.OPENAI_MODEL?.trim() ||
      DEFAULT_FEEDBACK_NOTE_MODEL,
    url:
      process.env.OPENAI_RESPONSES_URL?.trim() ||
      process.env.OPENAI_BASE_URL?.trim() ||
      OPENAI_RESPONSES_URL,
  };
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function extractResponseText(responseBody: Record<string, unknown>): string {
  const output = Array.isArray(responseBody.output) ? responseBody.output : [];
  const texts: string[] = [];

  for (const item of output) {
    const content = Array.isArray(asRecord(item).content)
      ? (asRecord(item).content as unknown[])
      : [];
    for (const chunk of content) {
      const record = asRecord(chunk);
      if (record.type === "output_text" && typeof record.text === "string") {
        texts.push(record.text);
      }
    }
  }

  return texts.join("\n").trim();
}

function buildFeedbackNormalizationPrompt(entries: PendingSourceEntry[]): string {
  return [
    "You normalize Korean teaching feedback into meaning units.",
    "Use only the provided text. Do not invent or merge across different source_id values.",
    "Split each source into 0..6 meaningful feedback units.",
    "Drop pure metadata, names, email headers/signatures, attendance tables, action-request tails, and clearly truncated fragments.",
    "If a unit is about tools, environment, login, schedule, time pressure, device constraints, or 운영 issues, use note_type=teaching_feedback_ops.",
    "If a unit is about explanation quality, examples, pace, usefulness, practice, understanding, immersion, or learner satisfaction, use note_type=teaching_feedback_qualitative.",
    "Keep the output concise, in Korean, and close to the original wording.",
    "Return JSON only.",
    "",
    "Sources:",
    JSON.stringify(
      entries.map((entry) => ({
        source_id: entry.sourceId,
        kind: entry.kind,
        note_type_hint: entry.noteTypeHint,
        metadata_hint: entry.metadataHint,
        company_name: entry.companyName,
        course_name: entry.courseName,
        session_label: entry.sessionLabel,
        response_date: entry.responseDate,
        text: entry.text,
      })),
      null,
      2
    ),
  ].join("\n");
}

function getFeedbackNormalizationSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      normalized_notes: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            source_id: { type: "string" },
            units: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  note_type: {
                    type: "string",
                    enum: [
                      "teaching_feedback_qualitative",
                      "teaching_feedback_ops",
                    ],
                  },
                  text: { type: "string" },
                },
                required: ["note_type", "text"],
              },
            },
          },
          required: ["source_id", "units"],
        },
      },
    },
    required: ["normalized_notes"],
  };
}

async function normalizeEntriesWithLlm(
  entries: PendingSourceEntry[]
): Promise<Map<string, FeedbackNormalizationResult["units"]>> {
  const config = getFeedbackLlmConfig();
  if (!config || entries.length === 0) {
    return new Map<string, FeedbackNormalizationResult["units"]>();
  }

  const results = new Map<string, FeedbackNormalizationResult["units"]>();
  const batches = chunkArray(entries, FEEDBACK_NOTE_BATCH_SIZE);

  for (const batch of batches) {
    let response: Response;
    try {
      response = await fetch(config.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          reasoning: { effort: "low" },
          input: buildFeedbackNormalizationPrompt(batch),
          text: {
            format: {
              type: "json_schema",
              name: "feedback_meaning_units",
              schema: getFeedbackNormalizationSchema(),
            },
          },
        }),
      });
    } catch {
      return new Map<string, FeedbackNormalizationResult["units"]>();
    }

    if (!response.ok) {
      return new Map<string, FeedbackNormalizationResult["units"]>();
    }

    let parsed: { normalized_notes?: FeedbackNormalizationResult[] };
    try {
      const body = (await response.json()) as Record<string, unknown>;
      parsed = JSON.parse(extractResponseText(body)) as {
        normalized_notes?: FeedbackNormalizationResult[];
      };
    } catch {
      return new Map<string, FeedbackNormalizationResult["units"]>();
    }

    for (const item of parsed.normalized_notes ?? []) {
      if (typeof item.source_id !== "string") continue;
      const units = Array.isArray(item.units)
        ? item.units
            .map((unit) => {
              const noteType =
                unit.note_type === "teaching_feedback_ops"
                  ? "teaching_feedback_ops"
                  : "teaching_feedback_qualitative";
              const text = sanitizeModelUnitText(unit.text);
              return text ? { note_type: noteType, text } : null;
            })
            .filter(
              (
                unit
              ): unit is {
                note_type: FeedbackNoteType;
                text: string;
              } => Boolean(unit)
            )
        : [];
      results.set(item.source_id, units);
    }
  }

  return results;
}

function asFeedbackNoteArray(value: unknown): FeedbackNoteRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    const noteType =
      record.note_type === "teaching_feedback_ops"
        ? "teaching_feedback_ops"
        : record.note_type === "teaching_feedback_qualitative"
          ? "teaching_feedback_qualitative"
          : null;
    const text = getString(record.text);
    if (!noteType || !text) return [];
    return [{ ...record, note_type: noteType, text }];
  });
}

function notesEqual(a: FeedbackNoteRecord[], b: FeedbackNoteRecord[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function buildPendingEntries(items: SatisfactionImportItemInput[]): PendingSourceEntry[] {
  const entries: PendingSourceEntry[] = [];

  items.forEach((item, itemIndex) => {
    const rawPayload = asRecord(item.rawPayload);
    const normalizedPayload = asRecord(item.normalizedPayload);
    const companyName =
      item.candidateCompanyName ?? getString(normalizedPayload.company_name);
    const courseName =
      item.candidateCourseName ?? getString(normalizedPayload.course_name);
    const sessionLabel = getString(normalizedPayload.session_label);
    const responseDate = getString(normalizedPayload.response_date);

    const feedbackNotes = asFeedbackNoteArray(rawPayload.feedback_notes);
    feedbackNotes.forEach((note, noteIndex) => {
      entries.push({
        sourceId: `item:${itemIndex}:feedback:${noteIndex}`,
        itemIndex,
        kind: "feedback_note",
        noteTypeHint: note.note_type,
        text: note.text,
        companyName,
        courseName,
        sessionLabel,
        responseDate,
        metadataHint: getString(note.header),
      });
    });

    const driveSheetNotes = asFeedbackNoteArray(rawPayload.drive_sheet_notes);
    driveSheetNotes.forEach((note, noteIndex) => {
      const tab = getString(note.tab);
      const rowIndex =
        typeof note.row_index === "number" ? String(note.row_index) : null;
      entries.push({
        sourceId: `item:${itemIndex}:drive:${noteIndex}`,
        itemIndex,
        kind: "drive_sheet_note",
        noteTypeHint: note.note_type,
        text: note.text,
        companyName,
        courseName,
        sessionLabel,
        responseDate,
        metadataHint: [tab, rowIndex ? `row ${rowIndex}` : null]
          .filter(Boolean)
          .join(" / "),
      });
    });

    const bodyExcerpt = getString(rawPayload.body_excerpt);
    const alreadyExtracted = rawPayload.feedback_notes_llm_extracted === true;
    if (
      item.sourceType === "gmail_summary" &&
      bodyExcerpt &&
      !alreadyExtracted
    ) {
      entries.push({
        sourceId: `item:${itemIndex}:body`,
        itemIndex,
        kind: "gmail_body_excerpt",
        noteTypeHint: null,
        text: bodyExcerpt.slice(0, 2400),
        companyName,
        courseName,
        sessionLabel,
        responseDate,
        metadataHint: "gmail_body_excerpt",
      });
    }
  });

  return entries;
}

function applyNormalizedNotesToItems(
  items: SatisfactionImportItemInput[],
  entries: PendingSourceEntry[],
  normalizedBySourceId: Map<string, FeedbackNormalizationResult["units"]>
): void {
  const entriesByItem = new Map<number, PendingSourceEntry[]>();
  for (const entry of entries) {
    const bucket = entriesByItem.get(entry.itemIndex) ?? [];
    bucket.push(entry);
    entriesByItem.set(entry.itemIndex, bucket);
  }

  for (const [itemIndex, itemEntries] of entriesByItem) {
    const item = items[itemIndex];
    if (!item) continue;

    const rawPayload = asRecord(item.rawPayload);

    const currentFeedbackNotes = asFeedbackNoteArray(rawPayload.feedback_notes);
    const currentDriveNotes = asFeedbackNoteArray(rawPayload.drive_sheet_notes);
    const feedbackEntryIds = new Set(
      itemEntries
        .filter((entry) => entry.kind === "feedback_note")
        .map((entry) => entry.sourceId)
    );
    const driveEntryIds = new Set(
      itemEntries
        .filter((entry) => entry.kind === "drive_sheet_note")
        .map((entry) => entry.sourceId)
    );

    const nextFeedbackNotes = currentFeedbackNotes.flatMap((original, noteIndex) => {
      const entryId = `item:${itemIndex}:feedback:${noteIndex}`;
      if (!feedbackEntryIds.has(entryId)) return [original];
      const units = normalizedBySourceId.get(entryId);
      if (!units) return [original];
      return units.map((unit) => ({
        ...original,
        note_type: unit.note_type,
        text: unit.text,
      }));
    });

    const nextDriveNotes = currentDriveNotes.flatMap((original, noteIndex) => {
      const entryId = `item:${itemIndex}:drive:${noteIndex}`;
      if (!driveEntryIds.has(entryId)) return [original];
      const units = normalizedBySourceId.get(entryId);
      if (!units) return [original];
      return units.map((unit) => ({
        ...original,
        note_type: unit.note_type,
        text: unit.text,
      }));
    });

    const bodyUnits: FeedbackNoteRecord[] = [];
    let bodyExtracted = false;

    for (const entry of itemEntries) {
      const units = normalizedBySourceId.get(entry.sourceId);
      if (!units) continue;

      if (entry.kind === "gmail_body_excerpt") {
        for (const unit of units) {
          bodyUnits.push({
            note_type: unit.note_type,
            text: unit.text,
          });
        }
        if (units.length > 0) {
          bodyExtracted = true;
        }
      }
    }

    const mergedFeedbackNotes = dedupeNotes([
      ...bodyUnits,
      ...nextFeedbackNotes,
    ]);
    const mergedDriveNotes = dedupeNotes(nextDriveNotes);

    if (
      currentFeedbackNotes.length > 0 &&
      !notesEqual(currentFeedbackNotes, mergedFeedbackNotes)
    ) {
      rawPayload.feedback_notes_original ??= currentFeedbackNotes;
    }
    if (
      currentDriveNotes.length > 0 &&
      !notesEqual(currentDriveNotes, mergedDriveNotes)
    ) {
      rawPayload.drive_sheet_notes_original ??= currentDriveNotes;
    }

    if (mergedFeedbackNotes.length > 0 || currentFeedbackNotes.length > 0) {
      rawPayload.feedback_notes = mergedFeedbackNotes;
      rawPayload.feedback_notes_llm_normalized = true;
    }
    if (mergedDriveNotes.length > 0 || currentDriveNotes.length > 0) {
      rawPayload.drive_sheet_notes = mergedDriveNotes;
      rawPayload.drive_sheet_notes_llm_normalized = true;
    }
    if (bodyExtracted) {
      rawPayload.feedback_notes_llm_extracted = true;
    }
  }
}

export async function normalizeFeedbackNotesInImportItems(
  items: SatisfactionImportItemInput[]
): Promise<void> {
  const entries = buildPendingEntries(items);
  if (entries.length === 0) return;

  const normalizedBySourceId = await normalizeEntriesWithLlm(entries);
  if (normalizedBySourceId.size === 0) return;

  applyNormalizedNotesToItems(items, entries, normalizedBySourceId);
}
