# Slack Coverage Root Cause Report

- 작성일: 2026-04-24
- 워크스페이스: `/Users/ga/workspace/instructor_db`
- 관련 리포트:
  - [reports/slack-daily-coverage-2025-10-24_2026-04-24.json](/Users/ga/workspace/instructor_db/reports/slack-daily-coverage-2025-10-24_2026-04-24.json)
  - [reports/slack-daily-coverage-2025-10-24_2026-04-24.tsv](/Users/ga/workspace/instructor_db/reports/slack-daily-coverage-2025-10-24_2026-04-24.tsv)
  - [reports/slack-daily-coverage-2026-04-20_2026-04-24.json](/Users/ga/workspace/instructor_db/reports/slack-daily-coverage-2026-04-20_2026-04-24.json)
- 관련 코드:
  - [src/app/api/refresh/route.ts](/Users/ga/workspace/instructor_db/src/app/api/refresh/route.ts)
  - [src/app/api/pipeline/slack/route.ts](/Users/ga/workspace/instructor_db/src/app/api/pipeline/slack/route.ts)
  - [scripts/audit-slack-daily-coverage.ts](/Users/ga/workspace/instructor_db/scripts/audit-slack-daily-coverage.ts)

## 결론

`2026-04-22`부터 Slack collector가 갑자기 잘못 동작하기 시작한 것이 아니라, `2026-04-22 10:47 KST` 이후 Slack source를 포함하는 refresh가 더 이상 실행되지 않았습니다.

그 결과:

1. `2026-04-22` 오후 이후 신규 Slack 메시지가 DB에 들어오지 않았습니다.
2. `2026-04-23`에는 오래된 thread에 달린 새 reply가 DB `activity_at`에 반영되지 않아 날짜가 밀린 상태(`stale_activity_at`)가 발생했습니다.
3. `2026-04-24`도 같은 이유로 신규 메시지가 누락됐습니다.

## 질문

왜 Slack 날짜별 coverage가 `2026-04-22`부터 깨졌는가?

## 핵심 판단

가장 가능성이 높은 설명은 아래입니다.

1. `2026-04-20`에도 Slack timeout/DB 연결 오류는 있었지만, 뒤이은 성공 run이 다시 수집해서 coverage gap으로 남지 않았습니다.
2. `2026-04-22` 이후에는 `manual_refresh`, `manual_refresh_lightweight`, `pilot_4_5_slack`가 끊겼고, `postprocess`/`teaching_history` scope 위주로만 실행됐습니다.
3. 이 두 scope는 코드상 Slack source를 아예 실행하지 않으므로, Slack checkpoint와 `activity_import_items`가 더 이상 앞으로 진행되지 않았습니다.

## 근거

### 1. 6개월 coverage audit 기준 첫 이상일은 `2026-04-22`

`2025-10-24`부터 `2026-04-24`까지 183일을 검사한 결과, flagged day는 3일뿐입니다.

- `2026-04-22`: `missing_in_db`
- `2026-04-23`: `missing_and_stale`
- `2026-04-24`: `missing_in_db`

즉 6개월 범위에서 coverage 불일치는 `2026-04-22`에 처음 나타납니다.

### 2. `2026-04-20`에도 Slack 오류는 있었다

DB `source_sync_logs(source_type=slack)`를 보면 `2026-04-20`에 아래 실패가 여러 번 있습니다.

- `2026-04-20 17:53 KST`: `slack source timeout after 90000ms (last_stage=queued)`
- `2026-04-20 17:58 KST`: `slack source timeout after 90000ms (last_stage=queued)`
- `2026-04-20 18:12 KST`: `slack source timeout after 90000ms (last_stage=queued)`
- `2026-04-20 18:43 KST`: `slack source timeout after 150000ms (last_stage=apply messages=2115)`
- `2026-04-20 20:42 KST`: DB 연결 실패

하지만 같은 날과 다음 날에 성공 run이 다시 이어졌습니다.

- `2026-04-20 19:49 KST`: `manual_refresh` 성공, `fetched=4`, `updated=2`
- `2026-04-20 19:55 KST`: `pilot_4_5_slack` 성공, `fetched=18`, `updated=3`
- `2026-04-20 21:02 KST` 이후 여러 차례 `pilot_4_5_slack` 성공
- `2026-04-21 16:44 KST`: `manual_refresh_lightweight` 성공, `fetched=4`, `updated=2`

즉 `2026-04-20` 오류 자체는 사실이지만, coverage 관점에서는 뒤이은 성공 run이 다시 따라잡았습니다.

### 3. `2026-04-22` 이후 Slack source가 멈췄다

DB 기준 마지막 Slack 성공 기록은 `2026-04-22 10:47:36 KST`입니다.

- run type: `pilot_4_5_slack_reconcile`
- status: `success`
- fetched: `398`
- updated: `73`

이후 `2026-04-22`부터 `2026-04-24` 사이의 `pipeline_runs`를 보면 아래 유형만 보입니다.

- `manual_refresh_postprocess`
- `manual_refresh_teaching_history`
- `pilot_4_5_slack_reconcile` (`2026-04-22` 오전까지만)

반대로 아래 run은 보이지 않습니다.

- `manual_refresh`
- `manual_refresh_lightweight`
- `pilot_4_5_slack` (`2026-04-22` 오전 이후 없음)

DB `activity_import_items(source_type=slack)`의 최신 생성 시각도 `2026-04-22 10:22:17 KST`에서 멈춰 있습니다.
최신 수정 시각 역시 `2026-04-22 10:47:21 KST`입니다.

즉 Slack row는 `2026-04-22` 오전 이후 더 이상 새로 들어오지 않았습니다.

### 4. 코드상 `postprocess`와 `teaching_history`는 Slack을 돌리지 않는다

[src/app/api/refresh/route.ts](/Users/ga/workspace/instructor_db/src/app/api/refresh/route.ts:1120)에서 `scope`별로 run type을 분기합니다.

[src/app/api/refresh/route.ts](/Users/ga/workspace/instructor_db/src/app/api/refresh/route.ts:1289) 기준:

- `scope=postprocess` -> `sources = []`
- `scope=teaching_history` -> `contract_sheet`, `instructor_dispatch_sheet`만 실행
- Slack은 전체/lightweight 경로에서만 실행

즉 `postprocess`나 `teaching_history`만 계속 돌면 Slack source는 한 번도 실행되지 않습니다.

### 5. checkpoint도 `2026-04-22` 오전 이후 더 진행되지 않았다

Slack checkpoint 최신값:

- `C015YD84VGS`: `2026-04-21 18:30:00 KST`
- `C099UH7ACGG`: `2026-04-17 14:21:11 KST`
- `C0AS2VDUXQ8`: `2026-04-22 10:10:18 KST`

이 값은 `2026-04-22 10:47 KST` reconcile 이후 저장된 값이고, 그 뒤로 갱신되지 않았습니다.

[src/app/api/refresh/route.ts](/Users/ga/workspace/instructor_db/src/app/api/refresh/route.ts:527)와 [src/app/api/refresh/route.ts](/Users/ga/workspace/instructor_db/src/app/api/refresh/route.ts:885) 주석/코드상 checkpoint는 `applyActivities` 이후에만 전진합니다.

즉 실패 run이 checkpoint를 망가뜨려서 문제가 시작된 패턴은 아닙니다. 오히려 이후 Slack run 자체가 없어서 checkpoint가 멈춘 패턴입니다.

### 6. coverage 누락 샘플도 이 설명과 맞는다

coverage audit 샘플:

- `2026-04-22` 누락 2건은 모두 `ops_report` 메시지이며, 시각이 `2026-04-22 17:43 KST`, `17:44 KST`입니다.
- 마지막 Slack sync가 `2026-04-22 10:47 KST`이므로, 그 뒤 메시지가 DB에 없는 것은 자연스럽습니다.
- `2026-04-23`의 stale 샘플 4건은 `dispatch_request` thread에서 `latest_reply_at`이 `2026-04-23`으로 갱신됐지만 DB `activity_at`은 `2026-04-20` 또는 `2026-04-22`에 머물러 있습니다.

즉:

- 신규 message 누락은 "Slack source 미실행"
- late reply 날짜 밀림은 "reconcile/full scan 미실행"

으로 설명됩니다.

## 원인 요약

직접 원인:

- `2026-04-22 10:47 KST` 이후 Slack source를 포함한 refresh가 더 이상 돌지 않았습니다.

운영상의 근본 원인 후보:

1. cron 또는 외부 트리거가 `scope=lightweight`/전체 refresh 대신 `scope=postprocess` 또는 `scope=teaching_history`만 호출했을 가능성
2. 운영자가 수동으로 후처리/teaching-history만 반복 실행했을 가능성
3. 전체/lightweight refresh 스케줄이 중단되었을 가능성

주의:

- 이 저장소와 DB만으로는 위 3개 중 어느 것이 실제 원인인지는 확정할 수 없습니다.
- 다만 "Slack source가 실행되지 않은 상태가 계속됐다"는 사실 자체는 확정적입니다.

## 왜 `2026-04-20`이 아니라 `2026-04-22`부터 coverage가 깨졌는가

`2026-04-20`에는 실패가 있었지만, 이후 성공 run이 이어져 데이터를 다시 반영했습니다.

`2026-04-22`는 다릅니다.

- 오전 reconcile까지만 Slack row가 갱신됨
- 그 이후 Slack source를 도는 run이 사라짐
- 따라서 그날 오후부터는 누락이 누적되기 시작함

즉 `2026-04-20`은 장애가 있었던 날이고, `2026-04-22`는 coverage gap이 실제로 고착된 시작일입니다.

## 재발 방지 대책

### A. 운영 즉시 조치

1. Slack을 포함하는 정기 run을 명시적으로 유지한다.
   - 최소 기준: `scope=lightweight` 또는 전체 `POST /api/refresh`
   - 더 안전한 기준: 별도 `POST /api/pipeline/slack` 정기 실행 추가

2. Slack reconcile을 별도 스케줄로 매일 1회 이상 돌린다.
   - 이유: Slack incremental은 top-level message `ts` 기준이라 오래된 thread의 새 reply를 놓칠 수 있음
   - collector 주석에도 이 한계가 명시돼 있음

3. 운영 문서에 "postprocess/teaching_history는 Slack을 갱신하지 않는다"를 명시한다.
   - 지금처럼 이 두 scope만 반복 실행하면 Slack freshness는 반드시 깨진다

### B. 코드 레벨 가드

1. freshness guard를 추가한다.
   - 기준 예시: `latest successful slack sync`가 6시간 또는 12시간 이상 없으면 `warning`, 24시간 이상이면 `error`
   - 체크 소스: `source_sync_logs(source_type=slack)` 또는 `source_checkpoints(source_type=slack)`

2. `postprocess` / `teaching_history` run에서 stale warning을 남긴다.
   - 예: "최근 Slack sync가 오래됐는데 Slack source 없이 후처리만 실행 중" 경고를 `pipeline_runs.summary`와 `source_sync_logs`에 기록

3. `/api/status` 또는 운영 대시보드에 Slack freshness를 노출한다.
   - `last_successful_slack_sync_at`
   - `hours_since_last_successful_slack_sync`
   - `latest_slack_checkpoint_at`
   - `latest_slack_item_created_at`

4. cron 호출 파라미터를 고정 검증한다.
   - cron이 의도치 않게 `scope=postprocess`만 호출하고 있지 않은지 배포 설정에서 점검
   - 필요하면 cron 전용 엔드포인트를 Slack 포함/미포함으로 분리

### C. 품질 감시

1. `audit:slack:daily-coverage`를 자동화한다.
   - rolling 7일 또는 30일 기준으로 매일 실행
   - `flaggedDays > 0`이면 운영 알림 발송

2. Slack source 미실행 감시를 추가한다.
   - "최근 24시간 내 Slack success log 없음"
   - "최근 24시간 내 Slack item createdAt 없음"

3. late reply drift 감시를 추가한다.
   - `latest_reply_at`가 오늘인데 DB `activity_at`가 이전 날짜에 머문 row 수를 집계
   - 이 수치가 0이 아니면 reconcile 필요 신호로 사용

## 권장 우선순위

즉시 해야 할 것:

1. cron/운영 호출이 `scope=lightweight` 또는 전체 refresh를 실제로 계속 치고 있는지 확인
2. `POST /api/pipeline/slack?mode=reconcile`을 1회 실행해 누락분 복구
3. Slack freshness alert 추가

이번 주 안에 해야 할 것:

1. Slack 전용 cron 추가
2. daily coverage audit 자동화
3. `postprocess`/`teaching_history` stale warning 추가

## 한 줄 요약

이번 이슈는 Slack collector 자체가 `2026-04-22`부터 망가진 것이 아니라, 그 시점 이후 Slack source를 포함하는 동기화가 끊기면서 발생한 운영/스케줄 계열 문제입니다. 재발 방지는 "Slack 포함 정기 run 보장", "freshness alert", "주기적 reconcile" 세 축으로 잡아야 합니다.
