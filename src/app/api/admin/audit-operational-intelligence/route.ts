/**
 * GET /api/admin/audit-operational-intelligence?top=200&staleDays=14&onlySuspicious=0
 *
 * 강사별 운영 인텔리전스(OI) 신호 분포 진단 (read-only).
 *
 * 강사별 출력:
 *  - sourceCounts: raw_operational_notes의 source_type별 건수
 *      curated_ops, notion_comment, teaching_feedback_qualitative,
 *      teaching_feedback_ops, slack_highlight, other
 *  - notionSourceLinkPresent: Notion SourceLink 보유 여부
 *  - generatedAt, generatedBy, generationModel, promptVersion, evidenceHash
 *  - rawNoteCount, classifiedNoteCount, humanFollowupCount
 *  - behavioralIntelligence: filledFields[], fillRatio, data_richness, confidence
 *  - suspicions[]: empty | single_source | stale | rule_based_only
 *
 * 회사·affiliation 그룹 통계도 제공.
 *
 * ⚠ 만족도 가드레일: satisfactionImportItem / SatisfactionRecord 등은
 *   조회/카운트만 (sourceCounts 산출 input). 변경·정규화·매칭 로직 미터치.
 *
 * 인증: CRON_SECRET
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";
import { extractOperationalIntelligencePayload } from "@/lib/operational-intelligence";
import type {
  BehavioralIntelligence,
  RawOperationalNote,
} from "@/types/operational-intelligence";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const KNOWN_SOURCE_TYPES = [
  "curated_ops",
  "notion_comment",
  "teaching_feedback_qualitative",
  "teaching_feedback_ops",
  "slack_highlight",
  "gmail_activity",
] as const;

type KnownSourceType = (typeof KNOWN_SOURCE_TYPES)[number];

interface SourceCounts {
  curated_ops: number;
  notion_comment: number;
  teaching_feedback_qualitative: number;
  teaching_feedback_ops: number;
  slack_highlight: number;
  gmail_activity: number;
  other: number;
}

function emptySourceCounts(): SourceCounts {
  return {
    curated_ops: 0,
    notion_comment: 0,
    teaching_feedback_qualitative: 0,
    teaching_feedback_ops: 0,
    slack_highlight: 0,
    gmail_activity: 0,
    other: 0,
  };
}

function tallyBySource(rawNotes: RawOperationalNote[]): SourceCounts {
  const counts = emptySourceCounts();
  for (const note of rawNotes) {
    const st = note.source_type;
    if ((KNOWN_SOURCE_TYPES as readonly string[]).includes(st)) {
      counts[st as KnownSourceType] += 1;
    } else {
      counts.other += 1;
    }
  }
  return counts;
}

function distinctNonZeroSourceCount(counts: SourceCounts): number {
  return (
    (counts.curated_ops > 0 ? 1 : 0) +
    (counts.notion_comment > 0 ? 1 : 0) +
    (counts.teaching_feedback_qualitative > 0 ? 1 : 0) +
    (counts.teaching_feedback_ops > 0 ? 1 : 0) +
    (counts.slack_highlight > 0 ? 1 : 0) +
    (counts.gmail_activity > 0 ? 1 : 0) +
    (counts.other > 0 ? 1 : 0)
  );
}

interface BehavioralFill {
  filledFields: string[];
  fillRatio: number;
  totalFields: number;
}

function evaluateBehavioralFill(bi: BehavioralIntelligence): BehavioralFill {
  const checks: Array<[string, boolean]> = [
    ["top_summary", Boolean(bi.top_summary && bi.top_summary.trim().length > 0)],
    ["teaching_style", Boolean(bi.teaching_style && bi.teaching_style.trim().length > 0)],
    [
      "curriculum_compliance",
      Boolean(bi.curriculum_compliance && bi.curriculum_compliance.trim().length > 0),
    ],
    ["attitude", Boolean(bi.attitude && bi.attitude.trim().length > 0)],
    ["recommendation", Boolean(bi.recommendation && bi.recommendation.trim().length > 0)],
    [
      "key_question_for_humans",
      Boolean(
        bi.key_question_for_humans && bi.key_question_for_humans.trim().length > 0
      ),
    ],
    ["risk_patterns", bi.risk_patterns.length > 0],
    ["strength_patterns", bi.strength_patterns.length > 0],
  ];
  const filled = checks.filter(([, ok]) => ok).map(([name]) => name);
  return {
    filledFields: filled,
    fillRatio: filled.length / checks.length,
    totalFields: checks.length,
  };
}

export async function GET(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const top = parseInt(request.nextUrl.searchParams.get("top") ?? "200", 10);
  const staleDays = parseInt(request.nextUrl.searchParams.get("staleDays") ?? "14", 10);
  const onlySuspicious =
    request.nextUrl.searchParams.get("onlySuspicious") === "1";
  const affiliationFilter = request.nextUrl.searchParams.get("affiliation");

  const staleCutoff = new Date();
  staleCutoff.setDate(staleCutoff.getDate() - staleDays);

  const instructors = await prisma.instructor.findMany({
    where: affiliationFilter
      ? { affiliation: affiliationFilter }
      : undefined,
    orderBy: [{ satisfactionCount: "desc" }, { name: "asc" }],
    take: top,
    select: {
      id: true,
      name: true,
      affiliation: true,
      satisfactionCount: true,
      satisfactionAvg: true,
      score: true,
      memoRaw: true,
      instructorIntelligence: {
        select: {
          generatedAt: true,
          generatedBy: true,
          generationModel: true,
          promptVersion: true,
          evidenceHash: true,
          dataRichness: true,
          confidence: true,
          sourceSummary: true,
          recommendedFor: true,
          avoidFor: true,
          riskNotes: true,
          opsCheckNote: true,
        },
      },
      sourceLinks: {
        where: { sourceType: "notion" },
        select: { externalKey: true, matchStatus: true },
      },
    },
  });

  const perInstructor = instructors.map((inst) => {
    const oi = inst.instructorIntelligence;
    const payload = extractOperationalIntelligencePayload(
      oi?.sourceSummary ?? null
    );
    const rawNotes = payload.raw_operational_notes;
    const sourceCounts = tallyBySource(rawNotes);
    const distinctSources = distinctNonZeroSourceCount(sourceCounts);
    const bi = payload.behavioral_intelligence;
    const behavioralFill = evaluateBehavioralFill(bi);

    const notionLink = inst.sourceLinks.find(
      (s) => s.externalKey && s.externalKey.trim().length > 0
    );
    const notionLinkPresent = Boolean(notionLink);

    const suspicions: string[] = [];
    if (!oi || rawNotes.length === 0) suspicions.push("empty");
    if (rawNotes.length > 0 && distinctSources <= 1) suspicions.push("single_source");
    if (
      oi?.generatedAt &&
      new Date(oi.generatedAt).getTime() < staleCutoff.getTime()
    ) {
      suspicions.push("stale");
    }
    if (oi?.generatedBy === "rule_based") suspicions.push("rule_based_only");

    return {
      id: inst.id,
      name: inst.name,
      affiliation: inst.affiliation,
      satisfaction_count: inst.satisfactionCount,
      satisfaction_avg:
        inst.satisfactionAvg !== null ? Number(inst.satisfactionAvg) : null,
      score: inst.score !== null ? Number(inst.score) : null,
      memo_raw_length: inst.memoRaw?.length ?? 0,
      notion_source_link: notionLinkPresent
        ? {
            external_key: notionLink?.externalKey ?? null,
            match_status: notionLink?.matchStatus ?? null,
          }
        : null,
      oi_present: Boolean(oi),
      generated_at: oi?.generatedAt?.toISOString() ?? null,
      generated_by: oi?.generatedBy ?? null,
      generation_model: oi?.generationModel ?? null,
      prompt_version: oi?.promptVersion ?? null,
      evidence_hash: oi?.evidenceHash ?? null,
      data_richness: oi?.dataRichness ?? null,
      confidence: oi?.confidence ?? null,
      source_counts: sourceCounts,
      distinct_source_count: distinctSources,
      raw_note_count: rawNotes.length,
      classified_note_count: payload.classified_notes.length,
      human_followup_count: payload.human_followups.length,
      behavioral_intelligence: {
        filled_fields: behavioralFill.filledFields,
        fill_ratio: behavioralFill.fillRatio,
        total_fields: behavioralFill.totalFields,
        top_summary: bi.top_summary,
        teaching_style: bi.teaching_style,
        curriculum_compliance: bi.curriculum_compliance,
        attitude: bi.attitude,
        recommendation: bi.recommendation,
        risk_patterns: bi.risk_patterns,
        strength_patterns: bi.strength_patterns,
      },
      legacy_top_level: {
        recommended_for_count: oi?.recommendedFor?.length ?? 0,
        avoid_for_count: oi?.avoidFor?.length ?? 0,
        risk_notes_count: oi?.riskNotes?.length ?? 0,
        has_ops_check_note: Boolean(oi?.opsCheckNote),
      },
      suspicions,
    };
  });

  const filtered = onlySuspicious
    ? perInstructor.filter((p) => p.suspicions.length > 0)
    : perInstructor;

  const totals = {
    queried_instructors: instructors.length,
    with_oi: perInstructor.filter((p) => p.oi_present).length,
    empty: perInstructor.filter((p) => p.suspicions.includes("empty")).length,
    single_source: perInstructor.filter((p) =>
      p.suspicions.includes("single_source")
    ).length,
    stale: perInstructor.filter((p) => p.suspicions.includes("stale")).length,
    rule_based_only: perInstructor.filter((p) =>
      p.suspicions.includes("rule_based_only")
    ).length,
    notion_link_present: perInstructor.filter((p) => p.notion_source_link).length,
    notion_link_missing: perInstructor.filter((p) => !p.notion_source_link).length,
  };

  const byGeneratedBy: Record<string, number> = {};
  for (const p of perInstructor) {
    const key = p.generated_by ?? "<null>";
    byGeneratedBy[key] = (byGeneratedBy[key] ?? 0) + 1;
  }

  const byAffiliation: Record<string, { count: number; with_oi: number }> = {};
  for (const p of perInstructor) {
    const key = p.affiliation ?? "<없음>";
    if (!byAffiliation[key]) byAffiliation[key] = { count: 0, with_oi: 0 };
    byAffiliation[key].count += 1;
    if (p.oi_present) byAffiliation[key].with_oi += 1;
  }

  return NextResponse.json({
    ok: true,
    params: { top, staleDays, onlySuspicious, affiliationFilter },
    generated_at: new Date().toISOString(),
    totals,
    by_generated_by: byGeneratedBy,
    by_affiliation: byAffiliation,
    instructors: filtered,
  });
}
