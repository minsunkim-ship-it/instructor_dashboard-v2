# Coolify Migration Runbook

## Role
이 문서는 `instructor_db`를 Railway에서 Coolify 셀프호스팅 환경으로 옮기는 절차를 정의한다.
앱 컨테이너, PostgreSQL 데이터 이전, 환경변수, OAuth redirect, 헬스체크, 운영 검증을 한 흐름으로 묶는다.

## This Doc Does Not Override
- 정책: `01_core_policy.md`
- 시스템 구성: `02_system_architecture.md`
- 데이터 구조: `03_data_model.md`
- 파이프라인 규칙: `04_data_pipeline.md`
- 로컬 handoff: `16_local_handoff_runbook.md`

## Depends On
- `00_docs_index.md`
- `02_system_architecture.md`
- `12_solo_launch_readiness.md`
- `13_smoke_test_runbook.md`
- `16_local_handoff_runbook.md`

## External References Checked
- Coolify Dockerfile build pack: https://coolify.io/docs/applications/build-packs/dockerfile
- Coolify environment variables: https://coolify.io/docs/knowledge-base/environment-variables
- Coolify health checks: https://coolify.io/docs/knowledge-base/health-checks
- Coolify PostgreSQL backups: https://coolify.io/docs/databases/backups
- Railway PostgreSQL: https://docs.railway.com/databases/postgresql
- PostgreSQL dump/restore: https://www.postgresql.org/docs/17/app-pgdump.html

## 1. 권장 목표 구조

- Coolify application: 이 저장소의 `Dockerfile` build pack 사용
- Coolify PostgreSQL: 앱과 같은 project/environment 안에 생성
- 앱 포트: `3000`
- 헬스체크 경로: `/api/health`
- DB schema 관리: 현재 저장소는 Prisma migration 파일이 없으므로, 초기 이전/스키마 정합성 확인은 `npx prisma db push` 기준
- Salesmap SQLite snapshot: 이미지에 넣지 않고 서버 persistent path 또는 Coolify persistent storage에 올린 뒤 `SALESMAP_SNAPSHOT_PATH`로 연결

## 2. 이전 전 준비

Railway는 검증 완료 전까지 끄지 않는다.

먼저 Railway에서 아래를 확보한다.

- 앱 환경변수 전체 목록과 값
- PostgreSQL public/external connection URL
- 현재 운영 domain
- Google OAuth client 설정 화면 접근 권한
- Slack/Notion/Gmail/Sheets 토큰 재발급 권한

새 Coolify 환경에서는 최소 아래 값을 새로 정한다.

```bash
openssl rand -base64 32 # SESSION_SECRET
openssl rand -base64 32 # CRON_SECRET
```

운영 domain이 바뀌면 Google OAuth redirect URI도 반드시 바꾼다.

```text
https://<coolify-domain>/api/auth/callback/google
```

## 3. Coolify 서버 준비

Coolify 서버는 Docker Engine 24+ 기준으로 준비한다. Docker snap 설치는 피한다.

Coolify dashboard에서 다음 순서로 만든다.

1. Project와 Environment 생성
2. PostgreSQL database resource 생성
3. Application resource 생성
4. Application build pack을 `Dockerfile`로 선택
5. Port exposes를 `3000`으로 설정
6. Health check는 `Dockerfile`에 이미 `/api/health` 기준으로 들어가 있다. Coolify UI에서도 켤 경우 같은 경로를 사용한다.

DB restore가 끝나기 전에는 앱 health check가 `503`을 낼 수 있다. 앱 배포는 DB restore 이후에 하거나, 첫 배포 동안만 health check를 임시로 꺼도 된다.

## 4. PostgreSQL 데이터 이전

Railway PostgreSQL은 external connection URL 또는 TCP proxy를 통해 `pg_dump`로 export한다.

```bash
export RAILWAY_DATABASE_URL='postgresql://...'
export COOLIFY_DATABASE_URL='postgresql://...'

pg_dump \
  --format=custom \
  --no-acl \
  --no-owner \
  --verbose \
  --file railway-instructor-db.dump \
  "$RAILWAY_DATABASE_URL"
```

Coolify PostgreSQL로 restore한다.

```bash
pg_restore \
  --verbose \
  --clean \
  --if-exists \
  --no-owner \
  --no-acl \
  --dbname "$COOLIFY_DATABASE_URL" \
  railway-instructor-db.dump
```

스키마가 현재 코드와 맞는지 확인한다.

```bash
DATABASE_URL="$COOLIFY_DATABASE_URL" npx prisma generate
DATABASE_URL="$COOLIFY_DATABASE_URL" npx prisma db push
psql "$COOLIFY_DATABASE_URL" -c 'select count(*) from instructors;'
psql "$COOLIFY_DATABASE_URL" -c 'select count(*) from pipeline_runs;'
```

운영 DB에 `npx prisma db seed` 또는 `npm run seed:mock`을 실행하지 않는다. restore 없이 새 demo DB를 만들 때만 seed를 사용한다.

## 5. Application 환경변수

Coolify Environment Variables는 Developer View로 붙여넣는 편이 가장 빠르다. 비밀값은 Runtime Variable만 켜는 것을 기본으로 한다. build 중 꼭 필요한 값은 현재 없다.

```dotenv
DATABASE_URL="postgresql://USER:PASSWORD@HOST:PORT/DB?schema=public"
AUTH_DISABLED="false"
AUTH_URL="https://<coolify-domain>"
GOOGLE_CLIENT_ID=""
GOOGLE_CLIENT_SECRET=""
SESSION_SECRET=""
CRON_SECRET=""
ADMIN_EMAILS="operator@day1company.co.kr"
OPERATOR_EMAILS=""

NOTION_API_KEY=""
NOTION_DATABASE_ID=""

GOOGLE_CONTRACTS_SPREADSHEET_ID=""

SALESMAP_SNAPSHOT_PATH="/app/runtime/salesmap_latest.db"

SLACK_BOT_TOKEN=""
SLACK_WORKSPACE_ID=""

GMAIL_CLIENT_ID=""
GMAIL_CLIENT_SECRET=""
GMAIL_REFRESH_TOKEN=""
GMAIL_ACCOUNT_EMAIL=""
GMAIL_TARGET_ADDRESSES=""

OPENAI_API_KEY=""
OPENAI_MODEL=""
OPENAI_BASE_URL=""
OPENAI_RESPONSES_URL=""
OPERATIONAL_INTELLIGENCE_LLM_MODEL=""
SATISFACTION_FEEDBACK_LLM_ENABLED="true"
SATISFACTION_FEEDBACK_LLM_MODEL=""
```

규칙:

- `DATABASE_URL`은 Coolify 내부 네트워크 URL을 우선 사용한다.
- `AUTH_URL`은 실제 접속 origin과 정확히 일치시킨다.
- production에서는 `AUTH_DISABLED=true`를 넣어도 코드상 인증 우회가 켜지지 않는다.
- `GOOGLE_SERVICE_ACCOUNT_JSON`은 현재 계약시트 canonical 경로가 아니므로 새 배포 기본값에 넣지 않는다.
- `SALESMAP_SNAPSHOT_PATH`는 이미지에 포함하지 않는 파일 경로를 가리켜야 한다.

## 6. Salesmap snapshot 처리

`data/*.db`는 Docker image context에서 제외된다. 운영 snapshot은 아래 중 하나로 배치한다.

- Coolify persistent storage를 `/app/runtime`에 mount하고 `salesmap_latest.db`를 업로드
- 서버의 bind mount를 `/app/runtime`으로 연결

그 후 환경변수는 아래처럼 둔다.

```dotenv
SALESMAP_SNAPSHOT_PATH="/app/runtime/salesmap_latest.db"
```

Salesmap을 당장 쓰지 않을 경우 이 source는 smoke test에서 제외하고, Notion/Sheets/Fulltime/Ops Notes로 먼저 go-live를 검증한다.

## 7. 앱 배포

Coolify application 설정:

- Build Pack: `Dockerfile`
- Base Directory: `/`
- Port Exposes: `3000`
- Health Check: `Dockerfile`의 `/api/health` healthcheck 사용
- Domain: 운영 domain
- Force HTTPS: enabled

첫 배포 후 Coolify logs에서 아래를 확인한다.

- `npm run build` 완료
- Prisma Client generation 완료
- Next standalone server가 `0.0.0.0:3000`에서 listen
- `/api/health`가 `200` 반환

## 8. Cron / refresh

외부 스케줄러 또는 Coolify scheduled task에서 아래 API를 호출한다.

```bash
curl -X POST "https://<coolify-domain>/api/refresh/cron" \
  -H "x-cron-secret: $CRON_SECRET"
```

초기 go-live 직후에는 cron을 바로 켜지 말고, 수동으로 한 번 호출해 `success` 또는 의도된 `partial`을 확인한 뒤 켠다.

## 9. Go-live 검증

DNS 전환 전:

```bash
curl -fsS "https://<coolify-domain>/api/health"
curl -fsS "https://<coolify-domain>/api/status"
```

브라우저에서 확인:

- Google login 성공
- `@day1company.co.kr` 외 도메인 접근 차단
- 강사 목록 렌더링
- 강사 상세 렌더링
- 관리자 화면 접근
- 수동 만족도 저장 후 상세 수치 갱신

source smoke test는 `13_smoke_test_runbook.md` 순서로 진행하되, go-live 최소 기준은 다음이다.

- `/api/health` 200
- `/api/status` 200
- `/api/instructors` 200
- `/api/refresh/cron`이 `success` 또는 원인 식별 가능한 `partial`
- 최소 1개 live source 성공

## 10. Rollback

검증 실패 시:

1. DNS를 Railway domain/origin으로 되돌린다.
2. Coolify app은 중지하지 말고 logs와 DB 상태를 보존한다.
3. Coolify cron 또는 외부 refresh scheduler를 끈다.
4. Railway DB를 source of truth로 유지한다.
5. 실패 원인이 DB restore, env, OAuth redirect, external source 권한 중 무엇인지 분리한다.

데이터가 Coolify에서만 새로 쓰였으면 rollback 전에 해당 DB를 `pg_dump --format=custom`으로 보관한다.

## 11. 운영 백업

Coolify PostgreSQL backup을 켜고, 가능하면 S3-compatible storage로 보낸다.

권장 최소값:

- 일 1회 PostgreSQL full backup
- go-live 직전 수동 backup 1회
- restore command를 실제로 한 번 dry-run 가능한 staging DB에서 검증

Coolify backup format은 custom dump이므로 restore는 `pg_restore` 기준으로 진행한다.
