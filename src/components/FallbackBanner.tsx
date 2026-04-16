"use client";

interface FallbackBannerProps {
  isFallback: boolean;
}

export default function FallbackBanner({ isFallback }: FallbackBannerProps) {
  if (!isFallback) return null;

  return (
    <div className="bg-amber-50 border-b border-amber-200 px-4 py-2 text-sm text-amber-800 font-medium">
      임시 데이터 표시 중
    </div>
  );
}
