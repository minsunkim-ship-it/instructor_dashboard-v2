/**
 * POST /api/backoffice/reject-pending
 * Body: { registryId: string, reason?: string }
 *
 * registry를 reject (잘못된 ingest, 만족도 아님 등). 이후 자동 resolver에서 제외.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth, isAuthDisabled } from "@/auth";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  let operatorEmail = "(auth_disabled)";
  if (!isAuthDisabled()) {
    const session = await auth();
    if (!session?.user?.email) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
    operatorEmail = session.user.email;
  }

  let body: { registryId?: string; reason?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const registryId = body.registryId;
  if (!registryId) {
    return NextResponse.json({ ok: false, error: "registryId required" }, { status: 400 });
  }
  const reason = (body.reason ?? "").slice(0, 200);

  const registry = await prisma.satisfactionReviewRegistry.findUnique({
    where: { id: registryId },
  });
  if (!registry) {
    return NextResponse.json({ ok: false, error: "registry_not_found" }, { status: 404 });
  }
  if (registry.matchStatus !== "pending") {
    return NextResponse.json(
      { ok: false, error: "registry_already_resolved", current: registry.matchStatus },
      { status: 409 }
    );
  }
  const nowIso = new Date().toISOString();
  const basis = `operator_reject|by:${operatorEmail}|at:${nowIso}${reason ? `|reason:${reason}` : ""}`;
  await prisma.satisfactionReviewRegistry.update({
    where: { id: registryId },
    data: {
      matchStatus: "rejected_by_operator",
      resolutionBasis: basis,
    },
  });
  return NextResponse.json({ ok: true, operator: operatorEmail });
}
