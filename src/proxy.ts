import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { auth, isAllowedEmail, isAuthDisabled } from "@/auth";

type AuthProxyRequest = NextRequest & {
  auth: {
    user?: {
      email?: string | null;
    };
  } | null;
};

function buildApiError(
  status: 401 | 403,
  code: "UNAUTHORIZED" | "FORBIDDEN_DOMAIN",
  message: string
) {
  return NextResponse.json(
    {
      status: "error",
      meta: {
        request_id: `req_${crypto.randomUUID()}`,
        data_mode: "live",
        is_fallback: false,
        last_updated_at: null,
      },
      errors: [{ code, message }],
    },
    { status }
  );
}

export default auth((req: AuthProxyRequest) => {
  const { nextUrl } = req;
  const { pathname, search, hostname } = nextUrl;

  if (isAuthDisabled()) {
    return NextResponse.next();
  }

  const isLocalDevRefresh =
    process.env.NODE_ENV !== "production" &&
    (pathname === "/api/refresh" || pathname.startsWith("/api/pipeline/")) &&
    (hostname === "localhost" || hostname === "127.0.0.1");

  if (isLocalDevRefresh) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/auth")) {
    return NextResponse.next();
  }

  if (pathname === "/signin") {
    const email = req.auth?.user?.email ?? null;
    if (isAllowedEmail(email)) {
      return NextResponse.redirect(new URL("/", nextUrl));
    }
    return NextResponse.next();
  }

  if (!req.auth?.user) {
    if (pathname.startsWith("/api/")) {
      return buildApiError(401, "UNAUTHORIZED", "로그인 세션이 없습니다.");
    }

    const signInUrl = new URL("/signin", nextUrl);
    const callbackUrl = `${pathname}${search}`;
    if (callbackUrl && callbackUrl !== "/") {
      signInUrl.searchParams.set("callbackUrl", callbackUrl);
    }
    return NextResponse.redirect(signInUrl);
  }

  if (!isAllowedEmail(req.auth.user.email)) {
    if (pathname.startsWith("/api/")) {
      return buildApiError(
        403,
        "FORBIDDEN_DOMAIN",
        "허용 도메인 계정만 접근할 수 있습니다."
      );
    }

    const signInUrl = new URL("/signin", nextUrl);
    signInUrl.searchParams.set("error", "forbidden_domain");
    return NextResponse.redirect(signInUrl);
  }

  return NextResponse.next();
});

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
