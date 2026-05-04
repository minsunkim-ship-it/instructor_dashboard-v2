---
name: google-sheet-row-ops
description: Diagnose and recover Google Drive spreadsheet row ingestion issues in instructor_db. Use when a user says rows are missing, duplicated, stale, slow to reflect, or date parsing looks wrong in Google Sheets backed pipelines. Run the existing audit and repair scripts, classify whether the issue is missing ingestion, sync/update drift, duplicate identity, or non-date literals in date columns, and summarize the result for non-developers.
---

# Google Sheet Row Ops

Use this skill for row-level Google Drive sheet issues in `instructor_db`.

## What this skill does

1. Audit row coverage for:
   - `contract_sheet`
   - `instructor_dispatch_sheet`
2. Classify issues into:
   - `missing_in_db`
   - `date_mismatch`
   - `duplicate_in_db`
   - `not_applicable` undated literals
   - `summary_or_meta` undated rows
   - `context_dependent_date` shorthand dates
3. Run the smallest safe repair path:
   - duplicate canonicalization
   - contract sheet resync
4. Re-run the audit and report the new counts.

## Commands

Audit contract sheet rows:

```bash
npm run audit:sheet:daily-coverage -- --source=contract_sheet --start=YYYY-MM-DD --end=YYYY-MM-DD
```

Audit instructor dispatch rows:

```bash
npm run audit:sheet:daily-coverage -- --source=instructor_dispatch_sheet --start=YYYY-MM-DD --end=YYYY-MM-DD
```

Repair duplicate instructors and duplicate contract source rows:

```bash
npm run repair:duplicate-instructors -- --apply
```

Resync contract sheet rows after source changes:

```bash
npm run repair:contract-resync
```

## How to interpret results

- `rowsMissingInDb > 0`
  Source rows were collected but not persisted.
- `rowsDateMismatch > 0`
  Source text changed, but DB still has stale schedule data.
- `rowsDuplicateInDb > 0`
  Source identity or canonical instructor mapping produced duplicate DB rows.
- `rowsWithoutParsedDatesNotApplicable > 0`
  Values are not real dates and should not be treated as parser failures.
- `rowsWithoutParsedDatesSummaryOrMeta > 0`
  Rows are monthly summary or operational meta rows, not session rows.
- `rowsWithoutParsedDatesContextDependent > 0`
  Dates are shorthand and need contextual year inference.
- `rowsWithoutParsedDatesUnknown > 0`
  These are the true unresolved parsing cases that need code changes.

## Recovery order

1. Run the relevant audit.
2. If `rowsDuplicateInDb > 0`, run duplicate repair.
3. If `rowsDateMismatch > 0`, run contract resync.
4. Re-run the audit.
5. Only escalate to code changes when `rowsWithoutParsedDatesUnknown > 0` remains.

## Output contract

Always report:

- audited source
- date range
- current counts
- whether the problem is ingestion, sync, duplicate, or date-shape
- what repair command was run
- post-repair counts

Keep the wording accessible to non-developers. Avoid raw stack traces unless repair failed.
