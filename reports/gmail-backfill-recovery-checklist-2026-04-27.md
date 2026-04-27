# Gmail Historical Backfill 대응 체크리스트

작성 시각: 2026-04-27  
대상: Gmail historical activity 누락이 의심될 때의 조사, 복구, 기록 기준

## 1. 언제 이 체크리스트를 쓰나

아래 중 하나라도 해당하면 이 체크리스트를 바로 쓴다.

- 특정 사용자 Gmail 데이터가 실제 메일량보다 적어 보인다
- 최근 3~6개월을 한 번에 backfill 했거나 하려 한다
- source sync는 성공/partial인데 DB raw row 수가 기대보다 낮다
- 월별/날짜별로 유독 비어 있는 구간이 보인다
- incremental은 돌아가는데 과거 구간 정확도가 의심된다

이 체크리스트는 “원인 추정”보다 먼저 **raw coverage가 실제로 비어 있는지**를 확인하는 데 목적이 있다.

## 2. 다른 사용자도 같은 리스크인지 빠르게 보는 체크리스트

### 고위험 사용자

- 첫 Gmail 동기화를 최근에 붙인 사용자
- 과거 3~6개월치를 한 번에 메우려는 사용자
- 특정 시점에 메일량이 급증하는 사용자
- source sync log는 많은데 `activity_import_items(source_type='gmail')` 생성 시점이 짧은 기간에 몰린 사용자
- 주간/월간 운영 메일이 많은 사용자

### 빠른 확인 질문

- Gmail raw import row 생성 시점이 장기간에 걸쳐 분산돼 있는가, 아니면 며칠에 몰려 있는가
- source sync 로그에 `fetched_count`가 비정상적으로 큰 run이 짧은 기간에 반복됐는가
- partial / timeout / error가 backfill 시기와 겹치는가
- 일별 compare에서 `missing_in_db`가 특정 월에 몰려 있는가

## 3. 대응 원칙

### 절대 원칙

1. incremental과 backfill을 같은 운영 행위로 취급하지 않는다
2. “route가 성공했다”와 “데이터가 완전히 채워졌다”를 같은 말로 쓰지 않는다
3. coverage compare 없이 bulk backfill 완료 판정을 하지 않는다
4. 날짜 window 단위로 복구한다
5. incomplete fetch면 checkpoint를 전진시키지 않는다

### 지금 코드 기준으로 이미 막아둔 것

- Gmail collector가 `fetchComplete`, `pageCapHit`, `nextPageTokenRemaining`, `threadsListed`, `threadsLoaded`, `threadsDroppedBeforeApply`, `detailFetchFailures`를 남김
- fetch가 불완전하면 checkpoint를 올리지 않음

관련 코드:

- [gmail-activity-collector.ts](/Users/ga/workspace/instructor_db/src/lib/pipeline/gmail-activity-collector.ts)
- [pipeline gmail route](/Users/ga/workspace/instructor_db/src/app/api/pipeline/gmail/route.ts)
- [refresh route](/Users/ga/workspace/instructor_db/src/app/api/refresh/route.ts)

## 4. 조사 순서

### Step 1. read-only coverage compare

먼저 의심 구간을 날짜별로 비교한다.

```bash
npm run audit:gmail:daily-coverage -- --start=YYYY-MM-DD --end=YYYY-MM-DD --max-pages=20 --page-size=500
```

이 결과에서 본다.

- `collectedThreads`
- `dbRowsFound`
- `missingInDb`
- `status`

해석:

- `status=ok`: 그 날짜 raw coverage는 채워져 있음
- `status=missing_in_db`: Gmail에는 있는데 DB raw row가 없음
- `status=empty`: 그 날짜 Gmail query 결과 자체가 0건

### Step 2. 구간 분할

결과를 세 구간으로 나눈다.

- 대부분 채워졌는데 일부만 빠진 구간
- 거의 비어 있는 구간
- 최근부라 많이 들어왔지만 잔여 누락이 남은 구간

현재 강사DB Gmail 사례에서는:

- `2025-10-24 ~ 2025-12-31`: 부분 누락 구간
- `2026-01-01 ~ 2026-02-29`: 대량 미적재 구간
- `2026-03-01 ~ 2026-04-24`: 잔여 누락 구간

### Step 3. 실험용 하루를 고른다

바로 전체를 다시 돌리지 말고, 먼저 하루 하나를 골라 확인한다.

추천 기준:

- missing이 큰 날 1개
- recent 누락 날 1개

이번 사례에서 의미 있었던 샘플:

- `2026-02-25`
- `2026-04-23`

## 5. 데이터를 온전히 다 가져오는 방법

여기서 “온전히”의 뜻은:

- fetch가 완결됐고
- 그 날짜 Gmail raw corpus가 DB raw import에 모두 존재하는 상태

### 한 날짜 window 복구 절차

#### 1. before compare

```bash
npm run audit:gmail:daily-coverage -- --start=2026-02-25 --end=2026-02-25 --max-pages=20 --page-size=500
```

#### 2. 해당 날짜 backfill 실행

서버 실행:

```bash
npm run dev
```

backfill:

```bash
curl -X POST \
  "http://localhost:3000/api/pipeline/gmail?mode=backfill&startDate=2026-02-25&endDate=2026-02-25&maxPages=20&pageSize=500"
```

#### 3. 응답에서 반드시 확인할 것

- `fetch_complete=true`
- `page_cap_hit=false`
- `next_page_token_remaining=false`
- `threads_listed == threads_loaded`
- `detail_fetch_failures=0`

이 중 하나라도 어기면:

- 그 run은 “복구 완료”가 아님
- coverage compare 없이 다음 window로 넘어가면 안 됨

#### 4. after compare

```bash
npm run audit:gmail:daily-coverage -- --start=2026-02-25 --end=2026-02-25 --max-pages=20 --page-size=500
```

완료 기준:

- `status=ok`
- `missingInDb=0`

#### 5. window를 넓힌다

하루가 clean하게 닫히면 그다음:

- 1일
- 3일
- 7일

순으로만 window를 키운다.

### 왜 6개월을 한 번에 다시 돌리면 안 되나

- 원인 추적이 다시 흐려진다
- timeout / partial / page cap이 나도 어느 날짜가 비었는지 바로 모른다
- rerun cost가 커진다
- 중간 실패 후 다시 비교하기 어렵다

## 6. 지금까지 확인된 실험 결과

### 2026-02-25

before:

- collected `172`
- DB `10`
- missing `162`

backfill 응답:

- `fetchComplete=true`
- `threads_listed=172`
- `threads_loaded=172`
- `activity_items_inserted=162`

after:

- DB `172`
- missing `0`

### 2026-04-23

before:

- collected `141`
- DB `60`
- missing `81`

backfill 응답:

- `fetchComplete=true`
- `threads_listed=141`
- `threads_loaded=141`
- `activity_items_inserted=80`

after:

- DB `141`
- missing `0`

### 해석

이 두 실험은 다음을 보여준다.

- 현재 fetch 경로는 이 날짜들에서 완전했다
- 현재 apply/store 경로도 정상적으로 동작했다
- 따라서 이 날짜들의 hole은 “지금 코드가 못 넣어서”가 아니라 “과거에 안 들어간 상태로 남아 있었기 때문”으로 보는 게 맞다

## 7. 이런 상황일 때의 운영 대처

### 하지 말아야 할 것

- 6개월 전체를 한 번에 다시 넣기
- route success를 보고 바로 완료라고 판단하기
- coverage compare 없이 다음 구간으로 넘어가기
- historical backfill과 live incremental을 같은 방식으로 취급하기

### 권장 대응

1. 일별/주별 compare로 hole 위치를 먼저 그린다
2. hole이 큰 구간부터 날짜 window 단위로 backfill한다
3. 매 window마다 fetch diagnostics를 보고
4. 매 window마다 after compare로 `missingInDb=0`를 확인한다
5. 그 다음 window로 넘어간다

### 실무 우선순위

- 1순위: 거의 비어 있는 구간
- 2순위: 최근인데 아직 구멍이 남은 구간
- 3순위: 부분 누락만 남은 구간

현재 사례라면:

1. `2026-01-01 ~ 2026-02-29`
2. `2026-03-01 ~ 2026-04-24`
3. `2025-10-24 ~ 2025-12-31`

## 8. 기록해야 할 것

기록은 나중에 설명하려고 남기는 게 아니라, **중간에 판단을 잃지 않기 위해** 남긴다.

최소 기록 항목:

- 사용자 / account_email
- 대상 corpus 기간
- 실제 실행 기간
- 조사 대상 window
- before compare 결과
- backfill 응답 요약
- fetch diagnostics
- after compare 결과
- 남은 hole 여부
- 다음 의사결정

### 복붙용 기록 템플릿

```md
## Window: YYYY-MM-DD ~ YYYY-MM-DD

- 목적:
- before:
  - collected:
  - dbRowsFound:
  - missingInDb:
- backfill response:
  - fetchComplete:
  - pageCapHit:
  - nextPageTokenRemaining:
  - threadsListed:
  - threadsLoaded:
  - detailFetchFailures:
  - inserted:
  - updated:
- after:
  - dbRowsFound:
  - missingInDb:
- 판단:
- 다음 액션:
```

## 9. 완료 판정

복구 완료는 아래를 모두 만족해야 한다.

- 대상 window별 compare가 `status=ok`
- `missingInDb=0`
- fetch diagnostics에서 incomplete 신호 없음
- checkpoint는 incomplete run에서 전진하지 않음

“몇 건 반영됐다”는 완료 기준이 아니다.  
완료 기준은 **그 날짜 raw corpus가 DB에 모두 존재하느냐**다.

## 10. 지금 바로 시작할 때의 프롬프트

```text
Gmail historical backfill 누락을 조사하고 복구해.

원칙:
1. 먼저 read-only daily coverage compare를 실행한다.
2. missing_in_db가 큰 날짜를 찾는다.
3. 하루 window 하나를 골라 before/after 비교가 가능한 controlled backfill을 실행한다.
4. backfill 응답에서 fetchComplete, pageCapHit, nextPageTokenRemaining, threadsListed, threadsLoaded, detailFetchFailures를 확인한다.
5. after compare에서 missingInDb=0이면 다음 window로 넘어간다.
6. 6개월 전체를 한 번에 돌리지 말고 날짜 window 단위로만 진행한다.

최종 출력:
- 어떤 window가 비어 있었는지
- backfill 후 실제로 닫혔는지
- 현재 원인이 fetch인지, apply/store인지, historical hole인지
- 다음 복구 순서
```
