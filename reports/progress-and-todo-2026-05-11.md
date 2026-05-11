# 진행 상황 + 남은 TODO (2026-05-11)

## ✅ 완료 — A 트랙 (P0 시스템 인프라)

Expert review (`instructor_dashboard_final_diagnosis_report.md`) P0-1 ~ P0-7 모두 적용.
**모든 변경은 DB에 영구 저장됨** — 인증 복구 후 즉시 확인 가능.

### Phase 1-1 (P0-1): sourceRef nested 추출 정상화
- 파일: `src/lib/pipeline/satisfaction-applier.ts`
- 함수: `getSourceKeyFromSourceRef`, `getRunSourceKeys`
- 1-depth flat (ImportItem) + 2-depth nested (`source_refs[].source_ref.source_key`, Record) 모두 처리
- 검증: 28건 sheet record 모두 추출 (이전 0/28 → 28/28)
- Unit test: `scripts/unit-test-source-key-extraction.ts` (7 cases pass)
- npm script: `test:unit:source-key-extraction`

### Phase 1-2 (P0-4): Replace source_key 단위 scope
- 파일: `prisma/schema.prisma` — `SatisfactionImportItem`에 `sourceKey String?` 컬럼 + `@@index([sourceKey])` 추가
- DB ALTER TABLE 실행 완료 (279건 backfill, google_forms 259 + sheet_summary 20)
- 파일: `src/lib/pipeline/satisfaction-applier.ts` — deleteMany를 `(sourceType, sourceKey)` 단위로 scope
- 검증: woori narrow include 후 9개 source_key 모두 정확 보존 (이전엔 다른 시트도 삭제됐던 버그)

### Phase 2-2 (P0-2 + P0-3): 자동 매칭 정책 정정
- 파일: `src/lib/pipeline/satisfaction-sheets-normalizer.ts`
- `resolveInstructorByCourseAndDate`에 `shouldAutoAccept: boolean` 필드 추가
- 정책:
  - L0 expectedInstructors 단일 강사 → auto-accept
  - L0 expectedInstructors 다중 강사 → pending_review
  - L1 단일 강사 (일정 ⊇ 응답일자) → auto-accept
  - L1 다중 강사 → pending_review
  - L2 (일정 근접 ≤14일) → pending_review
  - L3 (회사+과정 substring) → pending_review
  - L4 (instructorHint/expectedInstructors fallback) → pending_review
- Fan-out 로직: shouldAutoAccept=false 시 `suggested_instructor_id` 비움 → applier가 pending으로 처리

### Phase 3 (P0-5): summary/history 동일 row set + 가중 평균
- 파일: `src/lib/fallback-snapshot.ts`
  - 이전 버그: `recent_satisfaction_history: []` 하드코딩 (23명 모두 빈 배열)
  - 수정: `satisfactionRecord.findMany()` 추가 + 강사별 history 생성 + 가중 평균 summary
- 파일: `src/app/api/instructors/[id]/route.ts`
  - `recentCanonicalSatisfactionRows` 에 respondentCount/sourceKey/resolutionLevel/registryKey 등 채움
  - `buildRecentSatisfactionHistory` 모든 record 1:1 노출 (dedupe 제거)
  - summary `avg` = `sum(score × respondentCount) / sum(respondentCount)` (가중 평균)
- 파일: `src/types/api.ts` — `RecentSatisfactionHistoryItem`에 score/respondent_count/source_type/source_key/resolution_level/resolution_basis/registry_key 필드 추가
- 검증: 김인섭 단순평균 4.54 → 가중평균 4.48 (3.8 점수 × 15명 응답 무게 정확 반영)

### Phase 4 (P0-6): 기본 refresh = full
- 파일: `src/app/api/refresh/route.ts`
- 기본 (scope=null/all): notion + fulltime + ops_notes + salesmap + **contract_sheet** + **instructor_dispatch_sheet** + slack + gmail + satisfaction + **postprocess**
- scope=lightweight 명시 시만 contract_sheet/dispatch 제외 (운영자 빠른 새로고침용)

### Phase 4 (P0-7): catalog sourceKind validation
- 파일: `src/lib/pipeline/satisfaction-sheets-collector.ts`
- `SatisfactionSheetSourceDefinition.sourceKind` 필드 추가:
  - `google_forms_response` / `survey_summary` → 수집 가능
  - `lecture_management_sheet` / `syncup_sheet` → 자동 차단
  - `unknown` → 수동 검토
- `isSatisfactionCompatibleSourceKind()` 헬퍼 export
- `collectSatisfactionSheets`가 disabled + sourceKind 비호환 자동 필터
- 파일: `data/satisfaction-sheet-catalog.json` — 4개 disabled entry 모두 `sourceKind: "lecture_management_sheet"` 추가

### Phase 1 ~ Phase 4 정직화 결과 (DB 영구 저장)

| 강사 | 이전 (가짜) | 현재 (정직) |
|---|---|---|
| 박상훈 | 4.57/3 | null/0 (동국 fan-out + 디어포스 substring 모두 pending) |
| 최진영B | 4.45/2 | null/0 |
| 정민수A | 4.48/1 | null/0 |
| 유종훈 | 4.83/3 | **5.0/2** (gmail 2건만 — 사용자 처음 의심 진실) |
| 김정수A | 4.74/2 | **5.0/1** |
| 공지연 | 4.57/3 | **4.8/1** |

- **335 pending_review registry** 적재됨 (데이터 보존, 운영자 검토 가능)
- **23명 broken history 빈배열** → 채워짐
- audit:teaching-history-anomalies: P1 회귀 0건 유지
- diagnose:fee-chip-v3: 98.33% 유지
- verify:satisfaction-coverage-all: 100% PASS

## ⏸️ 진행 중단 — B/C/D 트랙

### B 트랙 (Catalog 자동 발견) — 1차 완료
- 파일: `scripts/discover-satisfaction-sheets.ts`
- gmail 454 ImportItem에서 spreadsheet ID 4건 추출
- 결과: 신규 후보 2건 (나스미디어 비즈니스매너, 애드이피션시 교육만족도), unknown 2건
- 보고서: `reports/catalog-discovery.md` + `catalog-discovery-draft.json`
- **gmail collector raw_payload 파싱 약함** — 4/454는 너무 적음. C 트랙이 해결

### C 트랙 (gmail satisfaction 강화) — DB 인증 실패로 중단
- 목표: gmail-satisfaction-collector raw_payload 파싱 강화 (HTML 본문 + 첨부 분석)
- 추정 영향: 49명 (cutoff 안 1건만 강사 16명 + cutoff 밖 33명)
- 진행 상태: 0% (DB 인증 실패로 raw_payload 분석 불가)
- 자기 의심 체크리스트:
  - [ ] expert P0 권고 부합 — collector는 raw 수집 단계, P0-3 정책 (자동 매칭 제한)는 그대로 유지
  - [ ] 추측 금지 — 발견한 시트도 자동 catalog 등록 X. 보고서만
  - [ ] read-only — collector 변경은 raw_payload 보강만, 기존 데이터 손상 X

### D 트랙 (pending_review queue UI) — 미진행
- 목표: 운영자가 335 pending registry 검토하는 frontend 화면
- API 스펙 초안 필요:
  - `GET /api/satisfaction-review/pending?source=...&limit=...`
  - `POST /api/satisfaction-review/{registryId}/approve` / `/reject` / `/override`
- frontend: dashboard에 review queue 탭 추가

## 남은 TODO

### 즉시 (DB 복구 후)
- [ ] **C 트랙**: gmail collector raw_payload 파싱 강화 (HTML 본문 spreadsheet link 추출)
- [ ] **C 검증**: 49명 single-record 강사 회복 가능성 측정
- [ ] **B 보강**: gmail 강화 후 catalog discovery 재실행 (4건 → 더 많은 후보)

### 별도 작업 (큰 단위)
- [ ] **D 트랙**: pending_review queue UI (frontend)
  - API endpoint 신설
  - 검토 UI 컴포넌트
  - approve/reject/override decision 워크플로우
- [ ] **운영팀 인계**: catalog 신규 등록 (B 트랙 결과로 발견된 2건 + 향후 발견)
- [ ] **course-level satisfaction UI**: 다중강사 과정의 "참여 과정 만족도" 표시 패널 (박상훈/최진영B 등 강사별 평균 없는 강사 대안 표시)

### 미래 (P1/P2 expert review)
- [ ] CourseSession canonical table 도입 (P1-1)
- [ ] satisfactionLevel 분리 (P1-2)
- [ ] source_record_hash (P1-3)
- [ ] alias registry (P1-4)
- [ ] tombstone 상태 (P1-5)
- [ ] 대시보드 품질 표시 패널 (P2)

## 환경 이슈

- **Railway DB 인증 실패** (2026-05-11 16:00 KST 발견)
- 원인: 비밀번호 회전 또는 DB 인스턴스 재배포 의심
- 해결: 사용자가 Railway dashboard에서 새 DATABASE_URL 받아 `.env` 갱신 필요
- 사용자 instruction: GitHub repo (https://github.com/D1-B2B-AX/instructor_db) fork → .env 옮기고 그 폴더에서부터 시작

## 신설/수정 파일 요약

### 신설 파일
- `src/lib/xlsx-minimal-reader.ts` (이전 세션 작업)
- `scripts/audit-teaching-history-anomalies.ts`
- `scripts/audit-satisfaction-coverage.ts`
- `scripts/verify-park-sanghoon-e2e.ts`
- `scripts/verify-satisfaction-coverage-all.ts`
- `scripts/unit-test-generic-forms-parser.ts`
- `scripts/unit-test-xlsx-reader.ts`
- `scripts/unit-test-source-key-extraction.ts` ← Phase 1-1
- `scripts/snapshot-source-ref-patterns.ts` ← Phase 1-1
- `scripts/snapshot-pre-p0-policy-shift.ts` ← Phase 2-1
- `scripts/diagnose-instructor-satisfaction.ts`
- `scripts/diagnose-all-instructor-satisfaction-distribution.ts`
- `scripts/analyze-p2-p4-recovery.ts`
- `scripts/discover-satisfaction-sheets.ts` ← B 트랙
- `scripts/trigger-aggregates-recompute.ts`

### 수정 파일
- `prisma/schema.prisma` — `SatisfactionImportItem.sourceKey` 컬럼
- `src/lib/pipeline/satisfaction-applier.ts` — P0-1, P0-4
- `src/lib/pipeline/satisfaction-sheets-normalizer.ts` — P0-2, P0-3 (shouldAutoAccept)
- `src/lib/pipeline/satisfaction-sheets-collector.ts` — P0-7 (sourceKind)
- `src/lib/pipeline/contract-sheet-store.ts` — dealFee 누락 버그 수정
- `src/lib/score-recalculator.ts` — dealFee 누락 버그 수정
- `src/lib/fallback-snapshot.ts` — P0-5 (history 생성)
- `src/app/api/instructors/[id]/route.ts` — P0-5 (가중 평균 + 확장 history fields)
- `src/app/api/refresh/route.ts` — P0-6 (기본 = full)
- `src/app/api/pipeline/satisfaction/route.ts` — catalog JSON entry도 include 인식
- `src/types/api.ts` — RecentSatisfactionHistoryItem 필드 확장
- `next.config.ts` — turbopack.root 설정
- `data/satisfaction-sheet-catalog.json` — 동국제강 expectedInstructors + 4개 disabled entry sourceKind
- `package.json` — npm scripts 7개 추가

## 회귀 검증 (최종)

| 검증 | 결과 |
|---|---|
| audit:teaching-history-anomalies | P1 회귀 0건 |
| diagnose:fee-chip-v3 | 98.33% (회귀 0) |
| verify:satisfaction-coverage-all | PASS 100% (L2/L3=0) |
| verify:park-sanghoon-e2e | (정책 변경 후 5/5 PASS 기대) |
| unit-test:source-key-extraction | 7/7 PASS + DB 28/28 |
| unit-test:generic-forms-parser | ALL PASS |
| unit-test:xlsx-reader | OK |
