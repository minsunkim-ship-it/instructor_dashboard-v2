/**
 * POST /api/admin/register-instructor
 * Body: { name, affiliation?, contactEmail?, contactPhone?, flag? }
 *
 * 외부 강사 등록 (계약시트에 없는 freelance 강사 등).
 * 이미 존재(name) → 409.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";

interface Body {
  name: string;
  affiliation?: string;
  contactEmail?: string;
  contactPhone?: string;
  flag?: string;
}

export async function POST(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  if (!body.name || body.name.trim().length < 1) {
    return NextResponse.json({ ok: false, error: "name required" }, { status: 400 });
  }
  const name = body.name.trim();
  const existing = await prisma.instructor.findMany({
    where: { name: { contains: name } },
    select: { id: true, name: true },
  });
  if (existing.some((e) => e.name === name)) {
    return NextResponse.json(
      { ok: false, error: "instructor_exists", matches: existing },
      { status: 409 }
    );
  }
  const created = await prisma.instructor.create({
    data: {
      name,
      displayName: name, // 일치 시작 — 운영자가 별도 표기 원하면 update endpoint로
      affiliation: body.affiliation ?? null,
      contactEmail: body.contactEmail ?? null,
      contactPhone: body.contactPhone ?? null,
      flag: body.flag ?? null,
    },
    select: {
      id: true,
      name: true,
      affiliation: true,
      contactEmail: true,
      contactPhone: true,
    },
  });
  return NextResponse.json({ ok: true, created, sibling_count: existing.length });
}
