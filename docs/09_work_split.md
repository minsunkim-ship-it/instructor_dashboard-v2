# Work Split

## Role
이 문서는 병렬 구현을 위해 작업 단위를 어떻게 나눌지 정의한다.
각 작업의 책임 범위, 선행 의존성, 참조 문서, 완료 기준을 명확히 해 구현 충돌을 줄이는 것을 목표로 한다.

## Source of Truth
- 병렬 작업 단위
- 작업별 책임 범위
- 작업별 선행 의존성
- 작업별 참조 문서
- 작업별 완료 기준

## Depends On
- `00_docs_index.md`
- `01_core_policy.md`
- `02_system_architecture.md`
- `03_data_model.md`
- `04_data_pipeline.md`
- `05_api_spec.md`
- `06_implementation_spec.md`
- `07_build_guide.md`

## Used By
- Claude Code
- Codex
- 병렬 구현 참여자 전원

## Out of Scope
- 개별 코드 구현 방식
- 인력 배정 상세
- 일정 관리 상세

## 1. 작업 분할 원칙

- 한 작업은 하나의 주요 책임을 가진다.
- 서로 다른 작업이 동일한 Source of Truth를 임의로 수정하지 않는다.
- 공통 필드 구조, API 계약, 상태 정의는 반드시 문서 기준으로 공유한다.
- 작업 단위는 가능한 한 독립적으로 테스트 가능해야 한다.
- 문서에 없는 정책은 구현 중 새로 만들지 않는다.

## 2. 병렬 구현 전 선행 조건

아래 조건이 충족된 뒤 병렬 구현을 시작한다.

- `01_core_policy.md` 확정
- `03_data_model.md` 확정
- `04_data_pipeline.md` 확정
- `05_api_spec.md` 확정
- `06_implementation_spec.md` 확정

## 3. 권장 작업 트랙

병렬 구현은 아래 5개 트랙으로 나누는 것을 권장한다.

- Track A. 데이터 저장소 및 스키마
- Track B. 데이터 파이프라인
- Track C. API
- Track D. 프론트엔드 화면
- Track E. 상태/운영 기능 및 통합 검증

## 4. Track A. 데이터 저장소 및 스키마

### 4-1. 책임 범위
- Railway PostgreSQL 스키마 설계 및 생성
- Prisma schema 설계 및 관리
- Prisma migration 생성 및 적용
- 엔티티 테이블 생성
- 설정 테이블 생성
- 인덱스 및 기본 제약조건 설정

### 4-2. 참조 문서
- `01_core_policy.md`
- `03_data_model.md`
- `02_system_architecture.md`

### 4-3. 핵심 구현 대상
- `instructors`
- `teaching_histories`
- `fee_histories`
- `satisfaction_records`
- `instructor_intelligence`
- `source_links`
- `validation_issues`
- `pipeline_runs`
- `source_sync_logs`
- `fulltime_instructor_configs`
- `fee_fix_configs`
- `practice_coach_rules`
- `score_policy_versions`

### 4-4. 완료 기준
- 데이터 모델 명세서에 있는 주요 테이블과 필드가 구현돼 있다.
- 전임강사 JSON, fee_fix_configs, score_breakdown 저장 구조가 반영돼 있다.
- API와 파이프라인이 바로 사용할 수 있는 기본 스키마가 준비돼 있다.
- Prisma schema와 실제 DB 스키마가 일치한다.

## 5. Track B. 데이터 파이프라인

### 5-1. 책임 범위
- 외부 소스 수집기 구현
- 정규화 로직 구현
- 동일인 판정 및 병합 로직 구현
- 전임강사/실습코치 판정 구현
- fee 처리, 만족도 집계, 운영 인텔리전스 정리, 점수 계산, 검증 및 자동 수정 구현

### 5-2. 참조 문서
- `01_core_policy.md`
- `03_data_model.md`
- `04_data_pipeline.md`

### 5-3. 핵심 구현 대상
- 계약시트 수집
- 노션 수집
- 세일즈맵 수집
- 슬랙 수집
- 지메일 수집
- Google Forms 수집
- 전임강사 JSON 로딩
- fallback용 마지막 정상 데이터 관리

### 5-4. 완료 기준
- 최신 데이터 수집과 병합이 문서 정의대로 동작한다.
- 일반 강사 fee 우선순위와 특수 금액 분리 기준이 반영된다.
- 전임강사와 실습코치 판정이 정책 문서와 일치한다.
- 점수, score_breakdown, satisfaction_is_imputed가 계산된다.
- 검증 규칙 결과가 `validation_issues`에 기록된다.

## 6. Track C. API

### 6-1. 책임 범위
- 목록 API
- 상세 API
- 만족도 작성 API
- 상태 조회 API
- 새로고침 API
- fallback 응답 처리

### 6-2. 참조 문서
- `01_core_policy.md`
- `03_data_model.md`
- `04_data_pipeline.md`
- `05_api_spec.md`

### 6-3. 핵심 구현 대상
- `GET /api/instructors`
- `GET /api/instructors/{id}`
- `POST /api/instructors/{id}/satisfaction`
- `GET /api/status`
- `POST /api/refresh`

### 6-4. 완료 기준
- 응답 구조가 API 명세서와 일치한다.
- `meta.is_fallback`, `meta.data_mode`, `last_updated_at`이 올바르게 반환된다.
- 만족도 작성 성공 시 집계값과 score 재계산 흐름이 연결된다.
- 인증 및 도메인 제한이 적용된다.

## 7. Track D. 프론트엔드 화면

### 7-1. 책임 범위
- 목록 화면 구현
- 검색/필터/정렬 UI 구현
- 상세 패널 구현
- 점수, 만족도, 운영 인텔리전스, 강의 이력, 단가 이력, 운영 메모 UI 구현
- 만족도 작성 UI 구현
- fallback/상태 표시 UI 구현

### 7-2. 참조 문서
- `01_core_policy.md`
- `05_api_spec.md`
- `06_implementation_spec.md`
- `07_build_guide.md`

### 7-3. 핵심 구현 대상
- 좌측 목록 + 우측 상세 패널 레이아웃
- URL params 기반 검색/필터/정렬 상태
- `useState` 기반 상세 선택 및 임시 UI 상태
- 점수 구성 요소 표시
- 만족도 표시 및 만족도 작성 입력 UI
- 전임강사 배지 표시
- 특수 금액 라벨 표시

### 7-4. 완료 기준
- 목록과 상세가 API 응답 기준으로 정상 렌더링된다.
- 검색, 필터, 정렬 상태가 URL params에 반영된다.
- fallback, partial, empty, error 상태가 사용자에게 구분되어 보인다.
- 전임강사, score, 운영 인텔리전스, 이력 표시가 문서와 일치한다.

## 8. Track E. 상태/운영 기능 및 통합 검증

### 8-1. 책임 범위
- 새로고침 상태 관리
- 소스 상태 표시
- 만족도 저장 후 재조회 흐름
- end-to-end 상태 검증
- fallback 전환 검증

### 8-2. 참조 문서
- `01_core_policy.md`
- `04_data_pipeline.md`
- `05_api_spec.md`
- `06_implementation_spec.md`

### 8-3. 핵심 구현 대상
- refresh 버튼 로딩/성공/실패 처리
- fallback 배너 처리
- 소스 상태 표시
- 상세 partial 상태 표시
- 만족도 작성 후 score 재반영 확인

### 8-4. 완료 기준
- refresh 및 fallback 동작이 문서 정의와 일치한다.
- 만족도 작성 후 상세가 최신 값으로 갱신된다.
- 일부 소스 실패 시 partial 또는 fallback 상태가 올바르게 노출된다.

## 9. 선행 의존성

### 9-1. Track A 선행 조건
- 없음

### 9-2. Track B 선행 조건
- Track A 기본 스키마 준비

### 9-3. Track C 선행 조건
- Track A 기본 스키마 준비
- Track B 최소한의 마스터 데이터 적재 가능 상태

### 9-4. Track D 선행 조건
- Track C 목록/상세 API 정의 완료

### 9-5. Track E 선행 조건
- Track C, Track D의 기본 플로우 구현 완료

## 10. 병렬 작업 시 파일 책임 경계

- DB/마이그레이션 파일: Track A 책임
- 수집/병합/점수 계산/검증 로직: Track B 책임
- API route 및 핸들러: Track C 책임
- 페이지, 컴포넌트, 화면 상태: Track D 책임
- 통합 상태 처리, 새로고침 플로우, 검증 자동화: Track E 책임

## 11. 머지 순서 권장안

1. Track A
2. Track B
3. Track C
4. Track D
5. Track E

이 순서를 기본으로 하되, Track C와 Track D는 문서 계약이 확정돼 있으면 일부 병렬 진행이 가능하다.

## 12. 문서 충돌 시 처리

- 정책 충돌: `01_core_policy.md`
- 데이터 구조 충돌: `03_data_model.md`
- 병합/검증/점수 충돌: `04_data_pipeline.md`
- API 충돌: `05_api_spec.md`
- 화면 동작 충돌: `06_implementation_spec.md`
- 작업 경계 충돌: `09_work_split.md`

## 13. 병렬 구현 가드레일 (파일럿 검증 기반)

아래 규칙은 2026-04-14 파일럿 검증 결과를 기반으로 확정되었다. (`08_decision_log.md` 참조)

### 13-1. Track A 선행 완료 기준

- `prisma/schema.prisma`에 `03_data_model.md`의 전체 엔티티가 반영되어 있어야 한다.
- Railway PostgreSQL에 스키마가 적용되어 있어야 한다.
- Prisma 클라이언트 생성(`prisma generate`)이 성공해야 한다.
- Track A가 위 기준을 충족한 이후에만 Track B, C, D가 시작할 수 있다.

### 13-2. 공유 파일 관리 규칙

- `src/types/api.ts`는 프론트엔드와 백엔드의 타입 계약 파일이다.
  - 각 트랙은 자기 담당 엔드포인트의 타입만 추가한다.
  - 기존에 정의된 타입(`ApiMeta`, `ApiError`, `ApiResponse`)을 수정하지 않는다.
  - 새 타입을 추가할 때는 `05_api_spec.md`에 정의된 필드만 사용한다.
- `prisma/schema.prisma`는 Track A 완료 후 고정한다.
  - Track B, C, D에서 스키마 변경이 필요한 경우 Track A 담당자에게 요청한다.
  - 여러 트랙이 독립적으로 스키마를 수정하지 않는다.
- `src/app/page.tsx`는 레이아웃 통합 지점이다.
  - Track D에서 컴포넌트 단위로 개발하고, 페이지 통합은 마지막에 수행한다.
  - 각 컴포넌트는 `src/components/` 아래에 독립 파일로 개발한다.

### 13-3. 트랙 간 동시 진행 조건

- Track B(파이프라인), Track C(API), Track D(프론트엔드)는 Track A 완료 후 동시 진행이 가능하다.
  - Track B는 `prisma/schema.prisma` 기준으로 수집/병합 로직을 구현한다.
  - Track C는 `05_api_spec.md` 기준으로 API 라우트를 구현한다.
  - Track D는 `05_api_spec.md` 응답 구조와 `06_implementation_spec.md` 기준으로 UI를 구현한다.
- Track D는 Track C의 API가 완성되지 않아도 `05_api_spec.md`의 응답 스키마 기준으로 선행 개발이 가능하다.
  - 파일럿에서 타입 계약(`src/types/api.ts`)만으로 UI 개발이 가능함을 확인했다.
- Track E(통합 검증)는 Track C와 Track D의 기본 플로우가 구현된 이후에 시작한다.

### 13-4. 충돌 방지 원칙

- 같은 파일을 두 개 이상의 트랙에서 동시에 수정하지 않는다.
- 트랙 간 공유가 필요한 정의(타입, 상수, 유틸)는 문서에 이미 정의된 값만 사용한다.
- 문서에 없는 새로운 공유 정의가 필요하면 `08_decision_log.md`에 기록하고 관련 문서를 먼저 수정한다.

## 14. 완료 판정

- 각 트랙의 결과물이 해당 Source of Truth 문서와 일치해야 한다.
- 트랙별 완료 기준이 충족되어야 다음 통합 단계로 넘어간다.
- 문서에 없는 임의 정책이 들어간 경우 완료로 보지 않는다.
