# Smoke Test Runbook

## Role
이 문서는 로컬에서 빠르게 "무엇이 실제로 동작하는지" 확인하기 위한 실행 런북이다.
현재 코드 상태를 기준으로 작성되며, 인증이 추가되기 전에는 아래 `curl` 테스트가 로컬에서 그대로 동작한다.

## 1. 사전 준비

### 1-1. 환경 준비

```bash
cp .env.example .env
```

- `.env`에 실제 시크릿을 채운다
- PostgreSQL이 비어 있다면 새 DB를 사용한다

### 1-2. 기본 부팅

```bash
npm install
npx prisma generate
npx prisma db push
npx prisma db seed
npm run build
npm run dev
```

옵션:

```bash
npm run seed:mock
```

- live source 접근이 막힌 상태에서 UI만 먼저 검증할 때 사용
- mock seed를 쓸 때는 live data용 DB와 분리하는 편이 안전하다

## 2. 소스별 개별 스모크 테스트

개별 source가 안 되는데 전체 refresh부터 돌리면 실패 원인 분리가 어렵다.
반드시 아래 순서대로 독립 확인한다.

### 2-1. fulltime

```bash
curl -X POST http://localhost:3000/api/pipeline/fulltime
```

기대 결과:
- HTTP 200
- `status = "success"`

### 2-2. ops notes

```bash
curl -X POST http://localhost:3000/api/pipeline/ops-notes
```

기대 결과:
- HTTP 200
- `status = "success"`

### 2-3. notion

```bash
curl -X POST http://localhost:3000/api/pipeline/notion
```

기대 결과:
- HTTP 200
- 강사 데이터 upsert 성공

### 2-4. contract sheet

```bash
curl -X POST http://localhost:3000/api/pipeline/contract-sheet
```

기대 결과:
- HTTP 200
- worksheet 2개 기준 수집
- `teaching_histories` 적재

### 2-5. salesmap

```bash
curl -X POST http://localhost:3000/api/pipeline/salesmap
```

기대 결과:
- HTTP 200
- snapshot file read 성공

### 2-6. slack

```bash
curl -X POST http://localhost:3000/api/pipeline/slack
```

기대 결과:
- HTTP 200
- canonical 채널 3개 중 읽을 수 있는 채널에서 활동 수집

### 2-7. gmail

```bash
curl -X POST http://localhost:3000/api/pipeline/gmail
```

기대 결과:
- HTTP 200
- OAuth token refresh 성공

### 2-8. satisfaction import

```bash
curl -X POST http://localhost:3000/api/pipeline/satisfaction
```

기대 결과:
- HTTP 200
- sheet 또는 gmail satisfaction 중 접근 가능한 source에서 partial 이상

## 3. 전체 orchestration 테스트

```bash
curl -X POST http://localhost:3000/api/refresh
```

기대 결과:
- HTTP 200 또는 partial
- 이미 running 중이면 HTTP 409
- 실패 source가 있어도 전체가 즉시 중단되지 않는다

이 단계에서 확인할 것:
- `pipeline_runs` 1건 생성
- source별 `source_sync_logs` 생성
- score 재계산 수행

## 4. 조회 API 테스트

### 4-1. 목록

```bash
curl "http://localhost:3000/api/instructors?limit=5"
```

기대 결과:
- HTTP 200
- `status = "success"` 또는 `empty`
- `data.items[0].id` 확보

### 4-2. 상세

```bash
curl "http://localhost:3000/api/instructors/INSTRUCTOR_ID"
```

기대 결과:
- HTTP 200
- 상세 패널용 필드 존재
- `score_breakdown`, `satisfaction`, `teaching_history` 확인

### 4-3. 상태

```bash
curl "http://localhost:3000/api/status"
```

기대 결과:
- HTTP 200
- `refresh_available` 확인
- source별 최근 sync 상태 확인

## 5. 만족도 작성 E2E

```bash
curl -X POST "http://localhost:3000/api/instructors/INSTRUCTOR_ID/satisfaction" \
  -H "Content-Type: application/json" \
  -d '{
    "score": 4.5,
    "company_name": "Test Company",
    "course_name": "Test Course",
    "comment": "smoke test",
    "response_date": "2026-04-16"
  }'
```

기대 결과:
- HTTP 200
- `status = "success"`
- 이후 상세 재조회 시 `satisfaction.avg`, `satisfaction.count`, `score` 갱신 확인

## 6. 브라우저 확인

브라우저에서 `http://localhost:3000` 접속 후 아래를 확인한다.

- 목록이 렌더링되는가
- 검색, 카테고리 필터, 정렬이 동작하는가
- 목록에서 강사를 클릭하면 상세 패널이 열리는가
- 상세 패널에서 만족도 저장 후 값이 갱신되는가
- 전임강사 배지가 보이고 fee가 숨겨지는가

## 7. 실패 시 바로 볼 것

### 7-1. notion 실패
- `NOTION_API_KEY`
- `NOTION_DATABASE_ID`
- integration share 여부

### 7-2. contract sheet 실패
- `GOOGLE_CONTRACTS_SPREADSHEET_ID`
- `GMAIL_CLIENT_ID`
- `GMAIL_CLIENT_SECRET`
- `GMAIL_REFRESH_TOKEN`
- `GMAIL_ACCOUNT_EMAIL`
- OAuth account spreadsheet access 여부

### 7-3. salesmap 실패
- `SALESMAP_SNAPSHOT_PATH`
- 실제 file 존재 여부

### 7-4. slack 실패
- `SLACK_BOT_TOKEN`
- `SLACK_WORKSPACE_ID`
- bot channel access

### 7-5. gmail / satisfaction 실패
- `GMAIL_CLIENT_ID`
- `GMAIL_CLIENT_SECRET`
- `GMAIL_REFRESH_TOKEN`
- `GMAIL_ACCOUNT_EMAIL`
- OAuth account spreadsheet access

## 8. 종료 기준

아래가 모두 되면 local smoke는 통과다.

- 개별 pipeline source 중 Day-1에 쓰기로 한 source가 모두 성공
- `POST /api/refresh`가 success 또는 partial
- 목록/상세/만족도 E2E 확인
- `GET /api/status`가 최근 run을 반영
