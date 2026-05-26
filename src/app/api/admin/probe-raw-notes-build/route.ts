/**
 * POST /api/admin/probe-raw-notes-build
 *   body: { ids?: string[], names?: string[] }
 *
 * Phase 6 진단: 강사별 buildRawOperationalNotes 결과 직접 노출 (LLM 미사용 read-only).
 * - context match: satisfactionImports/activitySignals가 instructor.id로 매핑된 카운트
 * - raw_notes: 추출 결과 (총량 + source_type 분포 + sample)
 * - existing_oi: 현재 DB OI 상태 비교용
 *
 * drop point 식별:
 * - context_match 0 + DB evidence 풍부 → 매핑 실패 (A)
 * - context_match >0 + raw_notes 0 → 추출 reject (B)
 * - raw_notes >0 + existing_oi.stored_raw_note_count 0 → 빈 payload 잔존 (C)
 *
 * 만족도 가드레일: satisfactionImportItem read-only.
 *
 * 인증: CRON_SECRET
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";
import { probeInstructorRawNotes } from "@/lib/operational-intelligence";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: { ids?: string[]; names?: string[] } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    // empty body OK
  }

  let resolvedIds: string[] = Array.isArray(body.ids) ? [...body.ids] : [];

  if (Array.isArray(body.names) && body.names.length > 0) {
    const byName = await prisma.instructor.findMany({
      where: { name: { in: body.names } },
      select: { id: true },
    });
    for (const row of byName) {
      if (!resolvedIds.includes(row.id)) resolvedIds.push(row.id);
    }
  }

  if (resolvedIds.length === 0) {
    return NextResponse.json({
      ok: false,
      error: "no instructor ids resolved (provide ids[] or names[])",
    });
  }

  const startedAt = Date.now();
  const probe = await probeInstructorRawNotes({ instructorIds: resolvedIds });
  const elapsedMs = Date.now() - startedAt;

  // drop point 분류 자동 태그
  const tagged = probe.results.map((r) => {
    const ctxMatched =
      r.context_match.sat_in_context > 0 ||
      r.context_match.activity_in_context > 0;
    const builtAny = r.raw_notes.total > 0;
    const storedAny = (r.existing_oi?.stored_raw_note_count ?? 0) > 0;
    let drop_point: "ok" | "A_mapping" | "B_extraction" | "C_stale" | "no_evidence";
    if (builtAny && storedAny) drop_point = "ok";
    else if (builtAny && !storedAny) drop_point = "C_stale";
    else if (!ctxMatched) drop_point = "A_mapping";
    else if (ctxMatched && !builtAny) drop_point = "B_extraction";
    else drop_point = "no_evidence";
    return { ...r, drop_point };
  });

  const dropPointCounts = tagged.reduce<Record<string, number>>((acc, r) => {
    acc[r.drop_point] = (acc[r.drop_point] ?? 0) + 1;
    return acc;
  }, {});

  return NextResponse.json({
    ok: true,
    generated_at: new Date().toISOString(),
    elapsed_ms: elapsedMs,
    instructor_count: resolvedIds.length,
    drop_point_counts: dropPointCounts,
    results: tagged,
  });
}
