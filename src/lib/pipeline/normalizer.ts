/**
 * Normalizer — 04_data_pipeline.md 6절
 *
 * 소스별 원문 데이터를 마스터 병합 전에 정규화한다.
 * 이 파일럿에서는 Notion 소스만 대상으로 한다.
 */

import type { RawNotionInstructor } from "@/lib/pipeline/notion-collector";
import { acceptOpsMemo } from "@/lib/pipeline/ops-notes-loader";

// instructors 테이블에 저장할 정규화 결과 — 03_data_model.md 4-1절
export interface NormalizedInstructor {
  name: string;
  displayName: string;
  affiliation: string | null;
  categories: string[];
  specialties: string[]; // 5-2-1: Notion에 직접 대응 필드 없음 → 빈 배열
  profileSummary: string | null; // 5-2-1: 직접 프로퍼티 없음 → null
  contactEmail: string | null;
  contactPhone: string | null;
  baseFeeHourly: number | null;
  feeNote: string | null;
  notionPageId: string; // source tracking용
  memoRawCandidate: string | null; // Notion 메모 + 보조 연락처 appendix
  notionRawProperties: Record<string, unknown>;
}

/**
 * 6절: 이름 앞뒤 공백 제거
 */
function trimName(name: string | null): string | null {
  if (!name) return null;
  const trimmed = name.trim();
  return trimmed || null;
}

/**
 * 6절: multi_select 형태의 소속정보는 순서를 유지한 채 `, `로 join
 */
function joinAffiliation(values: string[]): string | null {
  if (!values.length) return null;
  const joined = values
    .map((v) => v.trim())
    .filter(Boolean)
    .join(", ");
  return joined || null;
}

/**
 * 6절: multi_select 카테고리는 순서를 유지한 배열 그대로 저장
 * 6절: 배열형 필드는 중복 제거 후 저장
 */
function deduplicateArray(values: string[]): string[] {
  const trimmed = values.map((v) => v.trim()).filter(Boolean);
  return [...new Set(trimmed)];
}

/**
 * 6절: 금액 문자열은 숫자 금액으로 정규화
 * 5-2-1: 시간당 강사료가 명확한 경우에만 숫자 금액으로 정규화
 * 01_core_policy 8절: 특수 금액 키워드 필터
 */
/**
 * 5-2-1: 현재 live Notion 타입이 number이면 0 초과 값을 시간당 단가로 간주해 그대로 반영한다.
 * fee_note는 보조 설명으로 저장하며, number 필드의 반영 여부를 막는 조건으로 사용하지 않는다.
 */
function normalizeFee(rawAmount: number | null): number | null {
  if (rawAmount === null || rawAmount === undefined) return null;

  const amount = Math.round(rawAmount);
  if (amount <= 0) return null;

  return amount;
}

/**
 * 6절: 빈 문자열은 NULL로 치환
 */
function emptyToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/**
 * 5-2-1: 보조 연락처(이메일 주소 (2), 연락처2)는
 * Notion 원문 메모 블록에 라벨을 붙여 보존
 */
function buildMemoAppendix(
  email2: string | null,
  phone2: string | null
): string | null {
  const parts: string[] = [];
  if (email2?.trim()) parts.push(`보조 이메일: ${email2.trim()}`);
  if (phone2?.trim()) parts.push(`보조 연락처: ${phone2.trim()}`);
  return parts.length > 0 ? parts.join("\n") : null;
}

function splitMemoLines(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Notion 메모도 memo_raw 후보로 사용하되, 운영 메모 canonical 필터 규칙을 그대로 적용한다.
 */
function buildMemoRawCandidate(
  memo: string | null,
  email2: string | null,
  phone2: string | null
): string | null {
  const appendix = buildMemoAppendix(email2, phone2);
  const lines = [...splitMemoLines(memo), ...splitMemoLines(appendix)];
  if (lines.length === 0) return null;

  const deduped: string[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    if (!acceptOpsMemo(line)) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    deduped.push(line);
  }

  return deduped.length > 0 ? deduped.join("\n") : null;
}

/**
 * RawNotionInstructor 배열을 정규화한다.
 * 이름이 없는 레코드는 제외한다.
 */
export function normalizeNotionData(
  rawList: RawNotionInstructor[]
): NormalizedInstructor[] {
  const results: NormalizedInstructor[] = [];

  for (const raw of rawList) {
    const name = trimName(raw.name);
    // 강사명이 없으면 마스터 레코드를 만들 수 없다
    if (!name) continue;

    results.push({
      name,
      displayName: name, // 03_data_model 4-1: display_name 기본값 = name
      affiliation: joinAffiliation(raw.affiliation),
      categories: deduplicateArray(raw.categories),
      specialties: [], // 5-2-1: Notion에 직접 대응 필드 없음
      profileSummary: null, // 5-2-1: 직접 프로퍼티 없음
      contactEmail: emptyToNull(raw.contactEmail),
      contactPhone: emptyToNull(raw.contactPhone),
      baseFeeHourly: normalizeFee(raw.baseFeeHourly),
      feeNote: emptyToNull(raw.feeNote),
      notionPageId: raw.notionPageId,
      memoRawCandidate: buildMemoRawCandidate(
        emptyToNull(raw.memo),
        emptyToNull(raw.contactEmail2),
        emptyToNull(raw.contactPhone2)
      ),
      notionRawProperties: raw.rawProperties,
    });
  }

  return results;
}
