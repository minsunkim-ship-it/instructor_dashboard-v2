/**
 * GET /api/admin/probe-null-company-gmail
 *
 * companyName=null인 gmail_summary record를 SatisfactionImportItem
 * 여러 키로 lookup해서 진단.
 * 인증: CRON_SECRET
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const records = await prisma.satisfactionRecord.findMany({
    where: {
      sourceType: "gmail_summary",
      OR: [{ companyName: null }, { companyName: "" }],
    },
    select: {
      id: true,
      sourceRef: true,
      instructor: { select: { name: true } },
    },
    take: 50,
  });

  const out = [];
  for (const r of records) {
    const sr = r.sourceRef as Record<string, unknown> | null;
    const refs = Array.isArray(sr?.source_refs)
      ? (sr.source_refs as Record<string, unknown>[])
      : [];
    const inner =
      refs[0] && typeof refs[0].source_ref === "object"
        ? (refs[0].source_ref as Record<string, unknown>)
        : null;
    const threadId = typeof inner?.thread_id === "string" ? inner.thread_id : null;
    const messageId = typeof inner?.message_id === "string" ? inner.message_id : null;
    const registryKey = typeof sr?.registry_key === "string" ? sr.registry_key : null;

    // 여러 키로 lookup 시도
    const tried: Record<string, unknown> = {};

    if (registryKey) {
      const found = await prisma.satisfactionImportItem.findFirst({
        where: { sourceRefKey: registryKey },
        select: {
          candidateCompanyName: true,
          candidateName: true,
          candidateCourseName: true,
          normalizedPayload: true,
        },
      });
      tried.byRegistryKey = found
        ? {
            company: found.candidateCompanyName,
            name: found.candidateName,
            course: found.candidateCourseName,
            subjectInPayload:
              (found.normalizedPayload as Record<string, unknown> | null)?.subject ?? null,
          }
        : null;
    }

    if (threadId) {
      const found = await prisma.satisfactionImportItem.findFirst({
        where: {
          rawPayload: { path: ["thread_id"], equals: threadId } as never,
        },
        select: {
          sourceRefKey: true,
          candidateCompanyName: true,
          candidateName: true,
          normalizedPayload: true,
        },
      });
      tried.byThreadId = found
        ? {
            sourceRefKey: found.sourceRefKey,
            company: found.candidateCompanyName,
            name: found.candidateName,
            subject:
              (found.normalizedPayload as Record<string, unknown> | null)?.subject ?? null,
          }
        : null;
    }

    out.push({
      record_id: r.id,
      instructor: r.instructor.name,
      thread_id: threadId,
      message_id: messageId,
      registry_key: registryKey,
      tried,
    });
  }

  return NextResponse.json({ ok: true, count: out.length, items: out });
}
