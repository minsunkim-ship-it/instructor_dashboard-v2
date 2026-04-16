/**
 * Fulltime Instructor JSON Loader — 04_data_pipeline.md 4-7절, 5-7절, 5-7-1절
 *
 * canonical 소스: prisma/fulltime_instructors.json
 * 본 파일럿은 `fulltime_instructor_configs` 테이블을 사용하지 않고 JSON 직접 로딩 방식만 사용한다.
 * (5-7-1절 "또는 동등한 내부 설정 구조에 반영한다" 허용 범위)
 *
 * 판정 기준: 01_core_policy.md 4절 — `name` exact match.
 */

import fs from "node:fs";
import path from "node:path";

export interface FulltimeJsonEntry {
  name: string;
  active: boolean;
}

export interface FulltimeJson {
  version: number;
  updated_at: string;
  instructors: FulltimeJsonEntry[];
}

export interface FulltimeLoadResult {
  /** active=true 인 전임강사 이름 집합 (exact match 기준) */
  activeNames: Set<string>;
  /** 원문 엔트리 개수 */
  totalEntries: number;
  /** active=true 엔트리 개수 */
  activeCount: number;
  /** 원본 파일 경로 */
  sourcePath: string;
  /** 메타 */
  version: number;
  updatedAt: string;
}

const DEFAULT_FULLTIME_PATH = path.join(
  process.cwd(),
  "prisma",
  "fulltime_instructors.json"
);

/**
 * 전임강사 JSON을 읽어 active=true 항목의 이름 집합을 반환한다.
 * 5-7-1: active=true 인 항목만 현재 전임강사로 반영한다.
 * 6절: 이름 앞뒤 공백 제거.
 */
export function loadFulltimeJson(
  filePath: string = DEFAULT_FULLTIME_PATH
): FulltimeLoadResult {
  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw) as FulltimeJson;

  if (!Array.isArray(parsed.instructors)) {
    throw new Error(
      `전임강사 JSON 스키마 오류: 'instructors' 배열이 없습니다. (${filePath})`
    );
  }

  const activeNames = new Set<string>();
  let activeCount = 0;

  for (const entry of parsed.instructors) {
    if (typeof entry.name !== "string") continue;
    const trimmed = entry.name.trim();
    if (!trimmed) continue;
    if (entry.active === true) {
      activeNames.add(trimmed);
      activeCount++;
    }
  }

  return {
    activeNames,
    totalEntries: parsed.instructors.length,
    activeCount,
    sourcePath: filePath,
    version: parsed.version,
    updatedAt: parsed.updated_at,
  };
}
