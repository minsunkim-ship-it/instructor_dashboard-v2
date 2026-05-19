/**
 * POST /api/admin/migrate-add-notion-page-body
 *
 * 운영 메모 노션 본문 분리용 신규 컬럼 추가 (idempotent).
 *   ALTER TABLE instructors ADD COLUMN IF NOT EXISTS notion_page_body_raw TEXT
 *
 * 인증: CRON_SECRET
 *
 * ⚠ 이 endpoint는 1회용. 이미 적용되면 NO-OP.
 *   schema.prisma에 notionPageBodyRaw (= notion_page_body_raw) 컬럼이 declare됨.
 *   Prisma client 빌드 시점에 type을 생성하므로, 운영 DB ALTER가 끝나기 전에는
 *   해당 컬럼을 SELECT/UPDATE하는 새 코드 경로가 P2022(unknown column) 에러 가능.
 *   안전한 배포 순서: code push → Coolify auto-deploy → 본 endpoint 호출 → 후속 cleanup endpoint.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const before = await prisma.$queryRawUnsafe<
    Array<{ column_name: string; data_type: string }>
  >(
    `SELECT column_name, data_type
       FROM information_schema.columns
      WHERE table_name = 'instructors'
        AND column_name = 'notion_page_body_raw'`
  );
  const existedBefore = before.length > 0;

  await prisma.$executeRawUnsafe(
    `ALTER TABLE instructors
       ADD COLUMN IF NOT EXISTS notion_page_body_raw TEXT`
  );

  const after = await prisma.$queryRawUnsafe<
    Array<{ column_name: string; data_type: string }>
  >(
    `SELECT column_name, data_type
       FROM information_schema.columns
      WHERE table_name = 'instructors'
        AND column_name = 'notion_page_body_raw'`
  );
  const existsAfter = after.length > 0;

  return NextResponse.json({
    ok: true,
    column: "instructors.notion_page_body_raw",
    existed_before: existedBefore,
    exists_after: existsAfter,
    no_op: existedBefore,
    metadata: after[0] ?? null,
  });
}
