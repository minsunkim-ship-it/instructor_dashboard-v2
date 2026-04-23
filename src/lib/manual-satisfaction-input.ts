export interface ManualSatisfactionInput {
  score: number;
  comment: string | null;
  company_name: string | null;
  course_name: string | null;
  response_date: string | null;
}

export interface ManualSatisfactionInputError {
  code: "INVALID_SATISFACTION_SCORE" | "INVALID_INPUT";
  message: string;
}

type ManualSatisfactionInputResult =
  | { ok: true; value: ManualSatisfactionInput }
  | { ok: false; error: ManualSatisfactionInputError };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseOptionalStringField(
  record: Record<string, unknown>,
  key: keyof Omit<ManualSatisfactionInput, "score">
): { ok: true; value: string | null } | { ok: false; error: ManualSatisfactionInputError } {
  const raw = record[key];
  if (raw === undefined || raw === null) {
    return { ok: true, value: null };
  }
  if (typeof raw !== "string") {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: `${key}는 문자열이어야 합니다.`,
      },
    };
  }

  const trimmed = raw.trim();
  return { ok: true, value: trimmed.length > 0 ? trimmed : null };
}

function isDateOnly(value: string): boolean {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;

  const [, year, month, day] = match;
  const candidate = new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day))
  );

  return candidate.toISOString().slice(0, 10) === value;
}

export function parseManualSatisfactionInput(
  value: unknown
): ManualSatisfactionInputResult {
  if (!isRecord(value)) {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "요청 본문은 JSON 객체여야 합니다.",
      },
    };
  }

  const score = value.score;
  if (typeof score !== "number" || !Number.isFinite(score) || score < 1 || score > 5) {
    return {
      ok: false,
      error: {
        code: "INVALID_SATISFACTION_SCORE",
        message: "만족도 점수는 1~5 범위의 숫자여야 합니다.",
      },
    };
  }

  const comment = parseOptionalStringField(value, "comment");
  if (!comment.ok) return comment;

  const companyName = parseOptionalStringField(value, "company_name");
  if (!companyName.ok) return companyName;

  const courseName = parseOptionalStringField(value, "course_name");
  if (!courseName.ok) return courseName;

  const responseDate = parseOptionalStringField(value, "response_date");
  if (!responseDate.ok) return responseDate;
  if (responseDate.value !== null && !isDateOnly(responseDate.value)) {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "response_date는 YYYY-MM-DD 형식이어야 합니다.",
      },
    };
  }

  return {
    ok: true,
    value: {
      score,
      comment: comment.value,
      company_name: companyName.value,
      course_name: courseName.value,
      response_date: responseDate.value,
    },
  };
}
