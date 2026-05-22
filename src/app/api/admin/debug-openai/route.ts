/**
 * GET /api/admin/debug-openai
 *
 * OpenAI API 직접 ping — response status + body 노출. 429 원인 진단용.
 * model = OPERATIONAL_INTELLIGENCE_LLM_MODEL or OPENAI_MODEL.
 * key length만 노출 (실제 값 X).
 *
 * 인증: CRON_SECRET
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { CRON_SECRET_HEADER, isValidCronSecret } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get(CRON_SECRET_HEADER))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const model =
    process.env.OPERATIONAL_INTELLIGENCE_LLM_MODEL?.trim() ||
    process.env.OPENAI_MODEL?.trim() ||
    "gpt-5.2";
  const url =
    process.env.OPENAI_RESPONSES_URL?.trim() ||
    process.env.OPENAI_BASE_URL?.trim() ||
    "https://api.openai.com/v1/responses";

  const env = {
    has_api_key: Boolean(apiKey),
    api_key_length: apiKey?.length ?? 0,
    api_key_prefix: apiKey ? `${apiKey.slice(0, 7)}…` : null,
    model,
    url,
  };

  if (!apiKey) {
    return NextResponse.json({ ok: false, env, error: "OPENAI_API_KEY missing" });
  }

  const startedAt = Date.now();
  let response: Response | null = null;
  let bodyText = "";
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        reasoning: { effort: "low" },
        input: "Reply only with the JSON {\"ok\":true}.",
        text: {
          format: {
            type: "json_schema",
            name: "ping",
            schema: {
              type: "object",
              additionalProperties: false,
              properties: { ok: { type: "boolean" } },
              required: ["ok"],
            },
          },
        },
      }),
    });
    bodyText = await response.text();
  } catch (error) {
    return NextResponse.json({
      ok: false,
      env,
      elapsed_ms: Date.now() - startedAt,
      fetch_error: error instanceof Error ? error.message : String(error),
    });
  }

  // /v1/models — 가벼운 read-only call로 org/project ID 헤더 추출.
  let modelsCallOrgId: string | null = null;
  let modelsCallProjectId: string | null = null;
  let modelsCallStatus: number | null = null;
  let modelsBodyPreview = "";
  try {
    const mres = await fetch("https://api.openai.com/v1/models", {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    modelsCallStatus = mres.status;
    modelsCallOrgId = mres.headers.get("openai-organization");
    modelsCallProjectId = mres.headers.get("openai-project");
    modelsBodyPreview = (await mres.text()).slice(0, 600);
  } catch {
    // ignore
  }

  return NextResponse.json({
    ok: response.ok,
    env,
    elapsed_ms: Date.now() - startedAt,
    http_status: response.status,
    rate_limit_headers: {
      retry_after: response.headers.get("retry-after"),
      x_ratelimit_remaining_requests: response.headers.get(
        "x-ratelimit-remaining-requests"
      ),
      x_ratelimit_limit_requests: response.headers.get("x-ratelimit-limit-requests"),
      x_ratelimit_remaining_tokens: response.headers.get(
        "x-ratelimit-remaining-tokens"
      ),
      x_ratelimit_limit_tokens: response.headers.get("x-ratelimit-limit-tokens"),
      x_ratelimit_reset_requests: response.headers.get(
        "x-ratelimit-reset-requests"
      ),
      x_ratelimit_reset_tokens: response.headers.get("x-ratelimit-reset-tokens"),
    },
    body_preview: bodyText.slice(0, 1000),
    account_info: {
      organization_id: modelsCallOrgId,
      project_id: modelsCallProjectId,
      models_call_status: modelsCallStatus,
      models_body_preview: modelsBodyPreview,
    },
  });
}
