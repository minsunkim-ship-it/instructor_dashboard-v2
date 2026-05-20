/**
 * POST /api/admin/cleanup-memo-notion-body?mode=dry-run|apply&limit=N&offset=N
 *
 * Notion SourceLink 보유 강사 전수에 대해:
 *   1. 현재 Notion 페이지 본문(pageTitleLines + blockLines) 재 fetch
 *   2. 기존 memoRaw 라인 중 본문 라인과 일치하는 것 제거
 *   3. notionPageBodyRaw 컬럼에 fresh 본문 저장
 *   4. memoRaw는 본문 라인이 빠진 결과로 갱신
 *
 * dry-run: 변경 없이 영향 수량(per 강사)만 리턴.
 * apply: 위 작업 실제 적용.
 *
 * Best-effort: 현재 Notion 본문에 없는 (이미 사라진) 옛 본문 라인은 제거되지 않음.
 *   MemoSection의 방어 필터가 추가로 보호.
 *
 * 만족도 가드레일: satisfaction 영역 변경 없음. memoRaw / notionPageBodyRaw만 수정.
 *
 * 인증: CRON_SECRET
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";
import { collectNotionPageContentLines } from "@/lib/notion-enrichment";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function normalizeLineForCompare(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Notion API rate limit 회피용 강사간 throttle. 3 req/s 기준 약 350ms 권장. */
const PER_INSTRUCTOR_THROTTLE_MS = 400;

function splitLines(text: string | null | undefined): string[] {
  if (!text) return [];
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

interface InstructorCleanupResult {
  instructor_id: string;
  instructor_name: string;
  notion_page_id: string;
  before: {
    memo_line_count: number;
    page_body_present: boolean;
    page_body_line_count: number;
  };
  fetched: {
    notion_body_line_count: number;
    notion_comment_line_count: number;
  };
  after: {
    memo_line_count: number;
    page_body_line_count: number;
    removed_from_memo: number;
  };
  changed: boolean;
  error?: string;
}

export async function POST(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const mode = request.nextUrl.searchParams.get("mode") ?? "dry-run";
  const apply = mode === "apply";
  const limit = parseInt(
    request.nextUrl.searchParams.get("limit") ?? "30",
    10
  );
  const offset = parseInt(
    request.nextUrl.searchParams.get("offset") ?? "0",
    10
  );

  // 강사 목록 화면에 노출되는 강사만 cleanup (실습코치 제외).
  // shouldIncludeInInstructorList: flag !== '실습코치' AND isPracticeCoach !== true
  const visibleInstructorFilter: import("@prisma/client").Prisma.InstructorWhereInput =
    {
      AND: [
        { OR: [{ flag: null }, { flag: { not: "실습코치" } }] },
        { isPracticeCoach: false },
      ],
    };

  const totalCount = await prisma.instructor.count({
    where: {
      ...visibleInstructorFilter,
      sourceLinks: {
        some: { sourceType: "notion", externalKey: { not: null } },
      },
    },
  });

  const instructors = await prisma.instructor.findMany({
    where: {
      ...visibleInstructorFilter,
      sourceLinks: {
        some: { sourceType: "notion", externalKey: { not: null } },
      },
    },
    orderBy: { id: "asc" },
    skip: offset,
    take: limit,
    select: {
      id: true,
      name: true,
      memoRaw: true,
      notionPageBodyRaw: true,
      sourceLinks: {
        where: { sourceType: "notion" },
        select: { externalKey: true },
      },
    },
  });

  const results: InstructorCleanupResult[] = [];
  let totalRemoved = 0;
  let totalChanged = 0;
  let totalErrors = 0;

  for (let idx = 0; idx < instructors.length; idx += 1) {
    const inst = instructors[idx];
    // 첫 강사 제외 모든 강사 사이에 throttle (Notion 429 회피)
    if (idx > 0) {
      await sleep(PER_INSTRUCTOR_THROTTLE_MS);
    }
    const notionLink = inst.sourceLinks.find(
      (s) => s.externalKey && s.externalKey.trim().length > 0
    );
    if (!notionLink?.externalKey) continue;

    const initialMemoLines = splitLines(inst.memoRaw);
    const initialBodyLines = splitLines(inst.notionPageBodyRaw);

    try {
      const content = await collectNotionPageContentLines({
        notionPageId: notionLink.externalKey,
      });
      const bodyLines = [...content.pageTitleLines, ...content.blockLines];
      const commentLines = [
        ...content.pageCommentLines,
        ...content.blockCommentLines,
      ];

      const bodyNormalizedSet = new Set(
        bodyLines.map(normalizeLineForCompare).filter(Boolean)
      );

      const filteredMemoLines = initialMemoLines.filter(
        (line) => !bodyNormalizedSet.has(normalizeLineForCompare(line))
      );
      const removed = initialMemoLines.length - filteredMemoLines.length;

      const newMemo =
        filteredMemoLines.length > 0 ? filteredMemoLines.join("\n") : null;
      const newPageBody = bodyLines.length > 0 ? bodyLines.join("\n") : null;

      const memoChanged = newMemo !== inst.memoRaw;
      const bodyChanged = newPageBody !== inst.notionPageBodyRaw;
      const changed = memoChanged || bodyChanged;

      if (apply && changed) {
        await prisma.instructor.update({
          where: { id: inst.id },
          data: {
            ...(memoChanged ? { memoRaw: newMemo } : {}),
            ...(bodyChanged ? { notionPageBodyRaw: newPageBody } : {}),
          },
        });
      }

      results.push({
        instructor_id: inst.id,
        instructor_name: inst.name,
        notion_page_id: notionLink.externalKey,
        before: {
          memo_line_count: initialMemoLines.length,
          page_body_present: Boolean(inst.notionPageBodyRaw),
          page_body_line_count: initialBodyLines.length,
        },
        fetched: {
          notion_body_line_count: bodyLines.length,
          notion_comment_line_count: commentLines.length,
        },
        after: {
          memo_line_count: filteredMemoLines.length,
          page_body_line_count: bodyLines.length,
          removed_from_memo: removed,
        },
        changed,
      });
      if (changed) totalChanged += 1;
      totalRemoved += removed;
    } catch (error) {
      totalErrors += 1;
      results.push({
        instructor_id: inst.id,
        instructor_name: inst.name,
        notion_page_id: notionLink.externalKey,
        before: {
          memo_line_count: initialMemoLines.length,
          page_body_present: Boolean(inst.notionPageBodyRaw),
          page_body_line_count: initialBodyLines.length,
        },
        fetched: { notion_body_line_count: 0, notion_comment_line_count: 0 },
        after: {
          memo_line_count: initialMemoLines.length,
          page_body_line_count: initialBodyLines.length,
          removed_from_memo: 0,
        },
        changed: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const nextOffset = offset + results.length;
  return NextResponse.json({
    ok: true,
    mode: apply ? "apply" : "dry-run",
    generated_at: new Date().toISOString(),
    pagination: {
      total: totalCount,
      offset,
      limit,
      returned: results.length,
      next_offset: nextOffset < totalCount ? nextOffset : null,
      done: nextOffset >= totalCount,
    },
    summary: {
      processed: results.length,
      changed: totalChanged,
      lines_removed_from_memo: totalRemoved,
      errors: totalErrors,
    },
    results,
  });
}
