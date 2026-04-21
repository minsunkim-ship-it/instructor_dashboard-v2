import GoogleSignInButton from "@/components/GoogleSignInButton";

interface SignInPageProps {
  searchParams: Promise<{
    callbackUrl?: string;
    error?: string;
  }>;
}

function getErrorMessage(error: string | undefined) {
  if (!error) return null;
  if (error === "AccessDenied" || error === "forbidden_domain") {
    return "@day1company.co.kr 계정만 접근할 수 있습니다.";
  }
  return "로그인에 실패했습니다. 다시 시도해 주세요.";
}

export default async function SignInPage({ searchParams }: SignInPageProps) {
  const { callbackUrl, error } = await searchParams;
  const message = getErrorMessage(error);

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,_#f3f4f6,_#ffffff_48%,_#e5e7eb)] text-gray-900">
      <div className="mx-auto flex min-h-screen max-w-5xl items-center justify-center px-6 py-12">
        <section className="grid w-full overflow-hidden rounded-[32px] border border-gray-200 bg-white shadow-[0_24px_80px_rgba(15,23,42,0.08)] lg:grid-cols-[1.15fr_0.85fr]">
          <div className="space-y-6 bg-gray-950 px-8 py-10 text-white lg:px-12 lg:py-14">
            <p className="text-sm uppercase tracking-[0.24em] text-gray-400">
              Day1 Instructor DB
            </p>
            <div className="space-y-4">
              <h1 className="text-3xl font-semibold leading-tight lg:text-4xl">
                내부 운영 강사 대시보드
              </h1>
              <p className="max-w-xl text-base leading-7 text-gray-300">
                강사 목록, 상세 정보, 최근 6개월 만족도 조사 결과, 활동 로그, 점수 계산 결과를
                한 화면에서 확인하는 내부 전용 서비스입니다.
              </p>
            </div>
            <ul className="space-y-3 text-sm text-gray-300">
              <li>• Google 계정 기반 로그인</li>
              <li>• 허용 도메인: @day1company.co.kr</li>
              <li>• 로그인 후 강사 목록과 상세 정보에 접근 가능</li>
            </ul>
          </div>

          <div className="flex items-center justify-center px-8 py-10 lg:px-12 lg:py-14">
            <div className="w-full max-w-md space-y-6">
              <div className="space-y-2">
                <h2 className="text-2xl font-semibold">로그인</h2>
                <p className="text-sm leading-6 text-gray-500">
                  데이원 사내 Google 계정으로 로그인해 주세요.
                </p>
              </div>

              {message && (
                <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {message}
                </div>
              )}

              <GoogleSignInButton callbackUrl={callbackUrl} />

              <p className="text-xs leading-5 text-gray-400">
                로그인 후 허용 도메인이 아닌 계정은 접근이 차단됩니다.
              </p>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
