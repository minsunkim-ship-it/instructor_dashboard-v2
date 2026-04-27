# Gmail Daily Coverage Diagnosis

Generated: 2026-04-24
Scope: 2025-10-24 to 2026-04-24

## Method

- Read-only daily audit only. No backfill or write path was executed as part of this diagnosis.
- For each day in the range, the audit collected Gmail threads with:
  - query = `from:day1company.co.kr after:YYYY/MM/DD before:YYYY/MM/DD+1`
  - checkpoint = `null`
- Each collected thread was normalized to `source_ref_key = gmail:{accountEmail}:{threadId}`.
- The audit then compared that key set against existing `activity_import_items` rows for `source_type = "gmail"`.
- A day was marked:
  - `ok` when every collected thread already existed in DB
  - `missing_in_db` when at least one collected thread was not present in DB
  - `empty` when Gmail returned 0 threads for that day

Artifacts:

- JSON: `reports/gmail-daily-coverage-2025-10-24_2026-04-24.json`
- TSV: `reports/gmail-daily-coverage-2025-10-24_2026-04-24.tsv`

## Overall Result

- Total days audited: 183
- Days with missing DB rows: 150
- Empty days: 5
- Fully covered days: 28
- Threads currently visible in Gmail for the range: 13,940
- Matching Gmail import rows already present in DB: 10,565
- Missing raw Gmail import rows: 3,375
- Raw import coverage gap: 24.2%

This is not a narrow edge-case failure. Coverage is incomplete across most of the six-month range.

## Segment Breakdown

### 2025-10-24 to 2025-12-31

- Collected: 4,882
- DB present: 4,673
- Missing: 209
- Missing rate: 4.3%
- Missing days: 47 / 69

Interpretation:

- Q4 2025 is mostly present.
- The failure mode here is light but persistent partial loss, usually a few rows per day.

### 2026-01-01 to 2026-02-29

- Collected: 2,863
- DB present: 478
- Missing: 2,385
- Missing rate: 83.3%
- Missing days: 56 / 59

Interpretation:

- January and February 2026 are the primary hole.
- This is not “minor drift”; most Gmail rows from this period were never imported into DB.

### 2026-03-01 to 2026-04-24

- Collected: 6,195
- DB present: 5,414
- Missing: 781
- Missing rate: 12.6%
- Missing days: 47 / 55

Interpretation:

- March and April are substantially better than January and February.
- Even so, many days still have residual missing rows.
- Recent days 2026-04-22 to 2026-04-24 are notably incomplete again.

## Monthly Breakdown

| Month | Collected | DB Present | Missing | Missing Days |
| --- | ---: | ---: | ---: | ---: |
| 2025-10 | 688 | 636 | 52 | 7 / 8 |
| 2025-11 | 2,352 | 2,239 | 113 | 24 / 30 |
| 2025-12 | 1,842 | 1,798 | 44 | 16 / 31 |
| 2026-01 | 1,317 | 264 | 1,053 | 30 / 31 |
| 2026-02 | 1,546 | 214 | 1,332 | 26 / 28 |
| 2026-03 | 3,551 | 3,098 | 453 | 30 / 31 |
| 2026-04 | 2,644 | 2,316 | 328 | 17 / 24 |

## Largest Missing Days

| Date | Missing | Collected | DB Present |
| --- | ---: | ---: | ---: |
| 2026-02-25 | 162 | 172 | 10 |
| 2026-02-24 | 154 | 161 | 7 |
| 2026-02-23 | 145 | 152 | 7 |
| 2026-02-20 | 104 | 117 | 13 |
| 2026-04-22 | 84 | 163 | 79 |
| 2026-02-26 | 83 | 148 | 65 |
| 2026-04-23 | 81 | 141 | 60 |
| 2026-01-21 | 76 | 84 | 8 |
| 2026-02-09 | 74 | 80 | 6 |
| 2026-01-20 | 72 | 87 | 15 |

## Representative Missing Samples

These samples prove the gap is not limited to obviously ignorable mail. Some missing rows are invalid/non-instructor candidates, but others are clearly legitimate instructor-related Gmail activity rows with `invalidReason = null`.

### 2026-02-25

- `[패스트캠퍼스] 유한킴벌리 - 교육 대상자 명단 공유 요청드립니다.` | `invalidReason = null`
- `[패스트캠퍼스] 김인섭 강사님께 - 기업교육 출강 문의드립니다. (콜마그룹 - AI 교육체계)` | `invalidReason = null`
- `[패스트캠퍼스] 박지현 실습코치님께 - KB 집합과정 계약 안내 드립니다` | `invalidReason = null`

### 2026-04-22

- `[패스트캠퍼스] 문양근 강사님께 - 윤리경영 관련 콘텐츠 원고 작성 문의드립니다` | `invalidReason = null`
- `[패스트캠퍼스] 김민호 책임님께 - 변호사 의뢰인 비밀유지권(ACP) 관련 콘텐츠 원고 작성 관련 문의드립니다` | `invalidReason = null`
- `초대장: AX 1:1 세션 중간 점검...` | `invalidReason = gmail_subject_not_instructor`

### 2026-04-24

- `[패스트캠퍼스] 권오서 강사님께 - 기업교육 출강 문의드립니다. (스타벅스/오프라인)` | `invalidReason = null`
- `[패스트캠퍼스] 디노랩스 김초희 강사님께 - 딥러닝 기초 : 핵심 원리와 기본 모델 커리큘럼 전달의 건` | `invalidReason = null`
- `Re: [LG전자] 5/14일 교육 진행 강사님 경력증명서 관련 문의` | `invalidReason = null`

## Root Cause Assessment

### Evidence

- `source_sync_logs` for `source_type = "gmail"` start only on 2026-04-16 and end on 2026-04-21 in the current DB snapshot.
- `activity_import_items` for `source_type = "gmail"` were created only between 2026-04-16 and 2026-04-21.
- During that 2026-04-16 to 2026-04-21 period, Gmail sync logs show repeated large backfill-style runs:
  - multiple `fetched_count ≈ 998`
  - later runs with `fetched_count = 2000`, `2000`, `4000`
  - several failures/timeouts and multiple partial outcomes with large `invalid_items` counts

### Inference

Most of the six-month corpus was not continuously ingested when the mail originally arrived. Instead, historical Gmail data appears to have been backfilled in bulk during 2026-04-16 through 2026-04-21, and that backfill was uneven.

The observed shape strongly suggests two distinct failure modes:

1. **Historical gap before bulk backfill**
   - January and February 2026 were never fully loaded into DB.
   - This explains the extreme missing rates in that segment.

2. **Partial/incomplete bulk backfill**
   - March and April have much better coverage, but still retain missing rows on many days.
   - The large run counts, partial statuses, and timeout records indicate the bulk ingestion process was not consistently complete.

## Important Caveat

This audit measures **raw Gmail import coverage**, not final instructor aggregate coverage.

That means a missing row in this report can be:

- a valid instructor-related Gmail activity row that should exist in `activity_import_items`, or
- a row that would ultimately be marked invalid/unmatched after normalization

Even with that caveat, the diagnosis is still actionable because:

- missing valid rows are definitely present in the samples, and
- the DB’s raw Gmail corpus is demonstrably incomplete for large parts of the range

## Diagnosis Conclusion

The current issue is real.

- It is **not** limited to a few dates.
- It is **not** explained only by invalid/non-instructor filtering.
- The most severe hole is **2026-01 through 2026-02**.
- A secondary but still meaningful partial-loss pattern remains across **2026-03 through 2026-04-24**.
- The evidence points to **incomplete historical backfill**, not merely a small ongoing incremental drift.

## Suggested Next Step

Do not run a blind six-month rewrite first.

Safer sequence:

1. Use this diagnosis to define a recovery plan by segment:
   - `2026-01-01` to `2026-02-29` as the primary bulk recovery target
   - `2026-03-01` to `2026-04-24` as the secondary cleanup target
2. Backfill those segments in smaller date windows.
3. Re-run the same read-only daily coverage audit after each recovery batch.
