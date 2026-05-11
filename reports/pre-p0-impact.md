# P0 정책 적용 영향 dry-run (Phase 2-1)
Generated at: 2026-05-07T07:38:12.552Z
6개월 cutoff: 2025-11-07 이후 record 분석

## record 분류
- 전체 record (cutoff 안): **146건**
- L0 fan-out (catalog_expected_instructors_super_priority): **9건**
- L3 (회사+과정 substring): **1건**
- L4 (instructorHint/expectedInstructors): **0건**
- 그 외 (단일 강사 정확 매칭, gmail 등): 136건

정책 변경 시 제거 대상: **10건** (L0+L3+L4)

## 영향 강사 — Top 20
| 강사 | role | current avg/count | after avg/count | Δ count | Δ avg | source types |
|---|---|---|---|---|---|---|
| 박상훈 | 정규 | 4.57 / 3 | — / 0 | -3 | — | google_forms |
| 공지연 | 전임 | 4.57 / 3 | 4.8 / 1 | -2 | 0.23 | google_forms |
| 최진영B | 정규 | 4.45 / 2 | — / 0 | -2 | — | google_forms |
| 유종훈 | 정규 | 4.83 / 3 | 5 / 2 | -1 | 0.17 | google_forms |
| 김정수A | 정규 | 4.74 / 2 | 5 / 1 | -1 | 0.26 | google_forms |
| 정민수A | 정규 | 4.48 / 1 | — / 0 | -1 | — | google_forms |

## L0 fan-out record 상세 (최대 10건)
| 강사 | 회사 | 과정 | 일자 | 점수 | 응답수 | sourceType |
|---|---|---|---|---|---|---|
| 유종훈 | 우리은행 | AX 기획자 과정 | 2025-11-26 | 4.48 | 25 | google_forms |
| 김정수A | 우리은행 | AX 기획자 과정 | 2025-11-26 | 4.48 | 25 | google_forms |
| 정민수A | 우리은행 | AX 기획자 과정 | 2025-11-26 | 4.48 | 25 | google_forms |
| 공지연 | 동국제강그룹 | 2026 DK AI 역량강화 아카데미 | 2026-03-26 | 4.55 | 33 | google_forms |
| 공지연 | 동국제강그룹 | 2026 DK AI 역량강화 아카데미 | 2026-04-06 | 4.35 | 20 | google_forms |
| 최진영B | 동국제강그룹 | 2026 DK AI 역량강화 아카데미 | 2026-03-26 | 4.55 | 33 | google_forms |
| 최진영B | 동국제강그룹 | 2026 DK AI 역량강화 아카데미 | 2026-04-06 | 4.35 | 20 | google_forms |
| 박상훈 | 동국제강그룹 | 2026 DK AI 역량강화 아카데미 | 2026-04-06 | 4.35 | 20 | google_forms |
| 박상훈 | 동국제강그룹 | 2026 DK AI 역량강화 아카데미 | 2026-03-26 | 4.55 | 33 | google_forms |

## L3/L4 record 상세 (있을 시)
L3 1건, L4 0건

## 사용자 명시 영향 (요청 케이스)
| 강사 | 현재 | 정정 후 | 의미 |
|---|---|---|---|
| 박상훈 | 4.57 / 3 | — / 0 | 강사별 평균 사라짐 — course-level satisfaction으로만 표시 가능 |
| 유종훈 | 4.83 / 3 | 5 / 2 | 1건 제거 → 단일 강사 매칭만 남음 |
| 김정수A | 4.74 / 2 | 5 / 1 | 1건 제거 → 단일 강사 매칭만 남음 |
| 정민수A | 4.48 / 1 | — / 0 | 강사별 평균 사라짐 — course-level satisfaction으로만 표시 가능 |
| 최진영B | 4.45 / 2 | — / 0 | 강사별 평균 사라짐 — course-level satisfaction으로만 표시 가능 |
| 공지연 | 4.57 / 3 | 4.8 / 1 | 2건 제거 → 단일 강사 매칭만 남음 |
| 김인섭 | 4.54 / 5 | (변동 없음) | L0/L3/L4 record 없음 — 정정 영향 없음 |
| 송유이 | 4.5 / 1 | (변동 없음) | L0/L3/L4 record 없음 — 정정 영향 없음 |