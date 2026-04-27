import { auth, isAuthDisabled, signOut } from "@/auth";

export default async function AuthHeader() {
  if (isAuthDisabled()) {
    return null;
  }

  let session = null;
  try {
    session = await auth();
  } catch {
    return null;
  }
  const email = session?.user?.email ?? null;

  if (!email) return null;

  return (
    <div className="fixed top-3 right-4 z-50 flex items-center gap-2 rounded-full border border-gray-200/80 bg-white/85 px-3 py-1.5 text-xs shadow-sm backdrop-blur">
      <span className="max-w-[180px] truncate text-gray-500">{email}</span>
      <form
        action={async () => {
          "use server";
          await signOut({ redirectTo: "/signin" });
        }}
      >
        <button
          type="submit"
          className="rounded-full px-2 py-0.5 text-gray-500 transition hover:bg-gray-100 hover:text-gray-700"
        >
          로그아웃
        </button>
      </form>
    </div>
  );
}
