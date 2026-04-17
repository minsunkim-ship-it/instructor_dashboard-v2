# Parallel Bundle Prompts

## Role
이 문서는 Wave 1을 grouped `validated-plan` 방식으로 실행할 때 바로 붙여넣어 사용할
그룹별 프롬프트를 제공한다.
이 문서는 실행 보조 문서이며, Source of Truth를 재정의하지 않는다.

## Depends On
- `00_docs_index.md`
- `10_execution_plan.md`
- `11_wave1_tasks.md`
- `12_parallel_bundle_guardrails.md`

## 1. 공통 전제

모든 그룹 프롬프트에 아래 전제를 포함한다.

- 문서 읽기 순서는 `00_docs_index.md`를 따른다.
- 이번 웨이브 운영 원칙은 `10_execution_plan.md`를 따른다.
- 태스크 의미와 완료 기준은 `11_wave1_tasks.md`를 따른다.
- 공통 고정 항목 / 수정 가능 범위 / 파일 담당 그룹은 `12_parallel_bundle_guardrails.md`를 따른다.
- 시작 전 / `T5` 진입 전 체크는 `14_wave1_preflight_checklist.md`를 따른다.
- 허용되지 않은 파일 수정이 필요하면 구현하지 말고 blocker로 보고한다.

## 2. Group 1 프롬프트 (`T1, T2, T3`)

```text
docs 폴더 문서를 00_docs_index.md의 Read Order와 Source of Truth Priority에 따라 읽어줘.

이번 작업은 Wave 1 Group 1이다.
태스크 의미와 완료 기준은 docs/11_wave1_tasks.md의 T1, T2, T3를 따른다.
단, 실제 파일 수정 권한은 docs/12_parallel_bundle_guardrails.md를 우선한다.

반드시 먼저 읽을 문서:
- docs/10_execution_plan.md
- docs/11_wave1_tasks.md
- docs/12_parallel_bundle_guardrails.md
- docs/14_wave1_preflight_checklist.md
- docs/05_api_spec.md
- docs/06_implementation_spec.md

수정 가능 파일:
- src/components/InstructorDetail.tsx
- src/components/InstructorList.tsx
- src/app/page.tsx
- Group 1 범위 안에서 필요한 신규 컴포넌트 파일

수정 금지 파일:
- prisma/schema.prisma
- src/app/api/status/route.ts
- src/app/api/refresh/route.ts
- src/app/api/review-decisions/route.ts
- src/components/FallbackBanner.tsx
- src/lib/pipeline/**
- docs/**
- src/lib/score-recalculator.ts
- src/lib/pipeline/satisfaction-applier.ts
- src/lib/pipeline/activity-applier.ts
- src/lib/google-user-oauth.ts

구현 목표:
1. T2 검증 및 문서 기준 보완
2. T3 검증 및 문서 기준 보완
3. InstructorList -> page.tsx -> InstructorDetail 연결 완성
4. Group 2의 T9 산출물 이후 `FallbackBanner` 실제 import / JSX 삽입까지 완료
5. null/empty/loading/error/fallback 노출을 문서 기준으로 점검

검증:
- node wave1-preflight.mjs
- npm run build
- 상세 패널 열림/닫힘 확인
- 만족도 저장 성공 후 상세 재조회 확인

최종 보고:
- 변경 파일
- 실행한 검증 명령
- T2/T3 완료 기준 충족 여부
- blocker
- build 결과
- page.tsx 연결 범위 요약
- fallback 배너 실제 표시/숨김 연결 여부
```

## 3. Group 2 프롬프트 (`T4, T9`)

```text
docs 폴더 문서를 00_docs_index.md의 Read Order와 Source of Truth Priority에 따라 읽어줘.

이번 작업은 Wave 1 Group 2이다.
태스크 의미와 완료 기준은 docs/11_wave1_tasks.md의 T4, T9를 따른다.
단, 실제 파일 수정 권한은 docs/12_parallel_bundle_guardrails.md를 우선한다.

반드시 먼저 읽을 문서:
- docs/10_execution_plan.md
- docs/11_wave1_tasks.md
- docs/12_parallel_bundle_guardrails.md
- docs/14_wave1_preflight_checklist.md
- docs/05_api_spec.md
- docs/06_implementation_spec.md

수정 가능 파일:
- src/app/api/status/route.ts
- src/components/FallbackBanner.tsx
- Group 2 범위 안에서 필요한 신규 상태/배너 컴포넌트 파일

수정 금지 파일:
- src/app/page.tsx
- src/app/api/refresh/route.ts
- src/components/InstructorDetail.tsx
- src/components/InstructorList.tsx
- src/lib/pipeline/**
- docs/**
- prisma/schema.prisma
- src/lib/score-recalculator.ts
- src/lib/pipeline/satisfaction-applier.ts
- src/lib/pipeline/activity-applier.ts
- src/lib/google-user-oauth.ts

구현 목표:
1. T4 검증 및 문서 기준 보완
2. T9 구현
3. page.tsx에 직접 삽입하지 않고도 재사용 가능한 배너 인터페이스 제공
4. Group 1이 별도 해석 없이 바로 연결할 수 있는 props/표시 조건 정리

검증:
- node wave1-preflight.mjs
- npm run build
- GET /api/status 응답 구조가 docs/05_api_spec.md와 일치하는지 확인
- FallbackBanner가 단독 컴포넌트로 동작 가능한지 확인

최종 보고:
- 변경 파일 (절대경로)
- 실행한 검증 명령과 결과 (build / preflight)
- T4/T9 완료 기준 충족 여부 항목별
- blocker (없으면 "없음" 명시)
- build 결과
- FallbackBanner props 시그니처 + 표시 조건 + 최소 1개 사용 예시 (Group 1이 별도 해석 없이 wiring 가능한 수준)
```

## 4. Group 3 프롬프트 (`T6, T7, T8`)

```text
docs 폴더 문서를 00_docs_index.md의 Read Order와 Source of Truth Priority에 따라 읽어줘.

이번 작업은 Wave 1 Group 3이다.
태스크 의미와 완료 기준은 docs/11_wave1_tasks.md의 T6, T7, T8을 따른다.
단, 실제 파일 수정 권한은 docs/12_parallel_bundle_guardrails.md를 우선한다.

반드시 먼저 읽을 문서:
- docs/10_execution_plan.md
- docs/11_wave1_tasks.md
- docs/12_parallel_bundle_guardrails.md
- docs/14_wave1_preflight_checklist.md
- docs/01_core_policy.md
- docs/03_data_model.md
- docs/04_data_pipeline.md
- docs/05_api_spec.md

수정 가능 파일:
- src/lib/pipeline/practice-coach-detector.ts
- src/lib/pipeline/fee-resolver.ts
- src/lib/pipeline/fee-history-store.ts
- src/app/api/instructors/[id]/route.ts
- Group 3 범위 안에서 필요한 신규 pipeline helper 파일

수정 금지 파일:
- src/app/api/refresh/route.ts
- src/app/api/status/route.ts
- src/app/page.tsx
- src/components/**
- docs/**
- prisma/schema.prisma
- src/lib/score-recalculator.ts
- src/lib/pipeline/satisfaction-applier.ts
- src/lib/pipeline/activity-applier.ts
- src/lib/google-user-oauth.ts

구현 목표:
1. T6 실습코치 3-Layer 판정 구현
2. T7 fee 우선순위 체인 + 특수금액 분리 구현
3. T8 fee_histories 적재 및 상세 API fee_history 반환 구현
4. refresh orchestration에 연결하지 않고도 모듈 단위 검증 가능 상태로 마무리

검증:
- node wave1-preflight.mjs
- npm run build
- 상세 API fee_history 반환 확인
- 전임강사 / 실습코치 / 특수금액 분리 규칙이 문서와 일치하는지 확인

최종 보고:
- 변경 파일 (절대경로)
- 실행한 검증 명령과 결과 (build / preflight / dry-run)
- T6/T7/T8 완료 기준 충족 여부 항목별
- 도메인 sanity check 결과 3개 (실습코치 0점 / 전임 제외 / 특수금액 분리)
- refresh 미연결 범위 명시
- T5가 연결해야 하는 entry point (정확한 함수/모듈 경로 + 호출 순서)
- 구현 실패 vs 외부 source/runtime 실패 구분 기준
- blocker (없으면 "없음" 명시)
- build 결과
```

## 5. 마지막 통합 프롬프트 (`T5`)

```text
docs 폴더 문서를 00_docs_index.md의 Read Order와 Source of Truth Priority에 따라 읽어줘.

이번 작업은 Wave 1 마지막 통합 단계 T5다.
태스크 의미와 완료 기준은 docs/11_wave1_tasks.md의 T5를 따른다.
실제 파일 수정 권한은 docs/12_parallel_bundle_guardrails.md를 따른다.

중요:
- 이 단계는 새 기능 확장 단계가 아니다.
- Group 1, Group 2, Group 3의 결과를 refresh orchestration과 화면 wiring에 연결하고 검증하는 단계다.

반드시 먼저 읽을 문서:
- docs/10_execution_plan.md
- docs/11_wave1_tasks.md
- docs/12_parallel_bundle_guardrails.md
- docs/14_wave1_preflight_checklist.md
- docs/05_api_spec.md

수정 가능 파일:
- src/app/api/refresh/route.ts
- src/app/page.tsx
  - 단, status/refresh 관련 최소 범위만 허용
- 통합 과정에서 필요한 매우 제한된 wiring 파일

수정 금지 파일:
- Group 1~3의 내부 로직 파일 재작성
- docs/**
- prisma/schema.prisma
- src/lib/score-recalculator.ts
- src/lib/pipeline/satisfaction-applier.ts
- src/lib/pipeline/activity-applier.ts
- src/lib/google-user-oauth.ts

통합 목표:
1. Group 3 결과를 refresh route에 연결
2. Group 1이 완료한 fallback/status wiring 상태를 기준으로 refresh -> status -> page 동선과 build/E2E 확인

검증:
- node wave1-preflight.mjs
- npm run build
- POST /api/refresh
- GET /api/status
- page.tsx에서 fallback/status wiring 완료 상태 확인

최종 보고:
- 변경 파일
- 실행한 검증 명령
- T5 완료 기준 충족 여부
- upstream blocker 여부
- build/API 검증 결과
- 구현 실패 vs 외부 source/runtime 실패 구분
```
