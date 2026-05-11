/**
 * instructor-aliases.ts — 강사 이름 별칭 매핑
 *
 * 양방향 등록: key = 별칭, value = [대표명, 별칭들]. 첫 번째 값이 canonical 이름.
 *
 * 적용 케이스:
 *  - 노션 정식 표기와 운영(슬랙/계약시트) 표기가 다른 케이스 (신동원 ↔ 신동형)
 *  - 한국어/영어 닉네임 (서주란 ↔ 강주란, 신주혜 ↔ 신주혜 (Zemma))
 *  - 노션의 동명이인 분기 접미사 (이동훈 ↔ 이동훈A, 김영민 ↔ 김영민C)
 *    ※ 이 케이스는 "동명이인이 아니라 동일인" 가설이며 운영자 검증 후 확정 필요.
 *      `resolveCanonical`이 호출될 때마다 ValidationIssue로 검토 플래그를 등록한다.
 *
 * 적용 방식:
 *  - source 수집 시 instructor name이 이 모듈을 거치면 canonical로 정규화된다.
 *  - 기존 Instructor row가 별칭과 매칭되면 같은 row가 반환된다.
 *  - 같은 alias 그룹 안에 여러 row가 이미 존재하면 alias resolve가 작동하지 않으며,
 *    `repair:duplicate-instructors --mode=alias-merge`로 retroactive merge가 필요.
 */

/**
 * 정정 이력:
 *   2026-05-04: 신동원/신동형 페어 제거. 사용자 확인 결과 명백히 다른 강사.
 *   2026-05-04: 서주란/강주란 페어 제거. ground truth 결과 이메일/전화/노션/강사료 모두 다름.
 *
 * 남은 3쌍 (이동훈/이동훈A, 김영민/김영민C, 신주혜/신주혜 (Zemma))는 한쪽 contact 정보 부재로
 * ground truth 검증 보류 상태. 신규 source pipeline 실행 후 contact 채워지면 재검토.
 *
 * 검증 도구: `npm run diagnose:alias-ground-truth`
 */
export const KNOWN_ALIASES: Record<string, string[]> = {
  // 이동훈/이동훈A — 동명이인 분기 가설 (검증 보류, source pipeline 후 재검토)
  이동훈: ["이동훈", "이동훈A"],
  이동훈A: ["이동훈", "이동훈A"],
  // 김영민/김영민C — 동명이인 분기 가설 (검증 보류)
  김영민: ["김영민", "김영민C"],
  김영민C: ["김영민", "김영민C"],
  // 신주혜 영문 닉네임 가설 (Zemma) (검증 보류)
  신주혜: ["신주혜", "신주혜 (Zemma)"],
  "신주혜 (Zemma)": ["신주혜", "신주혜 (Zemma)"],
};

/**
 * 운영자 ground truth 검증이 필요한 동명이인/별칭 가설 케이스.
 * 검증 통과한 페어는 이 set에서 제거하거나 별도 confirmed list로 옮긴다.
 */
export const ALIAS_REVIEW_FLAGGED: ReadonlySet<string> = new Set([
  "이동훈",
  "이동훈A",
  "김영민",
  "김영민C",
  "신주혜",
  "신주혜 (Zemma)",
]);

/**
 * 별칭 → 대표명. 등록되지 않은 이름은 그대로 반환.
 */
export function resolveCanonical(name: string | null | undefined): string {
  if (!name) return "";
  const aliases = KNOWN_ALIASES[name];
  return aliases?.[0] ?? name;
}

/**
 * 한 이름과 같은 alias 그룹의 모든 표기. 등록되지 않은 이름은 [name] 반환.
 */
export function getAllAliases(name: string | null | undefined): string[] {
  if (!name) return [];
  const aliases = KNOWN_ALIASES[name];
  return aliases ?? [name];
}

/**
 * 운영자 검증이 필요한 별칭 케이스인지 확인.
 * (true 시 호출자가 ValidationIssue를 등록하는 게 권장됨.)
 */
export function isReviewFlaggedAlias(name: string | null | undefined): boolean {
  if (!name) return false;
  return ALIAS_REVIEW_FLAGGED.has(name);
}

/**
 * 두 이름이 같은 alias 그룹에 속하는지.
 */
export function areAliases(a: string, b: string): boolean {
  if (a === b) return true;
  return resolveCanonical(a) === resolveCanonical(b);
}
