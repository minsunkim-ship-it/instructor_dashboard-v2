import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const ALLOWED_DECISION_TYPES = new Set([
  "approve",
  "reject",
  "override_instructor",
  "invalidate",
]);

export async function GET(request: NextRequest) {
  const registryType = request.nextUrl.searchParams.get("registryType")?.trim();
  const registryKey = request.nextUrl.searchParams.get("registryKey")?.trim();
  const limitRaw = request.nextUrl.searchParams.get("limit");
  const limit = (() => {
    const parsed = Number.parseInt(limitRaw ?? "20", 10);
    return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 100) : 20;
  })();

  const decisions = await prisma.reviewDecision.findMany({
    where: {
      ...(registryType ? { registryType } : {}),
      ...(registryKey ? { registryKey } : {}),
    },
    orderBy: [{ createdAt: "desc" }],
    take: limit,
  });

  return NextResponse.json({
    status: "success",
    data: {
      decisions,
    },
  });
}

export async function POST(request: NextRequest) {
  const body = (await request.json()) as {
    registryType?: string;
    registryKey?: string;
    decisionType?: string;
    targetInstructorId?: string | null;
    note?: string | null;
    createdBy?: string | null;
  };

  const registryType = body.registryType?.trim();
  const registryKey = body.registryKey?.trim();
  const decisionType = body.decisionType?.trim();
  const targetInstructorId = body.targetInstructorId?.trim() || null;
  const note = body.note?.trim() || null;
  const createdBy = body.createdBy?.trim() || "api:/api/review-decisions";

  if (!registryType) {
    return NextResponse.json(
      { status: "error", errors: [{ code: "INVALID_INPUT", message: "registryType is required" }] },
      { status: 400 }
    );
  }
  if (!registryKey) {
    return NextResponse.json(
      { status: "error", errors: [{ code: "INVALID_INPUT", message: "registryKey is required" }] },
      { status: 400 }
    );
  }
  if (!decisionType || !ALLOWED_DECISION_TYPES.has(decisionType)) {
    return NextResponse.json(
      {
        status: "error",
        errors: [{ code: "INVALID_INPUT", message: "decisionType is invalid" }],
      },
      { status: 400 }
    );
  }
  if (decisionType === "override_instructor" && !targetInstructorId) {
    return NextResponse.json(
      {
        status: "error",
        errors: [
          { code: "INVALID_INPUT", message: "targetInstructorId is required for override_instructor" },
        ],
      },
      { status: 400 }
    );
  }

  const decision = await prisma.reviewDecision.create({
    data: {
      registryType,
      registryKey,
      decisionType,
      targetInstructorId,
      note,
      createdBy,
    },
  });

  return NextResponse.json({
    status: "success",
    data: {
      decision,
    },
  });
}
