/**
 * POST /api/admin/auto-reject-elearning?mode=dry_run|apply
 *
 * 강사 매칭 불가능한 사이버연수/이러닝/온라인 콘텐츠 pending registry를 영구 reject.
 *
 * 사용자 컨펌 규칙 (v24-25):
 *   - courseName / fileName 에 "사이버연수", "이러닝", "e-learning", "사이버 연수" 등 포함
 *   - 강사가 진행한 라이브 강의가 아닌 콘텐츠 → 강사 매칭 자체 불가능
 *
 * 인증: CRON_SECRET
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type RawRecord = { [key: string]: unknown };
function pickString(o: RawRecord | undefined | null, ...keys: string[]): string | null {
  if (!o) return null;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return null;
}

const ELEARNING_PATTERN = /(사이버\s*연수|이러닝|e-?learning|온라인\s*연수|온라인\s*콘텐츠|사이버\s*교육|미실시|미진행)/i;

export async function POST(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const mode = request.nextUrl.searchParams.get("mode") ?? "dry_run";
  const startedAt = Date.now();

  const pending = await prisma.satisfactionReviewRegistry.findMany({
    where: { matchStatus: "pending" },
    select: { id: true, registryKey: true, companyName: true, courseName: true, sourceRefs: true },
  });

  interface Plan { registry_key: string; reason: string; matched_text: string }
  const plans: Plan[] = [];
  for (const reg of pending) {
    const refs = Array.isArray(reg.sourceRefs) ? (reg.sourceRefs as RawRecord[]) : [];
    const inner = refs[0]?.source_ref as RawRecord | undefined;
    const fileName = pickString(inner, "file_name") ?? pickString(refs[0], "file_name") ?? "";
    const haystack = `${reg.courseName ?? ""} | ${fileName}`;
    if (ELEARNING_PATTERN.test(haystack)) {
      const m = haystack.match(ELEARNING_PATTERN);
      plans.push({
        registry_key: reg.registryKey,
        reason: "elearning_no_live_instructor",
        matched_text: m ? m[0] : "",
      });
    }
  }

  if (mode === "dry_run") {
    return NextResponse.json({
      ok: true,
      mode,
      durationMs: Date.now() - startedAt,
      pending_audited: pending.length,
      to_reject: plans.length,
      plans: plans.slice(0, 50),
    });
  }

  let rejected = 0;
  for (const p of plans) {
    await prisma.satisfactionReviewRegistry.update({
      where: { registryKey: p.registry_key },
      data: {
        matchStatus: "rejected",
        resolutionBasis: `auto_reject_elearning|matched=${p.matched_text}|date=${new Date().toISOString()}`,
      },
    });
    rejected += 1;
  }
  return NextResponse.json({
    ok: true,
    mode,
    durationMs: Date.now() - startedAt,
    rejected,
  });
}
