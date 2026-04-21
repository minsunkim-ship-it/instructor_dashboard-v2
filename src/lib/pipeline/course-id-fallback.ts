import fs from "node:fs";
import path from "node:path";

export interface CourseIdFallbackEntry {
  courseName: string;
  score: number;
  fileName: string | null;
  modifiedTime: string | null;
  reportPath: string;
  reason: string;
}

interface DrivePreviewTab {
  tab?: string | null;
  previewRows?: string[] | null;
}

interface DrivePreviewFile {
  name?: string | null;
  modifiedTime?: string | null;
  preview?: DrivePreviewTab[] | null;
}

interface DrivePreviewReport {
  files?: DrivePreviewFile[] | null;
}

interface DrivePreviewReportInput {
  path: string;
  report: DrivePreviewReport;
}

interface CourseNameCandidate {
  courseName: string;
  score: number;
  reason: string;
}

const REPORT_PREFIX = "drive-management-files-inspected-";
const REPORT_SUFFIX = ".json";

const globalForCourseIdFallback = globalThis as typeof globalThis & {
  __courseIdFallbackCache?:
    | {
        key: string;
        registry: Map<string, CourseIdFallbackEntry>;
      }
    | undefined;
};

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

export function sanitizeCourseNameCandidate(
  raw: string | null | undefined
): string | null {
  let cleaned = normalizeText(raw);
  if (!cleaned) return null;

  cleaned = cleaned.replace(/https?:\/\/\S+/gi, "").trim();
  cleaned = cleaned.replace(/^\d{4}(?:~\d{0,4})?[_\s-]+/, "");
  cleaned = cleaned.replace(
    /(?:[_\s-]+)?(?:싱크업 문서|강의관리 시트|강의관리시트|싱크업|복사용)(?:\.xlsx)?$/i,
    ""
  );
  cleaned = cleaned.replace(/(?:\.xlsx|\.xls|\.gsheet)$/i, "");
  cleaned = cleaned.replace(/\s*-\s*[^-]+ 강사님$/u, "");
  cleaned = cleaned.replace(/^[-_|:]+|[-_|:]+$/g, "").trim();

  if (!cleaned) return null;
  if (/^\d+(?:\.0+)?$/.test(cleaned)) return null;
  if (cleaned.length < 4) return null;
  if (/(?:^|\b)(?:TEMPLATE|NEW TEMPLATE)(?:\b|$)/i.test(cleaned)) return null;
  if (/(?:^|_)(?:기업명|과정명|교육시작월|교육종료월)(?:_|$)/.test(cleaned)) {
    return null;
  }
  if (
    [
      "FC DX기업교육팀 - 강의준비문서",
      "FC DX기업교육팀",
      "과정 관련 주요 링크",
      "과정 폴더",
      "백오피스",
      "제안서",
      "계약서",
      "LXP 강의장",
      "링크",
      "강의명",
      "과정명",
      "교육 과정명",
    ].includes(cleaned)
  ) {
    return null;
  }

  return cleaned;
}

function extractCourseIdsFromText(text: string | null | undefined): string[] {
  const ids = new Set<string>();
  const normalized = normalizeText(text);
  if (!normalized) return [];

  for (const regex of [
    /코스\s*ID\s*[:：]?\s*(\d{5,})/giu,
    /\/courses\/(\d{5,})\//giu,
  ]) {
    for (const match of normalized.matchAll(regex)) {
      const id = match[1]?.trim();
      if (id) ids.add(id);
    }
  }

  return Array.from(ids);
}

function splitPreviewRow(row: string): string[] {
  return row
    .split("|")
    .map((part) => normalizeText(part))
    .filter(Boolean);
}

function findNextRawValue(parts: string[], startIndex: number): string | null {
  for (let index = startIndex + 1; index < parts.length; index++) {
    const candidate = normalizeText(parts[index]);
    if (candidate) return candidate;
  }
  return null;
}

function findNextValue(parts: string[], startIndex: number): string | null {
  for (let index = startIndex + 1; index < parts.length; index++) {
    const candidate = sanitizeCourseNameCandidate(parts[index]);
    if (candidate) return candidate;
  }
  return null;
}

function extractCourseIdsFromPreviewRow(row: string): string[] {
  const ids = new Set<string>(extractCourseIdsFromText(row));
  const parts = splitPreviewRow(row);

  for (let index = 0; index < parts.length; index++) {
    if (parts[index] !== "백오피스") continue;
    const rawNextValue = findNextRawValue(parts, index);
    if (!rawNextValue) continue;
    for (const id of extractCourseIdsFromText(rawNextValue)) {
      ids.add(id);
    }
    const directMatch = rawNextValue.match(/^(\d{5,})(?:\.0+)?$/);
    if (directMatch?.[1]) {
      ids.add(directMatch[1]);
    }
  }

  return Array.from(ids);
}

function extractCourseNameCandidatesFromPreviewRow(row: string): CourseNameCandidate[] {
  const candidates: CourseNameCandidate[] = [];
  const parts = splitPreviewRow(row);

  for (let index = 0; index < parts.length; index++) {
    const label = parts[index];
    const nextValue = findNextValue(parts, index);
    if (!nextValue) continue;

    if (label === "과정명" || label === "교육 과정명") {
      candidates.push({
        courseName: nextValue,
        score: 100,
        reason: label,
      });
      continue;
    }

    if (label === "과정 폴더") {
      candidates.push({
        courseName: nextValue,
        score: 95,
        reason: label,
      });
      continue;
    }

    if (label === "강의명") {
      candidates.push({
        courseName: nextValue,
        score: 80,
        reason: label,
      });
    }
  }

  for (const [regex, score, reason] of [
    [/(?:교육\s*)?과정명\s*[:：]\s*(.+)$/iu, 100, "regex:course_name"],
    [/과정 폴더\s*[:：]\s*(.+)$/iu, 95, "regex:course_folder"],
    [/강의명\s*[:：]\s*(.+)$/iu, 80, "regex:lecture_name"],
  ] as const) {
    const match = normalizeText(row).match(regex);
    const courseName = sanitizeCourseNameCandidate(match?.[1]);
    if (!courseName) continue;
    candidates.push({ courseName, score, reason });
  }

  return candidates;
}

function extractCourseNameCandidatesFromFile(
  file: DrivePreviewFile
): CourseNameCandidate[] {
  const candidates: CourseNameCandidate[] = [];
  const fileNameCandidate = sanitizeCourseNameCandidate(file.name);
  if (fileNameCandidate) {
    candidates.push({
      courseName: fileNameCandidate,
      score: 60,
      reason: "file_name",
    });
  }

  for (const tab of file.preview ?? []) {
    for (const row of tab.previewRows ?? []) {
      candidates.push(...extractCourseNameCandidatesFromPreviewRow(row));
    }
  }

  return candidates;
}

function extractCourseIdsFromFile(file: DrivePreviewFile): string[] {
  const ids = new Set<string>();
  for (const id of extractCourseIdsFromText(file.name ?? null)) {
    ids.add(id);
  }
  for (const tab of file.preview ?? []) {
    for (const row of tab.previewRows ?? []) {
      for (const id of extractCourseIdsFromPreviewRow(row)) {
        ids.add(id);
      }
    }
  }
  return Array.from(ids);
}

function isBetterCandidate(
  next: CourseIdFallbackEntry,
  current: CourseIdFallbackEntry | undefined
): boolean {
  if (!current) return true;
  if (next.score !== current.score) return next.score > current.score;

  const nextTime = next.modifiedTime ? Date.parse(next.modifiedTime) : Number.NaN;
  const currentTime = current.modifiedTime
    ? Date.parse(current.modifiedTime)
    : Number.NaN;
  if (Number.isFinite(nextTime) && Number.isFinite(currentTime) && nextTime !== currentTime) {
    return nextTime > currentTime;
  }

  if (next.courseName.length !== current.courseName.length) {
    return next.courseName.length > current.courseName.length;
  }

  return next.reason < current.reason;
}

export function buildDriveCourseIdFallbackRegistryFromReports(
  inputs: DrivePreviewReportInput[]
): Map<string, CourseIdFallbackEntry> {
  const registry = new Map<string, CourseIdFallbackEntry>();

  for (const input of inputs) {
    for (const file of input.report.files ?? []) {
      const courseIds = extractCourseIdsFromFile(file);
      if (courseIds.length === 0) continue;

      const courseNames = extractCourseNameCandidatesFromFile(file);
      if (courseNames.length === 0) continue;

      for (const courseId of courseIds) {
        for (const candidate of courseNames) {
          const entry: CourseIdFallbackEntry = {
            courseName: candidate.courseName,
            score: candidate.score,
            fileName: normalizeText(file.name) || null,
            modifiedTime: normalizeText(file.modifiedTime) || null,
            reportPath: input.path,
            reason: candidate.reason,
          };

          if (isBetterCandidate(entry, registry.get(courseId))) {
            registry.set(courseId, entry);
          }
        }
      }
    }
  }

  return registry;
}

function loadDrivePreviewReports(): DrivePreviewReportInput[] {
  const reportsDir = path.join(process.cwd(), "reports");
  if (!fs.existsSync(reportsDir)) return [];

  return fs
    .readdirSync(reportsDir)
    .filter(
      (name) => name.startsWith(REPORT_PREFIX) && name.endsWith(REPORT_SUFFIX)
    )
    .sort()
    .map((name) => {
      const fullPath = path.join(reportsDir, name);
      try {
        const raw = fs.readFileSync(fullPath, "utf8");
        return {
          path: fullPath,
          report: JSON.parse(raw) as DrivePreviewReport,
        };
      } catch {
        return null;
      }
    })
    .filter((item): item is DrivePreviewReportInput => item !== null);
}

export function loadCourseIdFallbackRegistry(): Map<string, CourseIdFallbackEntry> {
  const reports = loadDrivePreviewReports();
  const cacheKey = reports
    .map((report) => {
      try {
        const stat = fs.statSync(report.path);
        return `${report.path}:${stat.mtimeMs}`;
      } catch {
        return report.path;
      }
    })
    .join("|");

  const cached = globalForCourseIdFallback.__courseIdFallbackCache;
  if (cached && cached.key === cacheKey) {
    return cached.registry;
  }

  const registry = buildDriveCourseIdFallbackRegistryFromReports(reports);
  globalForCourseIdFallback.__courseIdFallbackCache = {
    key: cacheKey,
    registry,
  };
  return registry;
}
