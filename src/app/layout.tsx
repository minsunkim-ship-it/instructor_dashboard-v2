import type { Metadata } from "next";
import "./globals.css";
import QueryProvider from "@/components/QueryProvider";
import AuthHeader from "@/components/AuthHeader";

export const metadata: Metadata = {
  title: "강사 DB",
  description: "데이원 강사 운영 대시보드",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <head>
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/npm/pretendard/dist/web/static/pretendard.css"
        />
      </head>
      <body className="antialiased">
        <QueryProvider>
          <AuthHeader />
          {children}
        </QueryProvider>
      </body>
    </html>
  );
}
