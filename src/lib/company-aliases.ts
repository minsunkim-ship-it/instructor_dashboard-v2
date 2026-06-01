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
  new Set([
    "KB금융그룹",
    "KB금융",
    "KB국민은행",
    "케이비국민은행",
    "KB ACE ACADEMY",
    "KB ACE Academy",
    "KB Ace Academy",
    "KB데이타시스템",
    "케이비데이타시스템",
    "KB증권",
    "KB손해보험",
    "KB라이프",
    "KB생명",
    "KB캐피탈",
    "KB저축은행",
  ]),
  new Set([
    "JB금융그룹",
    "JB금융",
    "제이비금융지주",
    "JB우리캐피탈",
    "전북은행",
    "광주은행",
  ]),
  new Set([
    "신한금융그룹",
    "신한금융지주",
    "신한은행",
    "신한카드",
    "신한라이프",
    "신한캐피탈",
    "신한투자증권",
    "신한금융투자",
  ]),
  new Set([
    "하나금융그룹",
    "하나금융지주",
    "하나은행",
    "하나카드",
    "하나캐피탈",
    "하나손해보험",
    "하나생명",
    "하나증권",
  ]),
  new Set([
    "IBK",
    "IBK기업은행",
    "기업은행",
    "아이비케이기업은행",
    "IBK캐피탈",
    "IBK투자증권",
  ]),
  new Set([
    "NH농협",
    "NH투자증권",
    "농협은행",
    "농협중앙회",
    "엔에이치투자증권",
    "엔에이치농협",
  ]),
  new Set([
    "SKT",
    "SK텔레콤",
    "에스케이텔레콤",
    "SK T",
  ]),
  new Set([
    "현대자동차",
    "현대모비스",
    "현대차",
    "현대자동차그룹",
    "현대차그룹",
  ]),
  new Set([
    "한국관광공사",
    "관광공사",
  ]),
  new Set([
    "평화발레오",
    "평화발레오(1)",
    "평화발레오(2)",
  ]),
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
