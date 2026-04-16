# Execution Plan

## Role
이 문서는 현재 구현 웨이브를 어떻게 실행할지 정의하는 운영 문서다.
병렬 구현 순서, 파일럿 검증 순서, 그룹 시작 조건, 공유 파일 가드레일, 머지 및 blocker 처리 규칙을 포함한다.

## Source of Truth
- 현재 구현 웨이브 목표
- 파일럿 검증 순서
- 본 병렬 구현 시작 조건
- 그룹 활성화 순서
- 공유 파일 수정 가드레일
- 머지 순서와 blocker 보고 규칙

## Depends On
- `00_docs_index.md`
- `07_build_guide.md`
- `08_decision_log.md`
- `09_work_split.md`

## Used By
- Claude Code
- Codex
- 병렬 구현에 참여하는 개발자 전원

## Out of Scope
- 제품 정책 정의
- 데이터 구조 정의
- 파이프라인 규칙 정의
- API 계약 정의
- 화면 동작 정의

## 1. 목적

- 여러 기능을 단기간에 병렬로 구현해 하나의 제품을 만든다.
- 병렬 구현 전, 문서 계약과 파일 책임 경계가 실제 구현과 머지 단계에서도 유효한지 먼저 검증한다.
- 본 문서는 "지금 이 웨이브에서 무엇을 어떤 순서로 실행할지"만 다룬다.

## 2. 현재 웨이브 정의

현재 웨이브는 Wave 1 본 구현 단계다.

- 검증 웨이브 결과:
  - 파일럿 1~3 통과
  - Pilot 4-1~4-5 통과
  - 검증 웨이브 완료

- Wave 1 목표:
  - Must-have(데모 가능한 MVP)와 Should-have(운영에 가까운 핵심 기능)를 완성한다.
  - 태스크 정의는 `11_wave1_tasks.md`를 따른다.

- Wave 1 범위:
  - Must-have: 상세 패널 UI, 만족도 작성 UI, page.tsx 연결, GET /api/status, POST /api/refresh, 누락 스키마 보강
  - Should-have: 실습코치 3-Layer 판정, Fee 우선순위 체인, fee_histories 적재, Fallback 배너 UI
  - 제외: 운영 인텔리전스 LLM 생성, validation 17개 규칙 전체, 만족도 외부 수집(Google Forms)

- Wave 1 현재 상태:
  - T1(스키마 보강): 에이전트 구현 완료, 검증 필요
  - T2(상세 패널): 에이전트 구현 완료, 검증 필요
  - T3(만족도 작성 UI): 에이전트 구현 완료, 검증 필요
  - T4(GET /api/status): 에이전트 구현 완료, 검증 필요
  - T5(POST /api/refresh): 에이전트 구현 완료, 검증 필요
  - T6(실습코치 판정): 구현 필요
  - T7(Fee 우선순위 체인): 구현 필요
  - T8(fee_histories 적재): 구현 필요
  - T9(Fallback 배너): 구현 필요

## 3. 파일럿 검증 이력

본 병렬 구현 전에 아래 파일럿을 완료했다.

1. 파일럿 1
   - Notion 단일 소스 수집
   - 정규화
   - `instructors` 저장
   - 목록 API 반영 검증
2. 파일럿 2
   - 만족도 저장
   - 만족도 집계 갱신
   - 전체 score/rank 재계산
   - 상세 API 재조회 검증
3. 파일럿 3
   - Track C / Track D 병렬 구현
   - 별도 브랜치 작업
   - 순차 머지
   - git 충돌 여부 검증
4. Pilot 4-1
   - 현재 검증 웨이브 이후의 추가 파일럿
   - 계약시트 Google Sheets API 외부 수집
   - 동일 헤더 매핑으로 2개 worksheet 병합 수집
   - `teaching_histories` 적재 검증
   - `pipeline_runs` / `source_sync_logs` 기록 검증

## 4. 본 병렬 구현 시작 조건 (충족 완료)

아래 조건을 충족해 Wave 1 본 구현을 시작했다.

- 파일럿 1 통과
- 파일럿 2 통과
- 파일럿 3 통과
- Pilot 4-1 통과
- 주요 문서 gap 없음
- 공유 파일 수정 규칙 확정
- 머지 순서와 blocker 보고 규칙 확정

## 5. 활성 Source of Truth

병렬 구현 중 문서 해석 충돌이 생기면 아래 우선순위를 따른다.

- 정책: `01_core_policy.md`
- 데이터 구조: `03_data_model.md`
- 파이프라인 규칙: `04_data_pipeline.md`
- API 계약: `05_api_spec.md`
- 화면 동작: `06_implementation_spec.md`
- 작업 경계: `09_work_split.md`
- 실행 웨이브 운영 규칙: `10_execution_plan.md`
- 변경 이력: `08_decision_log.md`

## 6. 그룹 활성화 규칙

- Group 1, Group 2, Group 3은 공통 고정 항목과 파일 담당 그룹 확인 후 병렬 실행 가능하다.
- 마지막 `T5`는 Group 1~3이 모두 끝난 뒤 단일 세션에서만 수행한다.
- 각 그룹은 자기 수정 가능 범위 안에서만 파일을 수정한다.

## 7. 공유 파일 가드레일

- `prisma/schema.prisma`는 baseline 반영 완료 상태로 간주하고 병렬 실행 중에는 고정한다.
- `src/types/api.ts`는 공유 타입 계약 파일이다.
  - 필요한 엔드포인트 타입만 추가한다.
  - 기존 공통 타입을 임의로 다시 정의하지 않는다.
- `src/app/page.tsx`는 레이아웃 통합 지점이다.
  - Group 1이 주 담당 그룹이며, `T5`에서만 최소 범위 추가 연결을 허용한다.
- 같은 파일을 두 개 이상의 그룹이 동시에 수정하지 않는다.
- 문서에 없는 새로운 공유 규칙이 필요하면 먼저 `08_decision_log.md`에 기록한다.

### 7-1. grouped `validated-plan` 실행 보정

- Wave 1 태스크를 `T1~T9` 그대로 병렬 실행하지 않는다.
- grouped `validated-plan`으로 실행할 때는 `12_parallel_bundle_guardrails.md`를 함께 적용한다.
- 이때:
  - 태스크 의미와 완료 기준은 `11_wave1_tasks.md`
  - 공통 고정 항목 / 파일 담당 그룹 / 마지막 통합 범위는 `12_parallel_bundle_guardrails.md`
  를 따른다.
- `11_wave1_tasks.md`의 파일 경계와 `12_parallel_bundle_guardrails.md`의 파일 담당 그룹 정의가 충돌하면, **병렬 실행 시에는 `12_parallel_bundle_guardrails.md`가 우선**한다.

## 8. 브랜치 및 머지 원칙

- 병렬 구현은 그룹별 브랜치를 기본으로 한다.
- 각 브랜치는 자기 그룹의 수정 가능 파일만 변경한다.
- 머지 전 반드시 변경 파일 목록을 비교한다.
- 기본 머지 순서는 `Group 1/2/3 완료 -> 검사 -> T5 통합`을 따른다.
- 같은 파일을 동시에 수정한 경우 해당 웨이브는 충돌 없는 병렬 구현으로 판정하지 않는다.

## 9. Blocker 규칙

- 문서에 없는 판단이 필요하면 임의로 구현하지 않는다.
- 문서 간 충돌, 문서-코드 불일치, 공유 파일 경계 위반은 blocker로 보고한다.
- blocker 보고 시 아래를 포함한다.
  - 충돌 문서 또는 파일
  - 관련 경로
  - 근거 라인
  - 왜 현재 실행을 멈춰야 하는지

## 10. 본 병렬 구현 시작 후 운영 방식

- 각 그룹은 시작 프롬프트와 완료 기준을 별도로 가진다.
- 구현자는 문서 계약을 재해석하지 않고, 확정된 계약만 따라 구현한다.
- 기능 구현 성공보다 문서 계약 준수와 충돌 없는 머지를 우선 검증한다.
- 웨이브 중간에 정책 변경이 생기면 `08_decision_log.md`를 먼저 수정한 뒤 관련 문서를 갱신한다.

## 10-1. 실행 전 사전 점검

- 아래 항목은 Group 1~3 시작 전에 먼저 확인한다.
  - `NOTION_API_KEY`, `NOTION_DATABASE_ID`
  - `SALESMAP_SNAPSHOT_PATH`
  - `SLACK_BOT_TOKEN`, `SLACK_WORKSPACE_ID`
  - `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, `GMAIL_ACCOUNT_EMAIL`, `GMAIL_TARGET_ADDRESSES`
  - `GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_CONTRACTS_SPREADSHEET_ID`
- Group 3 시작 전에는 아래 데이터 선행조건이 이미 baseline에 반영되어 있는지 확인한다.
  - `teaching_histories.contract_type`, `detail_type`
  - `instructors.is_fulltime`
  - `fee_fix_configs`
- 위 조건이 빠져 있으면 구현으로 덮지 말고 blocker로 보고한다.

## 11. 완료 판정

현재 웨이브는 아래 조건이 충족되면 완료로 본다.

- 파일럿 1, 2, 3이 모두 통과한다.
- 병렬 구현 책임 경계가 실제 git 머지에서도 유효함이 확인된다.
- 문서에 없는 임의 정책 없이 다음 병렬 구현 웨이브를 시작할 수 있다.

## 12. 검증 웨이브 종료 후 상태

- 검증 웨이브(파일럿 1~3)와 추가 파일럿(Pilot 4-1~4-5)은 모두 완료 상태다.
- 파일럿에서 `main`에 머지된 기능(검색/필터/정렬, Notion 적재, 계약시트 적재, 세일즈맵 보강, Slack/Gmail 수집, 만족도 작성+score 재계산)은 baseline feature로 간주한다.
- Wave 1 범위가 확정되었으며, 태스크 정의는 `11_wave1_tasks.md`에서 관리한다.

## 14. Wave 1 실행 규칙

### 14-1. 실행 순서
- Phase 1(검증): 에이전트 구현 완료 태스크(T1~T5)를 문서 계약 기준으로 검증한다.
- Phase 2(구현): 미구현 태스크(T6~T9)를 병렬 가능 구간에서 실행한다.
- Phase 3(통합): 전체 빌드 통과 + E2E 확인.

### 14-2. 검증 규칙
- 에이전트가 작성한 코드는 해당 태스크의 참조 문서 및 완료 기준과 대조해 검증한다.
- 검증 실패 시 문서 기준으로 수정한다.
- 검증 통과한 태스크만 baseline으로 채택한다.

### 14-3. 파일 경계
- Wave 1의 태스크별 파일 경계는 `11_wave1_tasks.md` 6절을 따른다.
- 같은 파일을 두 개 이상의 태스크가 동시에 수정하지 않는다.
- grouped `validated-plan` 방식으로 실행할 때는 `12_parallel_bundle_guardrails.md`의 파일 담당 그룹 문서를 함께 적용한다.

### 14-4. grouped `validated-plan` 권장 구조

- Group 1: `T1, T2, T3`
- Group 2: `T4, T9`
- Group 3: `T6, T7, T8`
- 마지막 통합: `T5`

- Group 1~3은 병렬 실행 가능하다.
- `T5`는 refresh orchestration과 최종 build/E2E를 담당하는 마지막 통합 단계로 분리한다.
- 단, 실제 수정 가능 범위와 공통 고정 항목은 `12_parallel_bundle_guardrails.md`를 따른다.

### 14-5. Blocker 규칙
- 기존 9절 blocker 규칙을 그대로 적용한다.

## 13. Pilot 4-1 — 계약시트 외부 수집 검증

### 13-1. 위치
- 현재 검증 웨이브(파일럿 1, 2, 3) 이후에 수행하는 추가 파일럿이다.
- 본 병렬 구현 Wave 1 진입 전에 통과 여부를 확정해야 한다.

### 13-2. 목적
- 계약시트 외부 수집이 `04_data_pipeline.md` 계약으로 구현 가능한지 검증한다.
- 동일 헤더 매핑을 사용하는 2개 worksheet가 한 번의 파이프라인 실행에서 함께 수집되는지 검증한다.
- 계약시트 실데이터 기준 `teaching_histories` 적재와 파이프라인 로그 기록이 정상 동작하는지 검증한다.

### 13-3. 수집 대상
- Canonical source: Google Sheets API
- Spreadsheet ID: `1QFlQItxBOrnTfF_wvjb5T7fhImbibeK2De4ZFyb0EWA`
- 대상 worksheet:
  - `gid=158052384`
  - `gid=1875350219`
- 두 worksheet는 동일 헤더 매핑을 사용한다. 필드 매핑 계약은 `04_data_pipeline.md` 5-1-1절을 따른다.

### 13-4. 필드 확정 사항
- `company_name`: 계약시트에 직접 대응 컬럼이 없으므로 이번 Pilot 4-1에서는 `NULL`로 둔다.
- `detail_type`: `계약서 유형 선택` 다음의 첫 번째 `세부 유형` 컬럼을 사용한다.
- `start_date`: `강의 일정` 원문에서 파싱한 첫 날짜를 사용한다.
- `end_date`: `강의 일정` 원문에서 파싱한 마지막 날짜를 사용한다.
- 날짜 파싱에 실패하면 `start_date` 또는 `end_date`는 `NULL`로 둔다.
- 날짜 원문은 `date_label`에 그대로 보존한다.

### 13-5. 파이프라인 로그 기록
- `pipeline_runs`는 실행당 1건 기록한다.
- `source_sync_logs`는 worksheet별 1건씩 총 2건 기록한다.

### 13-6. 완료 기준
- 두 worksheet에서 수집한 계약시트 행이 `teaching_histories`에 적재된다.
- `pipeline_runs` 1건과 `source_sync_logs` 2건이 기록된다.
- `04_data_pipeline.md` 5-1-1 매핑 계약과 13-4의 확정 사항이 충돌 없이 반영된다.
