import {
  exchangeGoogleUserAccessToken,
  googleApiGet,
} from "@/lib/google-user-oauth";
import { readFile } from "node:fs/promises";
import path from "node:path";

const SHEETS_API_BASE = "https://sheets.googleapis.com/v4";
const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";

export interface SatisfactionSheetSourceDefinition {
  key: string;
  sourceType: "sheet_summary" | "google_forms";
  spreadsheetId: string;
  worksheetGid: number;
  title: string;
  range: string;
  /** 시트 title에서 추출한 강사명 hint (예: "장철원"). 매칭 폴백에 사용. */
  instructorHint?: string | null;
  /** Phase B 일반 파서용 — catalog에서 회사명을 명시할 때 사용. 없으면 title에서 자동 추출. */
  companyName?: string | null;
  /** Phase B 일반 파서용 — catalog에서 과정명을 명시할 때 사용. 없으면 title에서 자동 추출. */
  courseName?: string | null;
  /** Phase B 일반 파서용 — catalog에서 차수 라벨을 명시할 때 사용. 없으면 title에서 정규식으로 추출. */
  sessionLabel?: string | null;
  /**
   * Phase C L4 폴백용 — 다중 강사 시트 명시. 매칭 알고리즘이 모두 실패하면 이 강사들에게 분배.
   * 단, 실제 contract sheet 일정과 교차 확인하여 정규 강사만 사용.
   */
  expectedInstructors?: string[];
  /** Phase C L1/L3 매칭 보강 — 회사명 alias (예: 동국홀딩스 ↔ 동국제강그룹). */
  companyAliases?: string[];
  /**
   * Phase B 보강 — true면 collect/normalize에서 skip.
   * "강의관리 시트" 같은 catalog 오등록 또는 연동 미완료 시트 비활성화.
   */
  disabled?: boolean;
  /**
   * Expert P0-7 — 시트 종류 명시. 만족도 파이프라인 처리 가능 여부 판별.
   *  - google_forms_response: 응답 시트 (1행=1응답)
   *  - survey_summary: 차수별 요약 시트
   *  - lecture_management_sheet: 강의관리 시트 — 만족도 X. 자동 차단.
   *  - syncup_sheet: 운영 싱크업 시트 — 만족도 X. 자동 차단.
   *  - unknown: 미분류 (수동 검토 필요)
   */
  sourceKind?:
    | "google_forms_response"
    | "survey_summary"
    | "lecture_management_sheet"
    | "syncup_sheet"
    | "unknown";
  /**
   * Expert P0-7 추가 필수 필드 — 만족도 시트의 평가 단위 명시.
   *  - course: 과정 전체 만족도 (강사별 평균 반영 금지)
   *  - session: 차수/세션별 만족도 (session-instructor mapping 있을 때만 강사 반영)
   *  - instructor: 강사 만족도 (강사별 평균 반영 가능)
   *  - unknown: 미분류 (pending_review)
   */
  satisfactionLevel?: "course" | "session" | "instructor" | "unknown";
  /**
   * Expert P0-7 추가 필수 필드 — instructor 매칭 모드 명시.
   *  - auto_single: 단일 강사 + catalog hint 일치 시 auto-accept
   *  - session_mapping: 차수별 강사 mapping 후 매칭 (별도 mapping table 필요)
   *  - course_level: 강사별 매칭 없이 course-level 만족도로만 저장
   *  - manual_per_response: 응답마다 운영자 매핑 (pending_review 기본)
   */
  instructorMappingMode?:
    | "auto_single"
    | "session_mapping"
    | "course_level"
    | "manual_per_response";
  /**
   * Expert P0-7 추가 필수 필드 — catalog entry 검증 상태.
   *  - verified: 운영자가 검증한 정식 source
   *  - candidate: 자동 발견 후보 (B 트랙 결과), 운영자 검토 필요
   *  - deprecated: 사용 중단 (disabled=true와 별도, 폐기 사유 명시)
   */
  validationStatus?: "verified" | "candidate" | "deprecated";
  /** 시트별 운영 메모 (빈 템플릿 가능성 등). */
  note?: string;
}

/**
 * sourceKind가 만족도 파이프라인 처리 대상인지 판별.
 * Expert P0-7 차단 규칙:
 *   - google_forms_response: 수집 가능
 *   - survey_summary: 수집 가능
 *   - lecture_management_sheet / syncup_sheet: 수집 금지 (만족도 시트 아님)
 *   - unknown: 수집 허용 (운영자 검토 위해), 매칭은 pending_review 강제
 *   - undefined: backward compat — 기존 동작 유지
 */
export function isSatisfactionCompatibleSourceKind(
  kind: SatisfactionSheetSourceDefinition["sourceKind"]
): boolean {
  if (kind === undefined) return true;
  return (
    kind === "google_forms_response" ||
    kind === "survey_summary" ||
    kind === "unknown" // 수집은 하되 매칭 단계에서 pending 처리
  );
}

/**
 * Expert P0-7: unknown sourceKind는 수집은 하되 매칭은 항상 pending.
 * Normalizer가 shouldAutoAccept=false 강제할 때 사용.
 */
export function shouldForcePendingReviewForSourceKind(
  kind: SatisfactionSheetSourceDefinition["sourceKind"]
): boolean {
  return kind === "unknown";
}

export interface SatisfactionSheetCollectResult {
  definition: SatisfactionSheetSourceDefinition;
  rows: string[][];
  error?: string;
  /** Office file (xlsx)에서 Drive 변환 폴백을 통해 읽은 경우 true. */
  usedOfficeFallback?: boolean;
}

export const ACCESSIBLE_SATISFACTION_SHEET_SOURCES: SatisfactionSheetSourceDefinition[] = [
  {
    key: "kt_ai_campus",
    sourceType: "sheet_summary",
    spreadsheetId: "1nXK-uXlBIYbPtRpTPSk2t9l5MJFJmCUAwYFzoDbaf3s",
    worksheetGid: 1459556567,
    title: "만족도조사 결과",
    range: "만족도조사 결과!A1:AB1000",
  },
  {
    key: "hyundai_mobis_llm",
    sourceType: "sheet_summary",
    spreadsheetId: "1hyTlx8sHf-YgqCduFG6WyUZbTW7LRKLgr-74Ug16tDo",
    worksheetGid: 0,
    title: "LLM 만족도 종합",
    range: "시트1!A1:Z1000",
  },
  {
    key: "hyundai_mobis_llm_2",
    sourceType: "google_forms",
    spreadsheetId: "1lBcnn_IiEdAYLF_-36l5McFUtRgDU-aYsFfSUpDd1gs",
    worksheetGid: 0,
    title: "LLM 2차수",
    range: "시트1!A1:Z1000",
  },
  {
    key: "hyundai_mobis_llm_3",
    sourceType: "google_forms",
    spreadsheetId: "1KNgGwYWdieFnfrz64gvz6l_oqIRSkePhy2cpdIzh1L0",
    worksheetGid: 952068825,
    title: "LLM 3차수 응답",
    range: "설문지 응답 시트1!A1:H1000",
  },
  {
    key: "hyundai_mobis_llm_4",
    sourceType: "google_forms",
    spreadsheetId: "170_wjDPSZGo6NeKDiC9CpmUwoApBBJeoeCJ5U1PHQbI",
    worksheetGid: 0,
    title: "LLM 4차수",
    range: "A1:H1000",
  },
  {
    key: "woori_ax_forms",
    sourceType: "google_forms",
    spreadsheetId: "19v7sdw0w6D1f-t91ptvUM5hzPbyngPgkgSHhVI1l9aM",
    worksheetGid: 777556001,
    title: "(공유) 설문지 응답 시트",
    range: "(공유) 설문지 응답 시트!A1:AB1000",
    companyName: "우리은행",
    courseName: "AX 전문가 양성 과정",
    expectedInstructors: ["유종훈", "김정수A", "정민수A"],
    note: "다중 강사 강의 — Phase C L0 super-priority로 3강사 fan-out",
  },
];

async function sheetsValuesGet(
  accessToken: string,
  spreadsheetId: string,
  range: string
): Promise<string[][]> {
  const data = await googleApiGet<{ values?: string[][] }>(
    accessToken,
    SHEETS_API_BASE,
    `/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`
  );
  return data.values ?? [];
}

/**
 * Office file 에러 감지 (Sheets API가 .xlsx file을 직접 read 못함).
 */
function isOfficeFileError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /must not be an Office file|FAILED_PRECONDITION/i.test(msg);
}

/**
 * Drive readonly로 xlsx 바이트를 다운로드.
 */
async function driveDownloadFileBytes(
  accessToken: string,
  fileId: string
): Promise<Buffer> {
  const url = `${DRIVE_API_BASE}/files/${fileId}?alt=media&supportsAllDrives=true`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Drive download failed (${res.status}): ${text}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Sheets API 실패 시 Drive readonly download → 자체 xlsx parser 폴백.
 * 외부 패키지 의존 없음 (xlsx-minimal-reader 사용).
 */
async function readSheetWithOfficeFallback(
  accessToken: string,
  spreadsheetId: string,
  range: string
): Promise<{ rows: string[][]; usedOfficeFallback: boolean }> {
  try {
    const rows = await sheetsValuesGet(accessToken, spreadsheetId, range);
    return { rows, usedOfficeFallback: false };
  } catch (error) {
    if (!isOfficeFileError(error)) throw error;

    // Office file → Drive readonly download → 자체 xlsx parser
    const { parseXlsxBuffer } = await import("@/lib/xlsx-minimal-reader");
    const bytes = await driveDownloadFileBytes(accessToken, spreadsheetId);
    const { rows } = parseXlsxBuffer(bytes);
    return { rows, usedOfficeFallback: true };
  }
}

/**
 * data/satisfaction-sheet-catalog.json을 동적으로 로드해 추가 시트 정의를 반환한다.
 * 파일이 없거나 파싱 실패 시 빈 배열 반환 (기본 ACCESSIBLE_SATISFACTION_SHEET_SOURCES만 사용).
 */
async function loadCatalogFromFile(): Promise<SatisfactionSheetSourceDefinition[]> {
  try {
    const catalogPath = path.resolve(
      process.cwd(),
      "data/satisfaction-sheet-catalog.json"
    );
    const raw = await readFile(catalogPath, "utf-8");
    const parsed = JSON.parse(raw) as {
      sources?: SatisfactionSheetSourceDefinition[];
    };
    if (!Array.isArray(parsed.sources)) return [];
    return parsed.sources.filter(
      (s): s is SatisfactionSheetSourceDefinition =>
        typeof s?.key === "string" &&
        typeof s?.spreadsheetId === "string" &&
        typeof s?.range === "string"
    );
  } catch {
    return [];
  }
}

/**
 * 코드 SOURCES + 카탈로그 파일을 합쳐 dedup된 시트 정의 배열 반환.
 * 충돌 시 코드 SOURCES가 우선 (key 기준).
 */
export async function getAllSatisfactionSheetSources(): Promise<
  SatisfactionSheetSourceDefinition[]
> {
  const fromFile = await loadCatalogFromFile();
  const seen = new Set<string>(
    ACCESSIBLE_SATISFACTION_SHEET_SOURCES.map((s) => s.key)
  );
  const merged: SatisfactionSheetSourceDefinition[] = [
    ...ACCESSIBLE_SATISFACTION_SHEET_SOURCES,
  ];
  for (const source of fromFile) {
    if (seen.has(source.key)) continue;
    seen.add(source.key);
    merged.push(source);
  }
  return merged;
}

export async function collectSatisfactionSheets(options?: {
  includeKeys?: SatisfactionSheetSourceDefinition["key"][];
}): Promise<SatisfactionSheetCollectResult[]> {
  const accessToken = await exchangeGoogleUserAccessToken();
  const allSources = await getAllSatisfactionSheetSources();
  // Expert P0-7: disabled + sourceKind 비호환은 collect 단계에서 자동 차단.
  const enabledSources = allSources.filter((s) => {
    if (s.disabled) return false;
    if (s.sourceKind && !isSatisfactionCompatibleSourceKind(s.sourceKind)) return false;
    return true;
  });
  const sources = options?.includeKeys?.length
    ? enabledSources.filter((source) => options.includeKeys?.includes(source.key))
    : enabledSources;

  return Promise.all(
    sources.map(async (definition) => {
      try {
        const { rows, usedOfficeFallback } = await readSheetWithOfficeFallback(
          accessToken,
          definition.spreadsheetId,
          definition.range
        );
        return {
          definition,
          rows,
          ...(usedOfficeFallback ? { usedOfficeFallback: true as const } : {}),
        };
      } catch (error) {
        return {
          definition,
          rows: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })
  );
}
