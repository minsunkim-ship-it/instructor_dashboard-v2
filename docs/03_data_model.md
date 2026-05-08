# Data Model

## Role
이 문서는 서비스에서 사용하는 데이터 구조를 정의한다.
저장소 선택, 엔티티 목록, 필드 정의, 엔티티 간 관계, 설정 데이터 구조, 검증 로그 구조를 포함한다.

## Source of Truth
- 엔티티 목록
- 필드명, 타입, 필수 여부, 기본값
- 엔티티 간 관계
- 저장소 구조
- 설정 데이터 구조
- 검증 및 수정 로그 저장 구조

## Depends On
- `00_docs_index.md`
- `01_core_policy.md`

## Used By
- `04_data_pipeline.md`
- `05_api_spec.md`
- `06_implementation_spec.md`
- `07_build_guide.md`

## Out of Scope
- SQL DDL 상세
- 인덱스 최적화 상세
- API 응답 예시 상세
- 화면 표현 상세

## 1. 저장소 선택

### 1-1. 기본 저장소
- 기본 저장소는 Coolify PostgreSQL을 사용한다.
- DB 엔진은 PostgreSQL을 전제로 한다.
- ORM은 Prisma를 사용한다.

### 1-2. 선택 이유
- 강사, 강의 이력, 단가 이력, 만족도, 검증 로그처럼 관계가 명확한 데이터가 많다.
- 수집 이력과 검증 이력을 함께 남겨야 하므로 트랜잭션이 필요하다.
- 병렬 구현 시 API, 파이프라인, 화면이 동일한 구조를 참조하기 쉽다.
- 일부 유연한 필드는 JSONB로 보조 저장할 수 있다.

### 1-3. 저장 전략
- 핵심 마스터 데이터는 정규화된 테이블로 저장한다.
- 소스 원문, 보조 메타데이터, 검증 전후 비교값은 JSONB로 저장할 수 있다.
- fallback용 정적 baseline은 애플리케이션 리소스로 별도 보관하되, 서비스의 주 저장소는 DB다.
- Prisma schema는 이 문서의 엔티티와 필드 정의를 기준으로 작성한다.
- 마이그레이션은 Prisma Migrate를 기준으로 관리한다.

## 2. 엔티티 목록

서비스에서 사용하는 주요 엔티티는 아래와 같다.

- `instructors`
- `teaching_histories`
- `fee_histories`
- `satisfaction_import_items`
- `satisfaction_records`
- `satisfaction_review_registries`
- `instructor_intelligence`
- `source_links`
- `validation_issues`
- `pipeline_runs`
- `source_sync_logs`
- `activity_import_items`
- `activity_review_registries`
- `review_decisions`
- `fulltime_instructor_configs`
- `fee_fix_configs`
- `practice_coach_rules`
- `score_policy_versions`

## 3. 엔티티 관계

- 강사 1 : N 강의 이력
- 강사 1 : N 단가 이력
- 강사 1 : N 만족도 원본 수집 아이템
- 강사 1 : N 만족도 기록
- 강사 1 : N 만족도 검토 레지스트리
- 강사 1 : 1 운영 인텔리전스
- 강사 1 : N 소스 연결 정보
- 강사 1 : N 검증 이슈
- 강사 1 : N fee fix 설정
- 강사 1 : N 활동 수집 아이템(매칭된 경우)
- 강사 1 : N 활동 검토 레지스트리
- 강사 1 : N 검토 결정
- 파이프라인 실행 1 : N 소스 수집 로그
- 파이프라인 실행 1 : N 만족도 원본 수집 아이템
- 파이프라인 실행 1 : N 활동 수집 아이템
- 파이프라인 실행 1 : N 만족도 검토 레지스트리
- 파이프라인 실행 1 : N 활동 검토 레지스트리
- 점수 정책 1 : N 강사 점수 메타데이터

## 4. 엔티티별 필드 정의

### 4-1. `instructors`

강사의 마스터 레코드다. 목록 화면과 상세 화면의 중심 엔티티다.

| 필드명 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---:|---|---|
| `id` | UUID | Y | - | 내부 PK |
| `instructor_id` | TEXT | N | `NULL` | 외부 또는 운영 기준 식별자 |
| `name` | TEXT | Y | - | 강사명, exact match 기준 필드 |
| `display_name` | TEXT | Y | `name` | 화면 표시용 이름 |
| `affiliation` | TEXT | N | `NULL` | 소속 |
| `categories` | TEXT[] | N | `{}` | 카테고리 배열 |
| `specialties` | TEXT[] | N | `{}` | 전문분야 배열 |
| `profile_summary` | TEXT | N | `NULL` | 강사 프로필 요약 |
| `contact_email` | TEXT | N | `NULL` | 대표 이메일 |
| `contact_phone` | TEXT | N | `NULL` | 대표 전화번호 |
| `is_fulltime` | BOOLEAN | Y | `FALSE` | 전임강사 여부 |
| `is_practice_coach` | BOOLEAN | Y | `FALSE` | 실습코치 여부 |
| `flag` | TEXT | N | `NULL` | 상태 플래그 |
| `base_fee_hourly` | INTEGER | N | `NULL` | 시간당 강사료 |
| `fee_note` | TEXT | N | `NULL` | 단가 관련 설명 |
| `rank` | INTEGER | N | `NULL` | 전체 강사 기준 순위 |
| `score` | NUMERIC(5,1) | N | `NULL` | Engagement Score 총점 |
| `score_breakdown` | JSONB | N | `{}` | 7개 컴포넌트별 점수 |
| `score_policy_version` | TEXT | N | `NULL` | 적용된 점수 정책 버전 |
| `score_calculated_at` | TIMESTAMPTZ | N | `NULL` | 점수 재계산 시각 |
| `satisfaction_avg` | NUMERIC(3,2) | N | `NULL` | 만족도 평균 |
| `satisfaction_count` | INTEGER | Y | `0` | 만족도 집계 건수 |
| `satisfaction_is_imputed` | BOOLEAN | Y | `FALSE` | 만족도 중앙값 대체 여부 |
| `total_courses` | INTEGER | Y | `0` | 총 출강 횟수 |
| `recent_courses_6mo` | INTEGER | Y | `0` | 최근 6개월 출강 횟수 |
| `slack_activity_count` | INTEGER | Y | `0` | Slack 활동량 집계값 |
| `email_activity_count` | INTEGER | Y | `0` | Gmail 활동량 집계값 |
| `ops_report_activity_count` | INTEGER | Y | `0` | 운영보고 채널 활동량 집계값 |
| `dispatch_request_activity_count` | INTEGER | Y | `0` | 출강요청 채널 활동량 집계값 |
| `last_activity_at` | TIMESTAMPTZ | N | `NULL` | 최근 활동 시각 |
| `memo_raw` | TEXT | N | `NULL` | 운영 메모 원문 |
| `created_at` | TIMESTAMPTZ | Y | `NOW()` | 생성 시각 |
| `updated_at` | TIMESTAMPTZ | Y | `NOW()` | 수정 시각 |

설명:
- `score_breakdown`은 아래 canonical key를 사용하는 JSONB 오브젝트로 저장한다.

```json
{
  "courses": 0,
  "satisfaction": 0,
  "slack": 0,
  "recency": 0,
  "salesmap": 0,
  "email": 0,
  "ops_channel": 0
}
```

- 각 키의 의미와 허용 범위는 아래와 같다.
- `courses`: 0~35
- `satisfaction`: 0~15
- `slack`: 0~15
- `recency`: 0~15
- `salesmap`: 0~10
- `email`: 0~5
- `ops_channel`: 0~5
- 총점 `score`는 위 7개 컴포넌트 합산 결과다.

### 4-2. `teaching_histories`

강사의 실제 출강 이력이다.

| 필드명 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---:|---|---|
| `id` | UUID | Y | - | PK |
| `instructor_db_id` | UUID | Y | - | `instructors.id` FK |
| `company_name` | TEXT | N | `NULL` | 기업명 |
| `course_name` | TEXT | N | `NULL` | 과정명 |
| `course_id` | TEXT | N | `NULL` | 외부 코스 ID |
| `start_date` | DATE | N | `NULL` | 시작일 |
| `end_date` | DATE | N | `NULL` | 종료일 |
| `date_label` | TEXT | N | `NULL` | 원문 날짜 표현 |
| `deal_fee_hourly` | INTEGER | N | `NULL` | 해당 출강 건에서 확인된 시간당 단가 |
| `fee_extra` | TEXT | N | `NULL` | 출장비 등 추가 금액 정보 |
| `total_hours` | NUMERIC(5,2) | N | `NULL` | 총 시간 |
| `total_sessions` | INTEGER | N | `NULL` | 총 회차 |
| `contract_type` | TEXT | N | `NULL` | 계약 유형 |
| `detail_type` | TEXT | N | `NULL` | 상세 유형 |
| `special_notes` | TEXT | N | `NULL` | 특이사항 |
| `source_type` | TEXT | Y | - | `contract_sheet`, `salesmap`, `fulltime_sheet`, `gmail_incremental` 등 |
| `source_ref` | JSONB | N | `{}` | 원본 소스 참조 정보 |
| `created_at` | TIMESTAMPTZ | Y | `NOW()` | 생성 시각 |

### 4-3. `fee_histories`

강사의 기본 단가 또는 단가 변동 이력이다.

| 필드명 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---:|---|---|
| `id` | UUID | Y | - | PK |
| `instructor_db_id` | UUID | Y | - | `instructors.id` FK |
| `effective_date` | DATE | N | `NULL` | 적용일 |
| `effective_label` | TEXT | N | `NULL` | `현재`, `이전` 등 원문 라벨 |
| `amount` | INTEGER | N | `NULL` | 금액 |
| `fee_kind` | TEXT | Y | `hourly` | `hourly`, `special`, `unknown` |
| `context` | TEXT | N | `NULL` | 변경 맥락 |
| `source_type` | TEXT | Y | - | `notion`, `contract_sheet`, `manual_fix` 등 |
| `is_current` | BOOLEAN | Y | `FALSE` | 현재 단가 여부 |
| `is_special_amount` | BOOLEAN | Y | `FALSE` | 콘텐츠 제작비 등 특수 금액 여부 |
| `created_at` | TIMESTAMPTZ | Y | `NOW()` | 생성 시각 |

설명:
- `fee_histories`는 강사의 실제 단가 이력과 화면 표시용 단가 변동 이력을 저장한다.
- `manual_fix`가 적용된 경우에도 현재 단가 반영 결과는 `fee_histories`에 남길 수 있다.
- 다만 수동 보정 설정의 Source of Truth는 별도 `fee_fix_configs`에서 관리한다.

### 4-4. `satisfaction_records`

개별 만족도 기록이다. 집계값은 `instructors`에 반영된다.

| 필드명 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---:|---|---|
| `id` | UUID | Y | - | PK |
| `instructor_db_id` | UUID | Y | - | `instructors.id` FK |
| `score` | NUMERIC(3,2) | Y | - | 만족도 점수 |
| `company_name` | TEXT | N | `NULL` | 기업명 |
| `course_name` | TEXT | N | `NULL` | 과정명 |
| `response_date` | DATE | N | `NULL` | 응답일 |
| `respondent_count` | INTEGER | N | `NULL` | 응답자 수 |
| `comment` | TEXT | N | `NULL` | 코멘트 |
| `source_type` | TEXT | Y | - | `google_forms`, `gmail`, `fulltime_sheet`, `manual` 등 |
| `source_ref` | JSONB | N | `{}` | 원본 참조 정보 |
| `created_by` | TEXT | N | `NULL` | 작성자 또는 시스템 |
| `created_at` | TIMESTAMPTZ | Y | `NOW()` | 생성 시각 |

### 4-4-1. `satisfaction_import_items`

Google Forms, Gmail 만족도 공유 등 외부 만족도 source의 원본 저장용 테이블이다.

| 필드명 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---:|---|---|
| `id` | UUID | Y | - | PK |
| `run_id` | UUID | Y | - | `pipeline_runs.id` FK |
| `source_type` | TEXT | Y | - | `google_forms`, `gmail_satisfaction`, `sheet_summary` 등 |
| `source_ref` | JSONB | Y | `{}` | `spreadsheet_id`, `worksheet_gid`, `row_number`, `thread_id` 같은 원본 식별자 |
| `raw_payload` | JSONB | Y | `{}` | 응답 row 또는 메일 본문에서 추출한 원문 메타데이터 |
| `normalized_payload` | JSONB | N | `{}` | 점수, 응답일, 회사명, 과정명, 강사명 후보 등 정규화 중간값 |
| `candidate_name` | TEXT | N | `NULL` | 원본에서 직접 확인한 강사명 후보 |
| `candidate_company_name` | TEXT | N | `NULL` | 회사명 후보 |
| `candidate_course_name` | TEXT | N | `NULL` | 과정명 후보 |
| `score_raw` | TEXT | N | `NULL` | 원문 점수 표현 |
| `score_normalized` | NUMERIC(3,2) | N | `NULL` | 정규화 가능한 경우의 수치형 점수 |
| `response_date` | DATE | N | `NULL` | 원문 또는 정규화 응답일 |
| `created_at` | TIMESTAMPTZ | Y | `NOW()` | 기록 시각 |

설명:
- `satisfaction_import_items`는 근거 보존용 테이블이다. 사람이 직접 수정하는 본체가 아니라, 매 실행마다 raw source를 재현 가능하게 남기는 용도다.
- 이 테이블의 레코드가 곧바로 `satisfaction_records`로 반영되지는 않는다. 먼저 `satisfaction_review_registries`로 자동 취합한 뒤 상태에 따라 반영한다.

### 4-4-2. `satisfaction_review_registries`

외부 만족도 source를 강사별/시트별로 자동 취합한 검토용 레지스트리다.

| 필드명 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---:|---|---|
| `id` | UUID | Y | - | PK |
| `run_id` | UUID | Y | - | `pipeline_runs.id` FK |
| `registry_key` | TEXT | Y | - | 같은 검토 단위를 묶는 stable key |
| `source_type` | TEXT | Y | - | `google_forms`, `gmail_satisfaction`, `sheet_summary` 등 |
| `source_refs` | JSONB | Y | `[]` | 이 레지스트리를 구성한 원본 참조 목록 |
| `candidate_name` | TEXT | N | `NULL` | 강사명 후보 |
| `company_name` | TEXT | N | `NULL` | 회사명 |
| `course_name` | TEXT | N | `NULL` | 과정명 |
| `avg_score` | NUMERIC(3,2) | N | `NULL` | 자동 취합 평균 |
| `response_count` | INTEGER | Y | `0` | 취합 응답 수 |
| `match_status` | TEXT | Y | `pending` | `auto_accepted`, `pending`, `approved`, `rejected`, `invalid` |
| `suggested_instructor_id` | UUID | N | `NULL` | 자동 매칭이 제안한 강사 |
| `resolved_instructor_id` | UUID | N | `NULL` | 최종 반영 강사 |
| `resolution_basis` | TEXT | N | `NULL` | `name`, `company_course_crosscheck`, `manual_decision` 등 |
| `created_at` | TIMESTAMPTZ | Y | `NOW()` | 생성 시각 |
| `updated_at` | TIMESTAMPTZ | Y | `NOW()` | 수정 시각 |

설명:
- `satisfaction_review_registries`는 사람이 직접 편집하는 데이터 본체가 아니다. `satisfaction_import_items`를 바탕으로 매 실행마다 자동 생성/갱신되는 취합 결과다.
- `auto_accepted`와 `approved` 상태만 `satisfaction_records` 및 `instructors.satisfaction_*`로 반영한다.
- `pending`, `rejected`, `invalid` 상태는 canonical 반영 대상에서 제외하고 검토 큐로만 남긴다.

### 4-5. `instructor_intelligence`

구조화된 운영 인텔리전스 저장소다.

| 필드명 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---:|---|---|
| `id` | UUID | Y | - | PK |
| `instructor_db_id` | UUID | Y | - | `instructors.id` FK |
| `recommended_for` | TEXT[] | N | `{}` | 추천 대상 |
| `avoid_for` | TEXT[] | N | `{}` | 지양 대상 |
| `risk_notes` | TEXT[] | N | `{}` | 리스크 정보 |
| `ops_check_note` | TEXT | N | `NULL` | 운영 확인 필요 사항 |
| `data_richness` | TEXT | N | `NULL` | `rich`, `moderate`, `sparse`, `minimal` |
| `confidence` | TEXT | N | `NULL` | 신뢰도 |
| `source_summary` | JSONB | N | `{}` | 소스별 근거 요약 |
| `generated_by` | TEXT | N | `NULL` | `rule_based`, `llm`, `mixed` |
| `generation_model` | TEXT | N | `NULL` | LLM 사용 시 모델 식별값 |
| `prompt_version` | TEXT | N | `NULL` | 구조화 프롬프트 버전 |
| `evidence_hash` | TEXT | N | `NULL` | 구조화 입력 근거 해시 |
| `generated_at` | TIMESTAMPTZ | N | `NULL` | 구조화 생성 시각 |
| `updated_at` | TIMESTAMPTZ | Y | `NOW()` | 수정 시각 |

### 4-6. `source_links`

강사와 원본 소스 사이의 연결 정보다.

| 필드명 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---:|---|---|
| `id` | UUID | Y | - | PK |
| `instructor_db_id` | UUID | Y | - | `instructors.id` FK |
| `source_type` | TEXT | Y | - | `notion`, `contract_sheet`, `salesmap`, `slack`, `gmail` 등 |
| `external_key` | TEXT | N | `NULL` | 외부 시스템 식별값 |
| `external_name` | TEXT | N | `NULL` | 외부 시스템 이름 |
| `match_status` | TEXT | Y | `matched` | `matched`, `candidate`, `manual_review`, `rejected` |
| `match_basis` | JSONB | N | `{}` | 이름/연락처/코스ID 기준 |
| `updated_at` | TIMESTAMPTZ | Y | `NOW()` | 수정 시각 |

### 4-7. `validation_issues`

검증 및 자동 수정 이력을 기록한다.

| 필드명 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---:|---|---|
| `id` | UUID | Y | - | PK |
| `instructor_db_id` | UUID | N | `NULL` | 관련 강사 FK |
| `entity_type` | TEXT | Y | - | `instructor`, `teaching_history`, `fee_history` 등 |
| `entity_id` | UUID | N | `NULL` | 관련 엔티티 PK |
| `rule_code` | TEXT | Y | - | 검증 규칙 코드 |
| `severity` | TEXT | Y | - | `info`, `warning`, `error` |
| `message` | TEXT | Y | - | 검증 메시지 |
| `before_value` | JSONB | N | `{}` | 수정 전 값 |
| `after_value` | JSONB | N | `{}` | 수정 후 값 |
| `auto_fixed` | BOOLEAN | Y | `FALSE` | 자동 수정 여부 |
| `run_id` | UUID | N | `NULL` | `pipeline_runs.id` FK |
| `created_at` | TIMESTAMPTZ | Y | `NOW()` | 기록 시각 |

### 4-8. `pipeline_runs`

수집/병합/검증 실행 단위를 기록한다.

| 필드명 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---:|---|---|
| `id` | UUID | Y | - | PK |
| `run_type` | TEXT | Y | - | `manual_refresh`, `scheduled_sync`, `initial_load` |
| `status` | TEXT | Y | - | `running`, `success`, `partial`, `failed` |
| `triggered_by` | TEXT | N | `NULL` | 사용자 또는 시스템 |
| `started_at` | TIMESTAMPTZ | Y | `NOW()` | 시작 시각 |
| `finished_at` | TIMESTAMPTZ | N | `NULL` | 종료 시각 |
| `summary` | JSONB | N | `{}` | 실행 요약 |

### 4-9. `source_sync_logs`

소스별 수집 상태를 기록한다.

| 필드명 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---:|---|---|
| `id` | UUID | Y | - | PK |
| `run_id` | UUID | Y | - | `pipeline_runs.id` FK |
| `source_type` | TEXT | Y | - | 소스명 |
| `status` | TEXT | Y | - | `success`, `partial`, `failed` |
| `fetched_count` | INTEGER | Y | `0` | 수집 건수 |
| `updated_count` | INTEGER | Y | `0` | 반영 건수 |
| `error_message` | TEXT | N | `NULL` | 실패 메시지 |
| `started_at` | TIMESTAMPTZ | Y | `NOW()` | 시작 시각 |
| `finished_at` | TIMESTAMPTZ | N | `NULL` | 종료 시각 |

### 4-10. `activity_import_items`

Slack/Gmail direct API 수집 결과의 원본 저장용 + 검토용 공통 테이블이다.

| 필드명 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---:|---|---|
| `id` | UUID | Y | - | PK |
| `run_id` | UUID | Y | - | `pipeline_runs.id` FK |
| `source_type` | TEXT | Y | - | `slack`, `gmail` |
| `source_ref` | JSONB | Y | `{}` | source-specific dedupe 식별자 |
| `raw_payload` | JSONB | Y | `{}` | 검토에 필요한 최소 메타데이터 |
| `candidate_name` | TEXT | N | `NULL` | 원본에서 식별한 강사명 후보 |
| `candidate_email` | TEXT | N | `NULL` | 원본에서 식별한 이메일 후보 |
| `activity_at` | TIMESTAMPTZ | N | `NULL` | 활동 시각 |
| `is_ops_report` | BOOLEAN | Y | `FALSE` | 운영보고 채널 활동 여부 |
| `is_dispatch_request` | BOOLEAN | Y | `FALSE` | 출강요청 채널 활동 여부 |
| `match_status` | TEXT | Y | `unmatched` | `matched`, `unmatched`, `ambiguous`, `ignored`, `invalid` |
| `matched_instructor_id` | UUID | N | `NULL` | `instructors.id` FK |
| `match_basis` | TEXT | N | `NULL` | `name`, `email`, `channel_map` |
| `error_reason` | TEXT | N | `NULL` | 미반영 또는 실패 사유 |
| `created_at` | TIMESTAMPTZ | Y | `NOW()` | 기록 시각 |

설명:
- `activity_import_items`는 raw source 보존용 테이블이다. Slack/Gmail 원문에서 직접 canonical을 갱신하지 않고, 먼저 이 테이블에 저장한 뒤 `activity_review_registries`로 자동 취합한다.
- 중복 판정 키는 `source_type + source_ref` 조합을 사용한다.
- Slack `source_ref`는 `workspace_id`, `channel_id`, `thread_ts` 또는 `message_ts`를 사용한다.
- Gmail `source_ref`는 `account_email`, `thread_id`, `message_id`를 사용한다.
- `raw_payload`는 full body dump가 아니라 검토 가능한 최소 메타데이터만 저장한다.

### 4-10-1. `activity_review_registries`

Slack/Gmail activity source를 강사별로 자동 취합한 검토용 레지스트리다.

| 필드명 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---:|---|---|
| `id` | UUID | Y | - | PK |
| `run_id` | UUID | Y | - | `pipeline_runs.id` FK |
| `registry_key` | TEXT | Y | - | 같은 검토 단위를 묶는 stable key |
| `source_type` | TEXT | Y | - | `slack`, `gmail` |
| `source_refs` | JSONB | Y | `[]` | 이 레지스트리를 구성한 원본 참조 목록 |
| `candidate_name` | TEXT | N | `NULL` | 강사명 후보 |
| `candidate_email` | TEXT | N | `NULL` | 이메일 후보 |
| `slack_activity_count` | INTEGER | Y | `0` | Slack activity 취합값 |
| `email_activity_count` | INTEGER | Y | `0` | Gmail activity 취합값 |
| `ops_report_activity_count` | INTEGER | Y | `0` | 운영보고 활동 취합값 |
| `dispatch_request_activity_count` | INTEGER | Y | `0` | 출강요청 활동 취합값 |
| `last_activity_at` | TIMESTAMPTZ | N | `NULL` | 취합 기준 최근 활동 시각 |
| `evidence_samples` | JSONB | Y | `[]` | 검토용 근거 샘플 |
| `match_status` | TEXT | Y | `pending` | `auto_accepted`, `pending`, `approved`, `rejected`, `invalid` |
| `suggested_instructor_id` | UUID | N | `NULL` | 자동 매칭이 제안한 강사 |
| `resolved_instructor_id` | UUID | N | `NULL` | 최종 반영 강사 |
| `resolution_basis` | TEXT | N | `NULL` | `name`, `email`, `channel_map`, `manual_decision` 등 |
| `created_at` | TIMESTAMPTZ | Y | `NOW()` | 생성 시각 |
| `updated_at` | TIMESTAMPTZ | Y | `NOW()` | 수정 시각 |

설명:
- `activity_review_registries`는 사람이 직접 patch하는 테이블이 아니다. `activity_import_items`를 바탕으로 매 실행마다 자동 취합된 reviewable summary다.
- `auto_accepted`와 `approved` 상태만 `instructors.slack_activity_count`, `email_activity_count`, `ops_report_activity_count`, `dispatch_request_activity_count`, `last_activity_at`에 반영한다.
- `pending`, `rejected`, `invalid`는 canonical 반영 대상에서 제외한다.

### 4-10-2. `review_decisions`

검토용 레지스트리의 수동 결정만 누적 저장하는 테이블이다.

| 필드명 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---:|---|---|
| `id` | UUID | Y | - | PK |
| `registry_type` | TEXT | Y | - | `satisfaction`, `activity` |
| `registry_key` | TEXT | Y | - | 대상 레지스트리 key |
| `decision_type` | TEXT | Y | - | `approve`, `reject`, `override_instructor` |
| `target_instructor_id` | UUID | N | `NULL` | override 또는 approve 대상 강사 |
| `note` | TEXT | N | `NULL` | 결정 메모 |
| `created_by` | TEXT | N | `NULL` | 결정자 |
| `created_at` | TIMESTAMPTZ | Y | `NOW()` | 기록 시각 |

설명:
- 사람 판단은 레지스트리 row를 직접 수정하는 대신 `review_decisions`에만 저장한다.
- 레지스트리는 raw source로부터 재생성 가능해야 하므로, 수동 개입은 decision log 성격의 별도 테이블로만 남긴다.
- 최신 유효 decision을 적용한 결과가 `approved`, `rejected`, `resolved_instructor_id`로 해석된다.

## 5. 설정 데이터 구조

### 5-1. `fulltime_instructor_configs`

전임강사 리스트를 관리한다.

| 필드명 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---:|---|---|
| `id` | UUID | Y | - | PK |
| `name` | TEXT | Y | - | 강사명 |
| `active` | BOOLEAN | Y | `TRUE` | 현재 전임 여부 |
| `source_file` | TEXT | Y | - | 별도 JSON 파일 경로 또는 식별값 |
| `note` | TEXT | N | `NULL` | 설명 |
| `updated_at` | TIMESTAMPTZ | Y | `NOW()` | 수정 시각 |

### 5-2. `practice_coach_rules`

실습코치 판정 기준을 관리한다.

| 필드명 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---:|---|---|
| `id` | UUID | Y | - | PK |
| `rule_name` | TEXT | Y | - | 규칙명 |
| `rule_type` | TEXT | Y | - | `contract_type`, `detail_type`, `special_note`, `protection_rule` |
| `rule_value` | JSONB | Y | - | 판정값 |
| `active` | BOOLEAN | Y | `TRUE` | 활성 여부 |
| `updated_at` | TIMESTAMPTZ | Y | `NOW()` | 수정 시각 |

### 5-3. `fee_fix_configs`

수동 fee 보정 기준을 관리한다.

| 필드명 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---:|---|---|
| `id` | UUID | Y | - | PK |
| `instructor_db_id` | UUID | N | `NULL` | `instructors.id` FK |
| `name` | TEXT | Y | - | 강사명 |
| `fixed_amount` | INTEGER | Y | - | 수동 확정 시간당 강사료 |
| `reason` | TEXT | N | `NULL` | 보정 사유 |
| `source_basis` | JSONB | N | `{}` | 노션, 세일즈맵, 운영 확인값 등 근거 |
| `active` | BOOLEAN | Y | `TRUE` | 현재 적용 여부 |
| `updated_at` | TIMESTAMPTZ | Y | `NOW()` | 수정 시각 |

### 5-4. `score_policy_versions`

점수 정책을 버전 단위로 관리한다.

| 필드명 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---:|---|---|
| `id` | UUID | Y | - | PK |
| `version` | TEXT | Y | - | 예: `v1`, `v2` |
| `weights` | JSONB | Y | - | 점수 가중치 |
| `missing_satisfaction_policy` | TEXT | Y | - | 결측 처리 규칙 |
| `recency_decay_days` | INTEGER | Y | `180` | 최근성 감쇠 기준 |
| `active` | BOOLEAN | Y | `TRUE` | 현재 정책 여부 |
| `updated_at` | TIMESTAMPTZ | Y | `NOW()` | 수정 시각 |

## 6. 검증/수정 로그 저장 구조

- 자동 수정이 발생하면 `validation_issues`에 `before_value`, `after_value`, `auto_fixed = true`로 기록한다.
- 수동 검토 대상은 `validation_issues`에 `auto_fixed = false`, `severity = warning or error`로 기록한다.
- 어떤 파이프라인 실행에서 발생했는지는 `run_id`로 연결한다.

## 7. 초기 데이터 적재 방식

### 7-1. 초기 적재 순서
1. 스키마 생성
2. 설정 데이터 적재
   - 전임강사 리스트
   - 실습코치 판정 규칙
   - 점수 정책 버전
3. 노션 기본 프로필 적재
4. 계약시트 기반 출강 이력 적재
5. 세일즈맵 보강 데이터 적재
6. 지메일/슬랙/만족도 데이터 적재
7. 병합 및 집계 실행
8. 검증 및 로그 기록

### 7-2. 초기 적재 기준
- 초기 적재는 기존 정적 데이터 또는 운영용 baseline을 기반으로 수행할 수 있다.
- 적재 후 `instructors` 테이블 기준으로 목록/상세 조회가 가능해야 한다.

## 8. 모델링 원칙

- 이름은 표시값이 아니라 식별 보조값으로 다룬다.
- fee와 전임강사 여부는 별도 속성으로 관리한다.
- 운영 메모와 구조화된 인텔리전스는 분리 저장한다.
- 화면 집계값(`score`, `satisfaction_avg`, `total_courses`)은 계산 결과를 저장하되, 원본 기록도 유지한다.
- 점수 구성 요소는 별도 테이블 대신 `instructors.score_breakdown` JSONB에 저장하며, 내부 키는 `courses`, `satisfaction`, `slack`, `recency`, `salesmap`, `email`, `ops_channel`로 고정한다.
- Slack/Gmail direct API 기반 활동성 입력값은 `instructors.slack_activity_count`, `email_activity_count`, `ops_report_activity_count`, `dispatch_request_activity_count`, `last_activity_at`에 저장한다.
- score 계산에서 `slack`은 broad slack signal(`slack_activity_count`)을 사용하고, `ops_channel`은 `ops_report_activity_count`만 사용한다.
- `dispatch_request_activity_count`는 수요 보조 신호/상세 정보 용도로 저장하되, 일반 강사 비교 점수의 direct input으로는 사용하지 않는다.
- 만족도 대체 여부는 `instructors.satisfaction_is_imputed`로 명시한다.
- 순위는 API 응답 시 계산하지 않고 `instructors.rank`에 저장한다.
- 수동 fee 보정의 기준값은 `fee_fix_configs`를 Source of Truth로 사용한다.
- fallback용 데이터와 운영 마스터 데이터는 구분해 관리한다.
