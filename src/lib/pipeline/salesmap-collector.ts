/**
 * Salesmap Collector — Pilot 4-3
 *
 * 04_data_pipeline.md 4-3절: 세일즈맵 스냅샷 수집
 * 04_data_pipeline.md 5-3절, 5-3-1절: deal + organization 필드 매핑
 *
 * Pilot 4-3 확정 계약:
 * - Canonical source: local snapshot SQLite DB (env SALESMAP_SNAPSHOT_PATH)
 * - 대상 row: `deal.강사 이름1` 이 채워진 row
 * - 기업명: `deal.organizationId = organization.id` join 결과 `organization.이름`
 * - 강사명 슬롯: `deal.강사 이름1~5` (unpivot은 normalizer에서 수행)
 * - 강사료 슬롯: `deal.강사료1~5`
 * - 최근 활동일 후보: `deal.최근 파이프라인 수정 날짜` > `deal.최근 노트 작성일` > `deal.수정 날짜`
 *
 * sqlite3 CLI를 child_process로 호출해 JSON을 받는다. 별도 패키지 의존성을 추가하지 않는다.
 */

import { execFileSync } from "node:child_process";

export interface RawSalesmapDeal {
  deal_id: string;
  organization_id: string | null;
  company_name: string | null;
  course_name: string | null; // deal.이름
  course_id: string | null; // deal.코스 ID
  start_date: string | null; // deal.수강시작일 원문
  end_date: string | null; // deal.수강종료일 원문
  recent_pipeline_edit: string | null; // deal.최근 파이프라인 수정 날짜
  recent_note: string | null; // deal.최근 노트 작성일
  recent_modified: string | null; // deal.수정 날짜
  instructor_slots: Array<{
    slot: number; // 1..5
    name: string | null;
    fee: string | null;
  }>;
}

function getSnapshotPath(): string {
  const p = process.env.SALESMAP_SNAPSHOT_PATH;
  if (!p) {
    throw new Error(
      "SALESMAP_SNAPSHOT_PATH 환경변수가 설정되지 않았습니다."
    );
  }
  return p;
}

/**
 * sqlite3 CLI 호출 helper.
 * `-json` 모드로 배열 JSON을 받고 파싱한다. 결과가 비어 있으면 `[]`.
 * 대용량 쿼리도 무방하도록 maxBuffer 를 넉넉히 준다.
 */
function runQuery<T>(dbPath: string, query: string): T[] {
  const out = execFileSync("sqlite3", ["-json", dbPath, query], {
    maxBuffer: 256 * 1024 * 1024,
  }).toString("utf8");
  if (!out.trim()) return [];
  return JSON.parse(out) as T[];
}

/**
 * deal + organization 조인으로 강사명 있는 모든 행을 수집한다.
 *
 * - 강사 이름1~5와 강사료1~5는 그대로 로드하고, unpivot은 normalizer에서 처리한다.
 * - organization.이름 이 NULL인 경우 `company_name`도 NULL 로 둔다.
 * - 날짜 컬럼은 원문 문자열 그대로 가져와 normalizer 에서 파싱한다.
 */
export function collectFromSalesmapSnapshot(): {
  snapshotPath: string;
  deals: RawSalesmapDeal[];
} {
  const snapshotPath = getSnapshotPath();

  interface Row {
    deal_id: string;
    organization_id: string | null;
    company_name: string | null;
    course_name: string | null;
    course_id: string | null;
    start_date: string | null;
    end_date: string | null;
    recent_pipeline_edit: string | null;
    recent_note: string | null;
    recent_modified: string | null;
    name1: string | null;
    name2: string | null;
    name3: string | null;
    name4: string | null;
    name5: string | null;
    fee1: string | null;
    fee2: string | null;
    fee3: string | null;
    fee4: string | null;
    fee5: string | null;
  }

  const query = `
    SELECT
      d."id"                          AS deal_id,
      d."organizationId"              AS organization_id,
      o."이름"                        AS company_name,
      d."이름"                        AS course_name,
      d."코스 ID"                     AS course_id,
      d."수강시작일"                  AS start_date,
      d."수강종료일"                  AS end_date,
      d."최근 파이프라인 수정 날짜"   AS recent_pipeline_edit,
      d."최근 노트 작성일"            AS recent_note,
      d."수정 날짜"                   AS recent_modified,
      d."강사 이름1"                  AS name1,
      d."강사 이름2"                  AS name2,
      d."강사 이름3"                  AS name3,
      d."강사 이름4"                  AS name4,
      d."강사 이름5"                  AS name5,
      d."강사료1"                     AS fee1,
      d."강사료2"                     AS fee2,
      d."강사료3"                     AS fee3,
      d."강사료4"                     AS fee4,
      d."강사료5"                     AS fee5
    FROM "deal" d
    LEFT JOIN "organization" o ON o."id" = d."organizationId"
    WHERE d."강사 이름1" IS NOT NULL AND TRIM(d."강사 이름1") != '';
  `;

  const rows = runQuery<Row>(snapshotPath, query);

  const deals: RawSalesmapDeal[] = rows.map((r) => ({
    deal_id: r.deal_id,
    organization_id: r.organization_id,
    company_name: r.company_name,
    course_name: r.course_name,
    course_id: r.course_id,
    start_date: r.start_date,
    end_date: r.end_date,
    recent_pipeline_edit: r.recent_pipeline_edit,
    recent_note: r.recent_note,
    recent_modified: r.recent_modified,
    instructor_slots: [
      { slot: 1, name: r.name1, fee: r.fee1 },
      { slot: 2, name: r.name2, fee: r.fee2 },
      { slot: 3, name: r.name3, fee: r.fee3 },
      { slot: 4, name: r.name4, fee: r.fee4 },
      { slot: 5, name: r.name5, fee: r.fee5 },
    ],
  }));

  return { snapshotPath, deals };
}
