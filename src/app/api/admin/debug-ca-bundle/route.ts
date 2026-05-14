/**
 * GET /api/admin/debug-ca-bundle
 * ca-certificates.crt 파일 존재 + 크기 + 일부 head.
 * Slack TLS는 시스템 CA로 verify 가능해야 함.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { stat, readFile } from "fs/promises";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";

const CANDIDATES = [
  "/etc/ssl/certs/ca-certificates.crt",
  "/usr/lib/ssl/certs/ca-certificates.crt",
  "/usr/local/share/ca-certificates/instructor-extra-ca.crt",
  "/etc/pki/tls/certs/ca-bundle.crt",
];

export async function GET(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const out: Array<{ path: string; exists: boolean; size: number; pemCount: number; firstSubjects: string[] }> = [];
  for (const p of CANDIDATES) {
    try {
      const s = await stat(p);
      if (!s.isFile()) {
        out.push({ path: p, exists: false, size: 0, pemCount: 0, firstSubjects: [] });
        continue;
      }
      const buf = await readFile(p, "utf-8");
      const beginCount = (buf.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length;
      const subjects = Array.from(buf.matchAll(/^subject=([^\n]+)/gm)).slice(0, 5).map((m) => m[1].slice(0, 80));
      out.push({ path: p, exists: true, size: s.size, pemCount: beginCount, firstSubjects: subjects });
    } catch {
      out.push({ path: p, exists: false, size: 0, pemCount: 0, firstSubjects: [] });
    }
  }
  // also probe Slack with explicit fetch + show node/runtime info
  const nodeVersion = process.version;
  const undiciVersion: string | null = null;
  return NextResponse.json({
    ok: true,
    node_version: nodeVersion,
    undici_version: undiciVersion,
    NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS ?? null,
    NODE_OPTIONS: process.env.NODE_OPTIONS ?? null,
    ca_files: out,
  });
}
