/**
 * Gmail Activity Normalizer — Pilot 4-5 v1
 *
 * 04_data_pipeline.md 5-5절, 5-5-1절, 5-5-2절
 * 08_decision_log.md 2026-04-15 "Pilot 4-5 v1" 결정 항목
 *
 * 책임:
 * - Gmail collector 가 수집한 raw thread를 activity_import_items 형태로 정규화한다.
 * - Gmail count 규칙: thread 1개 = activity 1건 (5-5-2).
 * - candidate_name/email은 From 또는 To 헤더에서 추출하되, 메일박스 자신은 제외한다.
 * - match_status는 본 normalizer에서는 확정하지 않는다. applier가 instructors.name/email exact match를 수행한다.
 */

import type { RawGmailThread, GmailCollectResult } from "./gmail-activity-collector";

/**
 * Gmail 활동 1건(= thread 1개)의 정규화 결과.
 */
export interface NormalizedGmailActivity {
  sourceRef: {
    account_email: string;
    thread_id: string;
    message_id: string | null;
  };
  sourceRefKey: string;
  /**
   * raw_payload — full body dump 금지 (5-5-2). 검토 가능한 최소 메타만 저장한다.
   */
  rawPayload: {
    subject: string | null;
    snippet: string | null;
    from: string | null;
    to: string | null;
    account_email: string;
    target_addresses: string[];
  };
  candidateName: string | null;
  candidateEmail: string | null;
  activityAt: Date | null;
  /** 정규화 단계에서 detect한 invalid 사유 (applier가 match_status=invalid 로 기록). */
  invalidReason: string | null;
}

/**
 * `"이름" <email@example.com>` 형태의 메일 헤더를 { name, email } 로 분리한다.
 * name 이 비어 있으면 null, email 이 없으면 null.
 */
export function parseAddressHeader(
  raw: string | null | undefined
): { name: string | null; email: string | null } {
  if (!raw) return { name: null, email: null };
  const text = raw.trim();
  if (!text) return { name: null, email: null };

  // "Name" <email@x> 또는 Name <email@x> 패턴
  const angle = text.match(/^(.*?)\s*<([^>]+)>\s*$/);
  if (angle) {
    const namePart = angle[1].replace(/^"|"$/g, "").trim();
    const emailPart = angle[2].trim().toLowerCase();
    return {
      name: namePart ? namePart : null,
      email: emailPart ? emailPart : null,
    };
  }

  // email 단독
  const emailOnly = text.match(/^[^\s@]+@[^\s@]+$/);
  if (emailOnly) {
    return { name: null, email: text.toLowerCase() };
  }

  // name 단독 (드묾)
  return { name: text, email: null };
}

/**
 * Gmail `internalDate` (ms string) 를 Date 로 변환한다.
 */
function internalDateMsToDate(ms: string | null | undefined): Date | null {
  if (!ms) return null;
  const n = Number.parseInt(ms, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * authenticated account 자신인지 여부. email 비교는 case-insensitive.
 */
function isSelfEmail(email: string | null, accountEmail: string): boolean {
  if (!email) return false;
  const self = accountEmail.trim().toLowerCase();
  if (!self) return false;
  return email === self;
}

/**
 * 단일 thread 를 정규화한다.
 * - candidate 는 From 또는 To 중 authenticated account 자신이 아닌 첫 주소에서 추출한다.
 */
function normalizeThread(t: RawGmailThread): NormalizedGmailActivity {
  const fromParsed = parseAddressHeader(t.from);
  const toParsed = parseAddressHeader(t.to);

  let candidateName: string | null = null;
  let candidateEmail: string | null = null;
  let invalidReason: string | null = null;

  // From 이 authenticated account 자신이면 To 후보 사용 (outbound), 아니면 From 후보 사용 (inbound)
  if (isSelfEmail(fromParsed.email, t.accountEmail)) {
    candidateName = toParsed.name;
    candidateEmail = toParsed.email;
  } else {
    candidateName = fromParsed.name;
    candidateEmail = fromParsed.email;
  }

  // From/To 모두 없으면 invalid
  if (!fromParsed.email && !toParsed.email && !fromParsed.name && !toParsed.name) {
    invalidReason = "gmail_missing_addresses";
  }

  const activityAt = internalDateMsToDate(t.lastInternalDateMs);

  const sourceRef = {
    account_email: t.accountEmail,
    thread_id: t.threadId,
    message_id: t.firstMessageId,
  };

  const sourceRefKey = `gmail:${t.accountEmail}:${t.threadId}`;

  return {
    sourceRef,
    sourceRefKey,
    rawPayload: {
      subject: t.subject,
      snippet: t.snippet,
      from: t.from,
      to: t.to,
      account_email: t.accountEmail,
      target_addresses: t.matchedTargetAddresses,
    },
    candidateName,
    candidateEmail,
    activityAt,
    invalidReason,
  };
}

export function normalizeGmailCollect(
  collect: GmailCollectResult
): NormalizedGmailActivity[] {
  return collect.threads.map(normalizeThread);
}
