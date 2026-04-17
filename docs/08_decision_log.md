# Decision Log

## Role
이 문서는 서비스 구현 과정에서 확정된 주요 정책과 변경 이력을 기록한다.
핵심 정책이 왜 결정되었는지 추적하고, 이후 정책 변경 시 기준점을 제공한다.

## Source of Truth
- 주요 정책 결정 이력
- 변경 사유
- 후속 반영 대상 문서

## Depends On
- `00_docs_index.md`
- `01_core_policy.md`

## Used By
- 모든 문서 수정 작업
- 정책 변경 추적

## Out of Scope
- 현재 유효한 정책의 전체 정의
- 화면 기능 상세
- API 스키마 상세

## 기록 규칙

- 새로운 정책이 확정되거나 기존 정책이 변경되면 이 문서에 기록한다.
- 각 항목은 날짜, 주제, 결정 내용, 반영 대상 문서를 포함한다.
- 구현 세부사항보다 정책 수준의 결정을 우선 기록한다.

## 결정 이력

### 2026-04-14

#### 인증 및 접근 정책
- 결정:
  - Google 로그인 사용
  - `@day1company.co.kr` 도메인만 접근 허용
  - 이번 버전에서는 로그인 사용자 모두 동일 권한
- 반영 문서:
  - `01_core_policy.md`
  - `02_system_architecture.md`
  - `05_api_spec.md`

#### 강사 동일인 판정 정책
- 결정:
  - `instructor_id`를 1차 식별자로 사용
  - 이름 비교는 exact match만 사용
  - alias 매핑은 사용하지 않음
  - 이름이 같더라도 연락처가 다르면 자동 병합하지 않음
- 반영 문서:
  - `01_core_policy.md`
  - `03_data_model.md`
  - `04_data_pipeline.md`

#### 동명이인 처리 정책
- 결정:
  - 동명이인은 이름 끝 suffix로 구분
  - 예: `홍길동`, `홍길동B`
  - suffix는 제거하지 않고 그대로 유지
- 반영 문서:
  - `01_core_policy.md`
  - `04_data_pipeline.md`

#### 카테고리 저장 정책
- 결정:
  - 카테고리는 단일 문자열이 아니라 배열로 저장한다.
  - 노션 multi_select 카테고리는 순서를 유지한 `categories` 배열로 저장한다.
  - 목록 화면에서는 `categories`의 첫 번째 값을 대표 카테고리로 표시한다.
  - 카테고리 필터는 단일 선택을 유지하되, 선택 값이 `categories` 배열에 포함된 강사를 노출한다.
- 반영 문서:
  - `01_core_policy.md`
  - `03_data_model.md`
  - `04_data_pipeline.md`
  - `05_api_spec.md`
  - `06_implementation_spec.md`

#### 전임강사 판정 및 표시 정책
- 결정:
  - 전임강사 여부는 별도 JSON 리스트 기준
  - 전임강사 여부와 fee는 별도 속성으로 관리
  - 화면에서는 `전임강사` 배지를 표시
- 반영 문서:
  - `01_core_policy.md`
  - `03_data_model.md`
  - `04_data_pipeline.md`
  - `06_implementation_spec.md`

#### 전임강사 fee 정책
- 결정:
  - 전임강사 fee는 노션 기본 강사료 또는 fee_note 기준으로 내부 데이터에 반영
  - 화면에서는 전임강사 fee를 직접 노출하지 않음
  - 전임강사는 fee 대신 `전임강사` 상태로 표시
- 반영 문서:
  - `01_core_policy.md`
  - `04_data_pipeline.md`
  - `06_implementation_spec.md`

#### 일반 강사 fee 결정 우선순위
- 결정:
  - 일반 강사 fee는 `fee_fix_configs > 노션 > 세일즈맵 > 계약시트` 순서로 확인한다.
  - 전임강사는 이 우선순위를 따르지 않고 노션 기준만 사용한다.
  - `fee_fix_configs`는 코드 하드코딩이 아니라 별도 설정 테이블로 관리한다.
- 반영 문서:
  - `03_data_model.md`
  - `04_data_pipeline.md`

#### 특수 금액 처리 정책
- 결정:
  - 콘텐츠 제작비, 건당 금액, 출장비 포함 금액, 개발비 등은 일반 시간당 강사료와 분리
  - 특수 금액은 `base_fee_hourly` 계산에 직접 사용하지 않음
  - `콘텐츠`, `제작`, `개발비`, `출장비`, `별도`, `건당`, `프로젝트`, `패키지`, `특강`, `자료개발`, `원고`, `감수` 키워드가 있으면 특수 금액 후보로 분류
  - 시간당 단가로 읽히지 않는 표현과 복수 단가 표기는 기본 단가 후보에서 제외
  - 동일 강사의 일반 출강료 분포 대비 3배 이상 큰 금액은 특수 금액 후보로 처리
- 반영 문서:
  - `01_core_policy.md`
  - `03_data_model.md`
  - `04_data_pipeline.md`
  - `06_implementation_spec.md`

#### Engagement Score 정책
- 결정:
  - 총점 100점
  - 구성 요소 7개 사용
  - 가중치:
    - 출강횟수 35
    - 만족도 15
    - 슬랙 활동 15
    - 최근성 15
    - 세일즈맵 딜 10
    - 이메일 활동 5
    - 운영 채널 활동 5
  - 만족도 결측 시 중앙값 대체
  - 실습코치는 0점 처리
- 반영 문서:
  - `01_core_policy.md`
  - `03_data_model.md`
  - `04_data_pipeline.md`
  - `05_api_spec.md`
  - `06_implementation_spec.md`

#### 실습코치 판정 정책
- 결정:
  - 실습코치 판정은 기존 기준 유지
  - 3-Layer 기준 적용
  - L1: 계약시트에서 `보조강사`, `코치`, `실습코치`, `멘토`, `문항개발` 비율이 정규강사 비율보다 높으면 후보
  - L2: `base_fee_hourly >= 100000` 이고 `categories`와 `specialties`가 모두 비어 있지 않으면 후보 제외
  - L3: 전임강사 리스트에 포함된 강사는 무조건 후보 제외
  - 최종 후보만 실습코치로 분류하고 score 0점 처리
- 반영 문서:
  - `01_core_policy.md`
  - `04_data_pipeline.md`

#### 추천/지양/운영 인텔리전스 정책
- 결정:
  - 추천 대상, 지양 대상, 리스크, 운영 확인 필요 사항은 노션 외 다른 소스도 허용
  - 구조화 필드가 소스에 직접 존재하면 해당 값을 우선 사용
  - 구조화 필드가 없고 원문 근거만 있는 경우 LLM을 이용해 구조화 가능
  - LLM은 원문 근거 기반 정리만 수행하며, 근거 없는 추측이나 새로운 사실 생성은 허용하지 않음
  - 근거가 부족하면 해당 필드는 비워 둠
  - 운영 인텔리전스는 파이프라인 단계에서 생성해 `instructor_intelligence`에 저장한다.
  - API와 화면은 저장된 결과만 사용하고, 요청 시점에 LLM을 다시 호출하지 않는다.
- 반영 문서:
  - `01_core_policy.md`
  - `03_data_model.md`
  - `04_data_pipeline.md`
  - `05_api_spec.md`
  - `06_implementation_spec.md`

#### 만족도 정책
- 결정:
  - 만족도는 이번 버전에서 조회와 작성 모두 포함
  - 점수 계산에도 사용
  - 만족도 결측 시 중앙값 대체 여부를 저장
- 반영 문서:
  - `01_core_policy.md`
  - `03_data_model.md`
  - `04_data_pipeline.md`
  - `05_api_spec.md`
  - `06_implementation_spec.md`

#### 데이터 소스 우선순위 정책
- 결정:
  - 기본 우선순위는 `계약시트 > 노션 > 세일즈맵 > 지메일/슬랙`
  - 강사 기본 프로필은 노션 우선
  - 출강 이력은 계약시트 우선
- 반영 문서:
  - `01_core_policy.md`
  - `04_data_pipeline.md`

#### 외부 데이터 소스 접근 방식
- 결정:
  - 노션은 Notion API로 수집한다.
  - 세일즈맵은 GitHub release로 배포된 스냅샷 데이터를 읽는다.
  - 슬랙은 MCP 연결을 사용한다.
  - 지메일은 MCP 연결을 사용한다.
  - Google Forms 만족도 데이터는 Google Sheets API로 직접 읽는다.
- 반영 문서:
  - `02_system_architecture.md`
  - `04_data_pipeline.md`

#### refresh 정책
- 결정:
  - 수동 새로고침 제공
  - 새로고침 시 데이터 업데이트 여부를 다시 조회하고 변경분을 반영
  - 실패 시 기존 데이터 유지
- 반영 문서:
  - `01_core_policy.md`
  - `04_data_pipeline.md`
  - `05_api_spec.md`
  - `06_implementation_spec.md`

#### fallback 정책
- 결정:
  - 기존 fallback 정책 유지
  - 최신 데이터 조회 실패 시 마지막 정상 저장 데이터 사용
  - 마지막 정상 저장 데이터도 없으면 정적 baseline 사용
- 반영 문서:
  - `01_core_policy.md`
  - `04_data_pipeline.md`

### 2026-04-15

#### Notion 파일럿 구현 계약 보강
- 결정:
  - Notion 수집기의 canonical 환경변수 이름은 `NOTION_API_KEY`, `NOTION_DATABASE_ID`를 사용한다.
  - `04_data_pipeline.md` 5-2-1 표에는 실제 프로퍼티명뿐 아니라 live Notion API 기준 현재 타입도 함께 기록한다.
  - Notion 수집기는 문서 타입을 참고하되, 실제 구현에서는 `property.type`을 런타임에 검증한다.
  - `기본 강사료`가 Notion `number` 타입이면 `0` 초과 값을 시간당 단가로 간주해 `base_fee_hourly`로 반영한다.
  - `fee_note`는 보조 설명 필드로만 사용하고, number 필드의 `base_fee_hourly` 반영 여부를 막는 조건으로 사용하지 않는다.
  - Notion 단일 소스 파일럿의 `instructors` upsert는 `name` exact match 기준으로 `create/update`를 수행한다.
  - Notion 소유 필드는 snapshot 방식으로 갱신하며, 원문이 빈값이면 `NULL` 또는 빈 배열로 덮어쓴다.
  - Notion 비소유 필드는 update 대상에서 제외하고 DB의 기존 값을 보존한다.
  - 별도 source가 없으면 `display_name = name`으로 유지한다.
- 반영 문서:
  - `02_system_architecture.md`
  - `04_data_pipeline.md`

#### 파이프라인 트리거 API 분리
- 결정:
  - 전체 orchestration 실행은 `POST /api/refresh`가 담당한다.
  - 소스별 파이프라인 실행은 `POST /api/pipeline/notion` 같은 운영/관리용 내부 API로 분리한다.
  - 운영/관리용 파이프라인 트리거 API는 사용자용 API 스펙 `05_api_spec.md`와 분리해 관리한다.
- 반영 문서:
  - `02_system_architecture.md`
  - `04_data_pipeline.md`
  - `05_api_spec.md`

#### 목록/상세/만족도 API 계약 보강
- 결정:
  - `GET /api/instructors`의 `meta.total_count`는 limit 적용 전 전체 매칭 건수로 정의한다.
  - `GET /api/instructors/{id}`의 `total_paid`는 화면 라벨 `누적 지급액 (추정)`에 대응하며, `SUM(deal_fee_hourly * total_hours)`로 계산 가능한 행만 합산한다.
  - 만족도 저장 성공 시 외부 소스를 재조회하지 않고, DB에 저장된 현재 canonical 값을 입력으로 사용해 전체 강사의 `score`, `score_breakdown`, `score_calculated_at`, `rank`를 같은 요청 흐름 안에서 재계산한다.
  - 위 전체 재계산에서 만족도 컴포넌트만 최신 집계를 기준으로 다시 계산하고, 나머지 비만족도 컴포넌트는 현재 저장된 canonical 값 또는 저장된 구성 요소를 재사용한다.
- 반영 문서:
  - `04_data_pipeline.md`
  - `05_api_spec.md`
  - `05_api_spec.md`
  - `06_implementation_spec.md`

#### 민감정보 노출 정책
- 결정:
  - 이번 버전은 내부 사용자 전용 서비스이므로 연락처와 운영 메모를 마스킹 없이 노출
- 반영 문서:
  - `01_core_policy.md`
  - `06_implementation_spec.md`

#### 저장소 및 배포 정책
- 결정:
  - 마스터 데이터 저장소는 Railway PostgreSQL
  - 애플리케이션 배포 환경도 Railway 사용
- 반영 문서:
  - `01_core_policy.md`
  - `02_system_architecture.md`
  - `03_data_model.md`

#### 파일럿 검증: DB 접근 라이브러리 선택
- 결정:
  - ORM으로 Prisma를 사용한다.
  - `02_system_architecture.md`에 ORM 명시가 없어 사용자 확인 후 결정했다.
- 사유:
  - Next.js + TypeScript 환경에서 타입 안전한 DB 접근이 필요하다.
  - Prisma는 스키마 기반 클라이언트 생성으로 `03_data_model.md` 필드 정의와 1:1 대응이 가능하다.
- 반영 대상:
  - `package.json` (`prisma`, `@prisma/client`)
  - `prisma/schema.prisma`
  - `src/lib/prisma.ts`

#### 파일럿 검증: 범위 및 결과
- 결정:
  - 파일럿 검증 범위를 아래 4개로 확정하고 구현했다.
    1. 공유 타입 정의 (`05_api_spec.md` 3절, 5-5절)
    2. instructors 최소 스키마 (`03_data_model.md` 4-1절 29필드)
    3. GET /api/instructors (`05_api_spec.md` 5절, 정렬/필터 없이 전체 목록)
    4. 목록 UI (`06_implementation_spec.md` Feature A, 검색/필터/정렬 없이 목록만)
  - 정렬, 필터, 검색, 상세 패널은 파일럿 범위에서 제외했다.
- 검증 결과:
  - TypeScript 타입 체크 통과
  - Next.js 빌드 성공
  - Railway PostgreSQL 스키마 적용 완료
  - 시드 데이터 5건 적재, API 응답 정상 확인
  - 전임강사 `base_fee_hourly = null` 반환 확인 (`05_api_spec.md` 5-5절)
  - 공통 envelope 구조 (`status`, `meta`, `data`) 확인 (`05_api_spec.md` 3절)
- 반영 대상:
  - `src/types/api.ts`
  - `prisma/schema.prisma`
  - `src/app/api/instructors/route.ts`
  - `src/components/InstructorList.tsx`
  - `src/app/page.tsx`
  - `src/app/layout.tsx`

#### 파일럿 검증: 병렬 구현 가능성 판정
- 결론: **병렬 구현 확장 가능**
- 판정 근거:
  - 계약 독립성 확인:
    - `src/types/api.ts`가 프론트엔드와 백엔드 사이의 타입 계약 역할을 한다. 각 트랙이 문서(`05_api_spec.md`)만 보고 자기 담당 타입을 추가할 수 있다.
    - `prisma/schema.prisma`가 DB 구조의 단일 진실 소스 역할을 한다. Track A가 확정한 스키마 위에서 Track B, C가 독립적으로 작업할 수 있다.
    - API envelope 구조(`status`, `meta`, `data`)가 모든 엔드포인트에 공통으로 적용되므로, 각 엔드포인트를 별도 트랙에서 구현해도 응답 형식이 일관된다.
  - 레이어 간 독립 구현 확인:
    - Track A 결과물(Prisma 스키마) 위에 Track C(API 라우트)가 독립적으로 구현 가능했다.
    - Track C 결과물(API 응답) 위에 Track D(목록 UI)가 독립적으로 구현 가능했다.
    - 각 레이어가 문서에 정의된 계약만으로 연결되며, 구현 내부 세부사항에 의존하지 않았다.
  - 파일 충돌 부재 확인:
    - `09_work_split.md` 10절에 정의된 파일 책임 경계가 실제 파일럿 구현에서도 유효했다.
    - Track A(`prisma/`), Track C(`src/app/api/`), Track D(`src/components/`, `src/app/page.tsx`)가 서로 다른 디렉토리에서 작업하며 파일 충돌이 없었다.
  - 공유 파일 관리 가능 확인:
    - 공유 타입 파일(`src/types/api.ts`)은 엔드포인트별로 독립된 인터페이스를 추가하는 방식이므로, 같은 인터페이스를 동시에 수정할 가능성이 낮다.
    - `prisma/schema.prisma`는 Track A에서 전체 모델을 선행 확정하므로 이후 트랙에서 수정할 필요가 없다.
- 발견된 문서 수정 필요 사항: 없음
  - 파일럿 범위에서 문서 정의와 실제 구현 사이에 불일치가 발견되지 않았다.
  - 문서 간 충돌도 발견되지 않았다.
- 파일럿이 증명한 것:
  - 문서가 실제 계약으로 기능한다.
    - 9개 문서를 읽고 문서 밖의 판단 없이 타입 → 스키마 → API → UI까지 연결되었다.
    - 문서 세트가 참고용이 아니라 실행 가능한 스펙으로 동작한다.
    - 구현자가 누구든(사람이든 AI든) 문서만 읽으면 동일한 결과물을 만들 수 있다.
  - 레이어 간 의존이 문서 계약으로만 연결된다.
    - 스키마 담당자는 `03_data_model.md`만, API 담당자는 `05_api_spec.md`만, UI 담당자는 `06_implementation_spec.md`만 참조했다.
    - 각자 만든 결과물이 서로의 코드를 보지 않고도 조합되어 동작했다.
    - 이것은 문서만으로 병렬 작업이 가능하다는 직접 증거다.
  - 병렬 구현의 전제 조건이 성립한다.
    - 병렬 구현 실패 원인인 "계약 모호 → 서로 다른 해석"과 "파일 충돌 → 머지 실패"가 모두 발생하지 않았다.
- 파일럿이 커버하지 못한 것:
  - Track B(파이프라인)는 검증하지 않았다. 외부 소스 수집/병합/검증 로직이 문서 계약만으로 독립 구현 가능한지는 미확인이다.
  - Track E(통합)도 미검증이다. fallback 전환, 만족도 작성 후 score 재계산 같은 트랙 간 연결 흐름은 확인되지 않았다.
  - 동시 머지 시 실제 git 충돌 가능성은 검증하지 않았다.
- 미검증 항목 해소를 위한 권장 후속 파일럿:
  - 파이프라인 파일럿: Track B 범위에서 단일 소스(예: 노션) 수집 → `instructors` 저장까지의 최소 흐름을 구현해 `04_data_pipeline.md`가 계약으로 기능하는지 검증한다.
  - 통합 파일럿: 만족도 작성(POST) → score 재계산 → 상세 재조회(GET)의 트랙 간 연결 흐름을 구현해 Track C-D-E 접점에서 충돌이 없는지 검증한다.
  - 머지 파일럿: Track C와 Track D를 별도 git 브랜치에서 동시 구현한 뒤 실제 머지해 파일 충돌 여부를 검증한다.
- 후속 조치:
  - 파일럿에서 확인된 병렬 구현 가드레일을 `09_work_split.md` 13절에 반영했다.
  - 반영 항목: 공유 파일 관리 규칙, Track A 선행 완료 기준, 트랙 간 동시 진행 조건, 충돌 방지 원칙

### 2026-04-15

#### 파이프라인 파일럿 검증: Notion 단일 소스 → instructors 저장 → API 반환
- 결정:
  - 파이프라인 파일럿 범위를 아래 4개로 확정하고 구현했다.
    1. Notion 소스 수집 (`04_data_pipeline.md` 4-2절, 5-2절)
    2. 정규화 (`04_data_pipeline.md` 6절)
    3. instructors 테이블 저장 (`03_data_model.md` 4-1절)
    4. GET /api/instructors 응답 반영 확인 (`05_api_spec.md` 5절)
  - 계약시트, 세일즈맵, 슬랙, 지메일, Google Forms, teaching_histories, fee_histories, instructor_intelligence 저장은 범위 밖으로 제외했다.
- 검증 결과:
  - Notion API 접속 및 774페이지 전량 수집 성공
  - 5-2-1절 프로퍼티 매핑 정상 (강사명, 소속정보, 카테고리, 이메일, 연락처, 기본 강사료, 강사료 특이사항)
  - 6절 정규화 정상 (이름 trim, multi_select→배열/join, 금액 정수화, 빈값→null, 배열 중복 제거)
  - 보조 연락처 라벨 보존 정상 (이메일 주소(2), 연락처2 → memoRaw에 `보조 이메일:`, `보조 연락처:` 라벨) — 49건
  - instructors 테이블 773건 저장 (774페이지 중 이름 없는 1건 제외)
  - GET /api/instructors 응답 구조 일치 (status, meta 전 필드, 11개 아이템 필드, limit 100건)
- 구현 버그:
  - B1: 실데이터 파일럿에서 mock seed reset 정책 미준수. 04_data_pipeline.md는 실데이터 파일럿에서 기존 mock seed와 merge하지 않도록 정의하나, DB에 seed 5건(홍길동, 김영희, 이철수, 박지민, 최수진)이 그대로 남아 총 778건이 됨. 사후 수동 삭제로 773건으로 정리함. 문서 gap 아님, 구현 버그.
- 발견된 문서 gap:
  - G1: `NOTION_DATABASE_ID` 환경변수 미정의. `02_system_architecture.md` 11-3절에 `NOTION_API_KEY`만 명시. 대상 DB ID 환경변수 정의 없음.
  - G2: Notion 프로퍼티 타입 정보 부재. 5-2-1절은 프로퍼티명만 명시. 실제 타입(number, multi_select 등)은 API 호출 후에야 확인 가능.
  - G3: `base_fee_hourly` "명확한 시간당 강사료" 판정 기준 모호. 5-2-1절의 "시간당 강사료가 명확한 경우에만"에 대한 구체적 판정 기준 없음.
  - G4: 동일인 upsert 전략 미명시. `01_core_policy.md` 4절은 판정 기준만 정의. 기존 레코드 update/신규 create 정책 없음.
  - G5: 소스별 개별 트리거 엔드포인트 미정의. `05_api_spec.md`는 `POST /api/refresh`만 정의.
  - G6: `display_name` Notion 소스 초기값 규칙 모호. `03_data_model.md` 4-1절 기본값 `name`이라고만 되어 있으나 Notion에 별도 프로퍼티 없을 때의 명시적 규칙 없음.
- 최종 DB 통계 (mock 제거 후):
  - 전체 773, 이메일 760, 전화 746, 기본단가 544, 카테고리 447, 소속 50, fee_note 132, 보조연락처 보존 49, is_fulltime 0 (전임강사 판정은 파일럿 범위 밖)
- 결론:
  - `04_data_pipeline.md`는 Notion 단일 소스 수집·정규화·저장에 대해 대체로 구현 가능한 수준의 계약이다.
  - G1~G6의 gap으로 구현자 임의 판단이 개입된다. 특히 G1(DB ID 환경변수)과 G4(upsert 정책)는 문서에 추가할 가치가 있다.
- 반영 대상:
  - `.env.example` (`NOTION_API_KEY`, `NOTION_DATABASE_ID` 추가)
  - `src/lib/pipeline/notion-collector.ts`
  - `src/lib/pipeline/normalizer.ts`
  - `src/lib/pipeline/store.ts`
  - `src/app/api/pipeline/notion/route.ts`

#### 머지 충돌 검증 파일럿: Track C / Track D 병렬 구현
- 결정:
  - 파일럿 3 범위를 아래 3개로 확정하고 구현했다.
    1. Track C: `GET /api/instructors`의 검색/필터/정렬 구현
    2. Track D: 검색 UI, 카테고리 필터 UI, 정렬 드롭다운 UI 구현
    3. 두 브랜치의 순차 머지와 git 충돌 여부 검증
  - Track C 구현 결과는 `main` baseline에 유지한다.
  - Track D 구현 결과도 `main` baseline에 유지한다.
  - 파일럿 3 결과물은 검증 전용 임시 코드로 폐기하지 않고, 문서 계약을 충족하는 baseline feature로 채택한다.
- 검증 결과:
  - Track C 브랜치는 `src/app/api/instructors/route.ts`만 수정했다.
  - Track D 브랜치는 `src/components/InstructorList.tsx`, `src/app/page.tsx`만 수정했다.
  - 두 브랜치가 수정한 파일 집합의 교집합은 0건이었다.
  - `src/types/api.ts`, `prisma/schema.prisma` 같은 공유 파일 수정은 발생하지 않았다.
  - Track C → `main`, Track D → `main` 순차 머지 시 git 충돌 0건이었다.
  - 머지 후 `query`, `category`, `sort`, `limit`, `empty`, `INVALID_SORT`, `INVALID_LIMIT` 동작을 모두 검증했다.
  - `09_work_split.md` 10절과 13절의 파일 책임 경계가 git 수준에서도 유효함을 확인했다.
- 결론:
  - Track C / Track D는 현재 문서 계약과 파일 경계만 지키면 병렬 구현 및 자동 머지가 가능하다.
  - 본 병렬 구현 전 검증 웨이브는 파일럿 1, 2, 3 통과로 완료됐다.
  - 다음 단계는 본 병렬 구현 `Wave 1` 범위 설계다.
- 반영 대상:
  - `src/app/api/instructors/route.ts`
  - `src/components/InstructorList.tsx`
  - `src/app/page.tsx`
  - `10_execution_plan.md`

#### Pilot 4-2: 전임강사 JSON + 운영 메모 hardcoded JSON canonical 계약 확정
- 결정:
  - 운영 메모 hardcoded 소스 파일의 canonical 경로는 `data/ops-notes-hardcoded.json`으로 확정한다.
  - JSON 스키마는 `04_data_pipeline.md` 5-8-2절을 단일 진실 소스로 사용한다.
    - top-level: `version`, `updated_at`, `notes`
    - `notes[]`: `name`(필수, exact match 키), `memo`(필수, 원문), `source_ref`(선택)
  - 초기 또는 데이터 부재 시 `{ "version": 1, "updated_at": "<date>", "notes": [] }`로 시작한다.
  - 전임강사 JSON은 `prisma/fulltime_instructors.json`을 그대로 직접 읽어 `is_fulltime`을 갱신하며, 본 파일럿 범위에서는 `fulltime_instructor_configs` 테이블을 사용하지 않고 JSON 직접 로딩 방식만 사용한다. (`04_data_pipeline.md` 5-7-1절 `또는 동등한 내부 설정 구조` 허용 범위에 해당)
  - `memo_raw`는 Notion 파일럿에서 주입된 보조 이메일/연락처 appendix를 보존하기 위해 **기존 값 + hardcoded 운영 메모 비파괴 병합** 방식으로만 갱신한다. 덮어쓰기를 금지한다.
  - 병합 규칙:
    - 기존 `memo_raw`에 이미 동일한 메모 라인이 포함돼 있으면 중복 추가하지 않는다.
    - 5-8-1절 및 6절의 운영 메모 필터 규칙(10자 미만, 민감 키워드, 시작 패턴 제외)을 hardcoded note에도 동일하게 적용한다.
  - `is_fulltime` 판정은 `01_core_policy.md` 4절 기준 `name` exact match만 사용한다.
  - 본 파일럿은 pipeline 실행 단위로 `pipeline_runs` 1건을 기록하고, 각 소스(전임강사 JSON, 운영 메모 JSON)별로 `source_sync_logs` 1건씩을 기록한다.
  - 소스별 엔드포인트는 `04_data_pipeline.md` 21-2절에 따라 `POST /api/pipeline/fulltime`, `POST /api/pipeline/ops-notes`로 분리한다.
- 반영 문서:
  - `04_data_pipeline.md` (5-8-2절 신설)
  - `08_decision_log.md`
- 반영 대상:
  - `data/ops-notes-hardcoded.json`
  - `src/lib/pipeline/fulltime-loader.ts`
  - `src/lib/pipeline/ops-notes-loader.ts`
  - `src/lib/pipeline/config-applier.ts`
  - `src/app/api/pipeline/fulltime/route.ts`
  - `src/app/api/pipeline/ops-notes/route.ts`

#### Pilot 4-1 선행 Track A mini-prep: `pipeline_runs`, `source_sync_logs` 스키마 추가
- 결정:
  - Pilot 4-1(계약시트 단일 소스 수집 검증) 본 실행 전에 파이프라인 실행/소스 수집 로그 저장에 필요한 최소 엔티티만 먼저 스키마에 반영한다.
  - 반영 범위는 `03_data_model.md` 4-8절(`pipeline_runs`), 4-9절(`source_sync_logs`) 필드 정의 그대로이며, 문서에 없는 필드는 추가하지 않는다.
  - `run_type`, `status`, `source_type`은 문서가 TEXT로 정의하므로 Prisma enum 대신 `String`으로 매핑한다.
  - `SourceSyncLog.runId`는 `PipelineRun.id`를 참조하는 FK로 구성하며, Prisma 요건상 `PipelineRun.sourceSyncLogs` back-relation만 최소 범위로 추가한다.
  - `practice_coach_rules`, `fulltime_instructor_configs`, `fee_histories` 확장, status/refresh API, 계약시트 수집 로직, 세일즈맵/슬랙/지메일/Google Forms 관련 모델은 이번 선행 작업 범위에서 제외한다.
  - 스키마 반영은 migrations 디렉토리가 없는 현 운영 방식에 맞춰 `prisma db push`로 Railway DB에 직접 적용한다.
- 검증 결과:
  - `npx prisma generate` 성공 (Prisma Client v6.19.3 재생성)
  - `npx prisma db push` 성공 (Railway DB `public` 스키마 sync, 11.71s)
  - Smoke insert 성공:
    - `pipeline_runs` 단건 insert OK
    - `source_sync_logs` FK 연결 insert OK
    - `include: { sourceSyncLogs: true }` 관계 쿼리 OK
    - 테스트 레코드는 즉시 삭제해 실데이터 오염 없음
  - `npm run lint` 성공 (ESLint v9 무출력 = 통과)
  - `npm run build` 성공 (`Compiled successfully`, 기존 6개 라우트 모두 정상 빌드)
  - 기존 모델(`Instructor`, `TeachingHistory`, `SatisfactionRecord`, `ScorePolicyVersion`) 및 기존 API 라우트와 충돌 없음
- 반영 대상:
  - `prisma/schema.prisma` (`PipelineRun`, `SourceSyncLog` 모델 추가)
  - Railway PostgreSQL `public` 스키마 (`pipeline_runs`, `source_sync_logs` 테이블 생성)
- 참고:
  - 본 작업은 Pilot 4-1 본 실행의 Blocker B2(로그 테이블 부재) 해소용 최소 선행 작업이며, Pilot 4-1 본 실행에 필요한 나머지 blocker(B1: 계약시트 canonical 원천 미정의, B3: `10_execution_plan.md`에 Pilot 4-1 미등재)는 여전히 해소되지 않았다.

#### Pilot 4-1: 계약시트 Google Sheets API 외부 수집 검증 완료
- 결정:
  - 계약시트 canonical source는 Google Sheets API(Service Account)이며, spreadsheet `1QFlQItxBOrnTfF_wvjb5T7fhImbibeK2De4ZFyb0EWA`의 `gid=158052384`, `gid=1875350219` 두 worksheet를 함께 수집한다.
  - `company_name`은 계약시트 직접 컬럼이 없으므로 `NULL`로 유지한다.
  - `instructors.name` exact match 실패 행은 최소 instructor 레코드(`name`, `display_name = name`)를 생성하는 B안으로 처리한다.
  - `teaching_histories` dedupe는 `source_ref.spreadsheet_id + worksheet_gid + row_number` 조합으로 처리한다.
- 검증 결과:
  - 두 worksheet 총 4,604행을 수집했고, 2,468건을 `teaching_histories`에 적재했다.
  - `instructors.total_courses`, `recent_courses_6mo` 집계는 405명에 대해 갱신됐다.
  - `pipeline_runs` 1건, `source_sync_logs` 2건이 worksheet별로 기록됐다.
  - `GET /api/instructors`, `GET /api/instructors/{id}`에서 `total_courses`, `recent_courses_6mo`, `teaching_history` 반영을 확인했다.
- 추가로 문서에 반영한 튜닝 포인트:
  - 실제 계약시트 헤더는 개행과 예시 문구를 포함할 수 있으므로, canonical 매칭 전에 `첫 개행 이전 + 공백 축약 + trim` 정규화를 적용한다.
  - 계약시트 `시간당 강사료`는 `10000` 이하뿐 아니라 `10000000` 초과 비정상 concat 값도 `NULL` 처리한다.
  - `강의 일정` 날짜 추출의 최소 지원 포맷은 `YYYY-MM-DD`, `YYYY.MM.DD`, `YYYY/MM/DD`, `YYYY년 M월 D일`로 명시한다.
- 후속 개선 메모:
  - 실데이터의 `강의 일정` 표현 다양성으로 날짜 파싱 커버리지는 아직 제한적이며, 추가 포맷 카탈로그 보강 여지가 있다.
  - 현재 구현은 행 단위 DB roundtrip이 많아 실행 시간이 길다. 성능 최적화는 후속 과제로 남긴다.

#### Pilot 4-3: 세일즈맵 스냅샷 외부 수집 검증 완료
- 결정:
  - 현재 단계의 세일즈맵 canonical source는 env `SALESMAP_SNAPSHOT_PATH`로 주입되는 local SQLite snapshot file로 확정한다.
  - `SALESMAP_RELEASE_URL`은 후속 자동 다운로드 단계가 생길 때의 배포 경로로만 남겨두고, Pilot 4-3 직접 실행에서는 사용하지 않는다.
  - 세일즈맵은 새 강사를 생성하지 않고 `instructors.name` exact match 되는 기존 강사만 보강한다.
  - 세일즈맵의 기업명/과정명 보강은 `instructors`에 새 필드를 만들지 않고 기존 `teaching_histories` 행 중 `(instructor_db_id, course_id)`가 매칭되는 행에만 반영한다.
  - 세일즈맵 `강사료`는 기본 단가로 직접 확정하지 않고 `10000 < fee <= 3000000` 구간일 때만 hourly candidate로 분류한다.
  - `fee_histories` 모델이 실제 스키마에 반영되기 전까지 세일즈맵 fee 후보는 DB에 적재하지 않고 pipeline summary 집계로만 남긴다.
- 검증 결과:
  - 강사명 있는 `deal` 531건, slot unpivot 793건을 수집했다.
  - exact match 강사 187명에 대해 `last_activity_at`를 갱신했다.
  - 기존 `teaching_histories` 1,100건의 `company_name`, 1,040건의 `course_name`을 보강했다.
  - `pipeline_runs` 1건, `source_sync_logs` 1건을 성공 상태로 기록했다.
  - `GET /api/instructors`, `GET /api/instructors/{id}`에서 보강 결과를 확인했다.
- 후속 개선 메모:
  - `SALESMAP_SNAPSHOT_PATH`를 `02_system_architecture.md` canonical env 목록에 반영했다.
  - 세일즈맵 fee 후보를 실제 이력 테이블에 적재하려면 `fee_histories` 모델의 스키마 반영이 먼저 필요하다.

#### Pilot 4-5 v1: Slack/Gmail activity-only direct API 계약 확정
- 결정:
  - Slack/Gmail v1은 direct API로 수집하되, live 응답을 바로 서비스용 필드에 반영하지 않고 먼저 DB 중간 저장본 `activity_import_items`에 저장한다.
  - `activity_import_items`는 하나의 공통 테이블로 사용하며, `source_type`, `source_ref`, `raw_payload`, `candidate_name`, `candidate_email`, `activity_at`, `match_status`, `matched_instructor_id`, `match_basis`, `error_reason`를 공통 구조로 갖는다.
  - 중복 판정 키는 `source_type + source_ref` 조합을 사용한다.
  - 자동 반영 가능한 `matched` activity만 서비스용 필드에 반영하고, `unmatched`, `ambiguous`, `invalid`는 검토 대상으로 남긴다. 사람 승인 후 반영 구조는 v1 범위에 포함하지 않는다.
  - 서비스 반영용 canonical 필드는 아래 5개로 확정한다.
    - `slack_activity_count`
    - `email_activity_count`
    - `ops_report_activity_count`
    - `dispatch_request_activity_count`
    - `last_activity_at`
  - Slack count 규칙은 `스레드가 있으면 thread 1개 = activity 1건`, 스레드가 없으면 `message 1개 = activity 1건`으로 확정한다. reply 수는 count를 직접 늘리지 않지만, 스레드 마지막 reply 시각은 `last_activity_at` 계산 후보로 사용한다.
  - Gmail count 규칙은 `thread 1개 = activity 1건`으로 확정한다.
  - Slack v1 canonical scope는 아래 3개 채널로 제한한다.
    - 운영보고: `C015YD84VGS`
    - 출강요청(정백): `C099UH7ACGG`
    - 출강요청(신동원): `C0AS2VDUXQ8`
  - 출강요청 활동은 일반 채널 목록 집계가 아니라 `channel_id -> instructor name` 전용 매핑을 우선 적용한다.
  - Slack 인증은 `SLACK_BOT_TOKEN`, `SLACK_WORKSPACE_ID`를 사용한다.
  - Gmail 인증은 Google Workspace domain-wide delegation이 아니라 OAuth refresh token 방식으로 확정하며, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, `GMAIL_ACCOUNT_EMAIL`, `GMAIL_TARGET_ADDRESSES`를 사용한다.
  - Gmail v1은 그룹 주소 자체로 로그인하지 않고, 실제 로그인 가능한 계정 mailbox에서 `GMAIL_TARGET_ADDRESSES`로 수신된 thread를 검색한다.
  - Slack/Gmail v1은 활동량과 최근 활동일만 다루며, 원문 body 기반 `memo_raw` 갱신과 LLM 구조화는 별도 canonical 규칙이 정의될 때까지 범위에서 제외한다.

### 2026-04-16

#### Pilot 4-5 v2: Slack/Gmail 증분 수집(checkpoint + upsert) 전환
- 결정:
  - `activity_import_items`에 `source_ref_key` TEXT 필드를 추가하고, `(source_type, source_ref_key)` unique index를 둔다.
  - `source_checkpoints` 테이블을 신설한다: `source_type`, `scope_key`, `checkpoint_json` (JSONB), `last_synced_at`, `created_at`, `updated_at`, `(source_type, scope_key)` unique.
  - Slack checkpoint scope_key: `slack:channel:{channelId}`. checkpoint_json: `{ last_seen_ts }`.
  - Gmail checkpoint scope_key: `gmail:target:{targetAddress}`. checkpoint_json: `{ last_internal_date_ms }`.
  - Slack incremental: `conversations.history` `oldest` = `last_seen_ts - overlap_seconds`. overlap_seconds 기본값 600초 (보수적).
  - Gmail incremental: `after:<epoch_seconds>` 쿼리 사용. epoch는 `last_internal_date_ms / 1000`.
  - `activity_import_items`는 insert-only가 아니라 `(source_type, source_ref_key)` 기준 upsert: 없으면 insert, 있으면 update.
  - aggregate 재계산은 이번 실행에서 insert/update된 matched 아이템이 영향준 강사만 대상. idempotent하게 해당 강사의 전체 matched items 기준 recount.
  - `?mode=reconcile` query param으로 checkpoint 무시 full backfill을 지원한다.
  - Slack incremental 한계: `conversations.history` oldest는 top-level 메시지 ts 기준이므로, overlap 범위 밖의 오래된 thread에 새 reply가 달린 경우 놓칠 수 있다. 주기적 reconcile(`?mode=reconcile`)로 보완해야 한다.
  - score 재계산, memo_raw, full body dump, LLM 구조화는 여전히 v2 범위 밖이다.
- 반영 문서:
  - `08_decision_log.md`
- 반영 대상:
  - `prisma/schema.prisma` (ActivityImportItem.sourceRefKey, SourceCheckpoint 모델)
  - `src/lib/pipeline/slack-activity-collector.ts` (incremental 수집)
  - `src/lib/pipeline/gmail-activity-collector.ts` (incremental 수집)
  - `src/lib/pipeline/activity-applier.ts` (upsert + 부분 aggregate)
  - `src/app/api/pipeline/slack/route.ts` (checkpoint 읽기/쓰기)
  - `src/app/api/pipeline/gmail/route.ts` (checkpoint 읽기/쓰기)

#### Wave 1 범위 확정 및 실행 방식
- 결정:
  - Wave 1 범위를 B(Must-have + Should-have)로 확정했다.
  - Must-have: 상세 패널 UI, 만족도 작성 UI, page.tsx 레이아웃 연결, GET /api/status, POST /api/refresh, 누락 스키마 보강 7개 모델
  - Should-have: 실습코치 3-Layer 판정, Fee 우선순위 체인 + 특수금액 분리, fee_histories 적재, Fallback 배너 UI
  - 제외(후속): 운영 인텔리전스 LLM 생성, validation_issues 17개 규칙 전체, 만족도 외부 수집(Google Forms)
  - 실행 방식은 문서 주도 개발을 따른다. 구현 전 `11_wave1_tasks.md`에 태스크를 정의하고, 문서 기준으로 검증한다.
- 반영 문서:
  - `00_docs_index.md` (Read Order, Current Phase, File Roles, How To Use, Update Rule 업데이트)
  - `10_execution_plan.md` (Wave 1 웨이브 정의, 실행 규칙 추가)
  - `11_wave1_tasks.md` (신규)

#### Wave 1 스키마 보강: 7개 누락 모델 추가
- 결정:
  - `03_data_model.md`에 정의되어 있으나 Prisma 스키마에 반영되지 않은 7개 모델을 추가하고 Railway DB에 반영했다.
  - 추가 모델: `InstructorIntelligence`, `SourceLink`, `ValidationIssue`, `FeeHistory`, `FulltimeInstructorConfig`, `FeeFixConfig`, `PracticeCoachRule`
  - `Instructor` 모델에 back-relation 추가: `instructorIntelligence`(1:1), `sourceLinks`(1:N), `validationIssues`(1:N), `feeHistories`(1:N)
  - `npx prisma generate` 성공, `npx prisma db push` 성공 (Railway DB 반영)
  - 기존 모델 및 기존 API 엔드포인트와 충돌 없음
- 검증 상태: 에이전트 구현 완료, 문서 정합성 검증 필요
- 반영 대상:
  - `prisma/schema.prisma`

#### Wave 1 프론트엔드: 상세 패널 + 만족도 작성 UI + 레이아웃 연결
- 결정:
  - `InstructorDetail.tsx` 컴포넌트를 신규 생성했다. Feature E~K, O에 대응하는 8개 섹션을 포함한다.
  - `InstructorList.tsx`에 `onSelectInstructor`, `selectedInstructorId` prop을 추가해 부모 컴포넌트에서 선택 상태를 제어할 수 있게 했다.
  - `page.tsx`를 client component로 전환하고, 목록 선택 → 상세 표시 연결을 구현했다.
  - 만족도 작성 폼은 `InstructorDetail.tsx` 안에 접기/펼치기 섹션으로 구현했다.
- 검증 상태: 에이전트 구현 완료, 문서 계약(06_implementation_spec.md) 정합성 검증 필요
- 반영 대상:
  - `src/components/InstructorDetail.tsx` (신규)
  - `src/components/InstructorList.tsx` (수정)
  - `src/app/page.tsx` (수정)

#### Wave 1 API: GET /api/status, POST /api/refresh
- 결정:
  - `GET /api/status`를 `05_api_spec.md` 8절 기준으로 구현했다. 최근 PipelineRun과 소스별 SourceSyncLog를 조회해 반환한다.
  - `POST /api/refresh`를 `05_api_spec.md` 9절 기준으로 구현했다. 기존 파이프라인 모듈을 순차 호출하는 오케스트레이션 엔드포인트다.
  - refresh는 running 중인 PipelineRun이 있으면 409 반환, 하나 실패해도 나머지 계속 실행, 마지막에 score 재계산을 수행한다.
- 검증 상태: 에이전트 구현 완료, 문서 계약(05_api_spec.md) 정합성 검증 필요
- 반영 대상:
  - `src/app/api/status/route.ts` (신규)
  - `src/app/api/refresh/route.ts` (신규)

#### Pilot 4-4 / 4-5 최소 구현안: raw 저장 + 자동 취합 registry + pending 분리
- 결정:
  - `4-4` 만족도와 `4-5` Slack/Gmail activity는 모두 `raw 저장 -> review registry 자동 취합 -> canonical 반영` 구조를 따른다.
  - raw/import 테이블은 근거 보존용이며 사람이 직접 patch하는 본체가 아니다.
  - review registry는 raw source에서 재생성 가능한 자동 취합 결과이며, demo의 검토 가능성을 유지하는 canonical review layer 역할을 맡는다.
  - 확실한 항목은 `auto_accepted` 상태로 두고 자동 반영한다.
  - 애매한 항목은 `pending`으로 남기고 서비스 반영에서 제외한다.
  - 사람 판단이 필요한 경우 registry row를 직접 편집하지 않고 `review_decisions`에만 `approve`, `reject`, `override_instructor`를 저장한다.
  - canonical 반영 대상은 `auto_accepted`, `approved` 상태만 허용한다. `pending`, `rejected`, `invalid`는 반영하지 않는다.
  - 이 구조는 demo의 사람 판단 중심 흐름은 유지하되, ad-hoc JSON patch와 hardcoded merge 지옥으로 되돌아가지 않기 위한 최소 보완안이다.
- 반영 문서:
  - `03_data_model.md`
  - `04_data_pipeline.md`

#### Pilot 종료 기준: 모든 회사 해소가 아니라 구조 검증 완료
- 결정:
  - 파일럿의 종료 조건은 `모든 회사/과정 pending 0건`이 아니다.
  - 종료 조건은 아래 4가지를 만족하는 것이다.
    - `4-4` 만족도 source가 `만족도 파일 + 강의관리/운영 메타 + review registry + canonical 반영` 구조로 실제 동작한다.
    - `4-5` Slack/Gmail activity가 `raw + registry + canonical` 구조로 실제 동작한다.
    - 자동 확정 가능한 케이스는 `auto_accepted`로 반영되고, 애매한 케이스는 안전하게 `pending`으로 남는다.
    - `review_decisions` 없이도 터미널/DB 기준으로 pending을 확인할 수 있고, 잘못된 canonical 반영이 일어나지 않는다.
  - 따라서 회사별 adapter는 운영 단계에서 계속 늘려가는 것이며, 파일럿 단계에서는 대표 회사/패턴 몇 개가 실제로 검증되면 충분하다.
  - 현재 파일럿 기준 남아 있는 pending은 `KT` 시트 강사명 `KT_...` 4건뿐이며, 이는 alias 금지 정책에 따라 그대로 `pending` 유지한다.
  - `gmail_summary` 만족도 registry는 파일럿 기준 `pending 0건`, `auto_accepted 9건` 상태를 종료선으로 본다.
  - score 계산은 정책 테이블(`score_policy_versions`)을 읽는 구조로 맞췄고, `salesmap` raw canonical 부재 때문에 기존 breakdown 재사용을 유지한다.
  - 전체 점수 재계산은 이미 satisfaction pipeline 실행 과정에서 현재 canonical 값을 기준으로 갱신되었으며, 남은 caveat는 `salesmap raw canonical 없음`, `email_activity_count 실데이터 부족`, `last_activity_at max-only` 3가지다.
- 후속 작업:
  - 회사별 adapter 확장 (`KT`, `현대모비스`, `우리은행`, 이후 타 회사)
  - `review_decisions` 활용 빈도가 높아질 경우 운영자 페이지 추가
  - `salesmap` raw canonical source 확정 시 score 재계산기 보강

#### Pilot 이후 운영 단계 후속 작업
- 운영 단계에서 계속해야 할 일:
  - 회사별 `4-4` 만족도 adapter를 추가한다. 기준은 `만족도 파일 + 강의관리/운영 메타` 조합이며, 새 회사는 discovery 후 adapter를 하나씩 붙인다.
  - `4-5` Gmail/Slack activity 및 Gmail 만족도에서 새로 발생하는 `pending`은 터미널/DB로 먼저 확인하고, 반복 패턴이 확인될 때만 회사별 rule 또는 adapter를 추가한다.
  - `review_decisions` 사용량이 늘어나면 운영자 페이지를 만든다. 그 전까지는 API/터미널 기반으로 충분하다.
  - `salesmap` raw canonical field를 추가할 수 있을 때 score 재계산기를 다시 보강한다. 그 전까지는 `salesmap`은 기존 breakdown 재사용을 유지한다.
  - `last_activity_at`가 max-only 필드라는 caveat를 해결하려면, 장기적으로는 source 기반 재집계 또는 더 엄격한 reconcile 전략을 도입한다.
  - Gmail 만족도 / Gmail activity / Slack activity는 `초기 백필 + 이후 증분` 원칙을 유지하고, 필요 시에만 `reconcile/backfill`을 수행한다.
- 내일 실제 구현 전에 반드시 확인할 것:
  - 새로 붙일 회사/과정의 source 위치
    - 회사 폴더 링크
    - 만족도 폴더 링크
    - 강의관리/운영 시트 링크
  - 새 source가 service account가 아니라 사용자 OAuth(`yeonhee.ha@day1company.co.kr`) 기준으로 실제 접근 가능한지
  - 새 회사를 붙이는 작업인지, 아니면 운영 UI/후속 기능을 만드는 작업인지 범위를 먼저 고정할 것
  - 그 외 필수 blocker는 현재 없음. 즉 내일은 바로 다음 회사 adapter 구현으로 시작 가능하다.

#### grouped `validated-plan` 병렬 실행 규칙
- 결정:
  - 기존 `11_wave1_tasks.md`는 태스크 의미, 참조 문서, 완료 기준을 유지하는 기준 문서로 남긴다.
  - 실제 병렬 실행은 `T1~T9` 개별 태스크 단위가 아니라 grouped workstream으로 수행한다.
  - 권장 구조는 `Group 1(T1,T2,T3)`, `Group 2(T4,T9)`, `Group 3(T6,T7,T8)` 병렬 실행 후, 마지막에 `T5`를 단일 통합 단계로 수행하는 방식이다.
  - 병렬 실행 안전장치로 `공통 고정 항목 + 그룹별 수정 가능 범위 + 충돌 파일 담당 그룹`을 별도 문서로 관리한다.
  - grouped `validated-plan` 실행에서 `11_wave1_tasks.md`의 파일 경계와 병렬 파일 담당 그룹 정의가 충돌하면, 병렬 실행 시에는 파일 담당 그룹 문서가 우선한다.
- 반영 문서:
  - `00_docs_index.md`
  - `10_execution_plan.md`
  - `12_parallel_bundle_guardrails.md`

#### `13_parallel_bundle_prompts.md` 역할 축소
- 결정:
  - `13_parallel_bundle_prompts.md`는 grouped 실행용 복사 프롬프트 문서로만 유지한다.
  - 영구 규칙은 아래 문서로 승격한다.
    - 이번 웨이브 전용 운영 원칙: `10_execution_plan.md`
    - 태스크 의미와 완료 정의: `11_wave1_tasks.md`
    - cross-group 책임 경계 / stale schema 검증: `12_parallel_bundle_guardrails.md`
    - 시작 전 / `T5` 진입 전 게이트: `14_wave1_preflight_checklist.md`
  - 따라서 `13_parallel_bundle_prompts.md`는 정책을 재정의하지 않고, `10/11/12/14`를 읽도록 안내하는 실행 보조 문서로만 사용한다.
- 반영 문서:
  - `00_docs_index.md`
  - `10_execution_plan.md`
  - `11_wave1_tasks.md`
  - `12_parallel_bundle_guardrails.md`
  - `13_parallel_bundle_prompts.md`
  - `14_wave1_preflight_checklist.md`
