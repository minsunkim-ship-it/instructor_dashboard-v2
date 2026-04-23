import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { parseReviewDecisionInput } from "@/lib/review-decision-input";

export const dynamic = "force-dynamic";

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
  const parsedBody = parseReviewDecisionInput(await request.json());
  if (!parsedBody.ok) {
    return NextResponse.json(
      {
        status: "error",
        errors: [parsedBody.error],
      },
      { status: 400 }
    );
  }

  const {
    registryType,
    registryKey,
    decisionType,
    targetInstructorId,
    note,
    createdBy,
  } = parsedBody.value;

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
