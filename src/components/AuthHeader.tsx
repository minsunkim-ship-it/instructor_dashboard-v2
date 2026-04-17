import { auth, signOut } from "@/auth";

export default async function AuthHeader() {
  const session = await auth();
  const email = session?.user?.email ?? null;

  if (!email) return null;

  return (
    <div className="fixed top-3 right-4 z-50 flex items-center gap-3 rounded-full border border-gray-200 bg-white/95 px-4 py-2 text-sm shadow-sm backdrop-blur">
      <span className="max-w-[220px] truncate text-gray-600">{email}</span>
      <form
        action={async () => {
          "use server";
          await signOut({ redirectTo: "/signin" });
        }}
      >
        <button
          type="submit"
          className="rounded-full bg-gray-900 px-3 py-1 text-white transition hover:bg-gray-700"
        >
          로그아웃
        </button>
      </form>
    </div>
  );
}
