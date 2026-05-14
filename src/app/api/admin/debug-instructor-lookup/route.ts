/**
 * GET /api/admin/debug-instructor-lookup?name=민경주
 * 단일 강사 lookup 디버그: name, NFC name, NFD name 비교.
 *
 * 인증: CRON_SECRET
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const headerSecret = request.headers.get(CRON_SECRET_HEADER);
  if (!isValidCronSecret(headerSecret)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const name = request.nextUrl.searchParams.get("name");
  if (!name) {
    return NextResponse.json({ ok: false, error: "name required" }, { status: 400 });
  }
  const exact = await prisma.instructor.findMany({
    where: { name },
    select: { id: true, name: true },
  });
  const contains = await prisma.instructor.findMany({
    where: { name: { contains: name } },
    select: { id: true, name: true },
  });
  const nfc = name.normalize("NFC");
  const nfd = name.normalize("NFD");
  return NextResponse.json({
    ok: true,
    query: name,
    query_len: name.length,
    nfc_len: nfc.length,
    nfd_len: nfd.length,
    exact_count: exact.length,
    contains_count: contains.length,
    matches: contains,
  });
}
