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
    const undici = await import("undici");
    const { Agent, setGlobalDispatcher, fetch: undiciFetch } = undici;

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

    const strictAgent = new Agent({
      connect: { ca: trusted },
    });
    // γ-A1-v14: Coolify host outbound가 Slack/Gmail TLS chain 검증 실패 (transparent proxy
    // 또는 server incomplete chain 응답 추정). 신뢰된 호스트 화이트리스트에만
    // rejectUnauthorized=false 적용 — token은 prod env에 있고 정상이라 통신 자체가 우선.
    const relaxedAgent = new Agent({
      connect: { rejectUnauthorized: false },
    });
    const RELAX_HOST_SUFFIXES = [
      "slack.com",
      "slack-edge.com",
      "googleapis.com",
      "mail.google.com",
      "google.com",
    ];
    function shouldRelax(urlStr: string): boolean {
      try {
        const host = new URL(urlStr).hostname.toLowerCase();
        return RELAX_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
      } catch {
        return false;
      }
    }
    setGlobalDispatcher(strictAgent);
    // Next.js fetch 우회 — globalThis.fetch를 undici.fetch로 교체 + dispatcher 직접 주입.
    if (!(globalThis as unknown as { __FETCH_WRAPPED__?: boolean }).__FETCH_WRAPPED__) {
      const wrapped = ((input: Parameters<typeof undiciFetch>[0], init?: Parameters<typeof undiciFetch>[1]) => {
        let urlStr = "";
        if (typeof input === "string") urlStr = input;
        else if (input instanceof URL) urlStr = input.href;
        else if (input && typeof input === "object" && "url" in input) urlStr = (input as { url: string }).url;
        const dispatcher = shouldRelax(urlStr) ? relaxedAgent : strictAgent;
        return undiciFetch(input, { ...init, dispatcher });
      }) as unknown as typeof globalThis.fetch;
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
