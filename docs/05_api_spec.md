# API Spec

## Role
이 문서는 프론트엔드와 백엔드가 어떤 형식으로 통신하는지 정의한다.
엔드포인트, 요청 파라미터, 응답 형식, 에러 형식, 인증 방식, fallback 응답 차이를 포함한다.

## Source of Truth
- 엔드포인트 목록
- 요청/응답 구조
- 상태 코드와 에러 형식
- 인증 방식
- fallback 응답 규칙

## Depends On
- `00_docs_index.md`
- `01_core_policy.md`
- `03_data_model.md`
- `04_data_pipeline.md`

## Used By
- `06_implementation_spec.md`
- `07_build_guide.md`

## Out of Scope
- DB 쿼리 구현 상세
- OAuth provider 설정 상세
- 캐시 구현 상세
- 프론트엔드 컴포넌트 구조
- 파이프라인 내부 스케줄링 및 배치 실행 상세

## 1. API 기본 원칙

- 모든 API는 JSON을 사용한다.
- 인증된 내부 사용자만 API를 호출할 수 있다.
- 이 문서는 프론트엔드가 호출하는 사용자용 API만 다룬다.
- 모든 주요 응답은 공통 envelope 구조를 따른다.
- fallback 데이터 사용 여부는 응답 메타데이터로 반드시 전달한다.
- 목록 API는 기본적으로 최대 100건까지 반환한다.

## 2. 인증 방식

- 인증 방식은 Google 로그인 기반 세션 인증을 사용한다.
- 허용 도메인은 `@day1company.co.kr`로 제한한다.
- 인증되지 않은 사용자는 `401 Unauthorized`를 반환한다.
- 허용 도메인이 아닌 사용자는 `403 Forbidden`을 반환한다.

## 3. 공통 응답 구조

### 3-1. 성공 응답

```json
{
  "status": "success",
  "meta": {
    "request_id": "req_xxx",
    "data_mode": "live",
    "is_fallback": false,
    "last_updated_at": "2026-04-14T07:00:00Z"
  },
  "data": {}
}
```

### 3-2. 부분 성공 응답

```json
{
  "status": "partial",
  "meta": {
    "request_id": "req_xxx",
    "data_mode": "live",
    "is_fallback": false,
    "last_updated_at": "2026-04-14T07:00:00Z"
  },
  "data": {},
  "errors": [
    {
      "code": "PARTIAL_DATA",
      "message": "일부 필드가 누락되었습니다."
    }
  ]
}
```

### 3-3. 실패 응답

```json
{
  "status": "error",
  "meta": {
    "request_id": "req_xxx",
    "data_mode": "live",
    "is_fallback": false
  },
  "errors": [
    {
      "code": "INSTRUCTOR_NOT_FOUND",
      "message": "강사 정보를 찾을 수 없습니다."
    }
  ]
}
```

### 3-4. 공통 meta 필드

| 필드명 | 타입 | 설명 |
|---|---|---|
| `request_id` | string | 요청 추적용 ID |
| `data_mode` | string | `live`, `stored`, `fallback` |
| `is_fallback` | boolean | fallback 사용 여부 |
| `last_updated_at` | string \| null | 현재 데이터 기준 최종 업데이트 시각 |

## 4. 엔드포인트 목록

- `GET /api/instructors`
- `GET /api/instructors/{id}`
- `POST /api/instructors/{id}/satisfaction`
- `GET /api/status`
- `POST /api/refresh`

## 5. GET /api/instructors

### 5-1. 목적
- 강사 목록을 조회한다.
- 검색, 필터, 정렬 조건을 적용한 결과를 반환한다.

### 5-2. Query Parameters

| 이름 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---:|---|---|
| `query` | string | N | `""` | 강사명, 카테고리 배열, 전문분야, 소속 검색 |
| `category` | string | N | `"전체"` | 단일 카테고리 필터 |
| `sort` | string | N | `"score_desc"` | 정렬 기준 |
| `limit` | number | N | `100` | 최대 반환 개수, 최대 100 |

### 5-3. sort 허용값

- `score_desc`
- `rank_asc`
- `courses_desc`
- `recent_desc`
- `fee_desc`
- `name_asc`

### 5-4. 성공 응답

```json
{
  "status": "success",
  "meta": {
    "request_id": "req_xxx",
    "data_mode": "live",
    "is_fallback": false,
    "last_updated_at": "2026-04-14T07:00:00Z",
    "total_count": 84,
    "query": "",
    "category": "전체",
    "sort": "score_desc"
  },
  "data": {
    "items": [
      {
        "id": "uuid",
        "name": "홍길동",
        "affiliation": "데이원",
        "categories": ["생성형AI", "업무생산성"],
        "specialties": ["ChatGPT", "업무자동화"],
        "rank": 3,
        "score": 91.5,
        "total_courses": 28,
        "base_fee_hourly": 180000,
        "is_fulltime": false,
        "flag": null
      }
    ]
  }
}
```

### 5-5. 목록 아이템 필드

| 필드명 | 타입 | 설명 |
|---|---|---|
| `id` | string | 강사 내부 ID |
| `name` | string | 강사명 |
| `affiliation` | string \| null | 소속 |
| `categories` | string[] | 카테고리 배열 |
| `specialties` | string[] | 전문분야 |
| `rank` | number \| null | 순위 |
| `score` | number \| null | 총점 |
| `total_courses` | number | 총 출강 횟수 |
| `base_fee_hourly` | number \| null | 화면 노출용 기본 단가 값. 전임강사(`is_fulltime = true`)인 경우 항상 `null` |
| `is_fulltime` | boolean | 전임강사 여부 |
| `flag` | string \| null | 운영 플래그 |

### 5-6. 빈 결과 응답

- `status`는 `empty`
- `data.items`는 빈 배열
- `meta.total_count`는 `0`

### 5-7. `meta.total_count` 규칙

- `meta.total_count`는 현재 query/filter 조건에 매칭되는 전체 건수다.
- `limit`가 적용되더라도 `meta.total_count`는 잘리지 않은 전체 매칭 건수를 반환한다.
- 실제 응답에 포함된 개수는 `data.items.length`로 해석한다.

### 5-8. 에러 응답

- `400 INVALID_SORT`
- `400 INVALID_LIMIT`
- `401 UNAUTHORIZED`
- `403 FORBIDDEN_DOMAIN`
- `500 LIST_FETCH_FAILED`

## 6. GET /api/instructors/{id}

### 6-1. 목적
- 선택한 강사의 상세 정보를 반환한다.

### 6-2. Path Parameters

| 이름 | 타입 | 필수 | 설명 |
|---|---|---:|---|
| `id` | string | Y | 강사 내부 ID |

### 6-3. 성공 응답

```json
{
  "status": "success",
  "meta": {
    "request_id": "req_xxx",
    "data_mode": "live",
    "is_fallback": false,
    "last_updated_at": "2026-04-14T07:00:00Z"
  },
  "data": {
    "id": "uuid",
    "name": "홍길동",
    "affiliation": "데이원",
    "categories": ["생성형AI", "업무생산성"],
    "contact": {
      "email": "hong@day1company.co.kr",
      "phone": "010-0000-0000"
    },
    "specialties": ["ChatGPT", "업무자동화"],
    "profile_summary": "강사 소개",
    "memo": "운영 메모 원문",
    "notion_memo_diagnostics": {
      "source_linked": true,
      "notion_page_id": "notion-page-id",
      "enrichment_attempted": true,
      "enrichment_updated": false,
      "comment_capability": "enabled",
      "page_comment_count": 2,
      "block_comment_count": 1,
      "block_text_count": 4,
      "incoming_line_count": 5,
      "error_message": null
    },
    "is_fulltime": false,
    "is_practice_coach": false,
    "total_courses": 28,
    "recent_courses_6mo": 6,
    "total_paid": 5400000,
    "base_fee_hourly": 180000,
    "score": 91.5,
    "score_breakdown": {
      "courses": 31.2,
      "satisfaction": 13.8,
      "slack": 14.0,
      "recency": 12.9,
      "salesmap": 8.0,
      "email": 4.1,
      "ops_channel": 4.5
    },
    "satisfaction": {
      "avg": 4.6,
      "count": 12,
      "is_imputed": false
    },
    "recommended_for": ["임원 대상", "워크숍"],
    "avoid_for": ["초급 실습 위주"],
    "risk_notes": ["현장 이동시간 고려 필요"],
    "raw_operational_notes": [],
    "classified_notes": [],
    "human_followups": [],
    "behavioral_intelligence": {
      "teaching_style": null,
      "curriculum_compliance": null,
      "attitude": null,
      "risk_patterns": ["delivery_quality 반복 근거 2건"],
      "strength_patterns": ["출강 이력 20건 이상"],
      "recommendation": null,
      "data_richness": "moderate",
      "confidence": "low",
      "key_question_for_humans": "2건 확인 필요: 현장 장비 재확인 필요 / 강의 속도 피드백 확인 필요"
    },
    "fee_history": [],
    "teaching_history": [],
    "teaching_history_remaining_count": 0
  }
}
```

### 6-4. 상세 필드 규칙

- `teaching_history`는 최신순 최대 30건만 반환한다.
- 30건을 초과하는 경우 초과 개수는 `teaching_history_remaining_count`로 반환한다.
- 전임강사의 경우 `is_fulltime = true`로 반환한다.
- 전임강사의 경우 내부 저장값과 무관하게 `base_fee_hourly = null`로 반환한다.
- 전임강사의 경우 `fee_history`는 빈 배열로 반환한다.
- `categories`는 카테고리 배열 전체를 반환한다.
- `total_paid`는 화면 라벨 `누적 지급액 (추정)`에 대응하는 상세 전용 파생 필드다.
- `total_paid`는 `deal_fee_hourly`와 `total_hours`가 모두 유효한 `teaching_history` 행만 대상으로 `SUM(deal_fee_hourly * total_hours)`로 계산한다.
- `fee_extra`는 `total_paid` 계산에 포함하지 않는다.
- 계산 가능한 `teaching_history` 행이 하나도 없으면 `total_paid = null`로 반환한다.
- 추천/지양/리스크 정보는 저장된 `instructor_intelligence` 기준으로 반환한다.
- `raw_operational_notes`, `classified_notes`, `human_followups`, `behavioral_intelligence`는 `docs/15_operational_intelligence_classification_spec.md` Phase 1 최소 shape 기준으로 반환한다.
- `notion_memo_diagnostics`는 Notion page body/open comments 기반 메모 영속화의 진단 값을 반환한다.
- 상세 조회 시점에 운영 인텔리전스를 새로 생성하지 않는다.
- 점수 구성 요소가 있으면 `score_breakdown`에 포함하며, 내부 키는 `courses`, `satisfaction`, `slack`, `recency`, `salesmap`, `email`, `ops_channel`을 사용한다.
- 만족도 결측 중앙값 대체 시 `satisfaction.is_imputed = true`로 반환한다.

### 6-5. 부분 성공 응답

- 필수 필드 일부 누락 시 `status = "partial"`
- 가능한 필드는 정상 반환하고, `errors`에 `PARTIAL_DATA`를 포함한다.

### 6-6. 에러 응답

- `401 UNAUTHORIZED`
- `403 FORBIDDEN_DOMAIN`
- `404 INSTRUCTOR_NOT_FOUND`
- `500 DETAIL_FETCH_FAILED`

## 7. POST /api/instructors/{id}/satisfaction

### 7-1. 목적
- 강사 만족도 기록을 새로 작성한다.

### 7-2. Path Parameters

| 이름 | 타입 | 필수 | 설명 |
|---|---|---:|---|
| `id` | string | Y | 강사 내부 ID |

### 7-3. Request Body

```json
{
  "score": 4.5,
  "comment": "참여도와 전달력이 좋았습니다.",
  "company_name": "데이원",
  "course_name": "생성형AI 실무",
  "response_date": "2026-04-14"
}
```

### 7-4. Body 규칙

| 필드명 | 타입 | 필수 | 설명 |
|---|---|---:|---|
| `score` | number | Y | 0~5 범위 |
| `comment` | string | N | 코멘트 |
| `company_name` | string | N | 기업명 |
| `course_name` | string | N | 과정명 |
| `response_date` | string | N | 만족도 기록 기준일 |

### 7-5. 성공 응답

```json
{
  "status": "success",
  "meta": {
    "request_id": "req_xxx",
    "data_mode": "live",
    "is_fallback": false,
    "last_updated_at": "2026-04-14T07:05:00Z"
  },
  "data": {
    "id": "record_uuid",
    "instructor_id": "uuid",
    "score": 4.5,
    "comment": "참여도와 전달력이 좋았습니다.",
    "created_at": "2026-04-14T07:05:00Z",
    "updated_satisfaction": {
      "avg": 4.59,
      "count": 13,
      "is_imputed": false
    }
  }
}
```

### 7-6. 저장 후 반영 규칙

- 만족도 저장 성공 시 `satisfaction_records` 저장과 `instructors.satisfaction_avg`, `instructors.satisfaction_count`, `instructors.satisfaction_is_imputed` 갱신은 같은 요청 흐름 안에서 반영한다.
- 만족도 저장 성공 시 외부 소스를 재조회하지 않고, DB에 저장된 현재 canonical 값을 입력으로 사용해 전체 강사의 `score`, `score_breakdown`, `score_calculated_at`, `rank`를 같은 요청 흐름 안에서 재계산한다.
- 위 전체 재계산에서는 만족도 컴포넌트만 최신 만족도 집계를 기준으로 다시 계산하고, 나머지 비만족도 컴포넌트는 현재 저장된 canonical 값 또는 저장된 구성 요소를 재사용한다.
- `POST /api/instructors/{id}/satisfaction` 성공 직후 다시 호출한 `GET /api/instructors/{id}`는 갱신된 만족도 집계값과 최신 `score`, `score_breakdown`을 반환해야 한다.
- 성공 응답의 `data.updated_satisfaction`는 저장 직후의 최신 집계값을 반환한다.

### 7-7. 에러 응답

- `400 INVALID_SATISFACTION_SCORE`
- `401 UNAUTHORIZED`
- `403 FORBIDDEN_DOMAIN`
- `404 INSTRUCTOR_NOT_FOUND`
- `500 SATISFACTION_WRITE_FAILED`

## 8. GET /api/status

### 8-1. 목적
- 데이터 상태, 마지막 업데이트 시각, 소스별 상태 정보를 조회한다.

### 8-2. 성공 응답

```json
{
  "status": "success",
  "meta": {
    "request_id": "req_xxx",
    "data_mode": "live",
    "is_fallback": false,
    "last_updated_at": "2026-04-14T07:00:00Z"
  },
  "data": {
    "last_updated_at": "2026-04-14T07:00:00Z",
    "refresh_available": true,
    "sources": [
      {
        "source_type": "notion",
        "status": "success",
        "last_synced_at": "2026-04-14T06:55:00Z",
        "fetched_count": 773,
        "updated_count": 773,
        "note": null
      },
      {
        "source_type": "gmail",
        "status": "partial",
        "last_synced_at": "2026-04-14T06:57:00Z",
        "fetched_count": 998,
        "updated_count": 0,
        "note": "reflected_instructors=0 matched=0 unmatched=998 ambiguous=0 invalid=0"
      }
    ]
  }
}
```

### 8-2-1. source status 의미

- `success`
  - source 수집과 반영이 예외 없이 종료되었고, partial 판정 조건이 없다.
  - `fetched_count = 0`, `updated_count = 0`이어도 “변경 없음”이면 `success`일 수 있다.
- `partial`
  - source 호출 자체는 끝났지만, 일부 target/channel 실패 또는 반영 0건 등으로 데이터 품질 경고가 남은 상태다.
  - 예:
    - Gmail 일부 target address 실패
    - Slack 일부 채널 실패
    - Gmail/Slack activity source가 데이터를 수집했지만 instructor aggregate 반영이 0건
- `failed`
  - source runner 자체가 실패해 수집/반영을 끝내지 못한 상태다.
- `never_synced`
  - 아직 한 번도 동기화되지 않은 상태다.

### 8-2-2. source item 필드

| 필드명 | 타입 | 설명 |
|---|---|---|
| `source_type` | string | 표준 source key |
| `status` | string | `success`, `partial`, `failed`, `never_synced` |
| `last_synced_at` | string \| null | 해당 source의 최근 sync 시각 |
| `fetched_count` | number | 최근 sync에서 수집한 raw 건수 |
| `updated_count` | number | 최근 sync에서 canonical 반영에 영향을 준 건수 |
| `note` | string \| null | partial/failed 판단 근거 또는 운영 참고 메모 |

### 8-3. 에러 응답

- `401 UNAUTHORIZED`
- `403 FORBIDDEN_DOMAIN`
- `500 STATUS_FETCH_FAILED`

## 9. POST /api/refresh

### 9-1. 목적
- 각 소스의 업데이트 여부를 다시 조회하고, 변경된 데이터가 있으면 마스터 데이터를 갱신한다.

### 9-2. Request Body

- 없음

### 9-3. 성공 응답

```json
{
  "status": "success",
  "meta": {
    "request_id": "req_xxx",
    "data_mode": "live",
    "is_fallback": false,
    "last_updated_at": "2026-04-14T07:10:00Z"
  },
  "data": {
    "refresh_status": "success",
    "updated": true,
    "run_id": "run_uuid",
    "summary": {
      "sources_checked": 6,
      "sources_updated": 3,
      "records_updated": 24
    }
  }
}
```

### 9-4. 부분 성공 응답

- 일부 소스만 실패해도 갱신이 가능한 경우 `status = "partial"`
- source별 `partial`도 전체 refresh를 `partial`로 만들 수 있다.
- 예: Gmail/Slack source는 API 호출은 성공했지만 canonical instructor 반영이 0건이면 `source_sync_logs.status = "partial"`로 기록할 수 있다.
- `summary`에 소스별 결과를 포함할 수 있다.

### 9-5. 에러 응답

- `401 UNAUTHORIZED`
- `403 FORBIDDEN_DOMAIN`
- `409 REFRESH_IN_PROGRESS`
- `500 REFRESH_FAILED`

## 10. fallback 응답 규칙

- fallback 데이터를 사용한 경우 `meta.data_mode = "fallback"`로 반환한다.
- fallback 데이터를 사용한 경우 `meta.is_fallback = true`로 반환한다.
- fallback 응답도 데이터 구조는 일반 성공 응답과 동일하게 유지한다.
- fallback 상태에서는 최신 일부 필드가 비어 있을 수 있으나 응답 스키마 자체는 바꾸지 않는다.

## 11. 에러 코드 목록

| 코드 | HTTP 상태 | 설명 |
|---|---:|---|
| `UNAUTHORIZED` | 401 | 로그인 세션 없음 |
| `FORBIDDEN_DOMAIN` | 403 | 허용 도메인 외 계정 |
| `INVALID_SORT` | 400 | 허용되지 않은 정렬값 |
| `INVALID_LIMIT` | 400 | 허용 범위를 벗어난 limit |
| `INVALID_SATISFACTION_SCORE` | 400 | 만족도 점수 범위 오류 |
| `INSTRUCTOR_NOT_FOUND` | 404 | 해당 강사 없음 |
| `PARTIAL_DATA` | 200 | 일부 데이터 누락 |
| `LIST_FETCH_FAILED` | 500 | 목록 조회 실패 |
| `DETAIL_FETCH_FAILED` | 500 | 상세 조회 실패 |
| `STATUS_FETCH_FAILED` | 500 | 상태 조회 실패 |
| `SATISFACTION_WRITE_FAILED` | 500 | 만족도 저장 실패 |
| `REFRESH_IN_PROGRESS` | 409 | 새로고침이 이미 진행 중 |
| `REFRESH_FAILED` | 500 | 새로고침 실패 |

## 12. 페이지네이션 정책

- 이번 버전에서는 목록 API에 페이지네이션을 두지 않는다.
- `GET /api/instructors`는 기본 100건, 최대 100건까지만 반환한다.
- 상세 API의 강의 이력은 최신순 30건까지만 반환한다.

## 13. API 버전 관리

- 이번 버전은 별도 버전 prefix를 두지 않고 단일 API 세트를 사용한다.
- 대규모 스키마 변경이 필요한 경우 이후 `/api/v2` 방식의 버전 분리를 검토한다.
