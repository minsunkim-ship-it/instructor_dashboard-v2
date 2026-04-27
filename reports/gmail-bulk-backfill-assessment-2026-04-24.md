# Gmail Bulk Backfill Assessment

Generated: 2026-04-24
Focus window: 2026-04-16 to 2026-04-21
Target corpus: historical Gmail activity for 2025-10-24 to 2026-04-24

## Conclusion

`2026-04-16`부터 `2026-04-21`까지의 Gmail 처리 흔적은 충분히 **bulk backfill 실행 기간**으로 분류할 수 있다.

중요한 구분:

- `2026-04-16` ~ `2026-04-21`는 **실행 기간**이다.
- 실제로 메우려 했던 대상은 `2025-10-24` ~ `2026-04-24`의 **6개월 historical corpus**다.

핵심 근거는 실행 기간의 길이가 아니라 실행 패턴이다.

- Gmail sync 로그가 이 구간에 처음 등장한다.
- 같은 짧은 기간 안에 대량 fetch가 반복된다.
- 성공, partial, timeout, 오류가 섞여 있다.
- 실제 Gmail raw import row 생성도 이 구간에 집중되어 있다.

이 패턴은 “메일이 들어올 때마다 정상 incremental로 쌓인 운영 흐름”보다 “과거 누적 메일을 단기간에 대량으로 메우려 한 배치성 backfill”에 훨씬 가깝다.

## Evidence

### 1. Gmail sync / import 시작 시점이 2026-04-16 이후에 몰려 있음

DB 기준:

- `source_sync_logs` for `source_type = "gmail"`
  - min `started_at`: `2026-04-16 04:37:54+00`
  - max `started_at`: `2026-04-21 07:44:41+00`
  - count: `47`
- `activity_import_items` for `source_type = "gmail"`
  - min `created_at`: `2026-04-16 04:40:40+00`
  - max `created_at`: `2026-04-21 07:44:46+00`
  - count: `7056`

의미:

- 현재 DB 스냅샷에서 Gmail raw import corpus는 사실상 이 6일 동안 만들어졌다.
- 즉, 6개월치 Gmail 활동이 장기간 incremental로 축적된 흔적이 아니라, 짧은 기간에 대량 생성된 흔적이다.

### 2. 같은 기간에 대량 fetch가 반복됨

대표 로그:

- `2026-04-17T02:50:07Z | success | fetched_count=998 | updated_count=9`
- `2026-04-17T04:20:30Z | success | fetched_count=998 | updated_count=9`
- `2026-04-18T03:27:47Z | success | fetched_count=998 | updated_count=9`
- `2026-04-20T09:46:19Z | success | fetched_count=997 | updated_count=9`
- `2026-04-21T01:25:54Z | partial | fetched_count=500 | updated_count=65 | invalid_items:227`
- `2026-04-21T01:35:49Z | partial | fetched_count=2000 | updated_count=119 | invalid_items:1129`
- `2026-04-21T01:37:53Z | partial | fetched_count=2000 | updated_count=118 | invalid_items:1129`
- `2026-04-21T02:34:30Z | partial | fetched_count=4000 | updated_count=174 | invalid_items:2092`

의미:

- 운영 incremental이라면 보통 최근 소량만 들어오는 게 자연스럽다.
- 여기서는 같은 시기 메일이 아니라 과거 누적분을 크게 긁는 패턴이 반복된다.
- 특히 `998`, `2000`, `4000` 같은 큰 fetch는 배치성 재수집 시도라고 보는 게 합리적이다.

### 3. 실패/partial/timeout이 섞여 있음

대표 로그:

- `2026-04-16T05:12:12Z | failed | Cannot read properties of undefined (reading 'findMany')`
- `2026-04-17T04:12:25Z | failed | codex verification interrupted before gmail completion`
- `2026-04-20T08:54:48Z` ~ `2026-04-20T09:38:23Z`
  - repeated `failed`
  - `gmail source timeout after 90000ms (last_stage=queued)`
- 여러 run이 `partial`
  - `invalid_items:*`
  - `reflected_instructors=0 ...`

의미:

- bulk backfill을 수행하던 중 안정적으로 한 번에 끝난 것이 아니라,
- 반복 재시도와 부분 성공이 섞여 있었고,
- 결과적으로 raw import coverage가 균일하지 않게 남았을 가능성이 크다.

### 4. 실제 coverage audit 결과와도 일치함

read-only daily coverage audit 결과:

- 전체 183일 중 `150일`이 `missing_in_db`
- 전체 raw coverage gap: `24.2%`
- `2026-01` ~ `2026-02` gap: `83.3%`
- `2026-03` ~ `2026-04-24` gap: `12.6%`

해석:

- historical corpus를 bulk backfill로 메우려 했지만 완결되지 않았다.
- 특히 `2026-01` ~ `2026-02`는 거의 비어 있고,
- `2026-03` ~ `2026-04`는 많이 들어왔지만 잔여 누락이 남아 있다.

## Why This Can Happen Again

현재 구조상 아래 지점들이 재발 가능성을 만든다.

### 1. 대량 수집인데도 “완결성”을 보장하는 표시가 없음

현재 refresh Gmail 수집은:

- `maxPages: 10`
- `pageSize: 100`

로 호출된다.

Reference:

- [src/app/api/refresh/route.ts](/Users/ga/workspace/instructor_db/src/app/api/refresh/route.ts:936)

문제:

- 큰 mailbox/backfill 상황에서 이 값은 수집 상한이 된다.
- 그런데 현재 결과 summary에는 “이번 run이 page cap에 걸렸는지”, “nextPageToken이 남았는지”, “수집이 완결됐는지”가 구조적으로 남지 않는다.
- 그래서 부분 수집이어도 운영자가 성공처럼 오인할 수 있다.

### 2. checkpoint는 있지만 “부분 backfill에서 안전한 watermark” 개념이 약함

현재 mailbox checkpoint는 `gmail:mailbox` 단일 key 하나다.

Reference:

- [src/app/api/refresh/route.ts](/Users/ga/workspace/instructor_db/src/app/api/refresh/route.ts:619)

문제:

- 대량 backfill을 일반 incremental과 같은 checkpoint로 처리하면,
- 완전성 검증 없이 watermark를 전진시키기 쉽다.
- 그러면 아직 못 본 구간이 있어도 이후 incremental에서 자연스럽게 스킵될 수 있다.

### 3. thread detail fetch 실패가 조용히 누락될 수 있음

collector는 thread detail fetch에서 예외가 나면 `null`을 반환하고 넘어간다.

Reference:

- [src/lib/pipeline/gmail-activity-collector.ts](/Users/ga/workspace/instructor_db/src/lib/pipeline/gmail-activity-collector.ts:240)

문제:

- 일부 thread가 네트워크/timeout/개별 fetch 오류로 빠져도 run이 계속된다.
- 지금 구조에서는 “list에는 있었는데 detail fetch에서 빠진 개수”가 별도 지표로 남지 않는다.
- 그래서 partial loss가 조용히 쌓일 수 있다.

### 4. 성공 여부가 raw coverage 기준이 아니라 apply 결과 중심으로 보임

현재 run 상태는 주로 `applyActivities` 결과와 aggregate 반영 여부를 기준으로 해석된다.

Reference:

- [src/app/api/refresh/route.ts](/Users/ga/workspace/instructor_db/src/app/api/refresh/route.ts:948)

문제:

- raw import coverage가 불완전해도 일부 row가 반영되면 “어느 정도 성공”처럼 보일 수 있다.
- 하지만 historical backfill에서는 “몇 건 반영됐는가”보다 “해당 window raw corpus를 다 가져왔는가”가 더 중요하다.

## How To Prevent This

아래는 우선순위 순서다.

### A. Backfill과 incremental을 운영적으로 분리

원칙:

- incremental은 `gmail:mailbox` checkpoint 기반
- backfill은 날짜 window 기반 전용 job

권장:

- backfill은 `YYYY-MM-DD ~ YYYY-MM-DD` 구간을 명시적으로 받는다.
- mailbox-wide one-shot backfill을 피하고, 일 단위 또는 주 단위 chunk로 고정한다.
- backfill job은 일반 incremental checkpoint를 직접 전진시키지 않는다.

효과:

- partial backfill이 live incremental watermark를 오염시키지 않는다.

### B. “완결성”이 확인되지 않으면 checkpoint를 전진시키지 않기

필요한 체크:

- list 단계에서 `maxPages`에 도달했는지
- 마지막 페이지에서 `nextPageToken`이 남아 있었는지
- mailbox timeout이 있었는지
- detail fetch 실패 건수가 0인지

정책:

- 위 조건 중 하나라도 true면 run을 `incomplete_backfill` 또는 `partial_fetch`로 기록한다.
- 이 경우 checkpoint는 유지한다.

효과:

- “일부만 읽고 watermark는 앞으로 갔다”는 최악의 형태를 막을 수 있다.

### C. detail fetch 실패를 silent drop 하지 않기

현재:

- detail fetch 예외 시 `return null`

개선:

- `dropped_thread_ids`, `detail_fetch_failures`를 명시적으로 집계한다.
- failure count > 0 이면 run status를 `partial` 또는 `failed`로 강등한다.
- backfill mode에서는 failure count > 0 이면 기본적으로 실패 처리한다.

효과:

- 실제 raw corpus 손실이 통계로 보인다.

### D. backfill 결과에 coverage audit를 붙이기

지금 추가한 daily coverage audit 같은 비교를 backfill 직후 자동으로 붙여야 한다.

권장:

- backfill batch 종료 후 같은 날짜 window에 대해 read-only coverage compare 실행
- `collected_threads == db_rows_found`일 때만 batch 완료로 간주
- 차이가 남으면 다음 chunk로 넘어가지 말고 재시도/조사

효과:

- backfill이 “돌아갔다”가 아니라 “채워졌다”로 검증된다.

### E. run summary에 운영자가 바로 이해할 수 있는 메타데이터 추가

필수 필드:

- `list_pages_fetched`
- `list_page_cap_hit`
- `next_page_token_remaining`
- `detail_fetch_failures`
- `threads_listed`
- `threads_loaded`
- `threads_dropped_before_apply`
- `checkpoint_advanced`

효과:

- 로그만 봐도 bulk backfill이 완결됐는지 즉시 판단 가능하다.

### F. historical recovery는 기간을 나눠서 수행

권장 chunk:

- 일 단위, 또는
- 최대 7일 단위

하지 말아야 할 것:

- 6개월 mailbox-wide를 한 번에 대량 재적재

효과:

- 실패 범위를 좁히고 재시도 비용을 줄인다.
- 어느 구간이 비었는지 진단하기 쉬워진다.

## Recommended Operational Policy

간단히 정리하면 다음 운영 규칙이 적절하다.

1. Incremental과 backfill은 다른 job type으로 분리한다.
2. Backfill은 날짜 window 기반으로만 실행한다.
3. Page cap hit, timeout, detail fetch failure가 있으면 checkpoint를 전진시키지 않는다.
4. Backfill 완료 조건은 apply 성공이 아니라 coverage compare 통과다.
5. 대량 historical recovery는 일 단위 또는 주 단위 chunk만 허용한다.

## Practical Bottom Line

`2026-04-16`~`2026-04-21`는 bulk backfill로 보는 것이 맞다.

그리고 그 backfill이 불완전하게 끝났기 때문에,

- `2026-01` ~ `2026-02`에는 대규모 raw import hole이 남았고
- `2026-03` ~ `2026-04`에도 잔여 누락이 남아 있다.

재발을 막으려면 핵심은 하나다.

**“대량 backfill을 실행했다”와 “그 기간 raw corpus를 완전히 채웠다”를 같은 말로 취급하지 말아야 한다.**

완결성 검증과 checkpoint 안전장치를 먼저 붙여야 한다.
