# Docs Index

## Purpose
이 문서는 구현에 필요한 문서들의 역할, 읽는 순서, 우선순위를 정의한다.
Claude Code와 Codex는 이 문서를 먼저 읽고, 이후 필요한 문서를 순서대로 참조한다.

## Read Order
1. `01_core_policy.md`
2. `02_system_architecture.md`
3. `03_data_model.md`
4. `04_data_pipeline.md`
5. `05_api_spec.md`
6. `06_implementation_spec.md`
7. `07_build_guide.md`
8. `08_decision_log.md`
9. `09_work_split.md`

## Source of Truth Priority
- 정책 충돌 시: `01_core_policy.md`
- 데이터 구조 충돌 시: `03_data_model.md`
- 파이프라인 규칙 충돌 시: `04_data_pipeline.md`
- API 계약 충돌 시: `05_api_spec.md`
- 화면/기능 동작 충돌 시: `06_implementation_spec.md`
- 구현 순서 및 작업 방식 참고: `07_build_guide.md`
- 변경 이력 확인: `08_decision_log.md`
- 병렬 구현 책임 경계 확인: `09_work_split.md`

## File Roles

### `01_core_policy.md`
- 서비스 전반의 핵심 정책을 정의한다.
- 병합 기준, 전임강사 정책, fee 정책, 점수 정책, fallback 정책, 인증 정책을 포함한다.

### `02_system_architecture.md`
- 시스템 구성과 배포 구조를 정의한다.
- 프론트엔드, 백엔드, 인증, 외부 의존성, 배포 환경, 환경변수를 포함한다.

### `03_data_model.md`
- 데이터 구조를 정의한다.
- 엔티티, 필드, 타입, 필수 여부, 기본값, 관계, 설정 데이터 구조를 포함한다.

### `04_data_pipeline.md`
- 외부 데이터 수집부터 마스터 데이터 생성까지의 흐름을 정의한다.
- 소스별 접근 방식, 필드 매핑, 병합 규칙, 검증 규칙, 실패 처리, 저장 위치를 포함한다.

### `05_api_spec.md`
- 프론트엔드와 백엔드 간 통신 계약을 정의한다.
- 엔드포인트, 요청/응답 형식, 에러 형식, 인증, fallback 응답 차이를 포함한다.

### `06_implementation_spec.md`
- 화면과 기능의 동작 방식을 정의한다.
- 목록, 상세, 검색, 필터, 정렬, 점수 표시, 운영 인텔리전스, 이력, 새로고침, fallback 처리 등을 포함한다.

### `07_build_guide.md`
- 구현자가 어떤 순서로 문서를 참고하고 어떤 순서로 구현할지 안내한다.
- 병렬 구현 원칙, 작업 시작 전 체크리스트, 문서 수정 우선순위를 포함한다.

### `08_decision_log.md`
- 정책 변경과 주요 의사결정 이력을 기록한다.
- 이후 문서 수정 시 어떤 결정이 언제 반영됐는지 추적하는 용도로 사용한다.

### `09_work_split.md`
- 병렬 구현을 위한 작업 분할 구조를 정의한다.
- 작업별 책임 범위, 선행 의존성, 완료 기준을 포함한다.

## Legacy Reference

- `구현명세서_v2.md`는 참고용 legacy 문서로만 사용한다.
- 새 구현의 Source of Truth는 `docs/` 아래 문서 세트를 사용한다.
- 정책, 데이터 구조, 파이프라인, API, 화면/기능 변경은 각 담당 문서를 직접 수정한다.
- `구현명세서_v2.md`는 더 이상 업데이트하지 않는다.

## How To Use
- 새로운 기능을 구현하기 전에는 먼저 `01_core_policy.md`를 확인한다.
- 시스템 구성, 배포 환경, 환경변수를 설계하거나 변경하기 전에는 `02_system_architecture.md`를 확인한다.
- 데이터 구조를 추가하거나 수정하기 전에는 `03_data_model.md`를 확인한다.
- 외부 소스 수집/병합 로직을 구현하기 전에는 `04_data_pipeline.md`를 확인한다.
- API를 구현하거나 호출하기 전에는 `05_api_spec.md`를 확인한다.
- 화면 구현 전에는 `06_implementation_spec.md`를 확인한다.
- 구현 순서가 헷갈리면 `07_build_guide.md`를 확인한다.
- 기존 정책과 다른 변경이 필요하면 먼저 `08_decision_log.md`에 기록하고 관련 문서를 수정한다.
- 병렬 구현 단위와 책임 경계를 확인하려면 `09_work_split.md`를 확인한다.

## Update Rule
- 정책이 바뀌면 먼저 `01_core_policy.md`를 수정한다.
- 시스템 구성이나 배포 구조가 바뀌면 `02_system_architecture.md`를 수정한다.
- 데이터 구조가 바뀌면 `03_data_model.md`를 수정한다.
- 수집/병합 규칙이 바뀌면 `04_data_pipeline.md`를 수정한다.
- API 계약이 바뀌면 `05_api_spec.md`를 수정한다.
- 화면 동작이 바뀌면 `06_implementation_spec.md`를 수정한다.
- `구현명세서_v2.md`는 참고만 하고 수정하지 않는다.
- 중요한 변경은 `08_decision_log.md`에 반드시 남긴다.
