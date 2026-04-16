/**
 * Notion Collector — 04_data_pipeline.md 4-2절, 5-2절
 *
 * Notion API에서 강사 기본 프로필 데이터를 수집한다.
 * 프로퍼티 매핑은 5-2-1절 기준을 따른다.
 */

const NOTION_API_VERSION = "2022-06-28";
const NOTION_BASE_URL = "https://api.notion.com/v1";
const NOTION_REQUEST_TIMEOUT_MS = 20_000;

// --- Notion property value extractors ---

function extractTitle(prop: unknown): string | null {
  const p = prop as { title?: { plain_text: string }[] };
  if (!p?.title?.length) return null;
  return p.title.map((t) => t.plain_text).join("") || null;
}

function extractRichText(prop: unknown): string | null {
  const p = prop as { rich_text?: { plain_text: string }[] };
  if (!p?.rich_text?.length) return null;
  return p.rich_text.map((t) => t.plain_text).join("") || null;
}

function extractMultiSelect(prop: unknown): string[] {
  const p = prop as { multi_select?: { name: string }[] };
  if (!p?.multi_select?.length) return [];
  return p.multi_select.map((s) => s.name);
}

function extractNumber(prop: unknown): number | null {
  const p = prop as { number?: number | null };
  return p?.number ?? null;
}

function extractEmail(prop: unknown): string | null {
  const p = prop as { email?: string | null };
  return p?.email ?? null;
}

function extractPhoneNumber(prop: unknown): string | null {
  const p = prop as { phone_number?: string | null };
  return p?.phone_number ?? null;
}

function extractSelect(prop: unknown): string | null {
  const p = prop as { select?: { name: string } | null };
  return p?.select?.name ?? null;
}

// 프로퍼티 값을 범용적으로 추출 (타입 불명 시 fallback)
function extractAny(prop: unknown): string | null {
  const p = prop as { type?: string };
  if (!p?.type) return null;
  switch (p.type) {
    case "title":
      return extractTitle(prop);
    case "rich_text":
      return extractRichText(prop);
    case "email":
      return extractEmail(prop);
    case "phone_number":
      return extractPhoneNumber(prop);
    case "select":
      return extractSelect(prop);
    case "number": {
      const n = extractNumber(prop);
      return n !== null ? String(n) : null;
    }
    default:
      return null;
  }
}

// --- Raw collected data type (before normalization) ---

export interface RawNotionInstructor {
  notionPageId: string;
  name: string | null;
  affiliation: string[]; // multi_select raw values, order preserved
  categories: string[]; // multi_select raw values, order preserved
  contactEmail: string | null;
  contactEmail2: string | null; // 이메일 주소 (2) — 보조 이메일
  contactPhone: string | null;
  contactPhone2: string | null; // 연락처2 — 보조 연락처
  baseFeeHourly: number | null; // 기본 강사료 (number)
  feeNote: string | null; // 강사료 특이사항 (rich_text)
}

// --- Collector ---

interface NotionQueryResponse {
  results: { id: string; properties: Record<string, unknown> }[];
  has_more: boolean;
  next_cursor: string | null;
}

/**
 * Notion DB에서 모든 강사 페이지를 수집한다.
 * 04_data_pipeline.md 5-2-1절 매핑 기준.
 */
export async function collectFromNotion(): Promise<RawNotionInstructor[]> {
  const apiKey = process.env.NOTION_API_KEY;
  const databaseId = process.env.NOTION_DATABASE_ID;

  if (!apiKey) throw new Error("NOTION_API_KEY 환경변수가 설정되지 않았습니다.");
  if (!databaseId)
    throw new Error("NOTION_DATABASE_ID 환경변수가 설정되지 않았습니다.");

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Notion-Version": NOTION_API_VERSION,
    "Content-Type": "application/json",
  };

  const allPages: { id: string; properties: Record<string, unknown> }[] = [];
  let cursor: string | null = null;

  // pagination
  do {
    const body: Record<string, unknown> = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;

    const res = await fetch(
      `${NOTION_BASE_URL}/databases/${databaseId}/query`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(NOTION_REQUEST_TIMEOUT_MS),
      }
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `Notion API 호출 실패: ${res.status} ${res.statusText} — ${text}`
      );
    }

    const data = (await res.json()) as NotionQueryResponse;
    allPages.push(...data.results);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);

  // 5-2-1절 프로퍼티 매핑
  return allPages.map((page) => {
    const props = page.properties;

    return {
      notionPageId: page.id,
      // 강사명 — title 타입
      name: extractTitle(props["강사명"]) ?? extractAny(props["강사명"]),
      // 소속정보 — multi_select, 순서 유지
      affiliation: extractMultiSelect(props["소속정보"]),
      // 카테고리 — multi_select, 순서 유지 배열
      categories: extractMultiSelect(props["카테고리"]),
      // 이메일 주소 — email 타입
      contactEmail:
        extractEmail(props["이메일 주소"]) ?? extractAny(props["이메일 주소"]),
      // 이메일 주소 (2) — 보조 이메일, memo 보존용
      contactEmail2:
        extractEmail(props["이메일 주소 (2)"]) ??
        extractAny(props["이메일 주소 (2)"]),
      // 연락처 — phone_number 타입
      contactPhone:
        extractPhoneNumber(props["연락처"]) ?? extractAny(props["연락처"]),
      // 연락처2 — 보조 연락처, memo 보존용
      contactPhone2:
        extractPhoneNumber(props["연락처2"]) ?? extractAny(props["연락처2"]),
      // 기본 강사료 — number 타입
      baseFeeHourly: extractNumber(props["기본 강사료"]),
      // 강사료 특이사항 — rich_text 타입
      feeNote:
        extractRichText(props["강사료 특이사항"]) ??
        extractAny(props["강사료 특이사항"]),
    };
  });
}
