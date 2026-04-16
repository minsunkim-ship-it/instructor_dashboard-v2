# Docs Index

## Purpose
이 문서는 구현에 필요한 문서들의 역할, 읽는 순서, 우선순위를 정의한다.
Claude Code와 Codex는 이 문서를 먼저 읽고, 이후 필요한 문서를 순서대로 참조한다.

## Read Order
1. `01_core_policy.md`
2. `02_system_architecture.md`
3. `03_data_model.md`
4. `04_data_pipeline.md`
5. `05_api_spec.md`
6. `06_implementation_spec.md`
7. `07_build_guide.md`
8. `08_decision_log.md`
9. `09_work_split.md`
10. `10_execution_plan.md`
11. `11_wave1_tasks.md`
12. `12_parallel_bundle_guardrails.md`

## Source of Truth Priority
- 정책 충돌 시: `01_core_policy.md`
- 데이터 구조 충돌 시: `03_data_model.md`
- 파이프라인 규칙 충돌 시: `04_data_pipeline.md`
- API 계약 충돌 시: `05_api_spec.md`
- 화면/기능 동작 충돌 시: `06_implementation_spec.md`
- 구현 순서 및 작업 방식 참고: `07_build_guide.md`
- 변경 이력 확인: `08_decision_log.md`
- 병렬 구현 책임 경계 확인: `09_work_split.md`
- 현재 구현 웨이브 운영 규칙 확인: `10_execution_plan.md`
- Wave 1 태스크별 파일 경계와 완료 기준 확인: `11_wave1_tasks.md`
- grouped `validated-plan` 병렬 실행 시 공통 고정 항목 / 파일 담당 그룹 확인: `12_parallel_bundle_guardrails.md`

## Current Execution Plan

이 섹션은 현재 구현 웨이브에서 병렬 작업을 어떻게 실행할지 안내한다.
상세 작업 정의와 책임 경계는 `09_work_split.md`를 따른다.
현재 웨이브에서 문서 해석 충돌이 생기면 `08_decision_log.md`를 먼저 확인하고, 그래도 해결되지 않으면 blocker로 보고한다.

### Current Objective
- 파일럿 검증을 모두 통과했으며, 본 병렬 구현 Wave 1을 실행 중이다.
- Wave 1의 목표는 데모 가능한 MVP(Must-have)와 운영에 가까운 핵심 기능(Should-have)을 완성하는 것이다.

### Current Phase
- 현재 단계는 Wave 1 본 구현 단계다.
- 파일럿 검증 웨이브(파일럿 1~3, Pilot 4-1~4-5)는 완료 상태다.
- Wave 1 태스크 정의와 실행 순서는 `11_wave1_tasks.md`를 따른다.
- Wave 1 범위:
  - Must-have: 상세 패널 UI, 만족도 작성 UI, page.tsx 연결, GET /api/status, POST /api/refresh, 누락 스키마 보강
  - Should-have: 실습코치 판정, Fee 우선순위 체인, fee_histories 적재, Fallback 배너

### Pilot Order (완료)
1. 파일럿 1 — Notion 단일 소스 수집 → 정규화 → `instructors` 저장 → 목록 API 반영
2. 파일럿 2 — 만족도 저장 → 집계 갱신 → 전체 score 재계산 → 상세 API 재조회
3. 파일럿 3 — Track C / Track D 병렬 구현 → 별도 브랜치 작업 → 순차 머지 → 충돌 검증
4. Pilot 4-1 — 계약시트 Google Sheets API 외부 수집 검증

### Execution Gate (통과 완료)
- 아래 조건이 모두 충족되어 Wave 1 본 구현으로 진입했다.
  - 파일럿 1 통과
  - 파일럿 2 통과
  - 파일럿 3 통과
  - Pilot 4-1 통과
  - Pilot 4-2~4-5 통과
  - 주요 문서 gap 없음
  - 공유 파일 충돌 규칙 확정

### Active Source of Truth For Parallel Work
- 정책: `01_core_policy.md`
- 데이터 구조: `03_data_model.md`
- 파이프라인 규칙: `04_data_pipeline.md`
- API 계약: `05_api_spec.md`
- 화면 동작: `06_implementation_spec.md`
- 작업 경계: `09_work_split.md`
- 결정 이력: `08_decision_log.md`

### Shared File Guardrail
- `prisma/schema.prisma`는 Track A 완료 후 고정한다.
- `src/types/api.ts`는 공유 타입 계약 파일이므로 필요한 엔드포인트 타입만 추가한다.
- 같은 파일을 두 개 이상의 트랙이 동시에 수정하지 않는다.
- 문서에 없는 새로운 공유 규칙이 필요하면 먼저 `08_decision_log.md`에 기록한다.

### Merge Rule
- 기본 머지 순서는 `09_work_split.md`를 따른다.
- 병렬 구현 중에도 같은 파일을 동시에 수정한 경우 완료로 보지 않는다.
- 기능 구현 성공보다 문서 계약 준수와 충돌 없는 머지를 우선 검증한다.

### Blocker Rule
- 문서에 없는 판단이 필요하면 임의로 구현하지 않는다.
- 문서 간 충돌, 문서-코드 불일치, 공유 파일 경계 위반은 blocker로 보고한다.
- blocker 보고 시 파일 경로와 근거 라인을 함께 남긴다.

### After Pilots
- 파일럿 1~3과 Pilot 4-1~4-5가 모두 통과하여 Wave 1 본 구현에 진입했다.
- Wave 1의 태스크별 실행 지시는 `11_wave1_tasks.md`에서 관리한다.
- Wave 1의 실행 순서와 시작 조건은 `10_execution_plan.md`에서 관리한다.
- grouped `validated-plan` 병렬 실행의 공통 고정 항목 / 파일 담당 그룹은 `12_parallel_bundle_guardrails.md`에서 관리한다.


## File Roles

### `01_core_policy.md`
- 서비스 전반의 핵심 정책을 정의한다.
- 병합 기준, 전임강사 정책, fee 정책, 점수 정책, fallback 정책, 인증 정책을 포함한다.

### `02_system_architecture.md`
- 시스템 구성과 배포 구조를 정의한다.
- 프론트엔드, 백엔드, 인증, 외부 의존성, 배포 환경, 환경변수를 포함한다.

### `03_data_model.md`
- 데이터 구조를 정의한다.
- 엔티티, 필드, 타입, 필수 여부, 기본값, 관계, 설정 데이터 구조를 포함한다.

### `04_data_pipeline.md`
- 외부 데이터 수집부터 마스터 데이터 생성까지의 흐름을 정의한다.
- 소스별 접근 방식, 필드 매핑, 병합 규칙, 검증 규칙, 실패 처리, 저장 위치를 포함한다.

### `05_api_spec.md`
- 프론트엔드와 백엔드 간 통신 계약을 정의한다.
- 엔드포인트, 요청/응답 형식, 에러 형식, 인증, fallback 응답 차이를 포함한다.

### `06_implementation_spec.md`
- 화면과 기능의 동작 방식을 정의한다.
- 목록, 상세, 검색, 필터, 정렬, 점수 표시, 운영 인텔리전스, 이력, 새로고침, fallback 처리 등을 포함한다.

### `07_build_guide.md`
- 구현자가 어떤 순서로 문서를 참고하고 어떤 순서로 구현할지 안내한다.
- 병렬 구현 원칙, 작업 시작 전 체크리스트, 문서 수정 우선순위를 포함한다.

### `08_decision_log.md`
- 정책 변경과 주요 의사결정 이력을 기록한다.
- 이후 문서 수정 시 어떤 결정이 언제 반영됐는지 추적하는 용도로 사용한다.

### `09_work_split.md`
- 병렬 구현을 위한 작업 분할 구조를 정의한다.
- 작업별 책임 범위, 선행 의존성, 완료 기준을 포함한다.

### `10_execution_plan.md`
- 현재 구현 웨이브를 어떤 순서와 규칙으로 실행할지 정의한다.
- 파일럿 순서, 본 병렬 구현 시작 조건, 공유 파일 가드레일, 머지 규칙, blocker 보고 규칙을 포함한다.

### `11_wave1_tasks.md`
- Wave 1 본 구현에서 수행할 개별 태스크를 정의한다.
- 각 태스크의 구현 범위, 참조 문서, 파일 경계, 선행 의존성, 완료 기준을 포함한다.
- AI 에이전트가 실행 지시서로 사용하는 문서다.

### `12_parallel_bundle_guardrails.md`
- Wave 1 태스크를 grouped `validated-plan` 작업 묶음으로 실행할 때의 공통 고정 항목, 수정 가능 범위, 파일 담당 그룹을 정의한다.
- `11_wave1_tasks.md`의 태스크 의미는 유지하되, 실제 병렬 실행 시 수정 권한과 통합 순서를 고정한다.

## Legacy Reference

- `구현명세서_v2.md`는 참고용 legacy 문서로만 사용한다.
- 새 구현의 Source of Truth는 `docs/` 아래 문서 세트를 사용한다.
- 정책, 데이터 구조, 파이프라인, API, 화면/기능 변경은 각 담당 문서를 직접 수정한다.
- `구현명세서_v2.md`는 더 이상 업데이트하지 않는다.

## How To Use
- 새로운 기능을 구현하기 전에는 먼저 `01_core_policy.md`를 확인한다.
- 시스템 구성, 배포 환경, 환경변수를 설계하거나 변경하기 전에는 `02_system_architecture.md`를 확인한다.
- 데이터 구조를 추가하거나 수정하기 전에는 `03_data_model.md`를 확인한다.
- 외부 소스 수집/병합 로직을 구현하기 전에는 `04_data_pipeline.md`를 확인한다.
- API를 구현하거나 호출하기 전에는 `05_api_spec.md`를 확인한다.
- 화면 구현 전에는 `06_implementation_spec.md`를 확인한다.
- 구현 순서가 헷갈리면 `07_build_guide.md`를 확인한다.
- 기존 정책과 다른 변경이 필요하면 먼저 `08_decision_log.md`에 기록하고 관련 문서를 수정한다.
- 병렬 구현 단위와 책임 경계를 확인하려면 `09_work_split.md`를 확인한다.
- 현재 웨이브의 파일럿 순서, 머지 규칙, blocker 처리 기준은 `10_execution_plan.md`를 확인한다.
- Wave 1의 개별 태스크 범위, 파일 경계, 완료 기준은 `11_wave1_tasks.md`를 확인한다.
- grouped `validated-plan` 병렬 실행 전에는 반드시 `12_parallel_bundle_guardrails.md`를 확인한다.

## Update Rule
- 정책이 바뀌면 먼저 `01_core_policy.md`를 수정한다.
- 시스템 구성이나 배포 구조가 바뀌면 `02_system_architecture.md`를 수정한다.
- 데이터 구조가 바뀌면 `03_data_model.md`를 수정한다.
- 수집/병합 규칙이 바뀌면 `04_data_pipeline.md`를 수정한다.
- API 계약이 바뀌면 `05_api_spec.md`를 수정한다.
- 화면 동작이 바뀌면 `06_implementation_spec.md`를 수정한다.
- 현재 구현 웨이브의 실행 순서나 머지 규칙이 바뀌면 `10_execution_plan.md`를 수정한다.
- Wave 1 태스크의 범위, 파일 경계, 완료 기준이 바뀌면 `11_wave1_tasks.md`를 수정한다.
- grouped `validated-plan` 병렬 실행 규칙, 공통 고정 항목, 파일 담당 그룹이 바뀌면 `12_parallel_bundle_guardrails.md`를 수정한다.
- `구현명세서_v2.md`는 참고만 하고 수정하지 않는다.
- 중요한 변경은 `08_decision_log.md`에 반드시 남긴다.
