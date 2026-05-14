/**
 * GET /api/admin/debug-slack-tls
 * Slack host TLS chain 검사 (tls.connect → peer cert chain).
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { connect, type TLSSocket, type DetailedPeerCertificate } from "tls";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";

interface ChainEntry {
  subject: string;
  issuer: string;
  valid_from: string;
  valid_to: string;
}

function fmtName(n: DetailedPeerCertificate["subject"] | DetailedPeerCertificate["issuer"] | undefined): string {
  if (!n) return "";
  return Object.entries(n)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}

function fetchChain(host: string, port = 443): Promise<{ host: string; ok: boolean; error?: string; chain: ChainEntry[] }> {
  return new Promise((resolve) => {
    const socket: TLSSocket = connect({
      host,
      port,
      servername: host,
      rejectUnauthorized: true,
      timeout: 5000,
    });
    socket.once("secureConnect", () => {
      try {
        const chain: ChainEntry[] = [];
        let cert: DetailedPeerCertificate | undefined = socket.getPeerCertificate(true);
        const seen = new Set<string>();
        while (cert && Object.keys(cert).length > 0) {
          const subj = fmtName(cert.subject);
          if (seen.has(subj)) break;
          seen.add(subj);
          chain.push({
            subject: subj,
            issuer: fmtName(cert.issuer),
            valid_from: cert.valid_from,
            valid_to: cert.valid_to,
          });
          cert = cert.issuerCertificate;
          if (!cert || cert === cert.issuerCertificate) break;
        }
        socket.end();
        resolve({ host, ok: true, chain });
      } catch (e) {
        socket.destroy();
        resolve({ host, ok: false, error: e instanceof Error ? e.message : String(e), chain: [] });
      }
    });
    socket.once("error", (err) => {
      resolve({ host, ok: false, error: err.message, chain: [] });
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve({ host, ok: false, error: "timeout", chain: [] });
    });
  });
}

export async function GET(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const hosts = ["slack.com", "www.googleapis.com", "sheets.googleapis.com"];
  const results = await Promise.all(hosts.map((h) => fetchChain(h)));
  return NextResponse.json({ ok: true, results });
}
