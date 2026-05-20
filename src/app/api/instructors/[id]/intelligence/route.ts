/**
 * GET /api/instructors/{id}/intelligence
 *
 * 운영 인텔리전스 섹션 lazy load 전용 endpoint.
 * /api/instructors/{id}를 internal call(include_oi=1 강제)로 호출한 뒤
 * OI 관련 필드만 응답으로 추출 — 코드 중복 없이 main 로직 재사용.
 *
 * 만족도 가드레일: main GET이 satisfactionImportItem을 read-only로 조회.
 * 별도 수정 없음.
 *
 * 인증: main endpoint와 동일 (NextAuth session 또는 proxy.ts CRON_SECRET bypass).
 */
import { NextResponse } from "next/server";
import { GET as mainGET } from "@/app/api/instructors/[id]/route";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // Force include_oi=1 (full OI build) regardless of incoming search params.
  const upstreamUrl = new URL(request.url);
  upstreamUrl.pathname = `/api/instructors/${id}`;
  upstreamUrl.searchParams.set("include_oi", "1");
  // Limit teaching_history to 1 — 이 endpoint는 OI만 필요. teaching/fee 비용 절감.
  upstreamUrl.searchParams.set("teaching_history_limit", "1");

  const mainResponse = await mainGET(
    new Request(upstreamUrl, {
      method: "GET",
      headers: request.headers,
    }),
    { params: Promise.resolve({ id }) }
  );

  if (!mainResponse.ok) {
    return mainResponse;
  }

  const json = (await mainResponse.json()) as Record<string, unknown>;
  const data = (json.data ?? {}) as Record<string, unknown>;

  return NextResponse.json({
    status: json.status ?? "success",
    meta: json.meta ?? null,
    data: {
      id: data.id ?? id,
      name: data.name ?? null,
      recommended_for: data.recommended_for ?? [],
      avoid_for: data.avoid_for ?? [],
      risk_notes: data.risk_notes ?? [],
      raw_operational_notes: data.raw_operational_notes ?? [],
      classified_notes: data.classified_notes ?? [],
      human_followups: data.human_followups ?? [],
      behavioral_intelligence: data.behavioral_intelligence ?? null,
      operational_intelligence_meta: data.operational_intelligence_meta ?? null,
      operational_evidence_snapshots: data.operational_evidence_snapshots ?? [],
    },
  });
}
