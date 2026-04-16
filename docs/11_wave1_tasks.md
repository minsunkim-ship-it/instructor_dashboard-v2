# Wave 1 Tasks

## Role
이 문서는 Wave 1 본 구현에서 수행할 개별 태스크를 정의한다.
각 태스크의 구현 범위, 참조 문서, 파일 경계, 선행 의존성, 완료 기준을 포함한다.
AI 에이전트는 이 문서를 실행 지시서로 사용한다.

## Source of Truth
- Wave 1 태스크 목록
- 태스크별 파일 경계
- 태스크별 완료 기준
- 태스크별 선행 의존성

## Depends On
- `01_core_policy.md`
- `03_data_model.md`
- `04_data_pipeline.md`
- `05_api_spec.md`
- `06_implementation_spec.md`
- `09_work_split.md`
- `10_execution_plan.md`

## Used By
- Claude Code
- 병렬 구현에 참여하는 에이전트

## Out of Scope
- 정책 정의
- 데이터 구조 정의
- API 계약 정의

## 1. Wave 1 범위

Wave 1은 Must-have(데모 가능한 MVP)와 Should-have(운영에 가까운 제품)를 포함한다.

### 1-1. Must-have
- 상세 패널 UI (Feature E~K)
- 만족도 작성 UI (Feature O)
- page.tsx 레이아웃 연결 (목록 선택 → 상세 표시)
- GET /api/status
- POST /api/refresh (기존 파이프라인 오케스트레이션)
- 누락 스키마 보강 (7개 모델)

### 1-2. Should-have
- 실습코치 3-Layer 판정 로직
- Fee 우선순위 체인 + 특수금액 분리
- fee_histories 적재
- Fallback 배너 UI

### 1-3. Wave 1 제외
- 운영 인텔리전스 LLM 생성
- validation_issues 17개 규칙 전체 구현
- 만족도 외부 수집 (Google Forms 시트 자동 연동)
- Google 인증 (이미 구현 완료)

## 2. 태스크 구분

태스크는 두 가지 상태로 구분한다.

- **검증 필요**: 에이전트가 이미 코드를 작성했으나, 문서 계약과의 정합성 및 빌드 통과 여부를 검증해야 하는 태스크
- **구현 필요**: 아직 코드가 작성되지 않은 태스크

## 3. 검증 필요 태스크

### T1. 스키마 보강

- 상태: 에이전트 구현 완료, 검증 필요
- 설명: `03_data_model.md`에 정의된 7개 누락 모델을 Prisma 스키마에 추가하고 Railway DB에 반영한다.
- 추가된 모델:
  - `InstructorIntelligence` (`instructor_intelligence`) — 4-5절
  - `SourceLink` (`source_links`) — 4-6절
  - `ValidationIssue` (`validation_issues`) — 4-7절
  - `FeeHistory` (`fee_histories`) — 4-3절
  - `FulltimeInstructorConfig` (`fulltime_instructor_configs`) — 5-1절
  - `FeeFixConfig` (`fee_fix_configs`) — 5-3절
  - `PracticeCoachRule` (`practice_coach_rules`) — 5-2절
- 참조 문서: `03_data_model.md`
- 파일: `prisma/schema.prisma`
- 선행 의존성: 없음
- 검증 기준:
  - 각 모델의 필드가 `03_data_model.md` 정의와 1:1 대응
  - `npx prisma generate` 성공
  - `npx prisma db push` 성공 (이미 반영 완료 상태)
  - 기존 API 엔드포인트(`GET /api/instructors`, `GET /api/instructors/{id}`, `POST /api/instructors/{id}/satisfaction`) 정상 동작

### T2. 상세 패널 UI

- 상태: 에이전트 구현 완료, 검증 필요
- 설명: 강사 상세 정보를 우측 패널에 표시하는 `InstructorDetail` 컴포넌트를 구현한다.
- 참조 문서:
  - `06_implementation_spec.md` Feature E (강사 상세 조회)
  - `06_implementation_spec.md` Feature F (핵심 수치 표시)
  - `06_implementation_spec.md` Feature G (점수 구성 요소 및 만족도 표시)
  - `06_implementation_spec.md` Feature H (운영 인텔리전스 표시)
  - `06_implementation_spec.md` Feature I (강의 이력 표시)
  - `06_implementation_spec.md` Feature J (단가 이력 표시)
  - `06_implementation_spec.md` Feature K (운영 메모 표시)
  - `05_api_spec.md` 6절 (상세 응답 구조)
- 파일:
  - `src/components/InstructorDetail.tsx` (신규)
  - `src/components/InstructorList.tsx` (수정 — onSelectInstructor 콜백 추가)
  - `src/app/page.tsx` (수정 — 상세 패널 연결)
- 선행 의존성: T1 (스키마에 InstructorIntelligence 모델 필요)
- 검증 기준:
  - 목록에서 강사 클릭 시 우측 상세 패널에 정보 표시
  - 프로필 헤더: 이름, 소속, 카테고리 배열, 전문분야, 연락처, 전임강사 배지
  - 핵심 수치: 총 출강 횟수, 최근 6개월, 누적 지급액(추정), 기본 단가 4개 카드
  - 점수: 종합 점수 + score_breakdown 7개 항목 표시
  - 만족도: 평균, 건수, 대체값 여부 표시
  - 강의 이력: 최신순 30건, 초과 시 "N건 더 있음"
  - 운영 인텔리전스: 값이 있는 항목만 표시
  - 운영 메모: 값이 있을 때만 표시
  - null 값은 `-`로 표시
  - 금액은 `N만원` 형식
  - 점수는 소수점 한 자리
  - 전임강사는 fee 숨김 + 배지 표시
  - 상세 패널 독립 스크롤

### T3. 만족도 작성 UI

- 상태: 에이전트 구현 완료 (T2에 포함), 검증 필요
- 설명: 상세 패널 내에서 만족도 기록을 작성하는 폼을 구현한다.
- 참조 문서:
  - `06_implementation_spec.md` Feature O
  - `05_api_spec.md` 7절
- 파일: `src/components/InstructorDetail.tsx` (T2와 동일 파일)
- 선행 의존성: T2
- 검증 기준:
  - 점수 입력: 0~5 범위, 0.5 단위
  - 선택 입력: 기업명, 과정명, 코멘트, 응답일
  - `POST /api/instructors/{id}/satisfaction`으로 전송
  - 저장 성공 시 상세 데이터 재조회 (TanStack Query invalidation)
  - 저장 실패 시 오류 메시지 표시
  - 로딩 중 버튼 비활성화

### T4. GET /api/status

- 상태: 에이전트 구현 완료, 검증 필요
- 설명: 데이터 상태, 마지막 업데이트 시각, 소스별 상태 정보를 반환하는 API를 구현한다.
- 참조 문서: `05_api_spec.md` 8절
- 파일: `src/app/api/status/route.ts` (신규)
- 선행 의존성: 없음
- 검증 기준:
  - 최근 성공 PipelineRun 기준 `last_updated_at` 반환
  - `refresh_available`: 현재 running 상태인 PipelineRun이 없으면 `true`
  - 소스별 `source_type`, `status`, `last_synced_at` 반환
  - 공통 envelope 구조 (`status`, `meta`, `data`) 준수
  - HTTP 200 정상 반환

### T5. POST /api/refresh

- 상태: 에이전트 구현 완료, 검증 필요
- 설명: 전체 데이터 파이프라인을 순차 실행하고 점수를 재계산하는 오케스트레이션 API를 구현한다.
- 참조 문서:
  - `05_api_spec.md` 9절
  - `04_data_pipeline.md` 21절
- 파일: `src/app/api/refresh/route.ts` (신규)
- 선행 의존성: 기존 파이프라인 모듈 전체
- 검증 기준:
  - 이미 running 상태인 PipelineRun 있으면 409 `REFRESH_IN_PROGRESS` 반환
  - PipelineRun 1건 생성
  - 소스별 수집기를 순차 실행 (하나 실패해도 나머지 계속)
  - 소스별 SourceSyncLog 기록
  - 마지막에 `recalculateAllScores()` 호출
  - 전체 성공 `success`, 일부 실패 `partial`, 전체 실패 `failed` 상태 반환
  - 공통 envelope 구조 준수

## 4. 구현 필요 태스크

### T6. 실습코치 3-Layer 판정

- 상태: 구현 필요
- 설명: 계약시트 데이터를 기반으로 실습코치 여부를 판정하고 `instructors.is_practice_coach`를 갱신한다.
- 참조 문서:
  - `01_core_policy.md` 10절 (3-Layer 판정 기준)
  - `04_data_pipeline.md` 11절 (판정 절차)
- 파일:
  - `src/lib/pipeline/practice-coach-detector.ts` (신규)
  - POST /api/refresh 실행 흐름에 통합
- 선행 의존성:
  - `teaching_histories`에 `contract_type`, `detail_type` 데이터 적재 완료 (계약시트 파이프라인)
  - `instructors.is_fulltime` 반영 완료 (전임강사 파이프라인)
- 구현 규칙:
  - L1 후보 판정: 계약시트에서 해당 강사의 계약 유형/상세 유형 중 `보조강사`, `코치`, `실습코치`, `멘토`, `문항개발` 비율이 정규강사 비율보다 높으면 후보
  - L2 정규강사 보호: `base_fee_hourly >= 100000` 이고 `categories`와 `specialties`가 모두 비어 있지 않으면 후보 제외
  - L3 전임강사 보호: 전임강사 리스트에 포함된 강사는 무조건 후보 제외
  - 최종 판정: 보호 규칙 통과한 후보만 `is_practice_coach = TRUE`
- 완료 기준:
  - 3-Layer 판정이 `01_core_policy.md` 10절과 일치
  - 실습코치로 판정된 강사의 score가 0점 처리됨 (score-recalculator에 이미 구현됨)
  - 전임강사는 실습코치로 분류되지 않음

### T7. Fee 우선순위 체인 + 특수금액 분리

- 상태: 구현 필요
- 설명: 일반 강사의 기본 단가를 우선순위에 따라 결정하고, 특수금액을 분리한다.
- 참조 문서:
  - `04_data_pipeline.md` 12절 (fee 및 단가 이력 처리)
  - `01_core_policy.md` 8절 (특수 금액 처리 정책)
- 파일:
  - `src/lib/pipeline/fee-resolver.ts` (신규)
  - POST /api/refresh 실행 흐름에 통합
- 선행 의존성:
  - Notion 파이프라인 (base_fee_hourly, fee_note)
  - 세일즈맵 파이프라인 (fee 후보)
  - 계약시트 파이프라인 (시간당 강사료)
- 구현 규칙:
  - 일반 강사 우선순위: `fee_fix_configs` > 노션 기본 강사료 > 세일즈맵 확인 금액 > 계약시트 시간당 강사료
  - 전임강사: 노션 기본 강사료 또는 fee_note만 기준
  - 특수금액 키워드: `콘텐츠`, `제작`, `개발비`, `출장비`, `별도`, `건당`, `프로젝트`, `패키지`, `특강`, `자료개발`, `원고`, `감수`
  - 특수금액은 `base_fee_hourly` 계산에 사용하지 않음
  - 동일 강사의 일반 출강료 분포 대비 3배 이상 큰 금액은 특수금액 후보
- 완료 기준:
  - `instructors.base_fee_hourly`가 우선순위 체인에 따라 결정됨
  - 전임강사는 노션 기준만 사용
  - 특수금액이 기본 단가에 혼입되지 않음

### T8. fee_histories 적재

- 상태: 구현 필요
- 설명: 단가 변동 이력을 `fee_histories` 테이블에 저장하고, 상세 API에서 반환한다.
- 참조 문서:
  - `03_data_model.md` 4-3절
  - `04_data_pipeline.md` 12절
  - `05_api_spec.md` 6-3절
- 파일:
  - `src/lib/pipeline/fee-history-store.ts` (신규)
  - `src/app/api/instructors/[id]/route.ts` (수정 — fee_history 반환 추가)
- 선행 의존성: T7 (fee resolver)
- 완료 기준:
  - Notion fee_note, 세일즈맵 확인 금액, 계약 데이터, 보정값을 fee_histories에 저장
  - `GET /api/instructors/{id}` 응답의 `fee_history`에 최신순 데이터 반환
  - 전임강사는 `fee_history` 빈 배열 반환 (이미 구현됨)
  - 특수금액은 `is_special_amount = true`로 구분

### T9. Fallback 배너 UI

- 상태: 구현 필요
- 설명: API 응답의 `meta.is_fallback`이 `true`일 때 화면 상단에 fallback 배너를 표시한다.
- 참조 문서:
  - `06_implementation_spec.md` Feature M
  - `05_api_spec.md` 10절
- 파일:
  - `src/components/FallbackBanner.tsx` (신규)
  - `src/app/page.tsx` (수정 — 배너 삽입)
- 선행 의존성: 없음
- 완료 기준:
  - `meta.is_fallback = true`일 때 `임시 데이터 표시 중` 배너 표시
  - `meta.is_fallback = false`일 때 배너 숨김
  - 배너가 다른 UI를 가리지 않음

## 5. 실행 순서

### 5-1. Phase 1: 검증 (순차)

검증 필요 태스크를 아래 순서로 검증한다.

1. T1 (스키마) — 기반이 되므로 가장 먼저
2. T4 (status API) + T5 (refresh API) — 독립적이므로 병렬 검증 가능
3. T2 (상세 패널) + T3 (만족도 작성) — T2 안에 T3 포함

### 5-2. Phase 2: 구현 (병렬 가능 구간)

구현 필요 태스크를 아래 순서로 실행한다.

- T6 (실습코치 판정) + T9 (fallback 배너) — 독립적이므로 병렬 가능
- T7 (fee 우선순위) — T6과 독립이나 파이프라인 데이터에 의존
- T8 (fee_histories) — T7 완료 후

### 5-3. Phase 3: 통합

- POST /api/refresh에 T6, T7, T8 로직 통합
- 전체 빌드 (`npm run build`) 통과
- 브라우저에서 목록 → 상세 → 만족도 작성 → score 반영 E2E 확인

## 6. 파일 경계 요약

| 파일 | 담당 태스크 | 수정/신규 |
|------|-----------|----------|
| `prisma/schema.prisma` | T1 | 수정 완료 |
| `src/components/InstructorDetail.tsx` | T2, T3 | 신규 |
| `src/components/InstructorList.tsx` | T2 | 수정 |
| `src/app/page.tsx` | T2, T9 | 수정 |
| `src/app/api/status/route.ts` | T4 | 신규 |
| `src/app/api/refresh/route.ts` | T5 | 신규 |
| `src/lib/pipeline/practice-coach-detector.ts` | T6 | 신규 |
| `src/lib/pipeline/fee-resolver.ts` | T7 | 신규 |
| `src/lib/pipeline/fee-history-store.ts` | T8 | 신규 |
| `src/app/api/instructors/[id]/route.ts` | T8 | 수정 |
| `src/components/FallbackBanner.tsx` | T9 | 신규 |
