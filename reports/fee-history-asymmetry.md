# 강사료 이력 ↔ 단가 칩 비대칭 진단 보고서
Generated at: 2026-05-06T04:00:09.305Z

총 5명 trace.

## 매칭 로직 (현재)
```typescript
function noteMatchesTimeline(note, item):
  return note.amount === item.amount AND note.start_date === item.start_key

function collapseFeeTimeline 필터:
  !item.is_special_amount AND item.fee_kind === "hourly" AND item.amount !== null AND label
```

---

## 김인섭
- fee_history: 전체 67건, timeline 통과 48건, special_amount 19건, 비-hourly 19건
- teaching contract notes: 50건 (matched 42 / unmatched 8)

### timeline에서 제외된 fee_history (단가 칩 매칭 후보 아님)
| amount | effective_date | label | fee_kind | special | context | reason |
|---|---|---|---|---|---|---|
| 300000 | 2024-10-21 | 2024. 10. 21(월) 10:00~17:00 (6H, 점심1H 제외)
2024. 10. 22(화) 09:00~17:00 (7H, 점심1H 제외)
2024. 10. 23(수) 09:00~17:00 (7H, 점심1H 제외)
2024. 10. 24(목) 09:00~17:00 (7H, 점심1H 제외)
2024. 10. 25(금) 09:00~11:00 (2H) | special | true | 강사비, 출장비 · 300,000 (출장비, 1회 지급) · 300,000 (출장비, 1회 지급) | is_special_amount=true (timeline 제외) |
| 350000 | 2024-10-29 | 10월 29일 (화) 10:00 ~ 17:00 (6H / 점심시간 1H 제외)
10월 30일 (수) 09:00 ~ 18:00 (8H / 점심시간 1H 제외)
10월 31일 (목) 09:00 ~ 16:00 (6H / 점심시간 1H 제외) | special | true | 강사비, 출장비 | is_special_amount=true (timeline 제외) |
| 1200000 | 2024-11-23 | 2024. 11. 23(토) 10:00 ~ 17:00 (점심시간 1시간 제외)
2024. 11. 30(토) 10:00 ~ 17:00 (점심시간 1시간 제외)
2024. 12. 07(토) 10:00 ~ 17:00 (점심시간 1시간 제외)
2024. 12. 14(토) 10:00 ~ 17:00 (점심시간 1시간 제외) | special | true | 강사비, 출장비 · 1,200,000(출장비, 300,000 X 4회) · 1,200,000(출장비, 300,000 X 4회) | is_special_amount=true (timeline 제외) |
| 200000 | 2024-12-10 | 2024. 12. 10 (화) 10:00 ~ 17:00 (점심시간 1H 포함) | special | true | 강사비, 출장비 · 출장비 200,000 · 출장비 200,000 | is_special_amount=true (timeline 제외) |
| 1000000 | 2025-03-10 | "영상 납품 기한 

1차 납기: 3월 10일 - 총 동영상의 80% 이상 전달 완료, 전달한 동영상에 해당하는 강의안, “마스터시트” 전달완료
최종 납기: 3월 17일 - 전체 동영상, 강의안, “마스터시트” 등 전달 완료" | special | true | 삼성생명보험 / 삼성생명보험 디지털역량강화과정-AI&데이터분석 Basic 영상제작(2025) · 강사비_Markup ver | is_special_amount=true (timeline 제외) |
| 200000 | 2025-03-25 | 2025. 03. 25(화) 13:30~17:30 | special | true | 불스원 / 불스원_생성형 AI 활용 교육 · 강사비, 녹화비 | is_special_amount=true (timeline 제외) |
| 14400000 | 2025-04-07 | 2025.04.07 (월) 10:00 - 18:00 (7h, 점심시간 제외) | special | true | 삼성생명보험 / 삼성생명 AI 해커톤 · 해커톤 코칭: 시간당 300,000원 * 8H * 6 → 5Day, 총 14,400,000원 12,000,000원 김인섭(주식회사_승리소프트)_AI 강의 및 프로젝트 리딩 및 팀 코칭 | is_special_amount=true (timeline 제외) |
| 400000 | 2025-04-08 | 2025.04.08(화) 09:00~18:00 (8H, 점심시간 1H 제외)
2025.05.27(화) 09:00~18:00 (8H, 점심시간 1H 제외) | special | true | 강사비, 출장비 · 400,000(출장비, 200,000 X 2회) · 400,000(출장비, 200,000 X 2회) | is_special_amount=true (timeline 제외) |
| 100000 | 2025-04-22 | 2025.04.22. (화) 09:00~17:00 (점심시간 1H 포함) | special | true | 강사비, 출장비 | is_special_amount=true (timeline 제외) |
| 700000 | 2025-06-16 | 2025. 06. 16(월) 09:00~17:30  점심시간 1시간제외, 7.5H
2025. 06. 23(월) 09:00~17:30  점심시간 1시간제외, 7.5H
2025. 06. 25(수) 09:00~17:30  점심시간 1시간제외, 7.5H
2025. 06. 27(금) 09:00~17:30  점심시간 1시간제외, 7.5H
2025. 07. 23(수) 09:00~17:30  점심시간 1시간제외, 7.5H
2025. 07. 31(목) 09:00~17:30  점심시간 1시간제외, 7.5H
2025. 08. 25(월) 09:00~17:30  점심시간 1시간제외, 7.5H
2025. 08. 27(수) 09:00~17:30  점심시간 1시간제외, 7.5H | special | true | 효성 / 효성 AI 프롬프트 엔지니어링 실무 마스터 과정(전사) · 강사비&출장비 | is_special_amount=true (timeline 제외) |

### teaching_history (contract notes 보유) — 매칭 결과
| 회사 | 과정 | start | deal_fee | matched | reason |
|---|---|---|---|---|---|
| — | — | 2024-10-21 | 150000 | ✅ | — |
| — | — | 2024-10-21 | 150000 | ✅ | — |
| — | — | 2024-10-29 | 200000 | ✅ | — |
| — | — | 2024-10-29 | 200000 | ✅ | — |
| — | — | 2024-11-23 | 200000 | ✅ | — |
| — | — | 2024-11-23 | 200000 | ✅ | — |
| — | — | 2024-12-10 | 200000 | ✅ | — |
| — | — | 2024-12-10 | 200000 | ✅ | — |
| 삼성생명보험 | 삼성생명보험 디지털역량강화과정-AI&데이터분석 Basi | 2025-03-10 | 1000000 | ❌ | amount/start_date 모두 다름 (TH amount=1000000 start=2025-03-10) |
| 삼성생명보험 | 삼성생명보험 디지털역량강화과정-AI&데이터분석 Basi | 2025-03-10 | 1000000 | ❌ | amount/start_date 모두 다름 (TH amount=1000000 start=2025-03-10) |
| 불스원 | 불스원_생성형 AI 활용 교육 | 2025-03-25 | 200000 | ✅ | — |
| 불스원 | 불스원_생성형 AI 활용 교육 | 2025-03-25 | 200000 | ✅ | — |
| 삼성생명보험 | 삼성생명 AI 해커톤 | 2025-04-07 | 200000 | ✅ | — |
| 삼성생명보험 | 삼성생명 AI 해커톤 | 2025-04-07 | 200000 | ✅ | — |
| — | — | 2025-04-08 | 200000 | ✅ | — |

---
## 박요한
- fee_history: 전체 21건, timeline 통과 0건, special_amount 21건, 비-hourly 21건
- teaching contract notes: 30건 (matched 0 / unmatched 30)

### timeline에서 제외된 fee_history (단가 칩 매칭 후보 아님)
| amount | effective_date | label | fee_kind | special | context | reason |
|---|---|---|---|---|---|---|
| 1500000 | 2025-03-31 | 계약 일정: 2025. 03.31  (월) ~ 2025. 05. 29 (목) | special | true | 케이비국민은행 / LG전자_Data Scientist 과정 (2025) · 문항개발 | is_special_amount=true (timeline 제외) |
| 75000 | 2025-04-17 | 2025.04.17 (목) ~ 2025.04.28 (월) | special | true | 대상 / 대상 그룹- 25년도 디지털리터러시 교육 · 문항개발 | is_special_amount=true (timeline 제외) |
| 5000 | 2025-04-17 | 2025.04.17 (목) ~ 2025.04.28 (월) | special | true | 대상 / 대상 그룹- 25년도 디지털리터러시 교육 · 문항개발 | is_special_amount=true (timeline 제외) |
| 180000 | 2025-06-30 | 2025년 06월 30일 (월)부터 2025년 07월 11일 (금)까지 | special | true | 삼성화재 / 삼성화재_생성형 AI Biz 전문가 과정 · 문항개발 | is_special_amount=true (timeline 제외) |
| 750000 | 2025-07-09 | 2025. 07.09  (수) ~ 2025. 07. 25 (금) | special | true | 케이비국민은행 / LG전자_Data Scientist 과정 (2025) · 문항개발 | is_special_amount=true (timeline 제외) |
| 15000 | 2025-08-06 | 2025. 08. 06(수) 09:00 - 18:00 (점심 휴게1시간, 8H) | special | true | 케이비국민은행 / KB국민은행_신입사원 AI 교육 · 출장비 ( 50,000) | is_special_amount=true (timeline 제외) |
| 50000 | 2025-08-06 | 2025. 08. 06(수) 09:00 - 18:00 (점심 휴게1시간, 8H) | special | true | 케이비국민은행 / KB국민은행_신입사원 AI 교육 · 출장비 ( 50,000) · 출장비 ( 50,000) | is_special_amount=true (timeline 제외) |
| 5000 | 2025-08-18 | 2025년 08월 18일 (월) ~ 2025년 08월 29일 (금) | special | true | 에쓰오일 / S-OIL_2025년 생성형 AI 교육 · 문항개발비 | is_special_amount=true (timeline 제외) |
| 100000 | 2025-08-18 | 2025년 08월 18일 (월) ~ 2025년 08월 29일 (금) | special | true | 에쓰오일 / S-OIL_2025년 생성형 AI 교육 · 문항개발비 | is_special_amount=true (timeline 제외) |
| 500000 | 2025-09-04 | 2025년 09월 04일 (목) ~ 2025년 09월 16일 (화) | special | true | 문항개발비 | is_special_amount=true (timeline 제외) |

### teaching_history (contract notes 보유) — 매칭 결과
| 회사 | 과정 | start | deal_fee | matched | reason |
|---|---|---|---|---|---|
| 케이비국민은행 | KB국민은행 2025 디지털 분야 위탁 교육 | 2025-03-31 | — | ❌ | teaching_history.deal_fee_hourly=null |
| 케이비국민은행 | KB국민은행 2025 디지털 분야 위탁 교육 | 2025-03-31 | — | ❌ | teaching_history.deal_fee_hourly=null |
| 대상 | 대상 그룹- 25년도 디지털리터러시 교육 | 2025-04-17 | — | ❌ | teaching_history.deal_fee_hourly=null |
| 대상 | 대상 그룹- 25년도 디지털리터러시 교육 | 2025-04-17 | — | ❌ | teaching_history.deal_fee_hourly=null |
| 케이비국민은행 | KB국민은행 2025 디지털 분야 위탁 교육 | 2025-05-26 | — | ❌ | teaching_history.deal_fee_hourly=null |
| 케이비국민은행 | KB국민은행 2025 디지털 분야 위탁 교육 | 2025-05-26 | — | ❌ | teaching_history.deal_fee_hourly=null |
| 솔브레인홀딩스 | [부가세별도] (B2B) 솔브레인홀딩스_2025 CDS | 2025-06-20 | — | ❌ | teaching_history.deal_fee_hourly=null |
| 솔브레인홀딩스 | [부가세별도] (B2B) 솔브레인홀딩스_2025 CDS | 2025-06-20 | — | ❌ | teaching_history.deal_fee_hourly=null |
| 삼성화재 | 삼성화재_생성형 AI Biz 저 | 2025-06-30 | — | ❌ | teaching_history.deal_fee_hourly=null |
| 삼성화재 | 삼성화재_생성형 AI Biz 저 | 2025-06-30 | — | ❌ | teaching_history.deal_fee_hourly=null |
| 케이비국민은행 | KB국민은행 2025 디지털 분야 위탁 교육 | 2025-07-09 | — | ❌ | teaching_history.deal_fee_hourly=null |
| 케이비국민은행 | KB국민은행 2025 디지털 분야 위탁 교육 | 2025-07-09 | — | ❌ | teaching_history.deal_fee_hourly=null |
| 솔브레인홀딩스 | [부가세별도] (B2B) 솔브레인홀딩스_2025 CDS | 2025-08-01 | — | ❌ | teaching_history.deal_fee_hourly=null |
| 솔브레인홀딩스 | [부가세별도] (B2B) 솔브레인홀딩스_2025 CDS | 2025-08-01 | — | ❌ | teaching_history.deal_fee_hourly=null |
| 케이비국민은행 | KB국민은행_신입사원 AI 교육 | 2025-08-06 | 15000 | ❌ | amount/start_date 모두 다름 (TH amount=15000 start=2025-08-06) |

---
## 박건민
- fee_history: 전체 20건, timeline 통과 0건, special_amount 20건, 비-hourly 20건
- teaching contract notes: 12건 (matched 0 / unmatched 12)

### timeline에서 제외된 fee_history (단가 칩 매칭 후보 아님)
| amount | effective_date | label | fee_kind | special | context | reason |
|---|---|---|---|---|---|---|
| 5000 | 2025-09-04 | 2025년 09월 04일 (목) ~ 2025년 09월 16일 (화) | special | true | 문항개발비 | is_special_amount=true (timeline 제외) |
| 5000 | 2025-09-04 | 2025년 09월 04일 (목) ~ 2025년 09월 16일 (화) | special | true | 문항개발비 | is_special_amount=true (timeline 제외) |
| 550000 | 2025-09-04 | 2025년 09월 04일 (목) ~ 2025년 09월 16일 (화) | special | true | 문항개발비 | is_special_amount=true (timeline 제외) |
| 550000 | 2025-09-04 | 2025년 09월 04일 (목) ~ 2025년 09월 16일 (화) | special | true | 문항개발비 | is_special_amount=true (timeline 제외) |
| 5000 | 2025-10-02 | 2025년 10월 02일 (목) ~ 2025년 10월 21일 (화) | special | true | 문항개발비 | is_special_amount=true (timeline 제외) |
| 650000 | 2025-10-02 | 2025년 10월 02일 (목) ~ 2025년 10월 21일 (화) | special | true | 문항개발비 | is_special_amount=true (timeline 제외) |
| 5000 | 2025-10-02 | 2025년 10월 02일 (목) ~ 2025년 10월 21일 (화) | special | true | 문항개발비 | is_special_amount=true (timeline 제외) |
| 650000 | 2025-10-02 | 2025년 10월 02일 (목) ~ 2025년 10월 21일 (화) | special | true | 문항개발비 | is_special_amount=true (timeline 제외) |
| 30000 | 2025-11-24 | 1. 비대면 온라인 멘토링 (ZOOM) 
- 일정 추후 논의, 1회당 1시간 * 5팀
>> 총 5H

2. 대면 프로젝트 멘토링 (MVP 구현 기술지원) 
-  2025년 11월 24일(월), 12:00~18:00 (휴게 1H, 총 5H)
-  2025년 11월 25일(화), 09:00~18:00 (휴게 1H, 총 8H)
-  2025년 11월 26일(수), 09:00~17:00 (휴게 1H, 총 7H)
>> 총 20H | special | true | 에쓰오일 / 에쓰오일_AX해커톤 · 비대면 온라인 멘토링 (ZOOM) - 일정 추후 논의, 1시간씩 5회, 총 5H 진행 >> 시급 30,000원 x 총 5H = 150,000원 2 · 비대면 온라인 멘토링 (ZOOM) - 시급 30,000원 2 | is_special_amount=true (timeline 제외) |
| 50000 | 2025-11-24 | 1. 비대면 온라인 멘토링 (ZOOM) 
- 일정 추후 논의, 1회당 1시간 * 5팀
>> 총 5H

2. 대면 프로젝트 멘토링 (MVP 구현 기술지원) 
-  2025년 11월 24일(월), 12:00~18:00 (휴게 1H, 총 5H)
-  2025년 11월 25일(화), 09:00~18:00 (휴게 1H, 총 8H)
-  2025년 11월 26일(수), 09:00~17:00 (휴게 1H, 총 7H)
>> 총 20H | special | true | 에쓰오일 / 에쓰오일_AX해커톤 · 비대면 온라인 멘토링 (ZOOM) - 일정 추후 논의, 1시간씩 5회, 총 5H 진행 >> 시급 30,000원 x 총 5H = 150,000원 2 · 비대면 온라인 멘토링 (ZOOM) - 시급 30,000원 2 | is_special_amount=true (timeline 제외) |

### teaching_history (contract notes 보유) — 매칭 결과
| 회사 | 과정 | start | deal_fee | matched | reason |
|---|---|---|---|---|---|
| — | — | 2025-09-04 | — | ❌ | teaching_history.deal_fee_hourly=null |
| — | — | 2025-09-04 | — | ❌ | teaching_history.deal_fee_hourly=null |
| — | — | 2025-10-02 | — | ❌ | teaching_history.deal_fee_hourly=null |
| — | — | 2025-10-02 | — | ❌ | teaching_history.deal_fee_hourly=null |
| 솔브레인홀딩스 | [부가세별도] (B2B) 솔브레인홀딩스_2025 CDS | 2025-10-10 | — | ❌ | teaching_history.deal_fee_hourly=null |
| 솔브레인홀딩스 | [부가세별도] (B2B) 솔브레인홀딩스_2025 CDS | 2025-10-10 | — | ❌ | teaching_history.deal_fee_hourly=null |
| 에쓰오일 | S-OIL_2025 AX 해커톤 | 2025-11-24 | — | ❌ | teaching_history.deal_fee_hourly=null |
| 에쓰오일 | S-OIL_2025 AX 해커톤 | 2025-11-24 | — | ❌ | teaching_history.deal_fee_hourly=null |
| — | — | 2025-12-16 | — | ❌ | teaching_history.deal_fee_hourly=null |
| — | — | 2025-12-16 | — | ❌ | teaching_history.deal_fee_hourly=null |
| — | — | 2026-01-07 | — | ❌ | teaching_history.deal_fee_hourly=null |
| — | — | 2026-01-07 | — | ❌ | teaching_history.deal_fee_hourly=null |

---
## 신동원
- fee_history: 전체 13건, timeline 통과 2건, special_amount 11건, 비-hourly 11건
- teaching contract notes: 22건 (matched 2 / unmatched 20)

### timeline에서 제외된 fee_history (단가 칩 매칭 후보 아님)
| amount | effective_date | label | fee_kind | special | context | reason |
|---|---|---|---|---|---|---|
| 100000 | 2025-09-16 | 2025.9.16(화) 9:30~16:30(점심 휴게 1시간, 6H) | special | true | 고등기술연구원 / [부가세별도](B2B) 고등기술연구원_연구원을 위한 AI 활용 교육 · 패스트캠퍼스 소속강사로 강의종료 이후(강의료는 정산 완료) 출장비만 사후에 지급하는 건입니다, 출장지: 용인(고등기술연구원, 경기도이나 거리 및 교통수단이 마땅치 않아 출장비 지급하기로 하였습니다 | is_special_amount=true (timeline 제외) |
| 150000 | 2025-09-17 | 2025.9.17 (수) 9:00~18:00(점심 휴게 1시간, 8H) | special | true | 나노종합기술원 / [부가세별도](B2B)나노종합기술원_AI 기술을 활용한 데이터 관리 과정 · 패스트캠퍼스 소속강사로 강의종료 이후(강의료는 정산 완료) 출장비만 사후에 지급하는 건입니다, 출장지: 대전(나노종합기술원) | is_special_amount=true (timeline 제외) |
| 30000 | 2025-09-22 | [온라인 질의 응대]
2025.09.22-2025.11.23 (총 8주) | special | true | 케이비국민은행 / LG전자_Data Scientist 과정 (2025) · 온라인 실습코치 | is_special_amount=true (timeline 제외) |
| 200000 | 2025-09-24 | 2025.9.24 (수) 13:00~17:00(4H)
2025.10.23 (목) 13:00~17:00(4H) | special | true | 국가보안기술연구소 / [부가세별도](B2B) 국가보안기술연구소_임직원 AI역량 향상 교육-연구직을 위한 생성형AI 교육 · 패스트캠퍼스 소속강사로 강의종료 이후(강의료는 정산 완료) 출장비만 사후에 지급하는 건입니다 / 각 출장비가 10만원으로 총 출장비는 20만원입니다 | is_special_amount=true (timeline 제외) |
| 250000 | 2025-10-21 | 2025.10.21 (화) ~ 2025.10.22 (수) 구미 | special | true | 출장비 / 2025.10.21 (화) ~ 2025.10.22 (수) 구미 · 패캠 전속 계약 강사로 출장비만 따로 계약하여 지급 | is_special_amount=true (timeline 제외) |
| 2100000 | 2025-10-28 | 2025.10.28 ~ 2026.1.28 (총 178 시간) | special | true | AI Agent 과정 · 강사비 | is_special_amount=true (timeline 제외) |
| 150000 | 2025-11-20 | 2025. 11. 20(목) 14:00~16:00(2H) | special | true | 글로벌핀테크산업진흥센터 / 2025년 글로벌핀테크산업진흥센터 부산핀테크허브 교육 운영 용역_PM교육+생성형AI특강 · 패캠 전속 계약 강사로 출장비만 따로 계약하여 지급 | is_special_amount=true (timeline 제외) |
| 260000 | 2026-01-22 | 2026. 1. 22(목) 8:00 - 15:30 (점심 휴게1시간, 6.5H) | special | true | 디알비동일 / 2601_디알비동일_승진자 대상 AX 기반 업무 자동화 교육 · 패캠 전속 계약 강사로 출장비만 따로 계약하여 지급 | is_special_amount=true (timeline 제외) |
| 50000 | 2026-01-27 | 2026.01.27 (화) ~ 2026.01.28 (수) 09:00~18:00 (점심 휴게 1H, 8H), 세종
2026.02.11 (수) 09:00~18:00 (점심 휴게 1H, 8H), 천안 출장 | special | true | 신입사원 AI 업무 첫걸음 과정 1/2회차 · 패캠 전속 강사로 출장비만 따로 계약하여 지급 · 350,000 (세종 출장비) 50,000 (천안출장비) | is_special_amount=true (timeline 제외) |
| 350000 | 2026-01-27 | 2026.01.27 (화) ~ 2026.01.28 (수) 09:00~18:00 (점심 휴게 1H, 8H), 세종
2026.02.11 (수) 09:00~18:00 (점심 휴게 1H, 8H), 천안 출장 | special | true | 신입사원 AI 업무 첫걸음 과정 1/2회차 · 패캠 전속 강사로 출장비만 따로 계약하여 지급 · 350,000 (세종 출장비) 50,000 (천안출장비) | is_special_amount=true (timeline 제외) |

### teaching_history (contract notes 보유) — 매칭 결과
| 회사 | 과정 | start | deal_fee | matched | reason |
|---|---|---|---|---|---|
| 고등기술연구원 | [부가세별도](B2B) 고등기술연구원_연구원을 위한 A | 2025-09-16 | — | ❌ | teaching_history.deal_fee_hourly=null |
| 고등기술연구원 | [부가세별도](B2B) 고등기술연구원_연구원을 위한 A | 2025-09-16 | — | ❌ | teaching_history.deal_fee_hourly=null |
| 나노종합기술원 | [부가세별도](B2B)나노종합기술원_AI 기술을 활용한 | 2025-09-17 | — | ❌ | teaching_history.deal_fee_hourly=null |
| 나노종합기술원 | [부가세별도](B2B)나노종합기술원_AI 기술을 활용한 | 2025-09-17 | — | ❌ | teaching_history.deal_fee_hourly=null |
| 케이비국민은행 | KB국민은행 2025 디지털 분야 위탁 교육 | 2025-09-22 | 30000 | ❌ | amount/start_date 모두 다름 (TH amount=30000 start=2025-09-22) |
| 케이비국민은행 | KB국민은행 2025 디지털 분야 위탁 교육 | 2025-09-22 | 30000 | ❌ | amount/start_date 모두 다름 (TH amount=30000 start=2025-09-22) |
| 국가보안기술연구소 | [부가세별도](B2B) 국가보안기술연구소_임직원 AI역 | 2025-09-24 | — | ❌ | teaching_history.deal_fee_hourly=null |
| 국가보안기술연구소 | [부가세별도](B2B) 국가보안기술연구소_임직원 AI역 | 2025-09-24 | — | ❌ | teaching_history.deal_fee_hourly=null |
| — | — | 2025-10-21 | — | ❌ | teaching_history.deal_fee_hourly=null |
| — | — | 2025-10-21 | — | ❌ | teaching_history.deal_fee_hourly=null |
| — | AI Agent 과정 | 2025-10-28 | 50000 | ✅ | — |
| — | AI Agent 과정 | 2025-10-28 | 50000 | ✅ | — |
| 글로벌핀테크산업진흥센터 | 2025년 글로벌핀테크산업진흥센터 부산핀테크허브 교육  | 2025-11-20 | — | ❌ | teaching_history.deal_fee_hourly=null |
| 글로벌핀테크산업진흥센터 | 2025년 글로벌핀테크산업진흥센터 부산핀테크허브 교육  | 2025-11-20 | — | ❌ | teaching_history.deal_fee_hourly=null |
| 디알비동일 | 2601_디알비동일_승진자 대상 AX 기반 업무 자동화 | 2026-01-22 | — | ❌ | teaching_history.deal_fee_hourly=null |

---
## 정백
- fee_history: 전체 3건, timeline 통과 0건, special_amount 3건, 비-hourly 3건
- teaching contract notes: 31건 (matched 0 / unmatched 31)

### timeline에서 제외된 fee_history (단가 칩 매칭 후보 아님)
| amount | effective_date | label | fee_kind | special | context | reason |
|---|---|---|---|---|---|---|
| 30000 | 2025-01-07 | 2025. 01. 07(화) 14:30~17:00,  2025. 01. 08(수) 09:30~12:00 (총 5H) | special | true | 에스케이텔레콤 / SK아카데미_신입사원 대상 생성형AI 역량 향상 과정 · 강사비, 출장비 | is_special_amount=true (timeline 제외) |
| 100000 | 2025-01-07 | 2025. 01. 07(화) 14:30~17:00,  2025. 01. 08(수) 09:30~12:00 (총 5H) | special | true | 에스케이텔레콤 / SK아카데미_신입사원 대상 생성형AI 역량 향상 과정 · 강사비, 출장비 | is_special_amount=true (timeline 제외) |
| 1000000 | 2025-07-02 | 2025. 07. 02(수) ~ 2025. 07. 04(금) - 창원
2025. 07. 11(금) - 구미
2025. 07. 17(목) - 용연 | special | true | 효성 / 효성 AI 프롬프트 엔지니어링 실무 마스터 과정(전사) · 패캠 전속 계약 강사로 출장비만 따로 계약하여 지급 | is_special_amount=true (timeline 제외) |

### teaching_history (contract notes 보유) — 매칭 결과
| 회사 | 과정 | start | deal_fee | matched | reason |
|---|---|---|---|---|---|
| 에스케이텔레콤 | SK텔링크_생성형 AI 프로젝트 | 2025-01-07 | 30000 | ❌ | amount/start_date 모두 다름 (TH amount=30000 start=2025-01-07) |
| 에스케이텔레콤 | SK텔링크_생성형 AI 프로젝트 | 2025-01-07 | 30000 | ❌ | amount/start_date 모두 다름 (TH amount=30000 start=2025-01-07) |
| 대상주식회사 | 생성형 AI 리터러시 전사 필수 과정 | 2025-06-19 | — | ❌ | teaching_history.deal_fee_hourly=null |
| 대상주식회사 | 생성형 AI 리터러시 전사 필수 과정 | 2025-06-19 | — | ❌ | teaching_history.deal_fee_hourly=null |
| 대상주식회사 | 생성형 AI 리터러시 전사 필수 과정 | 2025-06-26 | — | ❌ | teaching_history.deal_fee_hourly=null |
| 대상주식회사 | 생성형 AI 리터러시 전사 필수 과정 | 2025-06-26 | — | ❌ | teaching_history.deal_fee_hourly=null |
| 효성 | 효성 AI 프롬프트 엔지니어링 실무 마스터 과정(전사) | 2025-07-02 | — | ❌ | teaching_history.deal_fee_hourly=null |
| 효성 | 효성 AI 프롬프트 엔지니어링 실무 마스터 과정(전사) | 2025-07-02 | — | ❌ | teaching_history.deal_fee_hourly=null |
| 대상주식회사 | 생성형 AI 리터러시 전사 필수 과정 | 2025-07-14 | — | ❌ | teaching_history.deal_fee_hourly=null |
| 대상주식회사 | 생성형 AI 리터러시 전사 필수 과정 | 2025-07-14 | — | ❌ | teaching_history.deal_fee_hourly=null |
| 대상주식회사 | 생성형 AI 리터러시 전사 필수 과정 | 2025-07-15 | — | ❌ | teaching_history.deal_fee_hourly=null |
| 대상주식회사 | 생성형 AI 리터러시 전사 필수 과정 | 2025-07-15 | — | ❌ | teaching_history.deal_fee_hourly=null |
| 대상주식회사 | 25년도 전사원 AI 리터러시 필수과정 | 2025-07-21 | — | ❌ | teaching_history.deal_fee_hourly=null |
| 대상주식회사 | 25년도 전사원 AI 리터러시 필수과정 | 2025-07-21 | — | ❌ | teaching_history.deal_fee_hourly=null |
| 대상주식회사 | 25년도 전사원 AI 리터러시 필수과정 | 2025-07-22 | — | ❌ | teaching_history.deal_fee_hourly=null |

---
## 종합 요약
| 강사 | FH total | FH timeline | special | non_hourly | TH notes | matched | unmatched |
|---|---|---|---|---|---|---|---|
| 김인섭 | 67 | 48 | 19 | 19 | 50 | 42 | 8 |
| 박요한 | 21 | 0 | 21 | 21 | 30 | 0 | 30 |
| 박건민 | 20 | 0 | 20 | 20 | 12 | 0 | 12 |
| 신동원 | 13 | 2 | 11 | 11 | 22 | 2 | 20 |
| 정백 | 3 | 0 | 3 | 3 | 31 | 0 | 31 |
