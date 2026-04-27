# Gmail 누락 복구 사용법

작성 시각: 2026-04-27  
대상: 개발을 모르는 운영자도 그대로 따라 할 수 있는 Gmail 누락 복구 절차

## 이 문서는 언제 쓰나

아래 상황이면 이 문서를 쓴다.

- 특정 날짜의 Gmail 데이터가 강사DB에 덜 들어간 것 같다
- 과거 1일~7일 정도 구간을 다시 채워 넣고 싶다
- 조사 결과 `missing_in_db`가 확인됐다

이 문서의 목적은 **지정한 날짜 구간의 Gmail raw 데이터를 다시 채워 넣는 것**이다.

## 가장 쉬운 실행 방법

터미널에서 아래 형식으로 실행한다.

```bash
npm run recover:gmail:window -- --start=YYYY-MM-DD --end=YYYY-MM-DD
```

한 달 전체를 한 번에 넣고 싶으면 이렇게도 가능하다.

```bash
npm run recover:gmail:window -- --month=YYYY-MM
```

여러 달을 한 번에 넣고 싶으면 이렇게도 가능하다.

```bash
npm run recover:gmail:window -- --months=YYYY-MM,YYYY-MM,YYYY-MM
```

연속된 여러 달이면 이렇게도 가능하다.

```bash
npm run recover:gmail:window -- --start-month=YYYY-MM --end-month=YYYY-MM
```

예시:

```bash
npm run recover:gmail:window -- --start=2026-02-23 --end=2026-02-24
```

```bash
npm run recover:gmail:window -- --month=2026-02
```

```bash
npm run recover:gmail:window -- --months=2026-01,2026-02
```

```bash
npm run recover:gmail:window -- --start-month=2026-01 --end-month=2026-03
```

## 실행 전에 알아둘 것

- `start`와 `end`는 복구할 날짜 범위다
- `month`를 넣으면 그 달의 1일부터 말일까지를 자동으로 계산한다
- `months`를 넣으면 입력한 여러 달을 순서대로 이어서 계산한다
- `months`는 정확히 입력한 달들만 처리한다
- `start-month`와 `end-month`를 같이 넣으면 그 사이 모든 달을 자동으로 계산한다
- 하루만 복구하려면 `start`와 `end`를 같은 날짜로 넣는다
- 처음에는 1일 또는 2일만 실행하는 걸 권장한다
- 6개월 전체를 한 번에 넣지 않는다

## 실행하면 자동으로 하는 일

이 명령은 날짜별로 아래를 자동으로 한다.

1. Gmail에서 그 날짜 메일을 다시 읽는다
2. 현재 DB에 얼마나 비어 있는지 확인한다
3. 비어 있으면 필요한 row만 다시 넣는다
4. 끝난 뒤 실제로 hole이 닫혔는지 다시 확인한다
5. 결과 보고서를 만든다

## 성공 여부를 어디서 보나

실행이 끝나면 두 가지 보고서가 생긴다.

- JSON 보고서
- Markdown 보고서

예시:

- [gmail-window-recovery-2026-02-23_2026-02-24.md](/Users/ga/workspace/instructor_db/reports/gmail-window-recovery-2026-02-23_2026-02-24.md)
- [gmail-window-recovery-2026-02-23_2026-02-24.json](/Users/ga/workspace/instructor_db/reports/gmail-window-recovery-2026-02-23_2026-02-24.json)

Markdown 보고서에서 이 줄을 보면 된다.

- `Before Missing`
- `After Missing`
- `Fetch Complete`
- `Note`

## 성공으로 보는 기준

아래면 정상 복구다.

- `Fetch Complete = true`
- `After Missing = 0`
- `Note = gap_closed`

예시:

| Date | Action | Before Missing | After Missing | Fetch Complete | Note |
| --- | --- | ---: | ---: | --- | --- |
| 2026-02-23 | recovered | 119 | 0 | true | gap_closed |

## 실패 또는 중단으로 보는 기준

아래 중 하나면 바로 멈추고 큰 범위로 확장하지 않는다.

- `Fetch Complete = false`
- `After Missing`가 0이 아니다
- `Action = aborted`
- `Note = fetch_incomplete`

이 경우는 “다시 읽는 과정이 완전하지 않았을 수 있다”는 뜻이다.

## 추천 실행 순서

### 1. 먼저 작은 구간으로 시험

```bash
npm run recover:gmail:window -- --start=2026-02-25 --end=2026-02-25
```

### 2. 괜찮으면 2일~3일

```bash
npm run recover:gmail:window -- --start=2026-02-23 --end=2026-02-25
```

### 3. 그다음 7일 단위

```bash
npm run recover:gmail:window -- --start=2026-02-23 --end=2026-03-01
```

### 하지 말아야 할 것

이렇게는 하지 않는다.

```bash
npm run recover:gmail:window -- --start=2025-10-24 --end=2026-04-24
```

이유:

- 중간 실패가 나면 어느 날짜가 비었는지 추적하기 어렵다
- 시간이 오래 걸린다
- 보고서가 커져서 판단이 흐려진다

## 자주 쓰는 패턴

### 하루만 복구

```bash
npm run recover:gmail:window -- --start=2026-04-23 --end=2026-04-23
```

### 이틀 복구

```bash
npm run recover:gmail:window -- --start=2026-02-23 --end=2026-02-24
```

### 일주일 복구

```bash
npm run recover:gmail:window -- --start=2026-03-01 --end=2026-03-07
```

### 한 달 전체 복구

```bash
npm run recover:gmail:window -- --month=2026-02
```

### 여러 달 복구

```bash
npm run recover:gmail:window -- --months=2026-01,2026-02
```

띄엄띄엄인 달도 가능:

```bash
npm run recover:gmail:window -- --months=2026-01,2026-03
```

또는

```bash
npm run recover:gmail:window -- --start-month=2026-01 --end-month=2026-03
```

## 이 명령으로 해결되는 문제

- Gmail 원본에는 있는데 강사DB에 덜 들어간 경우
- 과거 backfill이 덜 끝나서 raw row hole이 남은 경우

## 이 명령으로 해결되지 않는 문제

- Gmail 원본 자체에 없는 메일
- 잘못된 비즈니스 규칙 때문에 invalid/unmatched가 많이 나오는 문제
- Slack/Sheet source 문제

이건 별도 조사/수정이 필요하다.

## 가장 짧은 요약

1. 작은 날짜 범위를 잡는다
2. 아래 명령을 실행한다

```bash
npm run recover:gmail:window -- --start=YYYY-MM-DD --end=YYYY-MM-DD
```

또는

```bash
npm run recover:gmail:window -- --month=YYYY-MM
```

또는

```bash
npm run recover:gmail:window -- --months=YYYY-MM,YYYY-MM
```

3. 결과 보고서에서 `After Missing = 0`인지 본다
4. 맞으면 다음 날짜 범위로 넘어간다
