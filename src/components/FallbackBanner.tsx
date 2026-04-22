"use client";

/**
 * FallbackBanner — 06_implementation_spec.md Feature M / 05_api_spec.md 10절
 *
 * 표시 조건:
 *   - `isFallback === true`일 때만 렌더링한다.
 *   - `isFallback === false`면 `null`을 반환한다.
 *
 * 트리거 신호:
 *   - 각 API 응답의 `meta.is_fallback` 단일 신호를 그대로 전달받는다.
 *
 * 문자열:
 *   - 고정 문자열 `임시 데이터 표시 중`을 표시한다 (06_implementation_spec.md 2절 공통 화면 규칙).
 *
 * 접근성:
 *   - 스크린리더가 알림으로 인식하도록 `role="status"`, `aria-live="polite"`를 사용한다.
 *
 * 소유 그룹:
 *   - 컴포넌트 정의 및 props 계약은 Group 2 (T9) 소유다.
 *   - 실제 삽입 위치 및 렌더 조건은 Group 1이 결정한다.
 */
export interface FallbackBannerProps {
  /**
   * API 응답 `meta.is_fallback` 값을 그대로 전달한다.
   * `true`면 `임시 데이터 표시 중` 배너가 렌더된다.
   * `false`면 컴포넌트가 `null`을 반환한다.
   */
  isFallback: boolean;
  /**
   * 추가 컨테이너 클래스. 페이지별 레이아웃에서 여백/테두리 조정이 필요할 때 사용한다.
   * 지정하지 않으면 기본 스타일만 적용된다.
   */
  className?: string;
}

export default function FallbackBanner({
  isFallback,
  className,
}: FallbackBannerProps) {
  if (!isFallback) return null;

  const baseClassName =
    "border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-800";
  const mergedClassName = className
    ? `${baseClassName} ${className}`
    : baseClassName;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="fallback-banner"
      className={mergedClassName}
    >
      임시 데이터 표시 중
    </div>
  );
}
