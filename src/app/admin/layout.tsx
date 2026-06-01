import type { Metadata } from "next";
import Link from "next/link";

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
          <nav className="admin-nav">
            <Link href="/admin/review" className="admin-nav-link">
              만족도 검토
            </Link>
            <Link href="/admin/th-mismatch" className="admin-nav-link">
              TH mismatch 잔존
            </Link>
            <Link href="/" className="admin-nav-link admin-nav-link-secondary">
              ↗ 대시보드
            </Link>
          </nav>
        </div>
      </header>
      <main className="admin-main">{children}</main>
    </div>
  );
}
