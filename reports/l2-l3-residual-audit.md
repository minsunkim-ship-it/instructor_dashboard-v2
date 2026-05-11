# L2/L3 잔여 강사 false positive 검수
Generated at: 2026-05-06T07:06:48.095Z
L2 3명 + L3 12명 = 15명 검수

## 분류 결과
- TP (회복 가능, catalog 보강): **0명**
- FP (audit 오류, L1 재분류): **5명**
- AMBIGUOUS (사용자 결정 필요): **10명**

## AMBIGUOUS — 사용자 검수 필요 (10명)

### 김건우 (L3, th=2, importItems=8)
- 분류: **AMBIGUOUS** — 회사만 매칭, 과정명은 다름 — 같은 회사의 다른 강의일 수 있음
- 권장: 사용자 검수: 시트 응답이 이 강사 강의의 만족도인지 확인
- 강사의 회사/과정 샘플:
  - 현대모비스 / [부가세 별도](B2B)현대모비스_영업지원팀 AI 교육
  - 현대모비스 / [부가세 별도](B2B)현대모비스_영업지원팀 AI 교육
- 매칭된 catalog 시트:
  - hyundai_mobis_llm: 현대모비스 LLM 만족도 종합
  - hyundai_mobis_llm_2: 현대모비스 LLM 2차수
  - hyundai_mobis_llm_3: 현대모비스 LLM 3차수 응답

### 김유신 (L3, th=6, importItems=25)
- 분류: **AMBIGUOUS** — 회사만 매칭, 과정명은 다름 — 같은 회사의 다른 강의일 수 있음
- 권장: 사용자 검수: 시트 응답이 이 강사 강의의 만족도인지 확인
- 강사의 회사/과정 샘플:
  - — / —
  - — / —
  - 우리은행 / 우리은행_2025 WLT 2 평가과정 문항개발
- 매칭된 catalog 시트:
  - woori_ax_forms: 우리은행 AX 전문가 양성과정
  - woori_bank_ax_2604_2611: 2604~2611_우리은행 AX 전문가 양성 과정_강의관리 시트

### 김태헌 (L3, th=6, importItems=25)
- 분류: **AMBIGUOUS** — 회사만 매칭, 과정명은 다름 — 같은 회사의 다른 강의일 수 있음
- 권장: 사용자 검수: 시트 응답이 이 강사 강의의 만족도인지 확인
- 강사의 회사/과정 샘플:
  - — / —
  - — / —
  - — / —
- 매칭된 catalog 시트:
  - woori_ax_forms: 우리은행 AX 전문가 양성과정
  - woori_bank_ax_2604_2611: 2604~2611_우리은행 AX 전문가 양성 과정_강의관리 시트

### 박노성 (L3, th=6, importItems=25)
- 분류: **AMBIGUOUS** — 회사만 매칭, 과정명은 다름 — 같은 회사의 다른 강의일 수 있음
- 권장: 사용자 검수: 시트 응답이 이 강사 강의의 만족도인지 확인
- 강사의 회사/과정 샘플:
  - 우리은행 / 우리은행 25' 하반기 WLTII 문항 개발
  - — / —
  - — / —
- 매칭된 catalog 시트:
  - woori_ax_forms: 우리은행 AX 전문가 양성과정
  - woori_bank_ax_2604_2611: 2604~2611_우리은행 AX 전문가 양성 과정_강의관리 시트

### 박효경 (L3, th=10, importItems=8)
- 분류: **AMBIGUOUS** — 회사만 매칭, 과정명은 다름 — 같은 회사의 다른 강의일 수 있음
- 권장: 사용자 검수: 시트 응답이 이 강사 강의의 만족도인지 확인
- 강사의 회사/과정 샘플:
  - 에이치엘인재개발원 / HL인재개발원_신입사원 대상 생성형 AI 활용
  - 에스케이텔레콤 / SK텔링크_생성형 AI 프로젝트
  - 에스케이텔레콤 / SK텔링크_생성형 AI 프로젝트
- 매칭된 catalog 시트:
  - hyundai_mobis_llm: 현대모비스 LLM 만족도 종합
  - hyundai_mobis_llm_2: 현대모비스 LLM 2차수
  - hyundai_mobis_llm_3: 현대모비스 LLM 3차수 응답

### 황만수 (L3, th=8, importItems=25)
- 분류: **AMBIGUOUS** — 회사만 매칭, 과정명은 다름 — 같은 회사의 다른 강의일 수 있음
- 권장: 사용자 검수: 시트 응답이 이 강사 강의의 만족도인지 확인
- 강사의 회사/과정 샘플:
  - 우리은행 / 우리은행 25' 하반기 WLTII 문항 개발
  - — / —
  - — / —
- 매칭된 catalog 시트:
  - woori_ax_forms: 우리은행 AX 전문가 양성과정
  - woori_bank_ax_2604_2611: 2604~2611_우리은행 AX 전문가 양성 과정_강의관리 시트

### 박효경(소속강사) (L3, th=6, importItems=8)
- 분류: **AMBIGUOUS** — 회사만 매칭, 과정명은 다름 — 같은 회사의 다른 강의일 수 있음
- 권장: 사용자 검수: 시트 응답이 이 강사 강의의 만족도인지 확인
- 강사의 회사/과정 샘플:
  - 현대모비스 / [부가세 별도] (B2B) 현대모비스_직무교육과정 (26년 4~5월 추가
  - 현대모비스 / 현대모비스_AI 직무교육과정
  - 현대모비스 / 현대모비스_AI 직무교육과정
- 매칭된 catalog 시트:
  - hyundai_mobis_llm: 현대모비스 LLM 만족도 종합
  - hyundai_mobis_llm_2: 현대모비스 LLM 2차수
  - hyundai_mobis_llm_3: 현대모비스 LLM 3차수 응답

### 김준범, 이진원 (L3, th=4, importItems=8)
- 분류: **AMBIGUOUS** — 회사만 매칭, 과정명은 다름 — 같은 회사의 다른 강의일 수 있음
- 권장: 사용자 검수: 시트 응답이 이 강사 강의의 만족도인지 확인
- 강사의 회사/과정 샘플:
  - 기아 / 기아 skill-up아카데미 정규 과정
  - 현대모비스 / [부가세 별도](B2B)현대모비스_영업지원팀 AI 교육
  - 기아 / 기아 skill-up아카데미 정규 과정
- 매칭된 catalog 시트:
  - hyundai_mobis_llm: 현대모비스 LLM 만족도 종합
  - hyundai_mobis_llm_2: 현대모비스 LLM 2차수
  - hyundai_mobis_llm_3: 현대모비스 LLM 3차수 응답

### 정민수A (L3, th=2, importItems=26)
- 분류: **AMBIGUOUS** — 회사만 매칭, 과정명은 다름 — 같은 회사의 다른 강의일 수 있음
- 권장: 사용자 검수: 시트 응답이 이 강사 강의의 만족도인지 확인
- 강사의 회사/과정 샘플:
  - 우리은행 / [부가세 별도] (B2B) 우리은행_AX 전문가 양성 과정
  - 우리은행 / [부가세 별도] (B2B) 우리은행_AX 전문가 양성 과정
- 매칭된 catalog 시트:
  - woori_ax_forms: 우리은행 AX 전문가 양성과정
  - woori_bank_ax_2604_2611: 2604~2611_우리은행 AX 전문가 양성 과정_강의관리 시트

### 이찬우B (L3, th=8, importItems=25)
- 분류: **AMBIGUOUS** — 회사만 매칭, 과정명은 다름 — 같은 회사의 다른 강의일 수 있음
- 권장: 사용자 검수: 시트 응답이 이 강사 강의의 만족도인지 확인
- 강사의 회사/과정 샘플:
  - — / —
  - — / —
  - 우리은행 / 우리은행_2025 WLT 2 평가과정 문항개발
- 매칭된 catalog 시트:
  - woori_ax_forms: 우리은행 AX 전문가 양성과정
  - woori_bank_ax_2604_2611: 2604~2611_우리은행 AX 전문가 양성 과정_강의관리 시트

## FP — Audit 알고리즘 false positive (5명)

### 신승진 (L2, th=4, importItems=0)
- 분류: **FP** — 회사명 일치 안 함 → audit 부분 매칭으로 인한 false positive
- 권장: audit 매칭 알고리즘 strict 보정 (length≥6 + 회사명 양방향 정규화)
- 강사의 회사/과정 샘플:
  - 에스케이텔레콤 / 에스케이텔레콤_ChatGPT를 활용한 Global Communicatio
  - 홈앤서비스 / 홈앤서비스_2025 홈앤서비스 AI 활용 DT 전문가 양성 과정
  - 홈앤서비스 / 홈앤서비스_2025 홈앤서비스 AI 활용 DT 전문가 양성 과정
- 매칭된 catalog 시트:
  - home_n_service_dt_2506_2512: 2506~2512_홈앤서비스_AI 활용 DT전문가 양성과정_강의관리 시트

### 이중학(주식회사 그로스링크) (L2, th=4, importItems=0)
- 분류: **FP** — 회사명 일치 안 함 → audit 부분 매칭으로 인한 false positive
- 권장: audit 매칭 알고리즘 strict 보정 (length≥6 + 회사명 양방향 정규화)
- 강사의 회사/과정 샘플:
  - — / [부가세 별도] (B2B) 현대자동차연구소_전사AI역량진단
  - 현대자동차 / [부가세 별도] (B2B) 현대자동차연구소_전사AI역량진단
  - — / [부가세 별도] (B2B) 현대자동차연구소_전사AI역량진단
- 매칭된 catalog 시트:
  - hyundai_motor_research_awareness: ★[현대자동차 연구소] Awareness 전환 설문 결과

### 김성재A (L2, th=10, importItems=0)
- 분류: **FP** — 회사명 일치 안 함 → audit 부분 매칭으로 인한 false positive
- 권장: audit 매칭 알고리즘 strict 보정 (length≥6 + 회사명 양방향 정규화)
- 강사의 회사/과정 샘플:
  - — / —
  - — / 삼성화재_디지털Basic 과정
  - 하나금융티아이 / AX Champion(AI 아이디어 도출 워크숍)
- 매칭된 catalog 시트:
  - samsung_life_ai_hackathon: [삼성생명] AI 해커톤 프로젝트 만족도 설문 결과 및 raw data

### 신주혜 (L3, th=10, importItems=1)
- 분류: **FP** — 회사명 일치 안 함 → audit 부분 매칭으로 인한 false positive
- 권장: audit 매칭 알고리즘 strict 보정 (length≥6 + 회사명 양방향 정규화)
- 강사의 회사/과정 샘플:
  - — / —
  - — / —
  - 바인그룹 / 바인그룹_생성형AI 마케팅 활용 과정 (출강)
- 매칭된 catalog 시트:
  - home_n_service_dt_2506_2512: 2506~2512_홈앤서비스_AI 활용 DT전문가 양성과정_강의관리 시트

### 유연휘 (L3, th=16, importItems=1)
- 분류: **FP** — 회사명 일치 안 함 → audit 부분 매칭으로 인한 false positive
- 권장: audit 매칭 알고리즘 strict 보정 (length≥6 + 회사명 양방향 정규화)
- 강사의 회사/과정 샘플:
  - 앰코테크놀로지코리아 / 2026년 AX 교육 기초2
  - 앰코테크놀로지코리아 / 2026년 AX 교육 기초2
  - 에스케이텔레콤 / SK텔링크_생성형 AI 프로젝트
- 매칭된 catalog 시트:
  - home_n_service_dt_2506_2512: 2506~2512_홈앤서비스_AI 활용 DT전문가 양성과정_강의관리 시트
