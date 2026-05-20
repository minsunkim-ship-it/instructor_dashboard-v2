/**
 * POST /api/admin/regenerate-operational-intelligence
 *   body: { ids?: string[], top?: number, names?: string[] }
 *   - ids: 특정 instructor id 목록
 *   - names: 특정 강사명 목록 → DB lookup으로 id 변환
 *   - top: list endpoint와 동일 기준 (실습코치 제외, score desc) 상위 N명
 *   - 둘 다 없으면 top=100 기본
 *
 * generateOperationalIntelligence를 해당 강사 ids에 대해 호출.
 * Step 3 (rule_based 라벨 차단)/Step 4 (top_summary) 새 prompt 적용.
 *
 * 만족도 가드레일: satisfactionImportItem read-only input. 변경·매칭 로직 미터치.
 *
 * 인증: CRON_SECRET
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";
import { generateOperationalIntelligence } from "@/lib/operational-intelligence";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: {
    ids?: string[];
    top?: number;
    names?: string[];
  } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    // empty body OK
  }

  let resolvedIds: string[] = Array.isArray(body.ids) ? body.ids : [];

  if (Array.isArray(body.names) && body.names.length > 0) {
    const byName = await prisma.instructor.findMany({
      where: { name: { in: body.names } },
      select: { id: true, name: true },
    });
    for (const row of byName) {
      if (!resolvedIds.includes(row.id)) resolvedIds.push(row.id);
    }
  }

  if (resolvedIds.length === 0) {
    const top = typeof body.top === "number" && body.top > 0 ? body.top : 100;
    const visibleFilter: import("@prisma/client").Prisma.InstructorWhereInput = {
      AND: [
        { OR: [{ flag: null }, { flag: { not: "실습코치" } }] },
        { isPracticeCoach: false },
      ],
    };
    const topInst = await prisma.instructor.findMany({
      where: visibleFilter,
      orderBy: [{ score: "desc" }, { name: "asc" }],
      take: top,
      select: { id: true },
    });
    resolvedIds = topInst.map((r) => r.id);
  }

  if (resolvedIds.length === 0) {
    return NextResponse.json({
      ok: true,
      message: "no instructors resolved",
      ids: [],
    });
  }

  const startedAt = Date.now();
  const result = await generateOperationalIntelligence({
    instructorIds: resolvedIds,
  });
  const elapsedMs = Date.now() - startedAt;

  return NextResponse.json({
    ok: true,
    generated_at: new Date().toISOString(),
    elapsed_ms: elapsedMs,
    requested_ids: resolvedIds.length,
    updated: result.updatedCount,
    source_counts: result.sourceCounts,
  });
}
