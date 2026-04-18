# Solo Launch Readiness

## Role
이 문서는 "문서는 준비됐지만 실제 하루 구현에서 무엇이 먼저 막히는가"를 점검하기 위한 실행 준비 문서다.
정책 Source of Truth를 대체하지 않고, 실제 구현 성공 확률을 높이기 위한 체크리스트와 blocker 기준만 다룬다.

## This Doc Does Not Override
- 정책: `01_core_policy.md`
- 데이터 구조: `03_data_model.md`
- 파이프라인 규칙: `04_data_pipeline.md`
- API 계약: `05_api_spec.md`
- 화면 동작: `06_implementation_spec.md`

## 1. 현재 저장소 기준 현실 점검

기준일: `2026-04-16`

- `npm run build` 통과
- `npm run lint` 통과, 단 `satisfaction-discovery.mjs`에 unused var warning 1건 존재
- 상세 패널, 만족도 작성 UI, status API, refresh API, 파이프라인 모듈은 현재 코드베이스에 존재
- 하지만 "문서상 완료"와 "실제 운영 준비 완료"는 아직 다르다

### 즉시 확인된 gap

#### G1. 인증은 문서상 완료지만 실제 구현 여부를 별도 확인해야 한다
- 2026-04-17 기준으로 Google 로그인 + `@day1company.co.kr` 도메인 제한 + API `401/403` proxy 가드는 구현됐다
- 다만 Railway 등 실제 배포 환경에서 `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`이 적용돼 있어야 한다
- 따라서 현재 상태를 "내부 서비스 운영 준비 완료"로 판단하려면 코드뿐 아니라 배포 환경의 인증 설정까지 함께 확인해야 한다

#### G2. fallback UI는 있지만 실제 fallback 데이터 경로는 아직 없다
- 목록/상세 API가 현재 `meta.is_fallback = false`를 고정 반환한다
- baseline/fallback 데이터 리소스 파일이 별도로 준비되어 있지 않다
- 따라서 현재 상태를 "fallback 완성"으로 판단하면 안 된다

#### G3. 환경변수 템플릿과 실제 접근 권한 검증 절차가 없었다
- 실제 구현에서 가장 먼저 막히는 지점은 코드보다 시크릿/권한/공유 설정이다
- 이번 턴에서 `.env.example`을 추가했으므로 로컬 `.env`는 반드시 그것을 기준으로 채운다

#### G4. 만족도 시트 수집은 숨은 접근 의존성이 있다
- `src/lib/pipeline/satisfaction-sheets-collector.ts`는 만족도 spreadsheet ID들을 코드에 하드코딩한다
- 즉 `GMAIL_ACCOUNT_EMAIL`로 인증되는 계정이 해당 스프레드시트들에 실제로 접근 가능해야 한다
- Gmail 활동 수집과 만족도 시트 수집은 같은 사용자 OAuth 계정 준비가 핵심이다

#### G5. README는 기본 템플릿 상태라 새 환경에서 바로 따라 하기 어렵다
- 실제 작업자는 `README.md`보다 이 문서와 `13_smoke_test_runbook.md`를 먼저 본다

## 2. 하루 구현 성공 기준

혼자 하루 안에 끝내려면 "모든 문서 범위 구현"보다 "데모 가능한 안정 경로 확보"를 먼저 달성해야 한다.

### Day-1 green path
- 강사 목록 조회
- 강사 상세 조회
- 수동 만족도 작성 및 score 재계산
- `POST /api/refresh` 동작
- 최소 1개 이상 live source 수집 성공

### Day-1 release blocker
- 외부에 URL을 노출할 계획이면 인증 미구현 상태로 배포하지 않는다
- fallback을 구현하지 않았다면 "partial refresh 지원"으로 설명하고 "fallback 완성"이라고 말하지 않는다
- 최소 1개 live source도 검증되지 않았다면 mock-only 상태로 간주한다

## 3. 권장 소스 우선순위

혼자 구현할 때는 신뢰도와 접근 난이도 기준으로 아래 순서를 권장한다.

1. `notion`
2. `contract_sheet`
3. `fulltime`
4. `ops_notes`
5. 수동 만족도 작성 API
6. `salesmap`
7. `slack`
8. `gmail`
9. 만족도 외부 수집(`sheet_summary`, `google_forms`)

이유:
- 1~5번만으로도 조회형 MVP와 만족도 작성 데모가 가능하다
- 6~9번은 파일 접근, OAuth, 메시지/메일 매칭, 검토 레지스트리 등 실패 변수가 더 많다

## 4. 코딩 시작 전 반드시 준비할 것

### 4-1. 환경변수 채우기
- `.env.example`를 기준으로 `.env` 작성
- `DATABASE_URL` 실제 연결 확인
- `NOTION_API_KEY`, `NOTION_DATABASE_ID` 확인
- `GOOGLE_CONTRACTS_SPREADSHEET_ID` 확인
- `SALESMAP_SNAPSHOT_PATH` 실제 파일 경로 확인
- `SLACK_BOT_TOKEN`, `SLACK_WORKSPACE_ID` 확인
- `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, `GMAIL_ACCOUNT_EMAIL`, `GMAIL_TARGET_ADDRESSES` 확인

### 4-2. 외부 접근 권한
- `GMAIL_ACCOUNT_EMAIL` 계정이 계약 스프레드시트에 실제 접근 가능한지 확인
- `GMAIL_ACCOUNT_EMAIL` 계정이 만족도 스프레드시트들에 실제 접근 가능한지 확인
- Slack bot이 canonical 채널 3개를 읽을 수 있는지 확인
- Notion integration이 대상 DB에 연결되어 있는지 확인

### 4-3. 기준 데이터 1개 선정
- 한 명의 "golden instructor"를 정한다
- 그 강사에 대해 Notion, 계약시트, 세일즈맵, Slack/Gmail 흔적이 있는지 먼저 확인한다
- 이 강사는 상세 조회와 만족도 저장 E2E 검증의 기준 샘플이 된다

### 4-4. mock fallback 준비
- live source 접근이 막히더라도 UI 검증을 계속하려면 `npm run seed:mock` 사용 계획을 세운다
- mock DB와 live DB를 혼용하지 않도록 별도 DB 또는 초기화 절차를 정한다

## 5. 구현 순서 권장안

### 5-1. 첫 1시간
- DB 연결
- `npx prisma generate`
- `npx prisma db push`
- `npx prisma db seed`
- `npm run build`

### 5-2. 다음 2시간
- `notion`, `contract_sheet`, `fulltime`, `ops_notes` 개별 파이프라인 검증
- 목록/상세 화면이 실제 데이터로 뜨는지 확인

### 5-3. 다음 2시간
- 만족도 작성 API와 상세 재조회 E2E 확인
- `POST /api/refresh` 전체 orchestration 검증

### 5-4. 남은 시간
- `salesmap` 연결
- `slack`, `gmail` 연결
- 만족도 외부 수집 검증
- 인증 또는 fallback 중 하나를 마무리

## 6. fail-fast 규칙

- Notion access 실패: UI부터 만들지 말고 integration 권한부터 해결한다
- 계약시트 access 실패: `GMAIL_ACCOUNT_EMAIL` 계정의 실제 스프레드시트 접근 권한부터 해결한다
- Gmail token refresh 실패: Slack/Gmail/만족도 시트 수집을 동시에 막을 수 있으므로 최우선 해결한다
- Salesmap snapshot 경로 미확정: 이 소스는 Day-1 Must-have에서 제외하고 뒤로 미룬다
- 인증 미구현: 외부 공개 중지
- fallback 미구현: 운영 설명 문구에서 제외

## 7. go / no-go 체크

아래가 모두 `yes`면 Day-1 목표 달성으로 본다.

- `GET /api/instructors` 응답 성공
- `GET /api/instructors/{id}` 응답 성공
- `POST /api/instructors/{id}/satisfaction` 후 상세 수치 갱신 확인
- `GET /api/status` 응답 성공
- `POST /api/refresh` 응답 성공 또는 partial
- 최소 1개 live source 성공
- golden instructor 기준 UI 확인 완료

아래 중 하나라도 `no`면 "계속 개발 중" 상태다.

- 인증이 실제로 적용되어 있는가
- fallback 데이터 경로가 실제로 동작하는가
- 접근 권한이 없는 소스를 명확히 비활성화했는가
