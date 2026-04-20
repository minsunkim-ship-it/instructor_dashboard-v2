# Data Pipeline

## Role
이 문서는 외부 데이터 소스에서 강사 데이터를 수집하고, 병합하고, 검증하고, 최종 마스터 데이터로 저장하는 전체 흐름을 정의한다.
수집 대상, 소스별 접근 방식, 병합 절차, 검증 규칙, 실패 처리, refresh 및 fallback 흐름을 포함한다.

## Source of Truth
- 데이터 소스 목록
- 소스별 접근 방식
- 소스별 수집 대상
- 소스별 필드 매핑
- 병합 순서와 충돌 처리
- 검증 및 정제 절차
- refresh 및 fallback 동작
- 결과 저장 위치와 형식

## Depends On
- `00_docs_index.md`
- `01_core_policy.md`
- `03_data_model.md`

## Used By
- `05_api_spec.md`
- `06_implementation_spec.md`
- `07_build_guide.md`

## Out of Scope
- UI 렌더링 방식
- SQL 쿼리 최적화 상세
- 외부 API 인증 구현 상세
- 배포 자동화 상세

## 1. 파이프라인 목표

- 여러 외부 소스의 데이터를 하나의 강사 마스터 레코드로 통합한다.
- 목록, 상세, 점수 계산, 운영 판단에 필요한 데이터를 일관된 구조로 저장한다.
- 소스 일부가 실패해도 서비스가 계속 동작할 수 있도록 마지막 정상 데이터와 fallback 구조를 유지한다.

## 2. 전체 흐름

데이터 파이프라인은 아래 순서로 동작한다.

1. 수집 실행 생성
2. 소스별 데이터 수집
3. 소스별 정규화
4. raw/import 테이블 저장
5. review registry 자동 취합
6. 자동 반영 가능 항목과 pending 항목 분기
7. 강사 동일인 판정 및 병합
8. 전임강사 및 실습코치 판정 반영
9. fee 및 단가 이력 정리
10. 만족도 집계 및 대체값 처리
11. 운영 인텔리전스 통합
12. 점수 계산
13. 검증 및 자동 수정
14. Railway DB 저장
15. 마지막 정상 데이터 갱신
16. 실패 시 fallback 처리

## 3. 데이터 소스 목록

이번 버전에서 다루는 데이터 소스는 아래와 같다.

- 계약시트
- 노션
- 세일즈맵
- 슬랙
- 지메일
- Google Forms
- 전임강사 JSON
- 운영 메모 hardcoded JSON
- 정적 baseline 데이터

## 4. 소스별 접근 방식

### 4-1. 계약시트
- 접근 방식: Google Sheets API (Google user OAuth refresh token)
- 필수 환경변수: `GOOGLE_CONTRACTS_SPREADSHEET_ID`, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, `GMAIL_ACCOUNT_EMAIL`
- Canonical spreadsheet ID: `1QFlQItxBOrnTfF_wvjb5T7fhImbibeK2De4ZFyb0EWA`
- 대상 worksheet: `gid=158052384`, `gid=1875350219`
- 두 worksheet는 동일 헤더 매핑을 사용하며, 필드 매핑 계약은 5-1-1절을 따른다.
- `GMAIL_ACCOUNT_EMAIL` 계정은 대상 스프레드시트에 Viewer 이상으로 접근 가능해야 한다.
- 목적: 출강 이력, 계약 유형, 상세 유형, 강사료 기준 정보, 실습코치 판정 근거, 운영 메모 후보 수집

### 4-2. 노션
- 접근 방식: Notion API 사용
- 필수 환경변수: `NOTION_API_KEY`, `NOTION_DATABASE_ID`
- 목적: 강사 기본 프로필, 카테고리, 연락처, 메모, fee_note, 기본 강사료와 프로필 요약/운영 인텔리전스 후보를 채울 수 있는 원문 근거 수집

### 4-3. 세일즈맵
- 접근 방식: local SQLite snapshot file 읽기
- 필수 환경변수: `SALESMAP_SNAPSHOT_PATH`
- 현재 단계의 canonical source는 env로 주입되는 local snapshot file이며, 고정 파일명 자체는 계약으로 삼지 않는다.
- `SALESMAP_RELEASE_URL`은 후속 자동 다운로드 단계가 생길 때의 배포 경로로만 사용한다.
- 목적: 딜 정보, 기업명/과정명 보강, 활동 최근성 보강, 일부 단가 참고 정보, 운영 메모 후보 수집

### 4-4. 슬랙
- 접근 방식: direct Slack API
- 필수 환경변수: `SLACK_BOT_TOKEN`, `SLACK_WORKSPACE_ID`
- 목적: 활동량, 최근 활동일, 운영 채널 활동 근거 수집

### 4-5. 지메일
- 접근 방식: direct Gmail API
- 필수 환경변수: `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, `GMAIL_ACCOUNT_EMAIL`, `GMAIL_TARGET_ADDRESSES`
- 목적: 활동량, 최근 활동일, 강사 관련 커뮤니케이션 근거, 운영 메모 후보 수집

### 4-6. Google Forms
- 접근 방식: Google Sheets API 직접 읽기
- 목적: 만족도 기록 수집

### 4-7. 전임강사 JSON
- 접근 방식: 별도 설정 JSON 파일 읽기
- 목적: 전임강사 여부 판정 기준 제공

### 4-8. 운영 메모 hardcoded JSON
- 접근 방식: 애플리케이션 로컬 JSON 파일 읽기
- 목적: 수동 확정 운영 메모 원문 수집

### 4-9. 정적 baseline 데이터
- 접근 방식: 애플리케이션 리소스 파일 읽기
- 목적: 마지막 정상 데이터도 없을 때 fallback용 기준 데이터 제공

## 5. 소스별 수집 대상

### 5-1. 계약시트
- 강사명
- 강의명 또는 과정명
- 기업명
- 시작일, 종료일
- 지급 강사료 또는 강사료 기준 정보
- 계약 유형
- 상세 유형
- 특이사항
- course_id 또는 검증 가능한 외부 과정 식별값

#### 5-1-1. 실제 계약시트 컬럼 매핑

아래 표는 사용자가 공유한 실제 계약시트 헤더 기준의 파이프라인 v1 매핑 계약이다.

| 논리 필드 | 내부 필드 | 실제 계약시트 컬럼명 | 상태 | 수집 규칙 |
|---|---|---|---|---|
| 강사명 | `name` | `강사명` | 확정 | exact match 기준 강사명으로 사용한다. |
| 강의명 또는 과정명 | `course_name` | `강의 코스명 (코스명 전체 정확히)` | 확정 | 원문 과정명을 그대로 저장한다. |
| 기업명 | `company_name` | 없음 | 간접 | 현재 공유된 계약시트 헤더에는 직접 컬럼이 없다. 필요 시 `course_id` 또는 세일즈맵 보강으로 채운다. |
| 시작일 | `start_date` | `강의 일정` | 간접 | 원문 일정 텍스트에서 첫 일정 날짜를 파싱한다. |
| 종료일 | `end_date` | `강의 일정` | 간접 | 원문 일정 텍스트에서 마지막 일정 날짜를 파싱한다. |
| 일정 원문 | `date_label` | `강의 일정` | 확정 | 원문 문자열을 보존한다. |
| 출강 단가 | `deal_fee_hourly` | `시간당 강사료 (ex. 250,000)` | 확정 | 해당 출강 건에서 확인된 시간당 단가다. 쉼표/공백/`원` 제거 후 정수로 파싱하고, `10000` 이하면 `NULL`로 둔다. |
| 기본 강사료 참고값 | `base_fee_hourly` 후보 | `시간당 강사료 (ex. 250,000)` | 확정 | 계약시트 기준 시간당 강사료로 파싱하며, 노션/세일즈맵 뒤의 fallback 후보로도 사용한다. |
| 강사료 외 | `fee_extra` | `강사료 외 (ex. 100,000 / 없으면 빈칸)` | 확정 | 추가 금액 설명 원문을 저장한다. |
| 총 강의시수 | `total_hours` | `총 강의시수 (숫자로 기입 ex. 8) 회차 * 시수  (총= 모든 합을 더한수)` | 확정 | 숫자로 정규화한다. |
| 총 회차 | `total_sessions` | `총 회차 (ex. 2)` | 확정 | 숫자로 정규화한다. |
| 계약 유형 | `contract_type` | `강사 계약 유형` | 확정 | 실습코치 판정과 이력 적재에 사용한다. |
| 상세 유형 | `detail_type` | 첫 번째 `세부 유형` | 조건부 확정 | 동일한 헤더명이 2개 있으므로, `계약서 유형 선택` 바로 다음에 나오는 첫 번째 `세부 유형`을 canonical 컬럼으로 사용한다. |
| 특이사항 | `special_notes` | `기타-계약관련 특이사항 기재` | 확정 | 계약 관련 특이사항 원문을 저장한다. |
| course_id | `course_id` | `강의 코스 ID (숫자만)` | 확정 | 문자열 또는 숫자형 ID로 정규화한다. |

- 실제 계약시트 헤더에는 `강의 일정  \n(ex. ...)`, `기타-계약관련 특이사항 기재\n(*특히 ...)`처럼 개행과 예시 문구가 함께 들어갈 수 있다. collector는 canonical 컬럼 매칭 전에 `첫 개행 이전 문자열만 사용 + 연속 공백 축약 + trim` 규칙으로 헤더를 정규화한다.
- `계약서 유형 선택`, 두 번째 `세부 유형`, `변경유형`, `계약 담당`, `타임스탬프`, `소속`, `담당자`, `팀장`, `강사 이메일`, `이메일 주소`, `신규강사 여부`, `분할지급 여부`, `법인계약시 취합링크`, `비고`는 현재 v1의 1차 적재 대상 필드에는 직접 매핑하지 않는다.
- 위 보조 컬럼은 필요 시 `source_ref` 원문 보존 또는 후속 매칭/검증 규칙 입력값으로 사용할 수 있다.
- 계약시트 `시간당 강사료`는 `teaching_histories.deal_fee_hourly`와 `instructors.base_fee_hourly` fallback 후보가 동시에 참조하는 공통 원천이다.
- 계약시트의 `시간당 강사료`는 `04_data_pipeline.md` 12절의 계약시트 fallback fee 기준값과 동일한 컬럼이다.

### 5-2. 노션
- 강사명
- 소속
- 카테고리
- 프로필 요약
- 이메일
- 전화번호
- 기본 강사료
- fee_note
- 메모
- 추천 대상
- 지양 대상
- 리스크 정보
- 운영 확인 필요 사항

#### 5-2-1. 실제 Notion DB 프로퍼티 매핑

아래 표는 현재 확인된 실제 Notion DB 프로퍼티명과 live Notion API 기준 현재 타입을 반영한 파이프라인 v1 매핑 계약이다.

| 논리 필드 | 내부 필드 | 실제 Notion 프로퍼티명 | 현재 Notion 타입 | 상태 | 수집 규칙 |
|---|---|---|---|---|---|
| 강사명 | `name` | `강사명` | `title` | 확정 | 대표 강사명으로 사용한다. |
| 소속정보 | `affiliation` | `소속정보` | `multi_select` | 확정 | multi_select면 순서를 유지한 채 `, `로 join한다. |
| 카테고리 | `categories` | `카테고리` | `multi_select` | 확정 | multi_select면 순서를 유지한 배열 그대로 저장한다. |
| 프로필 요약 | `profile_summary` | 없음 | 없음 | 간접 | 직접 프로퍼티는 없지만, 다른 소스 또는 원문 근거 기반 후속 파생 규칙이 있으면 채우고 없으면 `NULL`로 둔다. |
| 이메일 | `contact_email` | `이메일 주소` | `email` | 확정 | 대표 이메일만 구조화 필드에 저장한다. `이메일 주소 (2)`가 있으면 Notion 원문 `메모` 블록에 `보조 이메일:` 라벨로 덧붙여 보존한다. |
| 보조 이메일 | 보조 원문 | `이메일 주소 (2)` | `email` | 확정 | 대표 이메일로 승격하지 않고 Notion 원문 `메모` 블록에 `보조 이메일:` 라벨로만 보존한다. |
| 전화번호 | `contact_phone` | `연락처` | `phone_number` | 확정 | 대표 전화번호만 구조화 필드에 저장한다. `연락처2`가 있으면 Notion 원문 `메모` 블록에 `보조 연락처:` 라벨로 덧붙여 보존한다. |
| 보조 연락처 | 보조 원문 | `연락처2` | `phone_number` | 확정 | 대표 전화번호로 승격하지 않고 Notion 원문 `메모` 블록에 `보조 연락처:` 라벨로만 보존한다. |
| 기본 강사료 | `base_fee_hourly` | `기본 강사료` | `number` | 확정 | 현재 live Notion 타입이 `number`이면 `0` 초과 값을 시간당 단가로 간주해 그대로 반영한다. `fee_note`는 보조 설명으로 저장하며, number 필드의 반영 여부를 막는 조건으로 사용하지 않는다. |
| fee_note | `fee_note` | `강사료 특이사항` | `rich_text` | 확정 | 단가 설명 원문을 저장한다. |
| 추천 대상 | `recommended_for` | 없음 | 없음 | 간접 | 직접 프로퍼티는 없지만, 다른 소스 또는 원문 근거 기반 구조화 단계에서 채울 수 있다. |
| 지양 대상 | `avoid_for` | 없음 | 없음 | 간접 | 직접 프로퍼티는 없지만, 다른 소스 또는 원문 근거 기반 구조화 단계에서 채울 수 있다. |
| 리스크 정보 | `risk_flags` | 없음 | 없음 | 간접 | 직접 프로퍼티는 없지만, 다른 소스 또는 원문 근거 기반 구조화 단계에서 채울 수 있다. |
| 운영 확인 필요 사항 | `ops_notes` | 없음 | 없음 | 간접 | 직접 프로퍼티는 없지만, 다른 소스 또는 원문 근거 기반 구조화 단계에서 채울 수 있다. |

- 현재 확인된 실제 Notion 프로퍼티 목록에는 `specialties`에 대한 직접 대응 필드가 없다.
- 실제 Notion 프로퍼티 `메모`는 존재하지만, 현재 문서의 논리 필드 `운영 메모`의 직접 소스로 사용하지 않는다.
- `URL`, `강사자료(이력서 포함)`, `계좌 정보`, `담당 강의 정보`, `메모`, `이전 강의 및 강사료 History`, `커리큘럼` 등은 현재 파이프라인 v1의 직접 매핑 대상에 포함하지 않는다.
- `이메일 주소 (2)`와 `연락처2`는 구조화 연락처 필드로 승격하지 않고, Notion 원문 `메모` 블록에 라벨을 붙여 보존한다.
- 현재 Notion 타입 정보는 구현 편의를 위한 문서 계약이다. 실제 수집기는 `property.type`을 런타임에 확인해야 하며, 문서와 live 타입이 다르면 경고 또는 실패로 처리한다.
- 직접 프로퍼티가 없는 논리 필드는 Notion 원문, 다른 소스, 후속 구조화 단계 중 채울 수 있는 근거가 있을 때만 반영하고, 없으면 `NULL` 또는 빈 값으로 둔다.

### 5-3. 세일즈맵
- 강사명
- 기업명
- 과정명
- 딜 건수 또는 관련 활동량
- 최근 활동일
- 보조 fee 정보

#### 5-3-1. 실제 세일즈맵 스냅샷 필드 매핑

v1에서 사용하는 세일즈맵 원천은 env `SALESMAP_SNAPSHOT_PATH`로 주입되는 local SQLite snapshot file이며, 핵심 원천은 `deal` 테이블이고 기업명은 `organization` 테이블 join으로 보강한다.

| 논리 필드 | 내부 필드 | 실제 소스 | 상태 | 수집 규칙 |
|---|---|---|---|---|
| 강사명 | `name` | `deal.강사 이름1`~`deal.강사 이름5` | 확정 | 슬롯형 컬럼을 unpivot하여 강사별 후보 row로 펼친다. |
| 보조 fee 정보 | fee 후보 | `deal.강사료1`~`deal.강사료5` | 확정 | 같은 번호의 `강사 이름N`과 짝지어 수집한다. |
| 기업명 | `company_name` | `organization.이름` via `deal.organizationId` | 확정 | `deal.organizationId = organization.id`로 join한 값을 사용한다. |
| 과정명 | `course_name` | `deal.이름` | 확정 | 세일즈맵 딜/과정 대표명으로 사용한다. |
| `course_id` | `course_id` | `deal.코스 ID` | 확정 | 비어 있지 않은 경우 문자열 ID로 저장한다. |
| 시작일 | `start_date` | `deal.수강시작일` | 확정 | 날짜 또는 시각 문자열을 `DATE`로 정규화한다. |
| 종료일 | `end_date` | `deal.수강종료일` | 확정 | 날짜 또는 시각 문자열을 `DATE`로 정규화한다. |
| 최근 활동일 | `last_activity_at` 후보 | `deal.최근 파이프라인 수정 날짜` | 확정 | 세일즈맵 기준 최근성 판단의 1순위로 사용한다. |
| 최근 활동일 fallback | `last_activity_at` 후보 | `deal.최근 노트 작성일`, `deal.수정 날짜` | 확정 | `최근 파이프라인 수정 날짜`가 없을 때 순서대로 fallback한다. |
| 딜 식별자 | `source_ref.deal_id` | `deal.id` | 확정 | 원문 소스 추적용 식별자로 저장한다. |
| 조직 식별자 | `source_ref.organization_id` | `deal.organizationId` | 확정 | 기업 조인 추적용 식별자로 저장한다. |

- 현재 확인한 스냅샷에서 강사명이 있는 `deal` row는 534건이다.
- 세일즈맵 snapshot 파일명은 `salesmap_latest.db`, `salesmap_latest (1).db`처럼 환경마다 달라질 수 있으므로, 파일명 자체를 계약으로 고정하지 않고 `SALESMAP_SNAPSHOT_PATH`를 단일 진실 소스로 사용한다.
- 세일즈맵 `강사료`는 hourly candidate 분류 기준으로만 해석한다.
- `10000 < fee <= 3000000` 이면 `hourly-interpretable` 후보로 본다.
- 위 범위를 벗어나면 총액 또는 특수 금액으로 간주하고 기본 단가 후보로 직접 반영하지 않는다.
- 강사명이 있는 row 기준 `organization.이름`과 `deal.이름`, `deal.최근 파이프라인 수정 날짜`는 모두 안정적으로 채워져 있다.
- `deal.교육 주제`는 강사명이 있는 row 기준 실사용 값이 없어 v1 매핑 대상에서 제외한다.
- 세일즈맵의 `강사료1~5`는 250000 같은 시간당 단가 후보와 7000000, 11920000 같은 총액/특수 금액 후보가 혼재하므로, 기본 단가로 바로 확정하지 않고 보조 fee 정보로만 수집한다.
- 세일즈맵 `강사료N` 값이 시간당 강사료로 해석 가능한 경우에만 `04_data_pipeline.md` 12절의 fee fallback 후보로 사용할 수 있다.

### 5-4. 슬랙
- 강사명 또는 연결 가능한 식별값
- 활동 건수
- 최근 활동일
- 운영 채널 활동량

#### 5-4-1. 슬랙 direct API v1 계약

- 접근 방식은 direct Slack API다. 수집기는 `SLACK_BOT_TOKEN`, `SLACK_WORKSPACE_ID`를 사용한다.
- v1의 canonical scope는 아래 3개 채널만 사용한다.
  - 운영보고: `C015YD84VGS`
  - 출강요청(정백): `C099UH7ACGG`
  - 출강요청(신동원): `C0AS2VDUXQ8`
- 운영보고 채널 활동은 `ops_report_activity_count` 후보로 집계한다.
- 출강요청 채널 활동은 채널 → 강사 매핑을 우선 적용해 `dispatch_request_activity_count` 후보로 집계한다.
- Slack activity count 단위는 아래와 같다.
  - 스레드가 있으면 `thread 1개 = activity 1건`
  - 스레드가 없으면 `message 1개 = activity 1건`
  - reply 수는 count를 직접 늘리지 않는다.
  - 단, 스레드 마지막 reply 시각은 `last_activity_at` 계산 후보로 반영할 수 있다.
- direct API 응답은 즉시 서비스용 필드에 반영하지 않고, 먼저 `activity_import_items`에 저장한다.
- `activity_import_items`는 `activity_review_registries`로 자동 취합한다.
- `activity_review_registries`의 `auto_accepted`, `approved` 상태만 서비스용 필드 집계에 반영한다.
- `activity_import_items.source_ref`는 `workspace_id`, `channel_id`, `thread_ts` 또는 `message_ts`를 사용한다.
- `activity_import_items.raw_payload`는 `text`, `reply_count`, `latest_reply_at`, 채널 메타 등 검토 가능한 최소 메타데이터만 저장한다. full body dump는 v1 범위에 포함하지 않는다.

### 5-5. 지메일
- 강사명 또는 연결 가능한 식별값
- 메일 활동 건수
- 최근 활동일

#### 5-5-1. 슬랙/지메일 공통 매칭 키 규칙

슬랙과 지메일 활동 로그를 강사 마스터 레코드에 연결할 때는 아래 순서로만 매칭한다.

| 순서 | 매칭 키 | 상태 | 규칙 |
|---|---|---|---|
| 1 | 강사명 exact match | 확정 | 정규화된 강사명이 기존 `instructors.name`과 정확히 같을 때만 연결한다. |
| 2 | 이메일 exact match | 확정 | 강사명으로 연결되지 않고, 소스에 이메일이 있을 때 `contact_email`과 exact match면 연결한다. |
| 3 | 전화번호 exact match | 확정 | 강사명/이메일로 연결되지 않고, 소스에 전화번호가 있을 때 `contact_phone`과 exact match면 연결한다. |

- alias 매핑은 사용하지 않는다.
- 이름이 같아도 이메일 또는 전화번호가 충돌하면 자동 연결하지 않고 운영 검토 대상으로 남긴다.
- 강사명, 이메일, 전화번호 중 어떤 값으로도 연결할 수 없으면 해당 활동은 미연결 상태로 둔다.
- `이메일 주소 (2)`, `연락처2`처럼 Notion 원문 `메모`에만 보존한 보조 연락처는 자동 매칭 키로 사용하지 않는다.
- `course_id`와 소속은 Slack/Gmail 활동 매칭의 1차 키로 사용하지 않는다.
- Slack/Gmail는 강사 기본 프로필을 덮어쓰는 소스가 아니라 활동량과 최근 활동일을 보강하는 보조 소스다.

#### 5-5-2. 지메일 direct API v1 계약

- 접근 방식은 direct Gmail API다.
- 인증 방식은 Google Workspace domain-wide delegation이 아니라 OAuth refresh token 방식을 사용한다.
- canonical 환경변수는 `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, `GMAIL_ACCOUNT_EMAIL`, `GMAIL_TARGET_ADDRESSES`다.
- `GMAIL_ACCOUNT_EMAIL`은 실제 로그인 가능한 Gmail/Workspace 계정 주소를 사용한다.
- `GMAIL_TARGET_ADDRESSES`는 해당 계정 mailbox 안에서 검색할 그룹/수신 대상 주소의 comma-separated 목록을 사용한다.
- Gmail activity count 단위는 `thread 1개 = activity 1건`으로 본다.
- direct API 응답은 즉시 서비스용 필드에 반영하지 않고, 먼저 `activity_import_items`에 저장한다.
- `activity_import_items`는 `activity_review_registries`로 자동 취합한다.
- `activity_review_registries`의 `auto_accepted`, `approved` 상태만 서비스용 필드 집계에 반영한다.
- 수집기는 authenticated account mailbox에서 `to:`, `cc:`, `deliveredto:` 조건으로 `GMAIL_TARGET_ADDRESSES`를 검색한다.
- `activity_import_items.source_ref`는 `account_email`, `thread_id`, `message_id`를 사용한다.
- `activity_import_items.raw_payload`는 `subject`, `snippet`, `from`, `to` 등 검토 가능한 최소 메타데이터만 저장한다. full body dump는 v1 범위에 포함하지 않는다.
- Gmail v1은 활동량과 최근 활동일만 다룬다. 운영 사실 문장 추출과 `memo_raw` 병합은 별도 canonical 규칙이 정의되기 전까지 구현하지 않는다.

### 5-6. Google Forms
- 강사명
- 만족도 점수
- 응답일
- 기업명
- 과정명
- 코멘트

#### 5-6-1. 만족도 최소 구현 원칙

- 만족도 source는 demo discovery 우선순위를 그대로 따르되, 실제 구현 구조는 `raw 저장 -> review registry -> canonical 반영` 3단계로 고정한다.
- raw source는 `satisfaction_import_items`에 저장한다.
- `satisfaction_import_items`는 `satisfaction_review_registries`로 자동 취합한다.
- `satisfaction_review_registries`의 `auto_accepted`, `approved` 상태만 `satisfaction_records`와 `instructors.satisfaction_*` 집계에 반영한다.
- `pending`, `rejected`, `invalid`는 service 반영 대상이 아니라 검토 대상으로만 남긴다.
- 사람이 판단이 필요한 경우 registry 자체를 편집하지 않고 `review_decisions`에만 결정을 저장한다.

### 5-7. 전임강사 JSON
- 강사명
- 필요 시 보조 식별값

#### 5-7-1. 전임강사 JSON 실제 스키마

현재 전임강사 리스트의 canonical 소스 파일은 `prisma/fulltime_instructors.json`이다.

| 논리 필드 | 내부 필드 | 실제 JSON 경로 | 상태 | 수집 규칙 |
|---|---|---|---|---|
| 버전 | 메타 | `version` | 확정 | JSON 스키마 버전을 나타낸다. |
| 갱신일 | 메타 | `updated_at` | 확정 | 수동 갱신 기준 날짜 문자열을 저장한다. |
| 전임강사 목록 | `fulltime_instructor_configs` 원천 | `instructors` | 확정 | 배열 단위로 읽는다. |
| 강사명 | `name` | `instructors[].name` | 확정 | 강사명 exact match 기준으로 전임 여부를 판정한다. |
| 활성 여부 | `active` | `instructors[].active` | 확정 | `true`인 항목만 현재 전임강사로 반영한다. |

- 현재 파일 예시는 아래와 같다.

```json
{
  "version": 1,
  "updated_at": "2026-04-15",
  "instructors": [
    { "name": "정백", "active": true },
    { "name": "신동원", "active": true },
    { "name": "공지연", "active": true },
    { "name": "김용담", "active": true },
    { "name": "김재성", "active": true }
  ]
}
```

- JSON 로딩 시 `active = true`인 항목만 `fulltime_instructor_configs` 또는 동등한 내부 설정 구조에 반영한다.
- 별도 보조 식별값은 현재 파일 스키마에 포함하지 않으며, 필요해질 때만 후속 버전에서 확장한다.

### 5-8. 운영 메모
- 강사명
- 운영 메모 원문
- 소스 타입
- 소스 참조값

#### 5-8-1. 운영 메모 실제 소스 매핑

운영 메모 `memo_raw`는 Notion에서 직접 읽지 않고, 아래 원천을 수집해 합성한다.

| 논리 필드 | 내부 필드 | 실제 소스 | 상태 | 수집 규칙 |
|---|---|---|---|---|
| 운영 메모 | `memo_raw` 후보 | `data/ops-notes-hardcoded.json` | 확정 | 수동 확정 메모를 강사명 기준으로 읽어 후보에 포함한다. |
| 운영 메모 | `memo_raw` 후보 | 계약시트 `special_notes` (`기타-계약관련 특이사항 기재`) | 확정 | 3자 초과 항목만 수집하고 중복 제거 후 후보에 포함한다. |
| 운영 메모 | `memo_raw` 후보 | `incremental_merge.py`의 Gmail 운영 사실 삽입 로직 | 보류 | legacy reference로만 유지한다. direct API v1에서는 운영 사실 문장 추출 규칙이 정리되기 전까지 재구현하지 않는다. |
| 운영 메모 | `memo_raw` 후보 | `incremental_merge.py`의 세일즈맵 딜 변동 삽입 로직 | 확정 | 세일즈맵 딜 변동 관련 문장을 후보에 포함한다. |

- 운영 메모 후보는 중복 제거 후 하나의 원문 텍스트 블록으로 합쳐 `memo_raw`에 저장한다.
- 저장 후 아래 항목은 자동 제거한다.
- 10자 미만 노트
- `사업자번호`, `사업자등록`, `상호명`, `법인계약`, `통장사본`, `모두싸인`, `URL`이 포함된 노트
- `주요 고객사:`, `슬랙 하이라이트:`, `평균 만족도`로 시작하는 노트

#### 5-8-2. `data/ops-notes-hardcoded.json` 실제 스키마

운영 메모 hardcoded JSON의 canonical 소스 파일은 `data/ops-notes-hardcoded.json`이다.

| 논리 필드 | 내부 필드 | 실제 JSON 경로 | 상태 | 수집 규칙 |
|---|---|---|---|---|
| 버전 | 메타 | `version` | 확정 | JSON 스키마 버전을 나타낸다. |
| 갱신일 | 메타 | `updated_at` | 확정 | 수동 갱신 기준 날짜 문자열을 저장한다. |
| 운영 메모 목록 | `memo_raw` 후보 원천 | `notes` | 확정 | 배열 단위로 읽는다. |
| 강사명 | 매칭 키 | `notes[].name` | 확정 | 강사명 exact match 기준으로 기존 `instructors.name`과 연결한다. |
| 운영 메모 원문 | `memo_raw` 후보 | `notes[].memo` | 확정 | 수동 확정 메모 원문 문자열을 저장한다. |
| 소스 참조값 | `source_ref` | `notes[].source_ref` | 선택 | JSON 오브젝트로 저장한다. `03_data_model.md` 4-2절, 4-4절, 4-6절의 `source_ref` (JSONB) 구조와 동일한 형태를 따른다. 내부 필드 구성은 자유이되 원문 추적이 가능해야 한다. 없으면 필드 자체를 생략한다. |

- 파일 예시 (빈 초기 상태):

```json
{
  "version": 1,
  "updated_at": "2026-04-15",
  "notes": []
}
```

- `source_ref` 오브젝트 사용 예시 (선택):

```json
{
  "version": 1,
  "updated_at": "2026-04-15",
  "notes": [
    {
      "name": "홍길동",
      "memo": "임원 워크숍 경험 풍부, 사전 장비 체크 필요",
      "source_ref": {
        "origin": "ops_meeting_notes",
        "ref_id": "2026-Q2-ops-review",
        "captured_at": "2026-04-10"
      }
    }
  ]
}
```

- 로딩 시 `notes` 배열을 읽어 강사명 exact match 기준으로 기존 `instructors` 레코드와 연결한다.
- 매칭되지 않는 `name`은 현재 파일럿 범위에서 운영 검토 대상으로 남기고 새 강사를 생성하지 않는다.
- `memo` 원문은 5-8-1절 및 6절의 운영 메모 정규화/필터 규칙을 그대로 적용한 뒤 후보에 포함한다.
- 초기 상태 또는 데이터 부재 시 `notes: []` 빈 배열 파일로 시작한다.

## 6. 정규화 단계

소스별 원문 데이터는 마스터 병합 전에 아래 기준으로 정규화한다.

- 이름 앞뒤 공백 제거
- 이름 비교는 exact match 기준으로 유지
- alias 자동 치환은 하지 않음
- 날짜는 가능한 경우 `DATE` 또는 `TIMESTAMPTZ`로 변환
- 금액 문자열은 숫자 금액으로 정규화
- 계약시트 헤더는 canonical 컬럼 매칭 전에 `첫 개행 이전 문자열만 사용 + 연속 공백 축약 + trim` 규칙으로 정규화한다.
- multi_select 형태의 소속정보는 순서를 유지한 채 `, `로 join해 `affiliation`에 저장한다.
- multi_select 형태의 카테고리는 순서를 유지한 배열 그대로 `categories`에 저장한다.
- 대표 연락처는 `이메일 주소`, `연락처`만 구조화 필드로 저장하고, `이메일 주소 (2)`, `연락처2`는 Notion 원문 `메모` 블록에 라벨을 붙여 보존한다.
- 빈 문자열은 `NULL` 또는 빈 배열로 치환
- 기업명과 과정명 노이즈를 제거
- 배열형 필드는 중복 제거 후 저장
- 운영 메모 후보는 강사별로 중복 제거 후 합친다.
- 운영 메모 후보 중 10자 미만 노트는 제거한다.
- 운영 메모 후보 중 `사업자번호`, `사업자등록`, `상호명`, `법인계약`, `통장사본`, `모두싸인`, `URL`이 포함된 노트는 제거한다.
- 운영 메모 후보 중 `주요 고객사:`, `슬랙 하이라이트:`, `평균 만족도`로 시작하는 노트는 제거한다.
- 계약시트 `강의 일정` 날짜 추출의 최소 지원 포맷은 아래와 같다.
- `YYYY-MM-DD`, `YYYY.MM.DD`, `YYYY/MM/DD`
- `YYYY년 M월 D일`
- 위 패턴으로 파싱 가능한 날짜가 여러 개면 원문 등장 순서 기준 첫 날짜를 `start_date`, 마지막 날짜를 `end_date`로 사용한다.
- 위 패턴으로 파싱 가능한 날짜가 없으면 `start_date`, `end_date`는 `NULL`로 두고 `date_label` 원문만 보존한다.

### 6-1. 원본 저장용 / 검토용 / 서비스 반영용 구분

- `4-4` 만족도와 `4-5` Slack/Gmail activity는 공통으로 아래 3단계를 따른다.
  1. 원본 저장용: raw source를 `*_import_items`에 저장한다.
  2. 검토용: raw source를 강사별/시트별 review registry로 자동 취합한다.
  3. 서비스 반영용: `auto_accepted` 또는 `approved` 상태만 canonical 테이블과 집계 필드에 반영한다.
- review registry는 사람이 직접 patch하는 본체가 아니라, raw source에서 재생성 가능한 자동 취합 결과다.
- 사람이 개입해야 하는 경우에도 registry 자체를 수정하지 않고 `review_decisions`에만 결정(`approve`, `reject`, `override_instructor`)을 저장한다.
- `pending`, `rejected`, `invalid` 상태는 서비스용 canonical 반영 대상에서 제외한다.
- 이 구조의 목적은 demo의 검토 가능성을 유지하되, raw source를 다시 hardcoded JSON patch 본체로 되돌리지 않는 데 있다.

## 7. 마스터 레코드 매핑

### 7-1. 강사 기본 프로필 매핑
- `display_name`은 별도 source가 없으면 항상 `name`과 동일하게 채운다.
- `name`, `affiliation`, `categories`, `contact_email`, `contact_phone`는 5-2-1의 확정 Notion 프로퍼티 매핑 기준으로 채운다.
- `contact_email`은 `이메일 주소`만 사용한다. `이메일 주소 (2)`는 Notion 원문 `메모` 블록에 `보조 이메일:`로만 남긴다.
- `contact_phone`은 `연락처`만 사용한다. `연락처2`는 Notion 원문 `메모` 블록에 `보조 연락처:`로만 남긴다.
- `profile_summary`는 직접 Notion 프로퍼티가 없으므로, 다른 소스 또는 원문 기반 파생 규칙이 있을 때만 채우고 없으면 `NULL`로 둔다.
- `specialties`는 현재 Notion DB에서 수집하지 않는다.
- `memo_raw`는 `data/ops-notes-hardcoded.json`, 계약시트 `special_notes`, `incremental_merge.py`의 Gmail 운영 사실, 세일즈맵 딜 변동 문장을 합성해 채운다.
- 계약시트, 세일즈맵, 지메일, 슬랙은 보조 소스로만 사용한다.
- Slack/Gmail direct API는 `activity_import_items`에 raw source를 저장한 뒤 `activity_review_registries`로 자동 취합한다.
- `activity_review_registries`의 `auto_accepted` 또는 `approved` 상태만 `instructors.slack_activity_count`, `email_activity_count`, `ops_report_activity_count`, `dispatch_request_activity_count`, `last_activity_at`에 반영한다.
- Gmail/Slack activity source는 “API 호출 성공”과 “canonical 반영 성공”을 구분한다.
  - collector/normalizer/applier가 예외 없이 끝나도, instructor aggregate 반영이 0건이면 source status를 `partial`로 기록할 수 있다.
  - 예: Gmail thread 수집은 성공했지만 강사 매칭이 0건이어서 `email_activity_count`가 전혀 증가하지 않은 경우.
- `pending`, `rejected`, `invalid` activity registry는 서비스용 필드에 반영하지 않고 검토 대상으로만 남긴다.
- Slack/Gmail direct API v1은 `memo_raw`를 직접 갱신하지 않는다.

### 7-2. 출강 이력 매핑
- `teaching_histories`는 계약시트 기준으로 생성한다.
- `teaching_histories.deal_fee_hourly`는 해당 출강 건에서 확인된 시간당 단가를 저장한다.
- 계약시트에서는 `시간당 강사료` 문자열에서 쉼표, 공백, `원`을 제거해 정수로 파싱하고, `10000` 이하면 `NULL`로 둔다.
- 계약시트 단가 파싱값이 `10000000`을 초과하면 비정상 concat 값으로 간주해 `NULL`로 둔다. 예: `165,000/150,000`처럼 복수 단가가 구분자 제거 후 `165000150000`으로 합쳐진 경우.
- Gmail 수동 확인값과 초기 seed 하드코딩 값도 같은 의미의 시간당 단가로 `teaching_histories.deal_fee_hourly`에 넣을 수 있다.
- 세일즈맵은 기업명, 과정명, course_id 보강에만 사용한다.
- 세일즈맵은 `instructors`에 별도 `company_name`, `course_id` 필드를 만들지 않는다.
- 세일즈맵 보강은 기존 `teaching_histories` 행 중 `(instructor_db_id, course_id)`가 매칭되는 행에만 `company_name`, `course_name`을 채우는 방식으로 처리한다.

### 7-3. 단가 매핑
- 일반 강사의 기본 단가 `base_fee_hourly`는 `fee_fix_configs > 노션 기본 강사료 또는 fee_note > 세일즈맵 딜에서 확인된 금액 > 계약시트 시간당 강사료 (col T)` 우선순위로 결정한다.
- 전임강사의 기본 단가 `base_fee_hourly`는 위 우선순위를 따르지 않고, 노션 기본 강사료 또는 fee_note만 기준으로 사용한다.
- 특수 금액은 기본 단가에 반영하지 않는다.
- 단가 변동 이력은 노션 fee_note, 세일즈맵 확인 금액, 계약 데이터, 운영 보정값을 조합해 `fee_histories`로 저장한다.
- 단, `fee_histories` 모델이 실제 스키마에 반영되기 전까지는 세일즈맵 fee 후보를 DB에 적재하지 않고 pipeline summary 집계로만 남긴다.

### 7-4. 만족도 매핑
- 외부 만족도 source row는 먼저 `satisfaction_import_items`에 저장한다.
- `satisfaction_import_items`는 `satisfaction_review_registries`로 자동 취합한다.
- `satisfaction_review_registries`의 `auto_accepted` 또는 `approved` 상태만 `satisfaction_records`에 반영한다.
- 강사별 평균 및 건수는 `instructors.satisfaction_avg`, `instructors.satisfaction_count`에 반영한다.
- 결측 시 중앙값 대체 여부는 `instructors.satisfaction_is_imputed`에 저장한다.

### 7-5. 운영 인텔리전스 매핑
- 추천 대상, 지양 대상, 리스크, 운영 확인 필요 사항은 다중 소스를 허용한다.
- 구조화된 필드가 소스에 직접 존재하면 해당 값을 우선 매핑한다.
- 현재 확인된 Notion DB 실제 프로퍼티 목록에는 위 구조화 필드의 직접 대응 컬럼이 없지만, 노션 원문 텍스트가 충분한 근거를 제공하면 후속 구조화 단계의 입력 소스로 사용할 수 있다.
- 구조화된 필드가 없고 원문 메모나 대화 기록만 있는 경우, LLM을 이용해 구조화 후보를 생성할 수 있다.
- LLM은 원문 근거 기반 정리만 수행하며, 근거 없는 추측이나 새로운 사실 생성은 허용하지 않는다.
- 근거가 부족하면 해당 필드는 `NULL` 또는 빈 배열로 둔다.
- 최종 구조화 결과는 `instructor_intelligence`에 저장한다.
- LLM 구조화 결과는 `generated_by`, `generation_model`, `prompt_version`, `evidence_hash`, `generated_at` 메타와 함께 저장한다.

## 8. 동일인 판정 및 병합 절차

### 8-1. 병합 순서
1. `instructor_id` 기준 매칭
2. exact match 강사명 기준 후보 매칭
3. 연락처, `course_id`, 소속을 이용한 보조 검증
4. 병합 가능 시 동일 강사로 통합
5. 병합 불가 시 별도 강사로 생성

### 8-2. 병합 규칙
- alias 매핑은 사용하지 않는다.
- 이름이 다르면 다른 강사로 간주한다.
- 이름이 같더라도 연락처가 다르면 자동 병합하지 않는다.
- 이름이 같고 연락처가 없으면 운영 검토 대상으로 남길 수 있다.
- 동명이인은 suffix를 포함한 이름 그대로 서로 다른 강사로 유지한다.

### 8-3. Notion 단일 소스 파일럿 upsert 규칙
- Notion 단일 소스 파일럿의 `instructors` upsert는 `name` exact match 기준으로 수행한다.
- 기존 row가 있으면 `update`, 없으면 `create`한다.
- 이번 파일럿에서 Notion 소유 필드는 `display_name`, `affiliation`, `categories`, `specialties`, `profile_summary`, `contact_email`, `contact_phone`, `base_fee_hourly`, `fee_note`다.
- 위 Notion 소유 필드는 snapshot 방식으로 갱신하며, Notion 원문이 빈값이면 기존 값을 유지하지 않고 `NULL` 또는 빈 배열로 반영한다.
- Notion 비소유 필드 `is_fulltime`, `is_practice_coach`, `flag`, `satisfaction_*`, `total_courses`, `recent_courses_6mo`, `last_activity_at`, `score`, `score_breakdown`, `rank`, `score_policy_version`, `score_calculated_at`, `memo_raw`는 update 대상에서 제외하고 DB의 기존 값을 보존한다.
- 보조 연락처 라벨 보존이 필요하면 기존 `memo_raw`를 삭제하지 않는 비파괴 방식으로만 추가할 수 있다.

## 9. 소스 우선순위 및 충돌 처리

- 기본 우선순위는 `계약시트 > 노션 > 세일즈맵 > 지메일/슬랙`이다.
- 다만 강사 기본 프로필은 노션 우선 정책을 적용한다.
- 출강 이력은 계약시트 우선이다.
- 추천/지양/리스크/운영 확인 필요 사항은 복수 소스를 허용하되, 충돌 시 운영 기준 소스를 우선한다.
- 점수 계산용 활동량은 각 소스의 집계 결과를 별도로 유지한 뒤 계산 단계에서 합산 또는 비교한다.

## 10. 전임강사 반영 절차

- 전임강사 여부는 별도 JSON 리스트로 판정한다.
- 전임강사 리스트에 포함된 강사는 `is_fulltime = TRUE`로 저장한다.
- 전임강사 여부는 강사 병합 이후, fee 계산 이전 단계에서 반영한다.
- 전임강사 fee는 일반 강사 fee 우선순위를 따르지 않고, 노션 기본 강사료 또는 fee_note 기준으로만 내부 데이터에 반영한다.
- 노션에 시간당 강사료가 명확히 있으면 해당 값을 `base_fee_hourly`에 반영한다.
- 전임강사 fee의 화면 노출 정책은 `01_core_policy.md` 7절을 따른다.
- 현재 기준으로 화면에서는 `전임강사` 상태를 표시하고 fee 자체는 노출하지 않는다.

## 11. 실습코치 판정 절차

- 실습코치 판정은 기존 기준을 유지한다.
- 실습코치 판정의 Source of Truth는 `01_core_policy.md` 10절의 3-Layer 기준이다.
- L1에서 계약시트의 계약 유형, 상세 유형, 특이사항을 사용해 실습코치 후보를 산출한다.
- L2에서 `base_fee_hourly >= 100000` 이고 `categories`와 `specialties`가 모두 비어 있지 않은 강사는 정규강사 보호 규칙으로 후보에서 제외한다.
- L3에서 전임강사 리스트에 포함된 강사는 무조건 후보에서 제외한다.
- 실습코치로 판정된 강사는 `is_practice_coach = TRUE`로 저장한다.

## 12. fee 및 단가 이력 처리 절차

### 12-1. 일반 강사 기본 단가 결정
- 일반 강사의 기본 단가 결정 우선순위는 아래와 같다.
1. `fee_fix_configs` 수동 보정값
2. 노션 기본 강사료 또는 `fee_note`
3. 세일즈맵 딜에서 확인된 금액
4. 계약시트 시간당 강사료 (col T)
- 상위 우선순위 소스에 명확한 시간당 강사료가 없을 때만 다음 소스를 확인한다.
- 특수 금액은 기본 단가에 반영하지 않는다.
- 명확한 시간당 강사료가 없는 경우 `base_fee_hourly`는 `NULL`로 둘 수 있다.
- `250000`, `250,000`, `250000원`, `25만원`, `25만 원`처럼 단일 시간당 금액으로 해석 가능한 표현은 기본 단가 후보로 인정한다.
- `기본 25만`, `기본: 250,000원`, `기본 25만, 출장비 별도`처럼 `기본` 라벨과 함께 단일 시간당 금액이 제시된 경우, 해당 기본값을 `base_fee_hourly` 후보로 인정한다.
- `기본 25만 / 심화 35만`처럼 복수 단가가 함께 있어도 `기본` 라벨에 연결된 값이 단일 시간당 금액이면 그 값만 기본 단가 후보로 인정하고, 나머지 표현은 설명용 이력으로 분리한다.
- 특수 금액 후보 판정은 `01_core_policy.md` 8절의 canonical 기준을 따른다.
- 수집값에 `콘텐츠`, `제작`, `개발비`, `출장비`, `별도`, `건당`, `프로젝트`, `패키지`, `특강`, `자료개발`, `원고`, `감수`가 포함되면 특수 금액 후보로 분류한다.
- `기본 25~30만`, `기본 협의`처럼 범위값 또는 비정형 설명만 있는 경우는 기본 단가로 인정하지 않는다.
- `300만원/건`처럼 시간당 단가로 읽히지 않는 표현은 특수 금액으로 분류한다.
- `기본 300만원/건`, `기본 패키지 700만원`, `기본 25만 + 자료개발비 별도 100만`처럼 총액, 패키지, 개발비가 섞인 표현은 기본 단가로 확정하지 않는다.
- `기본 25만 / 심화 35만 / 특강 55만`처럼 복수 단가가 한 줄에 함께 있는 경우에도 `기본` 라벨의 시간당 값만 기본 단가 후보로 사용하고, 심화/특강 값은 특수 금액 또는 설명용 이력으로 분리한다.
- 동일 강사의 일반 출강료 분포 대비 3배 이상 큰 금액은 기본 단가 후보에서 제외하고 `is_special_amount = TRUE`로 저장한다.

### 12-2. 전임강사 기본 단가 결정
- 전임강사는 일반 강사 우선순위를 따르지 않는다.
- 전임강사의 기본 단가는 노션 기본 강사료 또는 `fee_note`만 기준으로 사용한다.
- 세일즈맵 확인 금액과 계약시트 시간당 강사료 (col T)는 전임강사 기본 단가 결정의 기준값으로 사용하지 않는다.
- 노션에 명확한 시간당 강사료가 없는 경우 `base_fee_hourly`는 내부 데이터로만 관리하거나 `NULL`로 둘 수 있다.

### 12-3. 수동 보정 처리
- 수동 fee 보정값은 `fee_fix_configs`를 Source of Truth로 사용한다.
- 보정 결과는 `fee_histories`에 `manual_fix` 성격으로 반영할 수 있다.
- 보정값이 있어도 원본 출처와 이유는 함께 기록한다.

### 12-4. 특수 금액 처리
- 콘텐츠 제작비, 건당 금액, 출장비 포함 금액, 개발비 등은 `is_special_amount = TRUE`로 구분한다.
- 특수 금액은 화면에서 단가 이력으로 참고 표시는 가능하지만 기본 단가 계산에는 사용하지 않는다.
- `teaching_histories` 기반 fee history 생성 시 `deal_fee_hourly`의 `is_special_amount` 판정은 다음 기준만 적용한다.
  - 동일 강사 일반 출강료 분포 대비 3배 이상 이상치 (`docs/01` §8).
- `teaching_histories.fee_extra`, `special_notes`의 키워드는 별도 special evidence로 기록하되, 동일 row의 `deal_fee_hourly`를 자동으로 `is_special_amount = TRUE`로 전환하지 않는다.
- Notion `fee_note` 기반 fee history 생성 경로는 별도. `fee_note` 자체가 금액을 직접 기술하므로 키워드 판정을 적용한다.

## 13. 만족도 처리 절차

### 13-1. 수집 및 적재
- Google Forms, Gmail 만족도 공유, 시트 요약 source에서 수집한 만족도는 먼저 `satisfaction_import_items`에 저장한다.
- `satisfaction_import_items`는 source별 raw 근거 보존용이며, 사람이 직접 수정하지 않는다.
- raw source는 `satisfaction_review_registries`로 자동 취합한다.
- `satisfaction_review_registries`의 `auto_accepted`, `approved` 상태만 `satisfaction_records`에 저장한다.
- 앱에서 작성된 만족도도 동일한 구조로 저장한다.

### 13-2. 집계
- 강사별 평균값은 `instructors.satisfaction_avg`에 반영한다.
- 건수는 `instructors.satisfaction_count`에 반영한다.
- `pending`, `rejected`, `invalid` 만족도 registry는 집계에서 제외한다.
- 앱에서 만족도 작성이 성공하면 해당 강사의 만족도 집계값은 같은 요청 흐름 안에서 즉시 재계산한다.

### 13-3. 결측치 처리
- 만족도 기록이 없는 경우 전체 수집 강사의 중앙값으로 대체한다.
- 대체 여부는 `instructors.satisfaction_is_imputed = TRUE`로 기록한다.

## 14. 운영 인텔리전스 처리 절차

- 소스에 구조화된 추천/지양/리스크/운영 확인 필드가 있으면 우선 사용한다.
- 소스에 구조화 필드가 없고 원문 근거만 있는 경우, 원문 텍스트를 수집한 뒤 LLM 기반 구조화를 수행할 수 있다.
- LLM 구조화 결과는 반드시 원문 근거와 함께 검토 가능해야 하며, 근거 없는 사실 추가는 허용하지 않는다.
- 근거가 부족하거나 모호한 경우 해당 필드는 비워 둔다.
- 추천 대상, 지양 대상, 리스크, 운영 확인 필요 사항은 수집 소스별 원문을 먼저 보관한다.
- 구조화 가능한 값은 `instructor_intelligence`에 정제해서 저장한다.
- 운영 인텔리전스는 파이프라인 단계에서 생성하고 DB에 저장한다.
- API와 화면은 저장된 `instructor_intelligence`만 조회하며, 요청 시점에 LLM을 다시 호출하지 않는다.

## 15. 점수 계산 절차

### 15-1. 계산 입력값
- 총 출강 횟수
- 만족도 평균 또는 중앙값 대체값
- 슬랙 활동량 (`instructors.slack_activity_count`)
- 최근 활동일
- 세일즈맵 딜 활동량
- 이메일 활동량 (`instructors.email_activity_count`)
- 운영 채널 활동량 (`instructors.ops_report_activity_count`)
- `dispatch_request_activity_count`는 저장은 하되, 점수의 direct input으로는 사용하지 않는다. 일부 강사 전용 출강요청 채널은 일반 강사 비교 점수의 공통 기준이 아니기 때문이다.

### 15-2. 계산 순서
1. 강사별 활동 집계 생성
2. 전체 강사 기준 최대값 계산
3. 항목별 정규화
4. 가중치 적용
5. 실습코치 0점 처리
6. 총점 계산
7. 항목별 점수 구조 생성

### 15-3. 저장 방식
- 총점은 `instructors.score`
- 구성 요소는 `instructors.score_breakdown`
- 적용 버전은 `instructors.score_policy_version`
- 계산 시각은 `instructors.score_calculated_at`
- 순위는 `instructors.rank`
- 만족도 작성으로 만족도 집계가 바뀐 경우, 외부 소스를 재조회하지 않고 DB에 저장된 현재 canonical 값을 입력으로 사용해 전체 강사의 `score`, `score_breakdown`, `score_calculated_at`, `rank`를 같은 요청 흐름 안에서 즉시 재계산한다.
- 위 전체 재계산에서 만족도 컴포넌트는 최신 만족도 집계를 기준으로 다시 계산하고, 나머지 비만족도 컴포넌트는 현재 저장된 canonical 값 또는 저장된 구성 요소를 재사용한다.

## 16. 검증 및 자동 수정 절차

### 16-1. 검증 대상
- 강사료 음수 여부
- 만족도 범위
- 출강 횟수 음수 여부
- 연락처 형식
- 비정상 단가 이력
- `base_fee_hourly`와 `teaching_histories.deal_fee_hourly` 최빈값 정합성
- 기업명/과정명 문자열 정제

### 16-2. `rule_code` 매핑 원칙
- 파이프라인이 검증 결과를 `validation_issues`에 기록할 때는 `rule_code`를 필수로 채운다.
- canonical `rule_code` 목록과 판정 기준은 `06_implementation_spec.md` 5-8절을 따른다.
- 파이프라인은 구현 명세에 정의된 동일한 `rule_code`를 사용해야 하며, ad-hoc 코드를 임의로 추가하지 않는다.

### 16-3. 처리 방식
- 자동 수정 가능한 항목은 정제 후 반영한다.
- `teaching_histories.deal_fee_hourly`는 숫자 정규화 후 `10000` 이하 값을 `NULL` 처리한다.
- 계약시트 `시간당 강사료` 파싱값이 `10000000`을 초과하면 비정상 concat 또는 총액성 노이즈로 보고 `NULL` 처리한다.
- 검증 이슈 기록 시 `severity`, `message`, `before_value`, `after_value`, `auto_fixed`를 함께 남긴다.
- 경고 수준 이슈는 `validation_issues`에 남긴다.
- 자동 수정이 불가능한 항목은 운영 검토 대상으로 남긴다.

## 17. 저장 단계

- 최종 마스터 레코드는 Railway DB에 저장한다.
- 저장 대상 테이블은 최소 아래를 포함한다.
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

## 18. refresh 동작

- 새로고침은 각 소스에 데이터 업데이트가 있는지 다시 조회한다.
- 변경된 데이터가 있으면 수집, 병합, 검증, 저장 단계를 다시 실행한다.
- 변경된 데이터가 없으면 기존 데이터를 유지한다.
- refresh 실행 단위는 `pipeline_runs`와 `source_sync_logs`에 기록한다.

### 18-1. 증분 병합 구현 원칙

기존 demo용 `incremental_merge.py`, `incremental_merge_0413.py` 리뷰 결과를 기준으로, 실제 구현은 아래 원칙을 따른다.

- 채택할 점:
- 강사명 기준 index map을 미리 만들어 반복 조회 비용을 줄인다.
- 변경된 강사 집합을 별도로 추적하고, 점수 재계산과 후처리는 영향받은 강사 중심으로 수행한다.
- Gmail, 세일즈맵, 슬랙처럼 소스별 증분 payload는 분리된 입력 단위로 관리한다.
- 중복 판정 없이 무조건 append하지 않고, 증분 이력 추가 전 기존 데이터와 비교한다.
- raw source와 review registry는 분리한다. 증분 실행 시 raw/import 테이블은 source-specific key 기준 upsert 또는 append하고, review registry는 raw source + `review_decisions`를 바탕으로 다시 계산 가능해야 한다.

- 반드시 보완할 점:
- 증분 병합은 canonical 스키마 경로만 사용한다. 운영 메모는 ad-hoc `operational_notes`가 아니라 문서에 정의된 `memo_raw` 생성 규칙 또는 `tacit_knowledge.operational_notes` 같은 canonical 경로로만 반영한다.
- 동일한 의미의 집계 필드는 스크립트마다 다른 이름을 쓰지 않는다. 예를 들어 Gmail 활동량, 운영 메모, 최근 활동일, 점수 입력값은 단일 canonical 필드명만 허용한다.
- `teaching_histories` 또는 동등한 출강 이력을 추가하면 `total_courses`, `recent_courses_6mo`, `last_activity_at` 같은 파생 집계값도 같은 실행 안에서 함께 갱신한다.
- 출강 이력 중복 판정은 `company + dates`처럼 약한 키만 사용하지 않는다. 최소 `company + course + dates + source_type` 또는 source-specific 식별자를 함께 사용한다.
- 운영 메모 후보는 저장 전에 중복 제거와 민감정보 필터를 반드시 적용한다. 필터 규칙은 5-8-1과 6절의 운영 메모 정규화 규칙을 따른다.
- 최근성 계산은 임의의 최근 5건 slice 같은 비결정적 규칙에 의존하지 않고, 검증 가능한 전체 활동 이력 또는 canonical `last_activity_at` 집계값을 사용한다.
- 증분 병합 로직은 날짜, 파일 경로, 출력 필드명을 하드코딩한 스크립트 복제로 늘리지 않는다. 하나의 canonical 구현에서 입력 payload만 교체 가능해야 한다.
- review registry는 사람이 직접 수정하는 patch 저장소가 아니다. 사람이 판단한 내용은 `review_decisions`에만 저장하고, registry는 raw source와 decision 적용 결과로 재생성 가능해야 한다.
- refresh 결과는 파일 overwrite만으로 끝내지 않고 `pipeline_runs`, `source_sync_logs`, 필요 시 `validation_issues`에 함께 기록한다.
- `source_sync_logs.status`는 `success`/`partial`/`failed`를 사용할 수 있다.
  - `success`: source가 기술적으로 끝났고 partial 조건이 없다.
  - `partial`: source 호출은 끝났지만 일부 target/channel 실패, 또는 raw 수집 후 canonical 반영 0건 같은 데이터 품질 경고가 남아 있다.
  - `failed`: source runner 자체가 실패했다.

## 19. 실패 처리

### 19-1. 소스별 실패
- 일부 소스만 실패해도 다른 소스 수집과 병합은 계속 진행한다.
- 소스별 실패는 `source_sync_logs`에 별도로 기록한다.
- 전체 실행 상태는 `success`, `partial`, `failed` 중 하나로 기록한다.

### 19-2. 병합 또는 저장 실패
- 병합 실패는 해당 강사 또는 해당 엔티티 단위의 검토 이슈로 남긴다.
- 저장 실패 시 현재 실행을 `failed`로 기록하고 마지막 정상 데이터를 유지한다.

## 20. fallback 처리

- 최신 데이터 조회 또는 파이프라인 실행에 실패하면 마지막 정상 저장 데이터를 사용한다.
- 마지막 정상 저장 데이터도 없으면 정적 baseline 데이터를 사용한다.
- fallback 상태는 API 응답과 UI에서 구분 가능해야 한다.
- fallback 사용 여부는 사용자에게 명시적으로 안내한다.

## 21. 초기 적재 및 운영 주기

### 21-1. 초기 적재
- 최초 실행 시 모든 소스를 기준으로 풀 수집을 수행한다.
- Notion 파이프라인 파일럿처럼 실데이터 적재를 수행하는 실행에서는 기존 mock seed 데이터와 merge하지 않는다.
- `prisma/seed.ts`로 적재한 샘플 강사 5건이 남아 있으면 파일럿 적재 전에 비우고, 실데이터만 기준으로 다시 적재한다.
- Notion 파이프라인 파일럿도 `pipeline_runs` 1건과 소스별 `source_sync_logs`를 실제로 기록한다.
- 파일럿에서 단일 소스만 수집하더라도 실행 상태, 수집 건수, 반영 건수, 실패 메시지는 로그 테이블에 남겨 디버깅 기준으로 사용한다.
- 풀 수집 결과를 Railway DB에 적재하고 이를 첫 마스터 데이터로 사용한다.

### 21-2. 운영 중 실행
- 수동 새로고침을 지원한다.
- 향후 배치 실행이 추가되더라도 동일한 파이프라인 구조를 사용한다.
- 전체 orchestration 실행은 `POST /api/refresh`가 담당한다.
- 소스별 실행은 운영/관리용 내부 API로 분리한다.
- 예: Notion 단일 소스 실행은 `POST /api/pipeline/notion`
- 위 운영/관리용 파이프라인 API는 사용자용 API 스펙 `05_api_spec.md`와 분리해 관리한다.

## 22. 파이프라인 산출물

파이프라인의 최종 산출물은 아래 두 가지다.

- Railway DB에 저장된 최신 마스터 데이터
- fallback용 마지막 정상 데이터 및 정적 baseline

프론트엔드와 API는 이 산출물을 기준으로 동작한다.
