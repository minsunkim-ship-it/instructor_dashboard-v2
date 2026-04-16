import { prisma } from "@/lib/prisma";
import {
  exchangeGoogleUserAccessToken,
  googleApiGet,
} from "@/lib/google-user-oauth";
import type { SatisfactionImportItemInput } from "@/lib/pipeline/satisfaction-applier";
import type { SatisfactionGmailCollectResult, SatisfactionGmailThread } from "@/lib/pipeline/satisfaction-gmail-collector";
import type { SatisfactionSourceSummary } from "@/lib/pipeline/satisfaction-sheets-normalizer";

const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
const SHEETS_API_BASE = "https://sheets.googleapis.com/v4";
const driveResolutionCache = new Map<string, InstructorResolutionResult | null>();

interface InstructorLookupMaps {
  byName: Map<string, { id: string; name: string; contactEmail: string | null }>;
  byEmail: Map<string, { id: string; name: string; contactEmail: string | null }>;
}

interface ParsedMailbox {
  name: string | null;
  email: string | null;
}

interface DraftGmailSatisfactionEvent {
  sourceRefKey: string;
  sourceRef: Record<string, unknown>;
  rawPayload: Record<string, unknown>;
  normalizedPayload: Record<string, unknown>;
  candidateName?: string | null;
  candidateCompanyName?: string | null;
  candidateCourseName?: string | null;
  scoreRaw?: string | null;
  scoreNormalized?: number | null;
  respondentCount?: number | null;
  responseDate?: Date | string | null;
}

interface GmailInferenceContext {
  accountEmail: string;
  instructorHint: string | null;
  companyHint: string | null;
  suggestedInstructorId: string | null;
  resolutionBasis: string | null;
}

interface InstructorResolutionResult {
  instructorHint: string;
  suggestedInstructorId: string;
  resolutionBasis: string;
}

function cleanText(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/\r/g, "")
    .replace(/\*/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function encodeKeyPart(value: string | null | undefined): string {
  if (!value) return "";
  return encodeURIComponent(value.trim().toLowerCase());
}

function buildGmailRegistryKey(args: {
  sourceFamily: string;
  companyName?: string | null;
  courseName: string;
  sessionOrDate: string;
  instructorName?: string | null;
}): string {
  const instructorPart = args.instructorName ? `:${encodeKeyPart(args.instructorName)}` : ":";
  return [
    "satisfaction",
    encodeKeyPart(args.sourceFamily),
    encodeKeyPart(args.companyName ?? ""),
    encodeKeyPart(args.courseName),
    encodeKeyPart(args.sessionOrDate),
  ].join(":") + instructorPart;
}

function parseNumber(value: string | null | undefined): number | null {
  if (!value) return null;
  const normalized = value.replace(/,/g, "").trim();
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDateOnly(value: string | null | undefined): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  const fullDateMatch = trimmed.match(/(\d{4})[./-]\s*(\d{1,2})[./-]\s*(\d{1,2})/);
  if (fullDateMatch) {
    const [, year, month, day] = fullDateMatch;
    return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 0, 0, 0));
  }
  return null;
}

function parseMonthDayWithYear(
  value: string | null | undefined,
  fallbackYear: number
): Date | null {
  if (!value) return null;
  const match = value.match(/(\d{1,2})\s*\/\s*(\d{1,2})/);
  if (!match) return null;
  const [, month, day] = match;
  return new Date(Date.UTC(fallbackYear, Number(month) - 1, Number(day), 0, 0, 0));
}

function toDateOnlyString(value: Date | string | null | undefined): string | null {
  const date = value instanceof Date ? value : parseDateOnly(value ?? null);
  return date ? date.toISOString().slice(0, 10) : null;
}

function parseMailboxHeader(value: string | null | undefined): ParsedMailbox[] {
  const text = value ?? "";
  const results: ParsedMailbox[] = [];
  const matchedEmails = new Set<string>();
  const angleRegex = /"?([^"<]*)"?\s*<([^>]+)>/g;
  let match: RegExpExecArray | null;
  while ((match = angleRegex.exec(text)) !== null) {
    const name = match[1]?.trim() || null;
    const email = match[2]?.trim().toLowerCase() || null;
    if (email) matchedEmails.add(email);
    results.push({ name, email });
  }

  const emailRegex = /([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/gi;
  while ((match = emailRegex.exec(text)) !== null) {
    const email = match[1]?.trim().toLowerCase() || null;
    if (!email || matchedEmails.has(email)) continue;
    results.push({ name: null, email });
  }

  return results;
}

function parseInstructorHintFromSubject(subject: string | null | undefined): string | null {
  const cleaned = cleanText(subject)
    .replace(/^re:\s*/i, "")
    .replace(/^\[[^\]]+\]\s*/, "");
  const match = cleaned.match(/([^-]+?)\s*강사님께\s*-/);
  const hint = match?.[1]?.trim() ?? null;
  return hint ? hint.replace(/\s+/g, "") : null;
}

function parseCompanyHintFromSubject(subject: string | null | undefined): string | null {
  const cleaned = cleanText(subject);
  const bracketMatch = cleaned.match(/^\[[^/\]]+\/([^\]]+)\]/);
  if (bracketMatch?.[1]) return bracketMatch[1].trim();

  const bracketDashMatch = cleaned.match(/^\[[^\]]+\]\s*([^-\n]{2,30}?)\s*-/);
  if (bracketDashMatch?.[1] && !bracketDashMatch[1].includes("님께")) {
    return bracketDashMatch[1].trim();
  }

  const underscoreMatch = cleaned.match(/-\s*([^_]+)_/);
  if (underscoreMatch?.[1]) return underscoreMatch[1].trim();

  return null;
}

function parseCompanyHintFromCourseName(courseName: string | null | undefined): string | null {
  const cleaned = cleanText(courseName);
  if (!cleaned) return null;

  const dashMatch = cleaned.match(/^([^-\n]{2,30}?)\s*-\s*/);
  if (dashMatch?.[1]) return dashMatch[1].trim();

  const underscoreMatch = cleaned.match(/^([^_\n]{2,30}?)_/);
  if (underscoreMatch?.[1]) return underscoreMatch[1].trim();

  const prefixPatterns = [
    /^(JB금융지주)\b/,
    /^(CJ올리브네트웍스)\b/,
    /^(효성ITX)\b/i,
    /^(제일기획)\b/,
    /^(우리은행)\b/,
    /^(KB)\b/,
  ];
  for (const pattern of prefixPatterns) {
    const match = cleaned.match(pattern);
    if (match?.[1]) return match[1].trim();
  }

  return null;
}

function parseScoreFromText(text: string): number | null {
  for (const line of text.split("\n").map((row) => row.trim()).filter(Boolean)) {
    if (!line.includes("종합 평균 만족도") && !line.includes("전체 만족도")) {
      continue;
    }
    const numbers = Array.from(line.matchAll(/(\d+(?:\.\d+)?)/g))
      .map((match) => parseNumber(match[1]))
      .filter((value): value is number => value !== null);
    if (numbers.length > 0) {
      return numbers[numbers.length - 1];
    }
  }

  const fallbackPatterns = [
    /전체 만족도(?:는)?[^\d]*(\d+(?:\.\d+)?)/,
    /\[만족도\][^\d]*(\d+(?:\.\d+)?)/,
  ];
  for (const pattern of fallbackPatterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const parsed = parseNumber(match[1]);
      if (parsed !== null) return parsed;
    }
  }
  return null;
}

function parseRespondentCountFromText(text: string): number | null {
  const patterns = [
    /응답인원[^\d]*(\d+)명/,
    /응답 평균\s*\(n\s*=\s*(\d+)\)/i,
    /\(n\s*=\s*(\d+)\)[^\n]{0,80}종합 평균 만족도/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const parsed = parseNumber(match[1]);
      if (parsed !== null) return parsed;
    }
  }
  return 1;
}

function parseSingleCourseName(bodyText: string): string | null {
  const match = bodyText.match(/과정명\s*:\s*(.+)/);
  if (!match?.[1]) return null;
  return match[1].split("\n")[0]?.trim() ?? null;
}

function parseInstructorHintFromBody(bodyText: string | null | undefined): string | null {
  const cleaned = cleanText(bodyText);
  const match =
    cleaned.match(/담당\s*강사\s*:\s*([^\n]+)/i) ??
    cleaned.match(/담당\s*강사\s*:\s*([^\n]+)/i);
  const hint = match?.[1]?.trim().replace(/강사\s*$/i, "") ?? null;
  return hint ? hint.replace(/\s+/g, "") : null;
}

function tokenizeCourseName(courseName: string | null | undefined): string[] {
  const stopwords = new Set([
    "AI",
    "ai",
    "과정",
    "워크숍",
    "교육",
    "대상",
    "활용",
    "생성형",
    "금융",
    "실습",
    "원데이",
    "기반",
    "자동화",
    "리터러시",
    "리더십",
    "차수",
    "일차",
    "특강",
    "보고서",
  ]);
  return cleanText(courseName)
    .replace(/[()[\]_,/-]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !stopwords.has(token));
}

function normalizeDateOnly(value: Date | string | null | undefined): Date | null {
  if (value instanceof Date) return value;
  return parseDateOnly(value ?? null);
}

async function resolveInstructorFromTeachingHistory(args: {
  companyName: string | null;
  courseName: string | null;
  responseDate: Date | string | null | undefined;
  lookups: InstructorLookupMaps;
}): Promise<InstructorResolutionResult | null> {
  if (!args.companyName || !args.courseName) return null;
  const responseDate = normalizeDateOnly(args.responseDate);
  const tokens = tokenizeCourseName(args.courseName).slice(0, 5);

  const histories = await prisma.teachingHistory.findMany({
    where: {
      companyName: { equals: args.companyName, mode: "insensitive" },
      ...(responseDate
        ? {
            AND: [
              { OR: [{ startDate: { lte: responseDate } }, { startDate: null }] },
              { OR: [{ endDate: { gte: responseDate } }, { endDate: null }] },
            ],
          }
        : {}),
      ...(tokens.length > 0
        ? {
            OR: tokens.map((token) => ({
              courseName: { contains: token, mode: "insensitive" },
            })),
          }
        : {}),
    },
    select: {
      instructor: { select: { id: true, name: true } },
    },
    take: 20,
  });

  const candidates = new Map<string, { id: string; name: string }>();
  for (const history of histories) {
    const name = history.instructor?.name?.trim();
    const id = history.instructor?.id;
    if (!name || !id) continue;
    candidates.set(id, { id, name });
  }
  if (candidates.size !== 1) return null;
  const only = [...candidates.values()][0];
  return {
    instructorHint: only.name,
    suggestedInstructorId: only.id,
    resolutionBasis: "teaching_history_single_instructor",
  };
}

interface DriveFile {
  id: string;
  name?: string;
  mimeType?: string;
}

async function resolveInstructorFromDriveSheet(args: {
  companyName: string | null;
  courseName: string | null;
  lookups: InstructorLookupMaps;
  accessToken: string;
}): Promise<InstructorResolutionResult | null> {
  if (!args.companyName || !args.courseName) return null;
  const cacheKey = `${args.companyName}::${args.courseName}`;
  if (driveResolutionCache.has(cacheKey)) {
    return driveResolutionCache.get(cacheKey) ?? null;
  }

  const courseTokens = tokenizeCourseName(args.courseName).slice(0, 4);
  const queryParts = [
    `fullText contains "${args.companyName.replace(/"/g, '\\"')}"`,
    `(name contains "강의관리" or name contains "싱크업")`,
  ];
  if (courseTokens[0]) {
    queryParts.splice(1, 0, `fullText contains "${courseTokens[0].replace(/"/g, '\\"')}"`);
  }
  let data: { files?: DriveFile[] };
  try {
    data = await googleApiGet<{ files?: DriveFile[] }>(args.accessToken, DRIVE_API_BASE, "/files", {
      q: `${queryParts.join(" and ")} and trashed=false`,
      pageSize: "3",
      fields: "files(id,name,mimeType)",
      corpora: "allDrives",
      includeItemsFromAllDrives: "true",
      supportsAllDrives: "true",
    });
  } catch {
    driveResolutionCache.set(cacheKey, null);
    return null;
  }

  const files = (data.files ?? []).filter(
    (file) => file.mimeType === "application/vnd.google-apps.spreadsheet"
  );
  if (files.length === 0) {
    driveResolutionCache.set(cacheKey, null);
    return null;
  }

  const instructorNames = [...args.lookups.byName.keys()];
  const matches = new Map<string, { id: string; name: string }>();

  for (const file of files.slice(0, 2)) {
    for (const name of instructorNames) {
      if (file.name?.includes(name)) {
        const instructor = args.lookups.byName.get(name);
        if (instructor) {
          matches.set(instructor.id, { id: instructor.id, name: instructor.name });
        }
      }
    }

    let meta: { sheets?: Array<{ properties?: { title?: string } }> };
    try {
      meta = await googleApiGet<{
        sheets?: Array<{ properties?: { title?: string } }>;
      }>(args.accessToken, SHEETS_API_BASE, `/spreadsheets/${file.id}`, {
        fields: "sheets.properties.title",
      });
    } catch {
      continue;
    }
    const tabs = (meta.sheets ?? [])
      .map((sheet) => sheet.properties?.title)
      .filter((title): title is string => Boolean(title))
      .filter((title) =>
        ["강의관리", "과정 정리", "교육 개요", "운영", "캘린더"].some((keyword) =>
          title.includes(keyword)
        )
      )
      .slice(0, 3);

    for (const tab of tabs) {
      let values: { values?: string[][] };
      try {
        values = await googleApiGet<{ values?: string[][] }>(
          args.accessToken,
          SHEETS_API_BASE,
          `/spreadsheets/${file.id}/values/${encodeURIComponent(`${tab}!A1:Z40`)}`
        );
      } catch {
        continue;
      }
      const rows = values.values ?? [];
      const joinedRows = rows.map((row) => row.join(" | "));
      for (let index = 0; index < joinedRows.length; index += 1) {
        const rowText = joinedRows[index];
        const tokenHits = courseTokens.filter((token) => rowText.includes(token));
        if (
          !rowText.includes(args.companyName) &&
          tokenHits.length < Math.min(2, Math.max(1, courseTokens.length))
        ) {
          continue;
        }

        const windowStart = Math.max(0, index - 6);
        const windowEnd = Math.min(joinedRows.length, index + 7);
        const windowText = joinedRows.slice(windowStart, windowEnd).join("\n");

        for (const name of instructorNames) {
          if (!windowText.includes(name)) continue;
          const instructor = args.lookups.byName.get(name);
          if (!instructor) continue;
          matches.set(instructor.id, { id: instructor.id, name: instructor.name });
        }
      }
    }
  }

  if (matches.size !== 1) {
    driveResolutionCache.set(cacheKey, null);
    return null;
  }
  const only = [...matches.values()][0];
  const resolved = {
    instructorHint: only.name,
    suggestedInstructorId: only.id,
    resolutionBasis: "drive_sheet_single_instructor",
  };
  driveResolutionCache.set(cacheKey, resolved);
  return resolved;
}

async function resolveSuggestedInstructorFallback(args: {
  sourceType: string;
  registryKey: string | null;
  companyName: string | null;
  courseName: string | null;
  responseDate: Date | string | null | undefined;
  lookups: InstructorLookupMaps;
  accessToken: string;
}): Promise<InstructorResolutionResult | null> {
  if (args.companyName && args.courseName) {
    const sameCourse = await prisma.satisfactionReviewRegistry.findMany({
      where: {
        sourceType: args.sourceType,
        matchStatus: { in: ["auto_accepted", "approved"] },
        companyName: args.companyName,
        courseName: args.courseName,
        resolvedInstructorId: { not: null },
      },
      select: {
        resolvedInstructorId: true,
        resolvedInstructor: { select: { name: true } },
      },
      take: 5,
    });
    const distinct = new Map<string, string>();
    for (const row of sameCourse) {
      if (!row.resolvedInstructorId || !row.resolvedInstructor?.name) continue;
      distinct.set(row.resolvedInstructorId, row.resolvedInstructor.name);
    }
    if (distinct.size === 1) {
      const [suggestedInstructorId, instructorHint] = [...distinct.entries()][0];
      return {
        instructorHint,
        suggestedInstructorId,
        resolutionBasis: "existing_course_single_instructor",
      };
    }
  }

  if (args.registryKey) {
    const existing = await prisma.satisfactionReviewRegistry.findMany({
      where: {
        sourceType: args.sourceType,
        matchStatus: { in: ["auto_accepted", "approved"] },
        registryKey: { startsWith: args.registryKey },
        resolvedInstructorId: { not: null },
      },
      select: {
        resolvedInstructorId: true,
        resolvedInstructor: { select: { name: true } },
      },
      take: 5,
    });
    const distinct = new Map<string, string>();
    for (const row of existing) {
      if (!row.resolvedInstructorId || !row.resolvedInstructor?.name) continue;
      distinct.set(row.resolvedInstructorId, row.resolvedInstructor.name);
    }
    if (distinct.size === 1) {
      const [suggestedInstructorId, instructorHint] = [...distinct.entries()][0];
      return {
        instructorHint,
        suggestedInstructorId,
        resolutionBasis: "existing_registry_single_instructor",
      };
    }
  }
  const byTeachingHistory = await resolveInstructorFromTeachingHistory(args);
  if (byTeachingHistory) return byTeachingHistory;
  return resolveInstructorFromDriveSheet(args);
}

function parseSessionLabel(text: string): string | null {
  const match = text.match(/(\d+(?:일차|차수))/);
  return match?.[1] ?? null;
}

function buildEventKey(args: {
  courseName: string;
  sessionLabel?: string | null;
  responseDate?: Date | string | null;
  score: number;
  respondentCount: number;
  companyName?: string | null;
}): string {
  return [
    "gmail_event",
    encodeKeyPart(args.companyName ?? ""),
    encodeKeyPart(args.courseName),
    encodeKeyPart(args.sessionLabel ?? ""),
    encodeKeyPart(toDateOnlyString(args.responseDate) ?? ""),
    encodeKeyPart(String(args.score)),
    encodeKeyPart(String(args.respondentCount)),
  ].join(":");
}

function parseResponseDateFromBody(bodyText: string, sentAt: string | null): Date | null {
  const fromCourseDate = parseDateOnly(
    bodyText.match(/과정일시\s*:\s*([0-9.\-/ ]+\([^)]+\)?)/)?.[1] ??
      bodyText.match(/과정일시\s*:\s*([0-9.\-/ ]+)/)?.[1] ??
      null
  );
  if (fromCourseDate) return fromCourseDate;

  const sentDate = sentAt ? new Date(sentAt) : null;
  return sentDate && !Number.isNaN(sentDate.getTime()) ? sentDate : null;
}

function extractSectionEvents(
  thread: SatisfactionGmailThread,
  context: GmailInferenceContext
): DraftGmailSatisfactionEvent[] {
  const bodyText = cleanText(thread.bodyText);
  const sentDate = thread.sentAt ? new Date(thread.sentAt) : null;
  const sentYear =
    sentDate && !Number.isNaN(sentDate.getTime()) ? sentDate.getUTCFullYear() : new Date().getUTCFullYear();
  const headerRegex = /(?:^|\n)\s*\d+\.\s*([^\n]+?)\s+결과\s*\((\d{1,2}\s*\/\s*\d{1,2})\)/g;
  const matches = Array.from(bodyText.matchAll(headerRegex));
  if (matches.length === 0) {
    return [];
  }

  const items: DraftGmailSatisfactionEvent[] = [];
  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index];
    const next = matches[index + 1];
    const sectionTitle = cleanText(current[1]);
    const sectionDateToken = current[2];
    const sectionStart = current.index ?? 0;
    const sectionEnd = next?.index ?? bodyText.length;
    const sectionText = bodyText.slice(sectionStart, sectionEnd).trim();

    const score = parseScoreFromText(sectionText);
    if (score === null) continue;

    const respondentCount = parseRespondentCountFromText(sectionText) ?? 1;
    const responseDate =
      parseMonthDayWithYear(sectionDateToken, sentYear) ??
      parseResponseDateFromBody(sectionText, thread.sentAt);
    const sessionLabel = parseSessionLabel(sectionTitle);
    const courseName =
      sectionTitle.replace(/\s+\d+(?:일차|차수)\s*$/, "").trim() || sectionTitle;
    const companyName = context.companyHint ?? parseCompanyHintFromCourseName(courseName);
    const registryKey = buildGmailRegistryKey({
      sourceFamily: "gmail_satisfaction",
      companyName,
      courseName,
      sessionOrDate: sessionLabel ?? toDateOnlyString(responseDate) ?? `thread:${thread.threadId}:${index + 1}`,
    });
    const eventKey = buildEventKey({
      companyName,
      courseName,
      sessionLabel,
      responseDate,
      score,
      respondentCount,
    });

    items.push({
      sourceRefKey: `gmail_satisfaction:${thread.threadId}:${index + 1}`,
      sourceRef: {
        account_email: context.accountEmail,
        thread_id: thread.threadId,
        message_id: thread.messageId,
        section_index: index + 1,
      },
      rawPayload: {
        subject: thread.subject,
        from: thread.from,
        to: thread.to,
        cc: thread.cc,
        sent_at: thread.sentAt,
        section_title: sectionTitle,
        body_excerpt: sectionText.slice(0, 1200),
      },
      normalizedPayload: {
        registry_key: registryKey,
        company_name: companyName,
        company_name_for_key: companyName ?? "",
        course_name: courseName,
        event_key: eventKey,
        session_label: sessionLabel,
        response_date: toDateOnlyString(responseDate),
        instructor_name: context.instructorHint,
        respondent_count: respondentCount,
        source_family: "gmail_satisfaction",
        ...(context.suggestedInstructorId
          ? {
              suggested_instructor_id: context.suggestedInstructorId,
              resolution_basis: context.resolutionBasis ?? "gmail_subject_or_email_exact",
            }
          : {}),
      },
      candidateName: context.instructorHint,
      candidateCompanyName: companyName,
      candidateCourseName: courseName,
      scoreRaw: String(score),
      scoreNormalized: score,
      respondentCount,
      responseDate,
    });
  }

  return items;
}

function extractSingleEvent(
  thread: SatisfactionGmailThread,
  context: GmailInferenceContext
): DraftGmailSatisfactionEvent | null {
  const bodyText = cleanText(thread.bodyText);
  const courseName = parseSingleCourseName(bodyText);
  const score = parseScoreFromText(bodyText);
  if (!courseName || score === null) {
    return null;
  }

  const responseDate = parseResponseDateFromBody(bodyText, thread.sentAt);
  const sessionLabel =
    parseSessionLabel(bodyText) ??
    parseSessionLabel(cleanText(thread.subject)) ??
    null;
  const respondentCount = parseRespondentCountFromText(bodyText) ?? 1;
  const companyName = context.companyHint ?? parseCompanyHintFromCourseName(courseName);
  const registryKey = buildGmailRegistryKey({
    sourceFamily: "gmail_satisfaction",
    companyName,
    courseName,
    sessionOrDate: sessionLabel ?? toDateOnlyString(responseDate) ?? `thread:${thread.threadId}`,
  });
  const eventKey = buildEventKey({
    companyName,
    courseName,
    sessionLabel,
    responseDate,
    score,
    respondentCount,
  });

  return {
    sourceRefKey: `gmail_satisfaction:${thread.threadId}:1`,
    sourceRef: {
      account_email: context.accountEmail,
      thread_id: thread.threadId,
      message_id: thread.messageId,
      section_index: 1,
    },
    rawPayload: {
      subject: thread.subject,
      from: thread.from,
      to: thread.to,
      cc: thread.cc,
      sent_at: thread.sentAt,
      body_excerpt: bodyText.slice(0, 1200),
    },
    normalizedPayload: {
      registry_key: registryKey,
      company_name: companyName,
      company_name_for_key: companyName ?? "",
      course_name: courseName,
      event_key: eventKey,
      session_label: sessionLabel,
      response_date: toDateOnlyString(responseDate),
      instructor_name: context.instructorHint,
      respondent_count: respondentCount,
      source_family: "gmail_satisfaction",
      ...(context.suggestedInstructorId
        ? {
            suggested_instructor_id: context.suggestedInstructorId,
            resolution_basis: context.resolutionBasis ?? "gmail_subject_or_email_exact",
          }
        : {}),
    },
    candidateName: context.instructorHint,
    candidateCompanyName: companyName,
    candidateCourseName: courseName,
    scoreRaw: String(score),
    scoreNormalized: score,
    respondentCount,
    responseDate,
  };
}

async function loadInstructorMaps(): Promise<InstructorLookupMaps> {
  const instructors = await prisma.instructor.findMany({
    select: { id: true, name: true, contactEmail: true },
  });

  const byName = new Map<string, { id: string; name: string; contactEmail: string | null }>();
  const byEmail = new Map<string, { id: string; name: string; contactEmail: string | null }>();

  for (const instructor of instructors) {
    if (instructor.name) {
      byName.set(instructor.name.trim(), instructor);
    }
    if (instructor.contactEmail) {
      byEmail.set(instructor.contactEmail.trim().toLowerCase(), instructor);
    }
  }

  return { byName, byEmail };
}

function resolveSuggestedInstructor(
  thread: SatisfactionGmailThread,
  lookups: InstructorLookupMaps
): {
  instructorHint: string | null;
  suggestedInstructorId: string | null;
  resolutionBasis: string | null;
} {
  const instructorHint = parseInstructorHintFromSubject(thread.subject ?? null);
  if (instructorHint) {
    const exactByName =
      lookups.byName.get(instructorHint) ??
      lookups.byName.get(instructorHint.replace(/\s+/g, ""));
    if (exactByName) {
      return {
        instructorHint,
        suggestedInstructorId: exactByName.id,
        resolutionBasis: "name_exact",
      };
    }
  }

  const bodyInstructorHint = parseInstructorHintFromBody(thread.bodyText);
  if (bodyInstructorHint) {
    const exactByName =
      lookups.byName.get(bodyInstructorHint) ??
      lookups.byName.get(bodyInstructorHint.replace(/\s+/g, ""));
    if (exactByName) {
      return {
        instructorHint: bodyInstructorHint,
        suggestedInstructorId: exactByName.id,
        resolutionBasis: "body_instructor_exact",
      };
    }
  }

  const fromMailbox = parseMailboxHeader(thread.from)[0] ?? null;
  if (fromMailbox?.email) {
    const exactByEmail = lookups.byEmail.get(fromMailbox.email);
    if (exactByEmail) {
      return {
        instructorHint: fromMailbox.name?.replace(/\s+/g, "") ?? exactByEmail.name,
        suggestedInstructorId: exactByEmail.id,
        resolutionBasis: "from_email_exact",
      };
    }
  }

  const mailboxNames = [
    ...parseMailboxHeader(thread.from),
    ...parseMailboxHeader(thread.to),
    ...parseMailboxHeader(thread.cc),
  ]
    .map((mailbox) => mailbox.name?.replace(/\s+/g, "") ?? null)
    .filter((name): name is string => Boolean(name));

  for (const name of mailboxNames) {
    const exactByName = lookups.byName.get(name);
    if (exactByName) {
      return {
        instructorHint: name,
        suggestedInstructorId: exactByName.id,
        resolutionBasis: "mailbox_name_exact",
      };
    }
  }

  const recipientEmails = [
    ...parseMailboxHeader(thread.to),
    ...parseMailboxHeader(thread.cc),
  ]
    .map((mailbox) => mailbox.email)
    .filter((email): email is string => Boolean(email));

  for (const email of recipientEmails) {
    const exactByEmail = lookups.byEmail.get(email);
    if (exactByEmail) {
      return {
        instructorHint: instructorHint ?? exactByEmail.name,
        suggestedInstructorId: exactByEmail.id,
        resolutionBasis: "email_exact",
      };
    }
  }

  return {
    instructorHint,
    suggestedInstructorId: null,
    resolutionBasis: null,
  };
}

export async function normalizeSatisfactionGmailResults(
  result: SatisfactionGmailCollectResult
): Promise<{
  items: SatisfactionImportItemInput[];
  sourceSummary: SatisfactionSourceSummary;
}> {
  const lookups = await loadInstructorMaps();
  const accessToken = await exchangeGoogleUserAccessToken();
  const items: SatisfactionImportItemInput[] = [];
  let skippedThreads = 0;
  let autoAcceptedCandidates = 0;
  let pendingCandidates = 0;

  for (const thread of result.threads) {
    const companyHint = parseCompanyHintFromSubject(thread.subject);
    const { instructorHint, suggestedInstructorId, resolutionBasis } = resolveSuggestedInstructor(
      thread,
      lookups
    );
    const context: GmailInferenceContext = {
      accountEmail: result.accountEmail,
      instructorHint,
      companyHint,
      suggestedInstructorId,
      resolutionBasis,
    };

    const multiSectionItems = extractSectionEvents(thread, context);
    const draftItems =
      multiSectionItems.length > 0
        ? multiSectionItems
        : (() => {
            const single = extractSingleEvent(thread, context);
            return single ? [single] : [];
          })();

    if (draftItems.length === 0) {
      skippedThreads += 1;
      continue;
    }

    for (const item of draftItems) {
      const normalizedPayload = item.normalizedPayload as Record<string, unknown>;
      if (!item.candidateCompanyName && item.candidateCourseName) {
        const inferredCompanyName = parseCompanyHintFromCourseName(item.candidateCourseName);
        if (inferredCompanyName) {
          item.candidateCompanyName = inferredCompanyName;
          normalizedPayload.company_name = inferredCompanyName;
          normalizedPayload.company_name_for_key = inferredCompanyName;

          const sourceFamily =
            typeof normalizedPayload.source_family === "string"
              ? normalizedPayload.source_family
              : "gmail_satisfaction";
          const sessionLabel =
            typeof normalizedPayload.session_label === "string"
              ? normalizedPayload.session_label
              : null;
          const responseDate =
            typeof normalizedPayload.response_date === "string"
              ? normalizedPayload.response_date
              : null;
          const instructorName =
            typeof normalizedPayload.instructor_name === "string"
              ? normalizedPayload.instructor_name
              : null;
          const respondentCount =
            typeof normalizedPayload.respondent_count === "number"
              ? normalizedPayload.respondent_count
              : item.respondentCount ?? 1;
          const registrySessionOrDate =
            sessionLabel ??
            responseDate ??
            `thread:${String((item.sourceRef as Record<string, unknown>).thread_id ?? "")}`;
          normalizedPayload.registry_key = buildGmailRegistryKey({
            sourceFamily,
            companyName: inferredCompanyName,
            courseName: item.candidateCourseName,
            sessionOrDate: registrySessionOrDate,
            instructorName,
          });
          if (item.scoreNormalized !== null && item.scoreNormalized !== undefined) {
            normalizedPayload.event_key = buildEventKey({
              companyName: inferredCompanyName,
              courseName: item.candidateCourseName,
              sessionLabel,
              responseDate,
              score: item.scoreNormalized,
              respondentCount,
            });
          }
        }
      }
      if (
        (!normalizedPayload.suggested_instructor_id ||
          typeof normalizedPayload.suggested_instructor_id !== "string") &&
        item.candidateCourseName
      ) {
        const fallback = await resolveSuggestedInstructorFallback({
          sourceType: "gmail_summary",
          registryKey:
            typeof normalizedPayload.registry_key === "string"
              ? normalizedPayload.registry_key
              : null,
          companyName: item.candidateCompanyName ?? null,
          courseName: item.candidateCourseName ?? null,
          responseDate: item.responseDate ?? null,
          lookups,
          accessToken,
        });
        if (fallback) {
          item.candidateName = fallback.instructorHint;
          normalizedPayload.instructor_name = fallback.instructorHint;
          normalizedPayload.suggested_instructor_id = fallback.suggestedInstructorId;
          normalizedPayload.resolution_basis = fallback.resolutionBasis;
        }
      }
      if (
        typeof normalizedPayload.suggested_instructor_id === "string" &&
        normalizedPayload.suggested_instructor_id.length > 0
      ) {
        autoAcceptedCandidates += 1;
      } else {
        pendingCandidates += 1;
      }
      items.push({
        sourceType: "gmail_summary",
        sourceRefKey: item.sourceRefKey,
        sourceRef: item.sourceRef,
        rawPayload: item.rawPayload,
        normalizedPayload: item.normalizedPayload,
        candidateName: item.candidateName ?? null,
        candidateCompanyName: item.candidateCompanyName ?? null,
        candidateCourseName: item.candidateCourseName ?? null,
        scoreRaw: item.scoreRaw ?? null,
        scoreNormalized: item.scoreNormalized ?? null,
        respondentCount: item.respondentCount ?? null,
        responseDate: item.responseDate ?? null,
      });
    }
  }

  const sourceSummary: SatisfactionSourceSummary = {
    sourceKey: result.sourceKey,
    sourceType: "gmail_summary",
    fetchedRows: result.threads.length,
    importedItems: items.length,
    skippedRows: skippedThreads,
    autoAcceptedCandidates,
    pendingCandidates,
    status: items.length === 0 ? "skipped" : skippedThreads > 0 ? "partial" : "success",
    note:
      items.length === 0
        ? "만족도 점수/과정 정보를 추출할 수 있는 Gmail thread가 없어 skip"
        : skippedThreads > 0
          ? `${skippedThreads}개 thread는 만족도 이벤트 추출 실패로 skip`
          : undefined,
  };

  return { items, sourceSummary };
}
