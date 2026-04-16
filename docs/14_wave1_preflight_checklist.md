# Wave 1 Preflight Checklist

## Role
이 문서는 Wave 1 grouped 병렬 구현을 시작하기 전과 마지막 `T5` 통합 단계에 들어가기 전에
반드시 확인해야 하는 실행 체크리스트를 정의한다.

## Source of Truth
- Group 1~3 실행 전 필수 점검 항목
- Group 3 데이터 선행조건
- `T5` 진입 전 확인 항목
- 시작 가능 / 시작 보류 판정 기준

## Depends On
- `00_docs_index.md`
- `10_execution_plan.md`
- `11_wave1_tasks.md`
- `12_parallel_bundle_guardrails.md`

## Used By
- Wave 1 grouped 병렬 구현 시작 전 점검 담당자
- `T5` 통합 실행 전 최종 확인 담당자

## Out of Scope
- 태스크 의미 정의
- 제품 기능 정의
- 코드 구현 상세

## 1. Group 1~3 시작 전 체크

아래 항목은 Group 1, Group 2, Group 3을 시작하기 전에 확인한다.

### 1-1. 문서 확인
- `11_wave1_tasks.md`를 읽고 각 태스크의 의미와 완료 기준을 확인했다.
- `12_parallel_bundle_guardrails.md`를 읽고 공통 고정 항목, 수정 가능 범위, 파일 담당 그룹을 확인했다.
- grouped 병렬 실행에서는 `11_wave1_tasks.md`보다 `12_parallel_bundle_guardrails.md`의 파일 담당 그룹이 우선한다는 점을 확인했다.

### 1-2. 공통 고정 항목 확인
- 아래 파일은 병렬 그룹에서 수정하지 않기로 확인했다.
  - `docs/**`
  - `prisma/schema.prisma`
  - `src/lib/score-recalculator.ts`
  - `src/lib/pipeline/satisfaction-applier.ts`
  - `src/lib/pipeline/activity-applier.ts`
  - `src/lib/google-user-oauth.ts`

### 1-3. 실행 환경 확인
- `NOTION_API_KEY`
- `NOTION_DATABASE_ID`
- `SALESMAP_SNAPSHOT_PATH`
- `SLACK_BOT_TOKEN`
- `SLACK_WORKSPACE_ID`
- `GMAIL_CLIENT_ID`
- `GMAIL_CLIENT_SECRET`
- `GMAIL_REFRESH_TOKEN`
- `GMAIL_ACCOUNT_EMAIL`
- `GMAIL_TARGET_ADDRESSES`
- `GOOGLE_SERVICE_ACCOUNT_JSON`
- `GOOGLE_CONTRACTS_SPREADSHEET_ID`

규칙:
- 값이 없거나 잘못된 경우 구현으로 우회하지 않는다.
- 필요한 source 접근이 불가능하면 blocker로 보고한다.

## 2. Group 3 시작 전 데이터 선행조건

Group 3은 아래 데이터와 구조가 baseline에 반영되어 있어야 한다.

- `teaching_histories.contract_type`
- `teaching_histories.detail_type`
- `instructors.is_fulltime`
- `fee_fix_configs` 테이블/모델

규칙:
- `teaching_histories.contract_type`, `teaching_histories.detail_type`, `instructors.is_fulltime`는 실제 값이 채워져 있어야 한다.
- `fee_fix_configs`는 수동 보정용 Source of Truth이므로 **테이블/모델이 존재하고 조회 가능하면 된다.**
- `fee_fix_configs` row 수가 `0`인 것은 blocker가 아니다.
- 위 required baseline 값이 비어 있거나 구조가 미반영 상태면 Group 3 구현을 진행하지 않는다.
- 코드에서 임시 기본값으로 덮지 않고 blocker로 보고한다.

## 3. Group 1~3 완료 후 `T5` 진입 전 체크

아래 항목은 `T5` 시작 직전에 확인한다.

### 3-1. 범위 위반 체크
- Group 1은 `src/app/page.tsx`, `InstructorDetail`, `InstructorList` 범위만 수정했다.
- Group 2는 `src/app/api/status/route.ts`, `src/components/FallbackBanner.tsx` 범위만 수정했다.
- Group 3은 pipeline helper들과 `src/app/api/instructors/[id]/route.ts` 범위만 수정했다.
- 어떤 그룹도 다른 그룹 담당 파일을 직접 수정하지 않았다.

### 3-2. 공통 고정 항목 위반 체크
- Group 1~3 중 어느 그룹도 공통 고정 항목을 수정하지 않았다.

### 3-3. blocker 체크
- Group 1 최종 보고에 blocker가 없다.
- Group 2 최종 보고에 blocker가 없다.
- Group 3 최종 보고에 blocker가 없다.

### 3-4. 빌드 체크
- Group 1은 `npm run build`를 통과했다.
- Group 2는 `npm run build`를 통과했다.
- Group 3은 `npm run build`를 통과했다.

## 4. 시작 판정

### 4-1. Group 1~3 시작 가능
아래를 모두 만족하면 Group 1~3을 시작할 수 있다.
- 1절 체크 완료
- Group 3을 실행할 경우 2절 체크 완료

### 4-2. `T5` 시작 가능
아래를 모두 만족하면 `T5`를 시작할 수 있다.
- 3절 체크 완료
- 검사 결과가 `T5 통합 진행 가능`

### 4-3. 시작 보류
아래 중 하나라도 해당하면 시작하지 않는다.
- 필수 환경변수/권한 누락
- Group 3 required baseline 값 누락
- `fee_fix_configs` 구조 미반영 또는 조회 불가
- 공통 고정 항목 수정 발생
- 파일 담당 그룹 위반
- blocker 존재
- 그룹별 build 실패
