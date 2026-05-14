/**
 * Next.js instrumentation — 서버 시작 시 1회 실행.
 *
 * γ-A1-v14: Coolify base image의 ca-bundle이 incomplete해 Slack/Gmail 등의 TLS
 * chain verify 실패. Node 자체 bundled Mozilla CA (`tls.rootCertificates`)로
 * undici Agent을 set해 모든 fetch가 안정적으로 동작하도록 한다.
 *
 * 시스템 CA + Mozilla bundled CA 둘 다 trust list에 포함시켜
 * Google API / Slack / Gmail / 기타 모두 호환.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }
  try {
    const tls = await import("tls");
    const fs = await import("fs/promises");
    const { Agent, setGlobalDispatcher } = await import("undici");

    const trusted: string[] = [...tls.rootCertificates];

    // OpenSSL system CA bundle을 추가로 병합 (Coolify Debian ca-certificates)
    const extra = process.env.NODE_EXTRA_CA_CERTS;
    if (extra) {
      try {
        const buf = await fs.readFile(extra, "utf-8");
        const pems = buf
          .split(/(?=-----BEGIN CERTIFICATE-----)/)
          .map((s) => s.trim())
          .filter((s) => s.startsWith("-----BEGIN CERTIFICATE-----"));
        for (const pem of pems) trusted.push(pem);
      } catch {
        // ignore
      }
    }

    setGlobalDispatcher(
      new Agent({
        connect: {
          ca: trusted,
        },
      })
    );
    // marker for /api/admin/debug-instrumentation
    (process as unknown as { __TLS_DISPATCHER_SET__?: number }).__TLS_DISPATCHER_SET__ = trusted.length;
    // eslint-disable-next-line no-console
    console.log(
      `[instrumentation] TLS dispatcher set with ${trusted.length} trusted root certs`
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[instrumentation] failed to set TLS dispatcher", e);
  }
}
