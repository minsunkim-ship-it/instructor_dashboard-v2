"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS: Array<{ href: string; label: string; secondary?: boolean }> = [
  { href: "/admin/review", label: "만족도 검토" },
  { href: "/admin/th-mismatch", label: "TH mismatch 잔존" },
  { href: "/", label: "↗ 대시보드", secondary: true },
];

export default function AdminNav() {
  const pathname = usePathname() ?? "";
  return (
    <nav className="admin-nav">
      {LINKS.map((l) => {
        const isActive =
          !l.secondary && (pathname === l.href || pathname.startsWith(l.href + "/"));
        const cls = [
          "admin-nav-link",
          l.secondary ? "admin-nav-link-secondary" : "",
          isActive ? "admin-nav-link-active" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <Link key={l.href} href={l.href} className={cls}>
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
