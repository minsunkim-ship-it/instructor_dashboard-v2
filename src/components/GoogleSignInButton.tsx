"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";

export default function GoogleSignInButton({
  callbackUrl,
}: {
  callbackUrl?: string;
}) {
  const [isPending, setIsPending] = useState(false);

  return (
    <button
      type="button"
      disabled={isPending}
      onClick={async () => {
        try {
          setIsPending(true);
          await signIn("google", {
            redirectTo: callbackUrl || "/",
          });
        } finally {
          setIsPending(false);
        }
      }}
      className="flex w-full items-center justify-center rounded-2xl bg-gray-900 px-4 py-3 text-sm font-medium text-white transition hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {isPending ? "이동 중..." : "Google로 로그인"}
    </button>
  );
}
