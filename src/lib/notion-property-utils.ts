type NotionPlainTextNode = {
  plain_text?: string;
};

type NotionPropertyLike = {
  type?: string;
  title?: NotionPlainTextNode[];
  rich_text?: NotionPlainTextNode[];
  multi_select?: Array<{ name?: string }>;
  select?: { name?: string } | null;
  status?: { name?: string } | null;
  number?: number | null;
  email?: string | null;
  phone_number?: string | null;
  url?: string | null;
  checkbox?: boolean;
  date?: { start?: string | null; end?: string | null } | null;
  people?: Array<{ name?: string | null }>;
  files?: Array<{ name?: string | null }>;
  formula?: { type?: string; string?: string | null; number?: number | null; boolean?: boolean | null; date?: { start?: string | null; end?: string | null } | null } | null;
  rollup?: { type?: string; number?: number | null; date?: { start?: string | null; end?: string | null } | null; array?: unknown[] } | null;
};

function toDelimitedList(value: string): string[] {
  return value
    .split(/\r?\n|[,;•▪·]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function extractPlainText(nodes: NotionPlainTextNode[] | undefined): string | null {
  if (!nodes?.length) return null;
  const text = nodes.map((node) => node.plain_text ?? "").join("").trim();
  return text || null;
}

function formatDateRange(
  date: { start?: string | null; end?: string | null } | null | undefined
): string | null {
  if (!date?.start && !date?.end) return null;
  if (date.start && date.end) {
    return date.start === date.end ? date.start : `${date.start} ~ ${date.end}`;
  }
  return date.start ?? date.end ?? null;
}

function extractTextListFromProperty(prop: unknown): string[] {
  const property = prop as NotionPropertyLike | null | undefined;
  if (!property?.type) return [];

  switch (property.type) {
    case "title":
      return toDelimitedList(extractPlainText(property.title) ?? "");
    case "rich_text":
      return toDelimitedList(extractPlainText(property.rich_text) ?? "");
    case "multi_select":
      return (property.multi_select ?? [])
        .map((item) => item.name?.trim() ?? "")
        .filter(Boolean);
    case "select":
      return property.select?.name ? [property.select.name.trim()] : [];
    case "status":
      return property.status?.name ? [property.status.name.trim()] : [];
    case "number":
      return property.number !== null && property.number !== undefined
        ? [String(property.number)]
        : [];
    case "email":
      return property.email ? [property.email.trim()] : [];
    case "phone_number":
      return property.phone_number ? [property.phone_number.trim()] : [];
    case "url":
      return property.url ? [property.url.trim()] : [];
    case "checkbox":
      return typeof property.checkbox === "boolean"
        ? [property.checkbox ? "true" : "false"]
        : [];
    case "date": {
      const value = formatDateRange(property.date);
      return value ? [value] : [];
    }
    case "people":
      return (property.people ?? [])
        .map((person) => person.name?.trim() ?? "")
        .filter(Boolean);
    case "files":
      return (property.files ?? [])
        .map((file) => file.name?.trim() ?? "")
        .filter(Boolean);
    case "formula": {
      if (!property.formula?.type) return [];
      if (property.formula.type === "string") {
        return toDelimitedList(property.formula.string ?? "");
      }
      if (property.formula.type === "number") {
        return property.formula.number !== null && property.formula.number !== undefined
          ? [String(property.formula.number)]
          : [];
      }
      if (property.formula.type === "boolean") {
        return property.formula.boolean !== null && property.formula.boolean !== undefined
          ? [property.formula.boolean ? "true" : "false"]
          : [];
      }
      if (property.formula.type === "date") {
        const value = formatDateRange(property.formula.date);
        return value ? [value] : [];
      }
      return [];
    }
    case "rollup": {
      if (!property.rollup?.type) return [];
      if (property.rollup.type === "number") {
        return property.rollup.number !== null && property.rollup.number !== undefined
          ? [String(property.rollup.number)]
          : [];
      }
      if (property.rollup.type === "date") {
        const value = formatDateRange(property.rollup.date);
        return value ? [value] : [];
      }
      if (property.rollup.type === "array") {
        return (property.rollup.array ?? []).flatMap((item) =>
          extractTextListFromProperty(item)
        );
      }
      return [];
    }
    default:
      return [];
  }
}

export function extractNotionPropertyTextList(
  properties: unknown,
  propertyName: string
): string[] {
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    return [];
  }

  const property = (properties as Record<string, unknown>)[propertyName];
  if (!property) return [];

  return [...new Set(extractTextListFromProperty(property))];
}
