const ALLOWED_DECISION_TYPES = new Set([
  "approve",
  "reject",
  "override_instructor",
  "invalidate",
] as const);

export interface ReviewDecisionInput {
  registryType: string;
  registryKey: string;
  decisionType: "approve" | "reject" | "override_instructor" | "invalidate";
  targetInstructorId: string | null;
  note: string | null;
  createdBy: string;
}

export interface ReviewDecisionInputError {
  code: "INVALID_INPUT";
  message: string;
}

type ReviewDecisionInputResult =
  | { ok: true; value: ReviewDecisionInput }
  | { ok: false; error: ReviewDecisionInputError };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseRequiredStringField(
  record: Record<string, unknown>,
  key: string
): { ok: true; value: string } | { ok: false; error: ReviewDecisionInputError } {
  const raw = record[key];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: `${key} is required`,
      },
    };
  }

  return { ok: true, value: raw.trim() };
}

function parseOptionalStringField(
  record: Record<string, unknown>,
  key: string
): { ok: true; value: string | null } | { ok: false; error: ReviewDecisionInputError } {
  const raw = record[key];
  if (raw === undefined || raw === null) {
    return { ok: true, value: null };
  }
  if (typeof raw !== "string") {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: `${key} must be a string`,
      },
    };
  }

  const trimmed = raw.trim();
  return { ok: true, value: trimmed.length > 0 ? trimmed : null };
}

export function parseReviewDecisionInput(
  value: unknown
): ReviewDecisionInputResult {
  if (!isRecord(value)) {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "request body must be a JSON object",
      },
    };
  }

  const registryType = parseRequiredStringField(value, "registryType");
  if (!registryType.ok) return registryType;

  const registryKey = parseRequiredStringField(value, "registryKey");
  if (!registryKey.ok) return registryKey;

  const decisionType = parseRequiredStringField(value, "decisionType");
  if (!decisionType.ok) return decisionType;
  if (!ALLOWED_DECISION_TYPES.has(decisionType.value as ReviewDecisionInput["decisionType"])) {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "decisionType is invalid",
      },
    };
  }

  const targetInstructorId = parseOptionalStringField(value, "targetInstructorId");
  if (!targetInstructorId.ok) return targetInstructorId;

  if (
    decisionType.value === "override_instructor" &&
    targetInstructorId.value === null
  ) {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "targetInstructorId is required for override_instructor",
      },
    };
  }

  const note = parseOptionalStringField(value, "note");
  if (!note.ok) return note;

  const createdBy = parseOptionalStringField(value, "createdBy");
  if (!createdBy.ok) return createdBy;

  return {
    ok: true,
    value: {
      registryType: registryType.value,
      registryKey: registryKey.value,
      decisionType: decisionType.value as ReviewDecisionInput["decisionType"],
      targetInstructorId: targetInstructorId.value,
      note: note.value,
      createdBy: createdBy.value ?? "api:/api/review-decisions",
    },
  };
}
