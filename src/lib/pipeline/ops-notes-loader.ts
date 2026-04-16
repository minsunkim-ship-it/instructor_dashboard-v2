/**
 * Ops Notes Hardcoded JSON Loader — 04_data_pipeline.md 4-8절, 5-8절, 5-8-2절
 *
 * canonical 소스: data/ops-notes-hardcoded.json
 *
 * 정규화 및 필터 규칙: 04_data_pipeline.md 5-8-1절, 6절.
 * 매칭 기준: 01_core_policy.md 4절 — `name` exact match.
 */

import fs from "node:fs";
import path from "node:path";

export interface OpsNoteJsonEntry {
  name: string;
  memo: string;
  /**
   * 선택 필드. `03_data_model.md` 4-2/4-4/4-6절의 `source_ref` (JSONB) 구조와 동일한 JSON 오브젝트.
   * 내부 필드 구성은 자유이며, 본 파일럿에서는 수집만 하고 저장에는 사용하지 않는다.
   */
  source_ref?: Record<string, unknown>;
}

export interface OpsNotesJson {
  version: number;
  updated_at: string;
  notes: OpsNoteJsonEntry[];
}

export interface OpsNotesLoadResult {
  /** 강사명 → 필터링된 memo 후보 라인 배열 (exact match 키) */
  notesByName: Map<string, string[]>;
  /** 원문 엔트리 개수 (파일 내) */
  totalEntries: number;
  /** 필터 통과 엔트리 개수 */
  acceptedCount: number;
  /** 필터로 제거된 엔트리 개수 */
  filteredOutCount: number;
  /** 원본 파일 경로 */
  sourcePath: string;
  /** 메타 */
  version: number;
  updatedAt: string;
}

const DEFAULT_OPS_NOTES_PATH = path.join(
  process.cwd(),
  "data",
  "ops-notes-hardcoded.json"
);

/**
 * 5-8-1 / 6절의 민감 키워드 및 시작 패턴 필터 규칙.
 * 통과(true)하면 후보에 포함, 실패(false)하면 제거.
 */
export function acceptOpsMemo(memo: string): boolean {
  const text = memo.trim();
  // 6절 / 5-8-1: 10자 미만 노트 제거
  if (text.length < 10) return false;

  // 6절 / 5-8-1: 민감 키워드 포함 노트 제거
  const SENSITIVE_KEYWORDS = [
    "사업자번호",
    "사업자등록",
    "상호명",
    "법인계약",
    "통장사본",
    "모두싸인",
    "URL",
  ];
  for (const kw of SENSITIVE_KEYWORDS) {
    if (text.includes(kw)) return false;
  }

  // 6절 / 5-8-1: 지정 시작 패턴 노트 제거
  const FORBIDDEN_PREFIXES = ["주요 고객사:", "슬랙 하이라이트:", "평균 만족도"];
  for (const prefix of FORBIDDEN_PREFIXES) {
    if (text.startsWith(prefix)) return false;
  }

  return true;
}

/**
 * 운영 메모 hardcoded JSON을 읽어 강사명별 정규화된 memo 후보를 반환한다.
 * - 이름/메모 trim (6절)
 * - 이름 또는 메모 빈값이면 제외
 * - 필터 규칙 적용 (5-8-1 / 6절)
 * - 강사명별 중복 제거 (6절)
 */
export function loadOpsNotesJson(
  filePath: string = DEFAULT_OPS_NOTES_PATH
): OpsNotesLoadResult {
  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw) as OpsNotesJson;

  if (!Array.isArray(parsed.notes)) {
    throw new Error(
      `운영 메모 JSON 스키마 오류: 'notes' 배열이 없습니다. (${filePath})`
    );
  }

  const notesByName = new Map<string, string[]>();
  let acceptedCount = 0;
  let filteredOutCount = 0;

  for (const entry of parsed.notes) {
    if (typeof entry.name !== "string" || typeof entry.memo !== "string") {
      filteredOutCount++;
      continue;
    }
    const name = entry.name.trim();
    const memo = entry.memo.trim();
    if (!name || !memo) {
      filteredOutCount++;
      continue;
    }

    if (!acceptOpsMemo(memo)) {
      filteredOutCount++;
      continue;
    }

    const list = notesByName.get(name) ?? [];
    // 강사명별 중복 제거
    if (!list.includes(memo)) {
      list.push(memo);
    }
    notesByName.set(name, list);
    acceptedCount++;
  }

  return {
    notesByName,
    totalEntries: parsed.notes.length,
    acceptedCount,
    filteredOutCount,
    sourcePath: filePath,
    version: parsed.version,
    updatedAt: parsed.updated_at,
  };
}
