# Parallel Bundle Guardrails

## Role
이 문서는 Wave 1 태스크를 `validated-plan` 기반 병렬 작업 묶음으로 실행할 때 필요한
공통 고정 항목, 그룹별 수정 가능 범위, 충돌 파일 담당 그룹, 마지막 통합 단계 범위를 정의한다.

## Source of Truth
- 병렬 `validated-plan` 실행 전제
- 공통 고정 항목
- 그룹별 수정 가능 / 수정 금지 파일
- 충돌 파일 담당 그룹
- `T5` 통합 단계 수정 가능 범위

## Depends On
- `08_decision_log.md`
- `10_execution_plan.md`
- `11_wave1_tasks.md`

## Used By
- `validated-plan`으로 병렬 작업 묶음을 쪼개는 오케스트레이터
- 병렬 구현에 참여하는 Codex / Claude Code 세션
- 최종 통합 담당 세션

## Out of Scope
- 태스크의 제품 의미 재정의
- 세부 구현 로직
- 머지 도구 선택

## 1. 적용 원칙

- `11_wave1_tasks.md`는 **태스크의 의미 / 참조 문서 / 완료 기준**을 정의한다.
- 이 문서는 **실제 병렬 실행 시의 파일 담당 그룹 / 공통 고정 항목 / 통합 순서**를 정의한다.
- 두 문서가 충돌할 때:
  - 태스크 의미와 완료 기준은 `11_wave1_tasks.md`를 따른다.
  - 파일 수정 권한과 병렬 실행 규칙은 **이 문서가 우선**한다.

### 1-1. baseline stale 검증 절차

- worktree 기반 sub-agent가 `schema_missing`, 모델/필드 누락, baseline 미반영 같은 진단을 내리면 보고 전에 아래 3개를 먼저 확인한다.
  1. `pwd`
  2. `git rev-parse --short HEAD`
  3. `grep -E "^model " prisma/schema.prisma`
- 목적:
  - 현재 세션이 `main HEAD`가 아닌 stale worktree/branch 위에 있는지 확인
  - 실제 schema 파일 기준으로 누락 여부를 재검증
- stale로 판명되면:
  - `git rebase main`
  - 또는 `main HEAD`에서 새 worktree/새 세션 시작
- baseline stale 문제는 graceful degrade 코드로 숨기지 않는다.

## 2. 실행 구조

Wave 1 병렬 실행은 아래 구조를 기본으로 한다.

- Group 1: `T1, T2, T3`
- Group 2: `T4, T9`
- Group 3: `T6, T7, T8`
- 마지막 통합: `T5`

단, 현재 저장소 기준으로는 `T1`의 실질 산출물(`prisma/schema.prisma`)이 이미 baseline에 반영되어 있다.
따라서 Group 1은 **의미상 `T1~T3` 묶음**이지만, 실제 수정 가능 범위는 `T2/T3` 중심으로 제한한다.

## 3. 공통 고정 항목

아래 파일/영역은 **전 그룹 수정 금지**다.

- `docs/**`
- `prisma/schema.prisma`
- `src/lib/score-recalculator.ts`
- `src/lib/pipeline/satisfaction-applier.ts`
- `src/lib/pipeline/activity-applier.ts`
- `src/lib/google-user-oauth.ts`

해석 규칙:
- 위 파일이 필요해 보이면 임의 수정하지 말고 blocker로 올린다.
- 공통 계약 변경이 필요하면 먼저 `08_decision_log.md`와 관련 문서를 갱신한 뒤 별도 단일 세션에서 처리한다.

## 4. Group 1 — `T1, T2, T3`

### 4-1. 역할
- `T2` 상세 패널 UI
- `T3` 만족도 작성 UI
- `page.tsx` 레이아웃 연결
- `T1`은 **baseline schema 확인 역할만** 가진다. schema 수정은 하지 않는다.

### 4-2. 수정 가능 파일
- `src/components/InstructorDetail.tsx`
- `src/components/InstructorList.tsx`
- `src/app/page.tsx`
- Group 1 범위 안에서 필요한 신규 컴포넌트 파일
  - 단, `src/components/FallbackBanner.tsx`는 Group 2 소유이므로 제외

### 4-3. 수정 금지 파일
- `prisma/schema.prisma`
- `src/app/api/status/route.ts`
- `src/app/api/refresh/route.ts`
- `src/app/api/review-decisions/route.ts`
- `src/components/FallbackBanner.tsx`
- `src/lib/pipeline/**`
- 공통 고정 항목 전체

### 4-4. 파일 담당 그룹
- `src/app/page.tsx`의 **주 담당 그룹은 Group 1**에 있다.
- 다른 그룹은 `src/app/page.tsx`를 직접 수정하지 않는다.
- 마지막 `T5` 통합 단계에서는 status/refresh 관련 최소 후속 연결만 허용된다.
- Group 1은 `page.tsx` 안에서 fallback/status UI가 들어갈 slot과 렌더 조건을 준비하고, fallback 배너의 실제 연결까지 책임진다.

## 5. Group 2 — `T4, T9`

### 5-1. 역할
- `T4` `GET /api/status`
- `T9` fallback 배너 UI

### 5-2. 수정 가능 파일
- `src/app/api/status/route.ts`
- `src/components/FallbackBanner.tsx`
- Group 2 범위 안에서 필요한 신규 상태/배너 컴포넌트 파일

### 5-3. 수정 금지 파일
- `src/app/page.tsx`
- `src/app/api/refresh/route.ts`
- `src/components/InstructorDetail.tsx`
- `src/components/InstructorList.tsx`
- `src/lib/pipeline/**`
- 공통 고정 항목 전체

### 5-4. 파일 담당 그룹
- `T9`는 배너 컴포넌트와 표시 계약만 제공한다.
- `T9`는 `src/app/page.tsx`에 직접 배너를 삽입하지 않는다.
- `page.tsx`와의 실제 연결은 Group 1이 수행한다.
- Group 2는 단순 렌더링 컴포넌트만 남기지 않는다.
  - Group 1이 바로 연결할 수 있도록 props / 표시 조건 / 최소 1개 사용 예시를 최종 보고에 포함한다.

## 6. Group 3 — `T6, T7, T8`

### 6-1. 역할
- `T6` 실습코치 3-Layer 판정
- `T7` fee 우선순위 체인 + 특수금액 분리
- `T8` `fee_histories` 적재 + 상세 API fee history 노출

### 6-2. 수정 가능 파일
- `src/lib/pipeline/practice-coach-detector.ts`
- `src/lib/pipeline/fee-resolver.ts`
- `src/lib/pipeline/fee-history-store.ts`
- `src/app/api/instructors/[id]/route.ts`
- Group 3 범위 안에서 필요한 신규 pipeline helper 파일

### 6-3. 수정 금지 파일
- `src/app/api/refresh/route.ts`
- `src/app/api/status/route.ts`
- `src/app/page.tsx`
- `src/components/**`
- 공통 고정 항목 전체

### 6-4. 파일 담당 그룹
- Group 3은 **pipeline module과 상세 API 반환 구조까지만** 구현한다.
- `refresh` 오케스트레이션에 실제로 이 모듈을 연결하는 작업은 하지 않는다.
- `src/app/api/refresh/route.ts` 연결은 마지막 `T5` 단계 전용이다.
- Group 3은 최종 보고에서 아래를 반드시 명시한다.
  - `refresh`에 아직 연결되지 않은 범위
  - `T5`가 연결해야 하는 entry point
  - 외부 source/runtime 실패와 구현 실패를 구분하는 기준

## 7. `T5` — 마지막 통합 단계

### 7-1. 역할
- 전체 refresh orchestration
- Group 1~3 산출물 연결
- 마지막 build / refresh / E2E 확인

### 7-1-1. `T5` 진입 기준
- `T5`는 아래 조건을 모두 만족할 때만 시작한다.
  - Group 1~3이 자기 수정 가능 범위 안에서만 작업을 마쳤다.
  - Group 1~3이 공통 고정 항목을 수정하지 않았다.
  - Group 1~3의 최종 보고에서 blocker가 없다.
  - Group 1~3이 각자 `npm run build` 기준을 통과했다.
- 위 조건 중 하나라도 만족하지 못하면 `T5`는 시작하지 않고 해당 그룹으로 되돌린다.

### 7-2. 수정 가능 파일
- `src/app/api/refresh/route.ts`
- `src/app/page.tsx`
  - 단, status/refresh 관련 최소 범위만 허용
- 통합 과정에서 필요한 매우 제한된 wiring 파일

### 7-3. 수정 금지 파일
- Group 1~3의 내부 로직 파일 재작성
- 공통 고정 항목 전체

### 7-4. 통합 규칙
- `T5`는 새 기능을 확장하는 단계가 아니다.
- `T5`는 Group 1~3 결과를 **문서 계약대로 연결하고 검증하는 단계**다.
- `T5`에서 upstream 로직 결함이 발견되면 그 그룹으로 되돌리고, 통합 단계에서 임의 우회 구현하지 않는다.
- `T5`는 fallback 배너의 위치, 조건, 실제 연결을 새로 설계하거나 대신 구현하지 않는다.
- Group 1이 fallback 배너 연결을 완료하지 못한 상태면 `T5` 진입 blocker로 본다.
- `T5`는 아래를 구분해서 보고한다.
  - 구현 실패: wiring 누락, 문서 계약 불일치, 타입/빌드 실패, API 응답 구조 불일치
  - 외부 source/runtime 실패: 인증, 권한, 네트워크, 외부 API 응답 문제
- 외부 source/runtime 실패는 `T5`의 구현 실패로 간주하지 않지만, 최종 동작 실패 원인으로 별도 보고한다.

## 8. 충돌 파일 담당 그룹 요약

| 파일 | 담당 그룹 | 비고 |
|---|---|---|
| `prisma/schema.prisma` | 공통 고정 | 현재 baseline, 병렬 수정 금지 |
| `src/app/page.tsx` | Group 1 | `T5`만 마지막에 최소 수정 허용 |
| `src/app/api/status/route.ts` | Group 2 | 단독 소유 |
| `src/app/api/refresh/route.ts` | `T5` | 병렬 그룹 수정 금지 |
| `src/app/api/instructors/[id]/route.ts` | Group 3 | `fee_history` 노출 범위 |
| `src/components/FallbackBanner.tsx` | Group 2 | 배너 정의만 담당 |
| `src/lib/score-recalculator.ts` | 공통 고정 | 현재 baseline 유지 |
| `src/lib/pipeline/satisfaction-applier.ts` | 공통 고정 | 공통 applier |
| `src/lib/pipeline/activity-applier.ts` | 공통 고정 | 공통 applier |

## 9. `validated-plan` 프롬프트에 반드시 넣을 제약

각 그룹에 `validated-plan`을 사용할 때 아래를 함께 넣는다.

- 이 그룹의 태스크 묶음
- 수정 가능 파일 목록
- 수정 금지 파일 목록
- 공통 고정 항목
- 다른 그룹의 담당 파일
- `T5`가 마지막 통합 단계라는 사실

핵심 문구:
- "문서 의미와 완료 기준은 `11_wave1_tasks.md`를 따르되, 파일 수정 권한은 `12_parallel_bundle_guardrails.md`를 우선한다."
- "허용되지 않은 파일을 수정해야 하면 구현하지 말고 blocker로 보고한다."

## 10. 실행 순서

1. 공통 고정 항목과 파일 담당 그룹을 전 그룹이 확인한다.
2. Group 1, Group 2, Group 3에 대해 각각 `validated-plan`을 실행한다.
3. Group 1~3을 병렬 구현한다.
4. 각 그룹 종료 시 `node wave1-preflight.mjs`를 다시 실행해 공통 고정 항목 위반과 build 상태를 확인한다.
5. 마지막에 `T5`를 단일 세션에서 수행한다.
6. build / refresh / E2E를 통합 검증한다.

## 11. 완료 판정

병렬 실행은 아래를 만족할 때 성공으로 본다.

- Group 1~3이 파일 담당 그룹 위반 없이 완료된다.
- `T5`가 upstream 재작업 없이 wiring과 검증만으로 끝난다.
- 같은 파일을 두 그룹이 동시에 수정하지 않는다.
- 문서 계약 위반이 blocker로 적절히 보고된다.
