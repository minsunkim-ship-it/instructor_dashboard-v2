const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface GoogleUserOAuthEnv {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accountEmail: string;
}

export function getGoogleUserOAuthEnv(): GoogleUserOAuthEnv {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
  const accountEmail = process.env.GMAIL_ACCOUNT_EMAIL?.trim();

  if (!clientId) {
    throw new Error("GMAIL_CLIENT_ID 환경변수가 설정되지 않았습니다.");
  }
  if (!clientSecret) {
    throw new Error("GMAIL_CLIENT_SECRET 환경변수가 설정되지 않았습니다.");
  }
  if (!refreshToken) {
    throw new Error("GMAIL_REFRESH_TOKEN 환경변수가 설정되지 않았습니다.");
  }
  if (!accountEmail) {
    throw new Error("GMAIL_ACCOUNT_EMAIL 환경변수가 설정되지 않았습니다.");
  }

  return {
    clientId,
    clientSecret,
    refreshToken,
    accountEmail,
  };
}

/**
 * 현재 프로젝트에서는 Gmail/Drive/Sheets 읽기를 모두 동일한 user OAuth refresh token으로 처리한다.
 * env 이름은 기존 Gmail 계약을 재사용하지만, scope는 gmail/drive/sheets readonly를 함께 포함할 수 있다.
 */
export async function exchangeGoogleUserAccessToken(
  env: GoogleUserOAuthEnv = getGoogleUserOAuthEnv()
): Promise<string> {
  const body = new URLSearchParams({
    client_id: env.clientId,
    client_secret: env.clientSecret,
    refresh_token: env.refreshToken,
    grant_type: "refresh_token",
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(`Google OAuth token refresh 실패 HTTP ${res.status}: ${await res.text()}`);
  }

  const json = (await res.json()) as { access_token?: string; error?: string };
  if (!json.access_token) {
    throw new Error(`Google OAuth access_token 미수신: ${json.error ?? "unknown"}`);
  }

  return json.access_token;
}

export async function googleApiGet<T>(
  accessToken: string,
  baseUrl: string,
  path: string,
  params: Record<string, string> = {}
): Promise<T> {
  const qs = new URLSearchParams(params).toString();
  const url = qs ? `${baseUrl}${path}?${qs}` : `${baseUrl}${path}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    throw new Error(`Google API ${path} HTTP ${res.status}: ${await res.text()}`);
  }

  return (await res.json()) as T;
}
