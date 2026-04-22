# Operational Intelligence Classification Spec

## Role
이 문서는 `instructor_db`에서 운영 인텔리전스 원문 메모를 어떻게 분류하고,
어떤 경우를 `risk_patterns`, `operational_alerts`, `human_followups`로 나눌지 정의한다.
이 문서는 "강사 평가"와 "운영 이슈"를 섞지 않기 위한 canonical 분류 규칙을 제공한다.

## Source of Truth
- 운영 인텔리전스 note 분류 기준
- `raw_operational_notes` 보존 규칙
- `classified_notes` 파생 규칙
- `human_followups`, `operational_alerts`, `risk_patterns`, `strength_patterns` 라우팅 규칙
- `data_richness` tier 판정 기준
- 사람 검토 큐 운영 규칙

## Depends On
- `00_docs_index.md`
- `01_core_policy.md`
- `03_data_model.md`
- `04_data_pipeline.md`
- `06_implementation_spec.md`

## Used By
- 파이프라인 수집/정규화 단계
- 운영 인텔리전스 구조화 단계
- 상세 패널 인텔리전스 카드
- 검토 큐 API / 화면

## Out of Scope
- SQL DDL 상세
- Prisma schema 구문 상세
- LLM 프롬프트 문구 상세
- UI 스타일 상세

## 1. Core Principle

- 원문 메모는 절대 버리지 않는다.
- 단건 사건을 반복 성향으로 일반화하지 않는다.
- 강사 책임이 아닌 환경 이슈를 강사 리스크로 올리지 않는다.
- 분류가 애매하면 억지로 판정하지 않고 `unknown`과 `human_followup`으로 보낸다.
- 모든 애매한 정보도 사람이 다시 볼 수 있게 저장한다.
- `behavioral_intelligence`는 전 강사 커버리지를 목표로 하되, 근거가 약하면 `confidence = low`와 `null` 필드를 유지한다.
- `출강요청` 채널은 일반적인 운영 인텔리전스 source가 아니라, 극소수 강사에게만 존재하는 예외적 보조 신호로 본다.
- 따라서 기본 분류/tier/품질 판단 기준은 `강의관리 시트`, `curated ops note`, `운영보고`, `만족도`, `출강 이력`에 둔다.

## 1-1. Demo Alignment Default

이 문서의 기본 구현 방향은 "이상적 장기 구조"보다 `instructor_db_demo`의 실제 동작에 맞춘다.

- Phase 1 기본값은 demo와 같이 전 강사 커버리지를 유지한다.
- curated ops note가 있는 강사는 기본적으로 LLM lane 후보로 본다.
- 의미 있는 강의관리 시트 피드백이 있는 강사는 `rich`, curated ops note만 있는 강사는 `moderate`에 가깝게 본다.
- 단건 중요 이슈는 demo처럼 우선 `key_question_for_humans` 성격으로 모은다.
- 별도 `operational_alerts`는 장기 확장으로 두되, Phase 1에서 미구현이어도 된다.
- 즉 Phase 1 최소 목표는 아래 4개다.
  - `raw_operational_notes`
  - `classified_notes`
  - `human_followups`
  - `behavioral_intelligence`

## 2. Canonical Object

### 2-1. `raw_operational_notes`
- 수집된 원문 메모를 그대로 저장한다.
- source, client, course, date 같은 추출 가능한 메타데이터만 덧붙인다.
- 어떤 자동 분류 결과가 바뀌어도 원문은 변경하지 않는다.

### 2-2. `classified_notes`
- `raw_operational_notes` 1건마다 1건 생성한다.
- note 단위 1차 분류 결과를 저장한다.
- 자동 분류가 틀릴 수 있다는 전제를 둔다.

### 2-3. `human_followups`
- 확인 필요, 불일치, 책임 불명, 데이터 누락, 해석 애매 note를 저장한다.
- 사람이 실제로 검토하는 큐다.
- demo의 `key_question_for_humans`로 보내던 내용을 구조화해서 담는 1차 적재처로 본다.

### 2-4. `operational_alerts`
- 단건이지만 운영 영향이 큰 사건을 저장한다.
- 반복 패턴으로 승격되기 전 단계다.
- Phase 1에서는 선택 구현이다.
- Phase 1에서 이 엔티티를 따로 만들지 않으면, 해당 내용은 `human_followups`에 적재하고 `behavioral_intelligence.key_question_for_humans`에 요약한다.

### 2-5. `risk_patterns`
- 반복되는 부정 패턴만 저장한다.
- 단건 사건은 여기에 넣지 않는다.

### 2-6. `strength_patterns`
- 반복되는 강점 패턴만 저장한다.
- 단순 호평 1건은 여기에 넣지 않는다.

## 3. Input Source

운영 인텔리전스 분류의 입력 소스는 아래를 canonical로 사용한다.

| 입력 소스 | 설명 | 우선 성격 |
|---|---|---|
| curated ops notes | 사람이 정리한 운영 메모 | 강한 운영 근거 |
| teaching feedback qualitative notes | 강의관리 시트 정성 피드백 | 강한 강의 근거 |
| teaching feedback ops notes | 강의관리 시트 운영 이슈 | 강한 운영 근거 |
| structured stats | 만족도, 출강 이력, 최근성, slack 활동 | 보조 근거 |
| slack highlights | 운영 요약 텍스트 | 보조 근거 |

규칙:
- `structured stats`만으로는 강의 스타일/애티튜드를 추론하지 않는다.
- `meaningful feedback = false`인 시트는 rich 근거로 쓰지 않는다.
- 아래와 같은 note는 `meaningful feedback = false`로 본다.
  - `미기재`
  - `미작성`
  - `빈 템플릿`
  - `확인 불가`
  - `데이터 입력 전 상태`
- 이 규칙은 demo의 `김용담` 케이스처럼 "feedback source는 있으나 실제 판단 근거는 빈 상태"인 경우를 `rich`로 승격하지 않기 위한 규칙이다.

### 3-1. Slack Source Priority

Slack 관련 source priority는 아래처럼 고정한다.

1. `운영보고`
2. curated ops note 안에 요약된 Slack 운영 메모
3. `출강요청` 채널

규칙:
- `운영보고`는 일반 강사에게 공통적으로 존재할 수 있는 운영/활동 근거다.
- `출강요청`은 일부 강사의 전용 채널에만 존재하는 예외적 수요 신호다.
- 따라서 `출강요청`은 아래 용도로만 제한적으로 사용한다.
  - mapped instructor의 보조 활동 신호
  - "이 강사 관련 요청이 있었다"는 demand hint
- `출강요청`만으로는 `rich` 또는 `moderate` 승격 근거가 되지 않는다.
- `출강요청`만으로는 강의 스타일, 태도, 운영 리스크를 추론하지 않는다.
- `출강요청`이 없더라도 데이터 부족으로 보지 않는다. 이것이 기본 상태다.

## 4. Step 1: Raw Note Normalization

각 원문 note는 아래 필드를 가지는 normalized note로 저장한다.

| 필드명 | 타입 | 설명 |
|---|---|---|
| `id` | UUID/TEXT | note 식별자 |
| `instructor_id` | UUID/TEXT | 강사 FK |
| `source_type` | TEXT | `curated_ops`, `teaching_feedback_qualitative`, `teaching_feedback_ops`, `slack_highlight` 등 |
| `source_ref` | JSONB | 원문 source 식별자 |
| `client_name` | TEXT | 추출 가능한 기업명 |
| `course_name` | TEXT | 추출 가능한 과정명 |
| `round_label` | TEXT | 회차 표현 |
| `observed_at` | DATE/TIMESTAMPTZ | 추출 가능한 날짜 |
| `raw_text` | TEXT | 원문 문장 |
| `ingested_at` | TIMESTAMPTZ | 수집 시각 |

규칙:
- client/course/date를 추출하지 못해도 note는 저장한다.
- 원문을 요약하거나 덮어쓰지 않는다.

## 5. Step 2: Note Classification

각 note는 아래 필드를 가진 `classified_note`로 파생한다.

| 필드명 | 값 |
|---|---|
| `family` | `data_gap`, `environment_issue`, `material_delivery`, `delivery_quality`, `curriculum_compliance`, `responsiveness_or_schedule`, `commercial_constraint`, `positive_signal`, `unknown` |
| `owner` | `instructor`, `client_or_env`, `ops_or_data`, `commercial`, `unknown` |
| `polarity` | `positive`, `negative`, `neutral`, `mixed` |
| `auto_confidence` | `high`, `medium`, `low` |
| `needs_followup` | `true/false` |
| `why_flagged` | 짧은 규칙 설명 |

### 5-1. `family` Rule

#### `data_gap`
- 키워드 예시:
  - `미기재`
  - `미작성`
  - `누락`
  - `불일치`
  - `확인 필요`
  - `재확인`
  - `수집 필요`
  - `확인 불가`
- 기본 owner는 `ops_or_data`

#### `environment_issue`
- 키워드 예시:
  - `접근불가`
  - `오류`
  - `권한`
  - `인터넷`
  - `Zoom`
  - `HDMI`
  - `전원`
  - `마이크`
  - `FabriX`
  - `Supabase`
  - `Vercel`
  - `Make 한도`
- 기본 owner는 `client_or_env`

#### `material_delivery`
- 키워드 예시:
  - `교안`
  - `자료`
  - `전달 지연`
  - `미전달`
- 기본 owner는 `instructor`

#### `delivery_quality`
- 키워드 예시:
  - `전달력`
  - `설명`
  - `속도`
  - `흡입력`
  - `몰입`
  - `따라가기 어려움`
  - `구두 설명`
  - `눈높이`
  - `쉽게 풀어 설명`
  - `밀착 케어`
- 기본 owner는 `instructor`

#### `curriculum_compliance`
- 키워드 예시:
  - `커리큘럼`
  - `시간 배분`
  - `마무리`
  - `준수`
  - `이론 편중`
  - `실습 위주 요청`
- 기본 owner는 `instructor`

#### `responsiveness_or_schedule`
- 키워드 예시:
  - `응답`
  - `조율`
  - `연락`
  - `가능 시간`
  - `출장 가능`
  - `일정 제한`
- 기본 owner는 `instructor`

#### `commercial_constraint`
- 키워드 예시:
  - `강사료`
  - `단가`
  - `상향 요청`
  - `암묵적 합의`
- 기본 owner는 `commercial`

#### `positive_signal`
- 키워드 예시:
  - `우수`
  - `극찬`
  - `만점`
  - `핵심 강사`
  - `반복 출강`
  - `장기 과정 핵심`
  - `만족도 4.8`
- 기본 owner는 `instructor`

#### `unknown`
- 위 규칙으로 안전하게 분류할 수 없는 경우
- owner는 `unknown`

### 5-2. `owner` Override Rule

아래 경우는 기본 owner를 override한다.

- 환경 키워드가 있어도 문장에 `강사 미숙`, `준비 부족`, `교안 미전달`, `사전 점검 안함`이 있으면 `instructor`
- 전달력/속도 관련 note라도 문장에 `고객사 시스템`, `현장 장비`, `계정 오류`, `환경 이슈`가 명시되면 `client_or_env` 또는 `mixed`
- `강사명 불일치`, `만족도 미기재`, `시트 미작성`은 항상 `ops_or_data`
- 단가/출장 가능/일정 제약은 항상 `commercial` 또는 `instructor`, 리스크 승격은 보수적으로 처리한다.

### 5-3. `needs_followup` Rule

아래 중 하나면 `true`다.

- `data_gap`
- `owner = unknown`
- `auto_confidence = low`
- 키워드:
  - `확인 필요`
  - `재확인`
  - `불일치`
  - `미작성`
  - `미기재`
  - `수집 필요`
  - `확인 불가`

## 6. Step 3: Queue Routing

### 6-1. Common Rule
- 모든 note는 `raw_operational_notes`에 남긴다.
- 모든 note는 `classified_notes`를 가진다.
- 애매한 것도 버리지 않는다.

### 6-2. `human_followups`

아래 중 하나면 `human_followups`에 적재한다.

- `needs_followup = true`
- `family = unknown`
- `owner = unknown`
- `auto_confidence = low`
- `polarity = mixed`

권장 상태 필드:
- `review_status = open | resolved | dismissed`
- `review_priority = high | medium | low`

Phase 1 규칙:
- demo 호환을 우선할 때, 단건 중요 이슈도 우선 `human_followups`에 적재한다.
- 별도 `operational_alerts`가 없어도 분류 실패로 보지 않는다.

### 6-3. `operational_alerts`

아래 조건을 만족하면 `operational_alerts` 후보다.

- 단건 사건이다
- `polarity = negative`
- 운영 영향이 있다
- 아직 `risk_patterns`로 승격되지 않았다

대표 예시:
- 교안 전달 지연 1건
- 고객사 시스템 장애 1건
- 현장 장비 이슈 1건
- 회차별 만족도 급락 1건

규칙:
- 환경 이슈는 alert로는 올릴 수 있지만 기본적으로 강사 리스크로는 올리지 않는다.
- Phase 1에서 미구현이면 `human_followups`로 대체한다.

## 7. Step 4: Pattern Aggregation

### 7-1. `risk_patterns`

`risk_patterns`는 아래 조건을 모두 만족할 때만 생성한다.

- `owner = instructor`
- `polarity = negative`
- 같은 issue family 또는 같은 semantic cluster의 근거가 2건 이상
- 가능하면 서로 다른 source, client, round, date 중 2개 이상에서 관찰됨

추가 규칙:
- 단건 사건만으로는 절대 생성하지 않는다.
- `data_gap`은 `risk_patterns`가 될 수 없다.
- `environment_issue`는 강사 귀책이 명시되지 않으면 `risk_patterns`가 될 수 없다.
- `commercial_constraint`는 기본적으로 `risk_patterns`로 승격하지 않는다.

### 7-2. `strength_patterns`

아래 중 하나면 `strength_patterns` 후보다.

- 같은 positive signal이 2건 이상 반복
- structured stats가 강점을 뒷받침

structured stats 기반 허용 예시:
- `satisfaction_avg >= 4.5 AND satisfaction_count >= 5`
- `teaching_history_count >= 20`
- `repeated_client_count >= 3`
- `recent_courses_6mo >= 5`

규칙:
- 단순 호평 1건은 `strength_pattern`으로 승격하지 않는다.

## 8. Step 5: Data Richness Tier

### 8-1. Canonical Tier

- `rich`
- `moderate`
- `sparse`
- `minimal`

### 8-2. Tier Rule

#### `rich`
- `meaningful feedback = true`
- 그리고 아래 중 하나:
  - `qualitative_feedback_count >= 2`
  - `ops_issue_count >= 2`
  - `numeric_round_score_count >= 2`

#### `moderate`
- `rich`는 아니고 아래 중 하나:
  - curated ops note 존재
  - feedback source는 있으나 내용이 빈약
  - `numeric_round_score_count >= 1` and `teaching_history_count >= 10`

#### `sparse`
- `rich/moderate`는 아니고 아래 중 하나:
  - `satisfaction_avg IS NOT NULL`
  - `ops_report_activity_count >= 3`
  - `teaching_history_count >= 5`

#### `minimal`
- 위에 해당하지 않는 경우

규칙:
- `curated ops note`는 강한 운영 신호로 본다.
- 빈 템플릿 피드백은 `rich` 승격 근거가 아니다.
- `dispatch_request_activity_count`는 `sparse` 승격의 기본 조건으로 사용하지 않는다.

### 8-3. Demo-Compatible Lane Selection

Phase 1에서는 아래 단순 lane selection을 기본값으로 사용해도 된다.

1. curated ops note 있음 + meaningful feedback 있음 -> `rich`
2. curated ops note 있음 + meaningful feedback 없음 -> `moderate`
3. curated ops note 없음 + structured signal 있음 -> `sparse`
4. 위에 모두 해당하지 않음 -> `minimal`

설명:
- 이것이 `instructor_db_demo`의 "17명 curated/Claude + 나머지 batch" 운영 방식과 가장 가깝다.
- 더 세밀한 tiering은 이후 확장 규칙으로 본다.
- 이 lane selection은 `출강요청` 유무와 무관하게 동작해야 한다. `출강요청`은 극소수 예외 채널이기 때문이다.

## 9. Step 6: Behavioral Intelligence Generation

### 9-1. `rich/moderate`
- LLM 합성을 허용한다.
- 반드시 evidence를 가진다.
- `risk_patterns`와 `strength_patterns`는 반복 근거를 바탕으로 하되, 저장 문자열은 짧은 자연어 요약 문구를 사용한다.

### 9-2. `sparse/minimal`
- 규칙 기반 카드만 생성한다.
- 아래 필드는 `null`로 둔다.
  - `teaching_style`
  - `curriculum_compliance`
  - `attitude`
- 아래는 생성 가능하다.
  - `strength_patterns`
  - `risk_patterns`
  - `recommendation`
  - `basic_stats`
  - `key_question_for_humans`

규칙:
- 정성 근거가 없으면 스타일/애티튜드 추론 금지
- `confidence`는 기본 `low`
- Phase 1에서는 demo처럼 `recommendation`과 `basic_stats` 위주로만 카드를 만들어도 된다.
- `출강요청` count가 있더라도, 일반 규칙 기반 카드에서는 이를 standalone 핵심 근거로 사용하지 않는다. 필요하면 `basic_stats`의 보조 activity로만 노출한다.

## 10. Human Review Workflow

### 10-1. Review Goal
- 애매한 note를 버리지 않고 운영 큐에 쌓는다.
- 사람은 모든 note를 보지 않고, 큐에 오른 note만 본다.

### 10-2. Review Queue Rule

사람이 보는 대상:
- `human_followups.review_status = open`
- `operational_alerts` 중 `severity >= medium`
- `family = unknown`
- `owner = unknown`

demo 호환 기본값:
- `operational_alerts`가 없으면 사람은 `human_followups.review_status = open`만 보면 된다.
- Phase 1에서는 review queue의 canonical 실체를 `human_followups` 하나로 단순화할 수 있다.

### 10-3. Review Outcome

사람 검토 후 가능한 결과:
- `resolved`
- `dismissed`
- `promoted_to_alert`
- `promoted_to_risk_pattern`
- `owner_corrected`
- `family_corrected`

## 11. Classifier Instruction

이 문서는 이후 "분류하라"는 요청을 받았을 때 아래 규칙으로 사용한다.

1. note 원문을 먼저 보존한다.
2. note 1건에서 반복 패턴을 직접 만들지 않는다.
3. `environment_issue`와 `data_gap`는 강사 리스크로 올리지 않는다.
4. 애매하면 `unknown + human_followup`으로 보낸다.
5. 사람이 나중에 볼 가치가 있는 애매한 정보는 버리지 않는다.
6. `risk_patterns`는 강사 귀책 + 반복 근거가 있을 때만 생성한다.
7. `sparse/minimal`에서 스타일/애티튜드는 `null`로 유지한다.
8. `출강요청`은 일반 강사 분류의 기본 source로 취급하지 않는다.
9. `출강요청`만 있는 경우도 `rich/moderate` 승격 근거로 쓰지 않는다.

## 12. Recommended Storage Shape

이 문서의 최소 저장 형태는 아래를 권장한다.

```json
{
  "raw_operational_notes": [],
  "classified_notes": [],
  "human_followups": [],
  "operational_alerts": [],
  "risk_patterns": [],
  "strength_patterns": [],
  "behavioral_intelligence": {
    "teaching_style": null,
    "curriculum_compliance": null,
    "attitude": null,
    "risk_patterns": [],
    "strength_patterns": [],
    "recommendation": null,
    "data_richness": "minimal",
    "confidence": "low",
    "key_question_for_humans": null
  }
}
```

### 12-1. Demo-Compatible Minimum Shape

`instructor_db_demo`에 최대한 맞추는 Phase 1 최소 형태는 아래를 권장한다.

```json
{
  "raw_operational_notes": [],
  "classified_notes": [],
  "human_followups": [],
  "behavioral_intelligence": {
    "teaching_style": null,
    "curriculum_compliance": null,
    "attitude": null,
    "risk_patterns": [],
    "strength_patterns": [],
    "recommendation": null,
    "data_richness": "minimal",
    "confidence": "low",
    "key_question_for_humans": null
  }
}
```

설명:
- 이 형태는 demo의 `risk_patterns + key_question_for_humans + recommendation` 구조와 가장 가깝다.
- `operational_alerts`는 Phase 2 이상에서 별도 구조로 분리해도 늦지 않다.

## 13. Why This Spec Exists

- `instructor_db_demo`는 반복 패턴과 단건 이슈를 텍스트 위치로만 느슨하게 구분했다.
- `instructor_db`는 장기 운영 DB이므로 구조화된 저장과 검토 큐가 필요하다.
- 이 문서는 "정보 손실 없이 보수적으로 분류"하는 방향을 canonical로 고정한다.
