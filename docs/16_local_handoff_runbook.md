# Local Handoff Runbook

## Role
이 문서는 `instructor_db`를 한 개발자 로컬 환경에서 다른 개발자 로컬 환경으로 옮길 때
무엇을 그대로 전달하고, 무엇을 새로 발급하거나 재설정해야 하는지 정의한다.
코드 이전, 로컬 DB 준비, 인증 우회/실사용 모드, 외부 source 권한 확인, 최종 검증 순서를 포함한다.

## This Doc Does Not Override
- 정책: `01_core_policy.md`
- 시스템 구성: `02_system_architecture.md`
- 데이터 구조: `03_data_model.md`
- 파이프라인 규칙: `04_data_pipeline.md`
- API 계약: `05_api_spec.md`

## Depends On
- `00_docs_index.md`
- `02_system_architecture.md`
- `04_data_pipeline.md`
- `12_solo_launch_readiness.md`
- `13_smoke_test_runbook.md`

## Used By
- 다른 개발자에게 로컬 실행 환경을 넘겨주는 사람
- 새 로컬 환경에서 앱을 다시 띄우는 사람
- 데모 전용 local setup과 live source 연동 setup을 구분해야 하는 사람

## Out of Scope
- 제품 정책 변경
- 외부 API SDK 구현 상세
- 배포 자동화 상세

## 1. 핵심 원칙

- 이전 대상은 **내 `.env` 자체가 아니라 실행 구조와 체크리스트**다.
- 코드, 문서, Prisma schema, mock/fallback 데이터는 전달할 수 있다.
- 개인 OAuth refresh token, 개인 Gmail/Sheets 접근 권한, 개인 로컬 절대경로는 전달 대상이 아니다.
- 로컬 이전은 아래 3개 모드로 나눠 진행한다.
  - `demo-local`: 화면과 기본 API만 로컬에서 재현
  - `dev-live-lite`: 최소 1개 이상 live source를 실제로 읽는 개발 모드
  - `dev-full`: 로그인, refresh, 주요 live source 전체를 다시 연결한 개발 모드

## 2. 전달 가능한 것 vs 재설정할 것

| 구분 | 예시 | 처리 원칙 |
|---|---|---|
| 그대로 전달 가능 | 저장소 코드, `docs/**`, `prisma/schema.prisma`, `prisma/seed.ts`, `prisma/seed.mock.ts`, `data/last-good-snapshot.json`, `data/ops-notes-hardcoded.json`, `prisma/fulltime_instructors.json` | Git으로 전달하거나 repo에 그대로 포함한다. |
| 팀 공용으로 재배포 가능 | 공용 dev DB, 팀 Notion integration, 팀 Slack bot, 공용 cron/ingest secret | 팀 정책상 공유 허용일 때만 비밀관리 도구로 전달한다. 채팅/문서 본문에 직접 남기지 않는다. |
| 사람마다 새로 발급/재설정 | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, `GMAIL_REFRESH_TOKEN`, `GMAIL_ACCOUNT_EMAIL`, spreadsheet access, local `DATABASE_URL`, `SALESMAP_SNAPSHOT_PATH` | 대상 개발자 기준으로 다시 발급하거나, 대상 기기에서 새 경로/새 계정으로 설정한다. |
| 절대 그대로 복사하면 안 되는 것 | 내 `.env`, 내 개인 OAuth refresh token, 내 로컬 Postgres 접속값, 내 홈디렉토리 절대경로 | 전달하지 않는다. 같은 구조로 새 환경을 다시 만든다. |

## 3. 이전 모드 선택

| 모드 | 목적 | 필수 준비물 | 권장 시작점 |
|---|---|---|---|
| `demo-local` | 화면과 기본 API를 빠르게 다시 띄운다. | 로컬 Postgres, `.env`, `AUTH_DISABLED=true`, mock 또는 fallback 데이터 | 새 사람이 처음 앱을 받아서 UI와 기본 플로우를 볼 때 |
| `dev-live-lite` | 최소 1개 이상 live source를 실제로 읽는다. | `demo-local` + Notion 또는 contract sheet 권한 | 로컬에서 실제 source 연결 문제를 보기 시작할 때 |
| `dev-full` | 로그인, refresh, 주요 live source를 모두 다시 연결한다. | `dev-live-lite` + Google login, Gmail/Sheets, Slack, Salesmap | 운영형 동작과 refresh orchestration을 로컬에서 재현해야 할 때 |

규칙:
- 처음부터 `dev-full`로 시작하지 않는다.
- 반드시 `demo-local -> dev-live-lite -> dev-full` 순서로 올린다.

## 4. 이전 전에 원본 로컬에서 먼저 정리할 것

### 4-1. 버전 정보 채집

원본 로컬에서 아래를 기록해 함께 전달한다.

```bash
node -v
npm -v
psql --version
git rev-parse --short HEAD
```

목적:
- 대상 로컬에서 런타임 차이로 생기는 오류를 줄인다.
- "같은 브랜치/같은 커밋"에서 재현하고 있는지 빠르게 확인한다.

### 4-2. 이전 대상 브랜치 고정

- 전달 대상 브랜치와 commit SHA를 고정한다.
- 로컬 dirty change가 있으면 먼저 정리하거나 별도 브랜치로 밀어둔다.
- 대상 개발자가 어떤 브랜치를 clone해야 하는지 한 줄로 남긴다.

### 4-3. 사용할 실행 모드 결정

- 데모만 필요하면 `demo-local`
- 실제 source 1~2개까지 확인하려면 `dev-live-lite`
- 전체 refresh와 live source를 재현하려면 `dev-full`

이 결정을 먼저 하지 않으면, 불필요하게 Google OAuth와 live source 설정부터 하다가 시간이 소모된다.

## 5. 대상 로컬에 전달할 패키지

### 5-1. Git으로 전달할 것

- 저장소 코드 전체
- `docs/**`
- `data/last-good-snapshot.json`
- `data/ops-notes-hardcoded.json`
- `prisma/fulltime_instructors.json`

### 5-2. 별도 공유 경로로 전달할 수 있는 것

- `SALESMAP_SNAPSHOT_PATH`에 넣을 snapshot 파일
  - 단, 라이선스/접근 정책상 허용될 때만 전달한다.
- 팀 공용 dev DB 접속 정보
  - 팀 정책상 허용될 때만 전달한다.

### 5-3. 절대 전달하지 않을 것

- 내 개인 `.env`
- 내 개인 Gmail/Google OAuth refresh token
- 내 개인 Gmail 계정에만 공유된 스프레드시트 접근
- 내 홈디렉토리 기준 절대경로 문자열

## 6. 대상 로컬 기본 세팅 절차

### 6-1. 로컬 준비물

- Git
- Node.js / npm
- PostgreSQL

### 6-2. 저장소 준비

```bash
git clone <repo-url>
cd instructor_db
git checkout <branch-or-commit>
cp .env.example .env
```

### 6-3. `.env` 최소값 설정

`demo-local` 기준 최소값:

```dotenv
DATABASE_URL="postgresql://USER:PASSWORD@HOST:PORT/DB?schema=public"
AUTH_DISABLED="true"
AUTH_URL="https://localhost:8080"
```

규칙:
- `AUTH_DISABLED=true`는 비운영 환경에서만 사용한다.
- `demo-local`에서는 Google login 관련 값이 비어 있어도 된다.
- `DATABASE_URL`은 대상 개발자 로컬 또는 팀 공용 dev DB 기준으로 새로 잡는다.

### 6-4. DB 부팅

```bash
npx prisma generate
npx prisma db push
npx prisma db seed
```

옵션:

```bash
npm run seed:mock
```

설명:
- `npx prisma db seed`는 설정성 초기 데이터 기준이다.
- `npm run seed:mock`은 UI와 기본 상호작용을 보기 위한 mock 강사 데이터를 넣는다.
- mock DB와 live data용 DB는 가능하면 분리한다.

### 6-5. 앱 부팅

```bash
npm install
npm run build
npm run dev
```

## 7. 모드별 검증 기준

### 7-1. `demo-local`

목표:
- 로그인 없이 로컬 페이지가 뜬다.
- mock 또는 fallback 데이터 기준으로 목록/상세를 볼 수 있다.

체크:
- `AUTH_DISABLED=true`
- `npm run build` 통과
- `npm run dev` 후 메인 페이지 접속 성공
- 목록/상세 UI가 깨지지 않음

### 7-2. `dev-live-lite`

목표:
- 최소 1개 이상 live source를 실제로 읽는다.
- source 접근 실패와 앱 자체 실패를 구분할 수 있다.

권장 source 순서:
1. `fulltime`
2. `ops-notes`
3. `notion`
4. `contract-sheet`

검증:
- `docs/13_smoke_test_runbook.md`의 source별 smoke test를 순서대로 수행한다.
- `notion` 또는 `contract-sheet` 중 최소 1개는 실제 성공해야 한다.

### 7-3. `dev-full`

목표:
- Google login
- `GET /api/status`
- `POST /api/refresh`
- 주요 live source 연결

검증:
- 로그인 세션이 실제로 생성된다.
- `GET /api/status` 응답 성공
- `POST /api/refresh` 응답이 `success` 또는 `partial`
- 최소 1개 이상 live source가 실제로 데이터를 갱신한다.

## 8. Google / 인증 설정

### 8-1. 화면만 띄울 때

- `AUTH_DISABLED=true`로 시작한다.
- 이 경우 Google Cloud Console 재설정 없이도 로컬 화면과 기본 API 확인이 가능하다.

### 8-2. 실제 Google login까지 검증할 때

아래 값이 필요하다.

- `AUTH_URL`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `SESSION_SECRET`

규칙:
- 대상 개발자 기준으로 OAuth client를 다시 맞추거나, 팀 공용 dev OAuth client를 사용한다.
- 로컬 HTTPS 프록시를 쓰면 redirect URI도 그 기준으로 다시 등록한다.
- 원본 개발자의 개인 OAuth refresh token을 그대로 복사하지 않는다.

### 8-3. Gmail / Google Sheets live source를 검증할 때

아래 값이 필요하다.

- `GMAIL_CLIENT_ID`
- `GMAIL_CLIENT_SECRET`
- `GMAIL_REFRESH_TOKEN`
- `GMAIL_ACCOUNT_EMAIL`
- `GMAIL_TARGET_ADDRESSES`
- `GOOGLE_CONTRACTS_SPREADSHEET_ID`

추가 체크:
- `GMAIL_ACCOUNT_EMAIL` 계정이 계약 스프레드시트에 실제 접근 가능한지
- 같은 계정이 만족도 스프레드시트에도 접근 가능한지

규칙:
- 이 부분은 "코드 공유"가 아니라 "계정 권한 재설정" 문제다.
- 대상 개발자 계정 또는 팀 지정 dev 계정 기준으로 다시 맞춘다.

## 9. source별 체크 항목

| source | 필요한 것 | 대상 로컬 체크 항목 |
|---|---|---|
| Notion | `NOTION_API_KEY`, `NOTION_DATABASE_ID` | integration이 대상 DB에 연결돼 있는지 |
| Contract Sheet | `GOOGLE_CONTRACTS_SPREADSHEET_ID`, Gmail OAuth 값 | `GMAIL_ACCOUNT_EMAIL`이 spreadsheet viewer 이상 권한을 갖는지 |
| Satisfaction Sheets | Gmail OAuth 값, 각 시트 접근 권한 | Gmail/Sheets를 읽는 같은 계정이 실제 시트에 접근 가능한지 |
| Slack | `SLACK_BOT_TOKEN`, `SLACK_WORKSPACE_ID` | bot이 canonical 채널을 읽을 수 있는지 |
| Salesmap | `SALESMAP_SNAPSHOT_PATH` | 파일이 대상 로컬에 실제 존재하는지, 경로가 새 기기 기준으로 맞는지 |
| Fulltime JSON | `prisma/fulltime_instructors.json` | repo에 포함된 파일이므로 별도 시크릿 없음 |
| Ops Notes | `data/ops-notes-hardcoded.json` | repo에 포함된 파일이므로 별도 시크릿 없음 |

## 10. 자주 막히는 지점

### 10-1. 페이지는 뜨는데 API가 401/403

원인 후보:
- `AUTH_DISABLED`가 꺼져 있음
- Google login 설정이 덜 됨
- 허용 도메인 계정이 아님

### 10-2. `POST /api/refresh`는 되는데 source가 안 읽힘

원인 후보:
- env 누락
- spreadsheet/Notion/Slack 권한 누락
- snapshot 파일 경로 불일치

### 10-3. contract sheet만 실패

우선 확인:
- `GOOGLE_CONTRACTS_SPREADSHEET_ID`
- `GMAIL_ACCOUNT_EMAIL`의 해당 시트 접근 권한

### 10-4. Gmail/만족도 시트 수집만 실패

우선 확인:
- `GMAIL_REFRESH_TOKEN`
- 대상 계정의 시트 공유 여부
- 팀 정책상 개인 계정 대신 지정 dev 계정을 써야 하는지

### 10-5. Salesmap만 실패

우선 확인:
- `SALESMAP_SNAPSHOT_PATH`가 원본 로컬 절대경로 그대로 들어가 있지 않은지
- 대상 기기에서 실제 파일이 존재하는지

## 11. 이전 완료 기준

### 11-1. `demo-local` 완료

- 대상 로컬에서 `npm run build` 성공
- `npm run dev` 성공
- 로그인 없이 메인 화면 접근 성공
- mock 또는 fallback 데이터 기준 UI 확인 완료

### 11-2. `dev-live-lite` 완료

- `demo-local` 완료
- 최소 1개 live source smoke test 성공
- source 실패 시 권한 문제와 코드 문제를 구분해서 설명할 수 있음

### 11-3. `dev-full` 완료

- `GET /api/status` 성공
- `POST /api/refresh` 성공 또는 `partial`
- 로그인 세션 동작 확인
- 필요한 live source가 대상 로컬에서 실제로 접근 가능

## 12. handoff 요약 메시지 템플릿

아래 형식으로 전달하면 누락이 줄어든다.

```text
브랜치/커밋:
- <branch>
- <commit-sha>

이번 handoff 목표:
- demo-local / dev-live-lite / dev-full 중 하나

그대로 쓰는 것:
- repo 코드
- docs
- fallback/mock 데이터

새로 맞춰야 하는 것:
- DATABASE_URL
- AUTH_DISABLED 또는 Google login 설정
- Gmail/Sheets 권한
- Notion/Slack 권한
- Salesmap 로컬 경로

먼저 볼 문서:
- docs/12_solo_launch_readiness.md
- docs/13_smoke_test_runbook.md
- docs/16_local_handoff_runbook.md
```
