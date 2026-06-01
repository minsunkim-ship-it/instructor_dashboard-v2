import type { Metadata } from "next";
import Link from "next/link";
import AdminNav from "./AdminNav";

export const metadata: Metadata = {
  title: "백오피스 — 패스트캠퍼스 강사 운영",
};

export default function AdminLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="admin-shell">
      <header className="admin-header">
        <div className="admin-header-inner">
          <div className="admin-brand">
            <Link href="/admin" className="admin-brand-link">
              <span className="admin-brand-dot" />
              <span className="admin-brand-title">백오피스</span>
              <span className="admin-brand-sub">강사 운영 검토</span>
            </Link>
          </div>
          <AdminNav />
        </div>
      </header>
      <main className="admin-main">{children}</main>
    </div>
  );
}
