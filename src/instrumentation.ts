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

    const agent = new Agent({
      connect: { ca: trusted },
    });
    setGlobalDispatcher(agent);
    // Next.js fetch 우회 — globalThis.fetch wrapper로 dispatcher 직접 주입
    const origFetch = globalThis.fetch;
    if (origFetch && !(globalThis as unknown as { __FETCH_WRAPPED__?: boolean }).__FETCH_WRAPPED__) {
      const wrapped: typeof globalThis.fetch = (input, init) =>
        origFetch(input, {
          ...init,
          // @ts-expect-error — undici dispatcher option은 Node fetch에서 동작하지만 lib.dom.d.ts에 정의 없음
          dispatcher: agent,
        });
      globalThis.fetch = wrapped;
      (globalThis as unknown as { __FETCH_WRAPPED__?: boolean }).__FETCH_WRAPPED__ = true;
    }
    // marker for /api/admin/debug-instrumentation
    (process as unknown as { __TLS_DISPATCHER_SET__?: number }).__TLS_DISPATCHER_SET__ = trusted.length;
    // eslint-disable-next-line no-console
    console.log(
      `[instrumentation] TLS dispatcher set + fetch wrapped (${trusted.length} certs)`
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[instrumentation] failed to set TLS dispatcher", e);
  }
}
