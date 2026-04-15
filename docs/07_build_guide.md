# Build Guide

## Role
이 문서는 Claude Code 또는 Codex가 이 프로젝트를 구현할 때 어떤 문서를 어떤 순서로 읽고, 어떤 기준으로 작업을 나누고, 충돌 시 무엇을 우선해야 하는지 안내한다.

## Source of Truth
- 구현 시작 전 체크리스트
- 문서 읽는 순서
- 작업 유형별 참조 문서
- 병렬 구현 원칙
- 문서 충돌 시 우선순위

## Depends On
- `00_docs_index.md`
- `01_core_policy.md`
- `03_data_model.md`
- `04_data_pipeline.md`
- `05_api_spec.md`
- `06_implementation_spec.md`

## Used By
- 구현 작업 전반

## Out of Scope
- 제품 정책 정의
- DB 스키마 정의
- API 스키마 정의
- 화면 기능 정의

## 1. 이 문서의 사용 대상

- Claude Code
- Codex
- 병렬 구현을 수행하는 개발자

이 문서는 이미 작성된 문서를 다시 해석하지 않고, 기존 문서를 적극 참고하면서 구현을 진행하기 위한 안내서다.

## 2. 구현 시작 전 원칙

- 먼저 기존 문서를 읽고, 이미 정의된 정책과 계약을 그대로 사용한다.
- 문서에 이미 정의된 규칙을 구현 단계에서 다시 추론하지 않는다.
- 새 가정을 만들기 전에 관련 문서에 이미 정의가 있는지 먼저 확인한다.
- 문서 간 충돌이 있으면 우선순위 규칙에 따라 해결한다.
- DB 스키마와 마이그레이션은 Prisma 기준으로 구현한다.

## 3. 구현 시작 전 체크리스트

아래 항목이 확인되지 않으면 구현을 시작하지 않는다.

- 병합 기준이 `01_core_policy.md`에 정의되어 있는지 확인
- 데이터 구조가 `03_data_model.md`에 정의되어 있는지 확인
- 수집/병합/검증 흐름이 `04_data_pipeline.md`에 정의되어 있는지 확인
- API 요청/응답 형식이 `05_api_spec.md`에 정의되어 있는지 확인
- 화면 동작과 상태가 `06_implementation_spec.md`에 정의되어 있는지 확인
- 구현 대상 기능이 기존 문서 범위 안에 있는지 확인

## 4. 문서 읽는 순서

구현자는 항상 아래 순서로 문서를 읽는다.

1. `00_docs_index.md`
2. `01_core_policy.md`
3. `03_data_model.md`
4. `04_data_pipeline.md`
5. `05_api_spec.md`
6. `06_implementation_spec.md`
7. 필요 시 `02_system_architecture.md`
8. 변경 이력이 필요한 경우 `08_decision_log.md`

## 5. 작업 유형별 참조 순서

### 5-1. 데이터 수집/병합 작업
1. `01_core_policy.md`
2. `03_data_model.md`
3. `04_data_pipeline.md`
4. `05_api_spec.md`

데이터 레이어 구현 기본 원칙:
- DB 모델은 Prisma schema로 정의한다.
- 마이그레이션은 Prisma Migrate를 사용한다.
- API와 파이프라인에서 DB 접근은 Prisma Client를 기준으로 구현한다.

### 5-2. API 구현 작업
1. `01_core_policy.md`
2. `03_data_model.md`
3. `04_data_pipeline.md`
4. `05_api_spec.md`
5. `06_implementation_spec.md`

### 5-3. 프론트엔드 목록/상세 화면 작업
1. `01_core_policy.md`
2. `05_api_spec.md`
3. `06_implementation_spec.md`
4. `03_data_model.md` 필요 시 참조

프론트엔드 구현 기본 원칙:
- 프론트엔드는 Next.js + TypeScript + Tailwind CSS 기준으로 구현한다.
- 서버 상태는 TanStack Query를 사용한다.
- 검색, 필터, 정렬과 같이 공유 가능해야 하는 상태는 URL params로 관리한다.
- 상세 패널 열림 여부, 임시 입력값 등 화면 내부 상태는 React `useState`로 관리한다.
- 전역 상태 라이브러리는 이번 버전에서 사용하지 않는다.

### 5-4. 상태/에러/fallback 처리 작업
1. `01_core_policy.md`
2. `04_data_pipeline.md`
3. `05_api_spec.md`
4. `06_implementation_spec.md`

### 5-5. 만족도 작성 기능 작업
1. `01_core_policy.md`
2. `03_data_model.md`
3. `05_api_spec.md`
4. `06_implementation_spec.md`

## 6. 병렬 구현 원칙

- 병렬 구현은 문서상 경계가 분명한 단위로 나눈다.
- 하나의 작업은 가능한 한 하나의 주요 책임만 갖는다.
- 서로 다른 작업이 같은 필드 정의를 따로 만들지 않는다.
- 공통 타입, 응답 구조, 상태 정의는 문서를 기준으로 공유한다.

## 7. 권장 작업 분할

### 7-1. 데이터 레이어
- DB 스키마 생성
- 마스터 데이터 저장 구조 구현
- 설정 테이블 구현

### 7-2. 파이프라인 레이어
- 소스별 수집기 구현
- 병합 로직 구현
- 검증 및 자동 수정 로직 구현
- 점수 계산 로직 구현

### 7-3. API 레이어
- 목록 API
- 상세 API
- 만족도 작성 API
- 상태 조회 API
- 새로고침 API

### 7-4. 프론트엔드 레이어
- 목록 UI
- 검색/필터/정렬 UI
- 상세 패널 UI
- 점수/운영 인텔리전스/이력 UI
- 만족도 작성 UI
- 상태/새로고침/fallback UI

## 8. 문서 충돌 시 우선순위

- 정책 충돌 시: `01_core_policy.md`
- 데이터 구조 충돌 시: `03_data_model.md`
- 파이프라인 규칙 충돌 시: `04_data_pipeline.md`
- API 계약 충돌 시: `05_api_spec.md`
- 화면 동작 충돌 시: `06_implementation_spec.md`
- 구현 순서 관련 혼선 시: `07_build_guide.md`

## 9. 구현 중 가정이 필요한 경우

- 먼저 관련 문서에 이미 정의가 있는지 다시 확인한다.
- 정의가 없으면 임의로 정책을 만들지 않는다.
- 문서에 없는 새로운 정책이 필요하면 `08_decision_log.md`에 기록하고 반영 대상을 명시한다.
- 구현자가 임시 가정을 넣어야 하는 경우, 코드 주석이나 커밋 메시지 대신 문서 변경을 우선한다.

## 10. 구현 중 절대 다시 해석하지 말아야 하는 항목

- alias를 사용하지 않는 강사 병합 정책
- 전임강사 리스트가 별도 JSON이라는 점
- 전임강사 fee는 노션 기준값을 내부적으로 사용하되 화면에는 `전임강사`만 표시하는 정책
- 실습코치 판정은 기존 기준 유지
- 점수 계산 항목과 가중치
- fallback 정책
- Google 로그인 + `@day1company.co.kr` 접근 제한

## 11. 기능 구현 순서 권장안

### 11-1. 1단계
- 데이터 모델 기반 DB 스키마
- 전임강사 JSON 로딩
- 기본 마스터 데이터 적재 구조

### 11-2. 2단계
- 계약시트/노션/세일즈맵/슬랙/지메일/Google Forms 수집기
- 병합 로직
- 검증 및 자동 수정 로직

### 11-3. 3단계
- 점수 계산
- 운영 인텔리전스 적재
- 마지막 정상 데이터 및 fallback 처리

### 11-4. 4단계
- 목록 API
- 상세 API
- 상태 API
- 새로고침 API
- 만족도 작성 API

### 11-5. 5단계
- 목록 UI
- 검색/필터/정렬 UI
- 상세 패널 UI
- 점수/운영 인텔리전스/이력 UI
- 만족도 작성 UI
- fallback/상태 표시 UI

## 12. 완료 판정 기준

- 정책 구현이 `01_core_policy.md`와 충돌하지 않는다.
- 저장 구조가 `03_data_model.md`와 일치한다.
- 수집/병합/검증 흐름이 `04_data_pipeline.md`와 일치한다.
- API 응답이 `05_api_spec.md`와 일치한다.
- 화면 동작이 `06_implementation_spec.md`와 일치한다.
- 문서에 없는 임의 정책이 코드에 들어가지 않는다.
