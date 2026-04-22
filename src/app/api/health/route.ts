import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;

    return NextResponse.json({
      status: "success",
      meta: {
        request_id: `req_${crypto.randomUUID()}`,
        data_mode: "live",
        is_fallback: false,
        last_updated_at: new Date().toISOString(),
      },
      data: {
        ok: true,
        database: "reachable",
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        status: "error",
        meta: {
          request_id: `req_${crypto.randomUUID()}`,
          data_mode: "live",
          is_fallback: false,
          last_updated_at: null,
        },
        errors: [
          {
            code: "HEALTHCHECK_FAILED",
            message:
              error instanceof Error
                ? error.message
                : "healthcheck에 실패했습니다.",
          },
        ],
      },
      { status: 503 }
    );
  }
}
