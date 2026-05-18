/**
 * 회사명 한영 alias dictionary.
 *
 * 한국 대기업 영문 약어 ↔ 한글 발음 매핑. record/TH/ops_report 등에서
 * 같은 회사가 다양한 형태로 표기되는 결함을 정규화.
 *
 * 일반 사용:
 *   normalizeCompanyWithAlias("BGF리테일") === normalizeCompanyWithAlias("비지에프리테일")
 *   companyMatchesWithAlias("BGF리테일", "비지에프리테일") === true
 */

const ALIAS_PAIRS: Array<[string, string]> = [
  ["bgf", "비지에프"],
  ["kt", "케이티"],
  ["kb", "케이비"],
  ["lg", "엘지"],
  ["sk", "에스케이"],
  ["ls", "엘에스"],
  ["hl", "에이치엘"],
  ["cj", "씨제이"],
  ["gs", "지에스"],
  ["nh", "엔에이치"],
  ["jb", "제이비"],
  ["dk", "디케이"],
  ["dl", "디엘"],
  ["tkg", "티케이지"],
  ["ax", "에이엑스"],
  ["mg", "엠지"],
  ["ms", "엠에스"],
  ["ai", "에이아이"],
  ["it", "아이티"],
  ["hr", "에이치알"],
  ["dx", "디엑스"],
  ["dt", "디티"],
  ["pb", "피비"],
];

// v21: 그룹사 자회사 ↔ 모기업/그룹 alias.
// satisfaction registry는 자회사 명("웰컴저축은행")으로 들어오는데
// 계약시트(TH)는 모기업/그룹명("웰컴금융그룹")으로 등록되는 케이스 정규화.
// 양방향 substring 포함 매칭은 [[companyMatchesWithAlias]]에서 이미 처리되지만,
// 토큰 자체가 완전히 다르면(저축은행 vs 금융그룹) 매칭 안 됨. 동일 그룹 SET으로 명시.
const GROUP_ALIAS_SETS: Array<Set<string>> = [
  new Set(["웰컴저축은행", "웰컴금융그룹", "웰컴크레디라인", "웰컴캐피탈"]),
  // 필요 시 다른 그룹사도 여기에 추가 (BGF/KT/SK/롯데 등은 prefix 매칭으로 이미 처리됨)
];

function findGroupAliasSet(value: string): Set<string> | null {
  for (const set of GROUP_ALIAS_SETS) {
    for (const member of set) {
      if (value.includes(member) || member.includes(value)) return set;
    }
  }
  return null;
}

// 정규화된 normalized form (소문자 + special char strip) 후 적용
export function normalizeCompanyBase(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[\s()[\]{}.,:;'"`~!?+\-_/\\|]+/g, "");
}

/**
 * alias 적용된 정규화: 영어 약어를 한글 발음으로 표준화한다.
 * 검색은 한글 form으로 통일 (한글이 더 unique).
 */
export function normalizeCompanyWithAlias(value: string | null | undefined): string {
  let n = normalizeCompanyBase(value);
  for (const [eng, kor] of ALIAS_PAIRS) {
    // 영어가 단독 토큰(시작/끝/숫자 경계 X — normalize가 special char 다 지웠으므로 직접 치환)
    if (n.includes(eng)) {
      n = n.split(eng).join(kor);
    }
  }
  return n;
}

/**
 * 두 회사명이 alias 포함 매칭하는지.
 */
export function companyMatchesWithAlias(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  if (!a || !b) return false;
  const na = normalizeCompanyWithAlias(a);
  const nb = normalizeCompanyWithAlias(b);
  if (na.length < 2 || nb.length < 2) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  // v21: 그룹사 SET 내 member끼리 동일 그룹으로 인정
  const groupA = findGroupAliasSet(a);
  if (groupA && groupA === findGroupAliasSet(b)) return true;
  return false;
}
