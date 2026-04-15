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
