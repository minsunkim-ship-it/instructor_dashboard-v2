import { extractPrimaryBodyText } from "@/lib/pipeline/satisfaction-gmail-collector";

let passed = 0;
let failed = 0;

function assertEq(label: string, actual: string, expected: string): void {
  if (actual === expected) {
    console.log(`  [PASS] ${label}`);
    passed++;
  } else {
    console.log(`  [FAIL] ${label}`);
    console.log(`    expected: ${JSON.stringify(expected)}`);
    console.log(`    actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

function assertContains(label: string, haystack: string, needle: string, shouldContain: boolean): void {
  const found = haystack.includes(needle);
  if (found === shouldContain) {
    console.log(`  [PASS] ${label}`);
    passed++;
  } else {
    console.log(`  [FAIL] ${label}`);
    console.log(`    haystack: ${JSON.stringify(haystack)}`);
    console.log(`    needle: ${JSON.stringify(needle)} shouldContain=${shouldContain} found=${found}`);
    failed++;
  }
}

console.log("Forwarded message trim — extractPrimaryBodyText");

// 1. empty input
assertEq("empty input returns empty string", extractPrimaryBodyText(""), "");
assertEq("null input returns empty string", extractPrimaryBodyText(null), "");
assertEq("undefined input returns empty string", extractPrimaryBodyText(undefined), "");

// 2. "-- Forwarded message --" cut
const forwardedBody =
  "만족도 결과 공유드립니다.\n평균 4.8/5.0\n\n-- Forwarded message --\nFrom: someone@example.com\n평균 2.0/5.0 (이건 다른 과정)";
const forwardedResult = extractPrimaryBodyText(forwardedBody);
assertContains("forward cut: keeps content before marker", forwardedResult, "평균 4.8/5.0", true);
assertContains("forward cut: drops content after marker", forwardedResult, "다른 과정", false);

// 3. Korean-style original message header
const koreanOriginalBody =
  "만족도 결과 전달드립니다\n강의 만족도 4.9\n\n2025년 12월 5일 (목) 오전 9:30, someone@example.com 작성:\n이전 과정 만족도 3.5";
const koreanResult = extractPrimaryBodyText(koreanOriginalBody);
assertContains("korean original: keeps new content", koreanResult, "강의 만족도 4.9", true);
assertContains("korean original: drops quoted content", koreanResult, "이전 과정 만족도 3.5", false);

// 4. "On ... wrote:" English-style
const englishOriginalBody =
  "Satisfaction results attached.\nOverall 4.7/5.0\n\nOn Mon, Dec 5, 2025 at 9:30 AM Someone <a@b.com> wrote:\n> Previous result 3.0";
const englishResult = extractPrimaryBodyText(englishOriginalBody);
assertContains("english On..wrote: keeps new content", englishResult, "Overall 4.7/5.0", true);
assertContains("english On..wrote: drops quoted", englishResult, "Previous result 3.0", false);

// 5. Quote marker "\n>"
const quotedBody = "평균 4.5 점수입니다\n> 이전 메일 내용\n> 인용된 내용";
const quotedResult = extractPrimaryBodyText(quotedBody);
assertContains("quote block: keeps reply", quotedResult, "평균 4.5", true);
assertContains("quote block: drops quoted lines", quotedResult, "이전 메일 내용", false);

// 6. 보낸사람 header
const senderBody = "결과 공유합니다\n4.8/5\n\n보낸사람: abc@example.com\n이전 공유";
const senderResult = extractPrimaryBodyText(senderBody);
assertContains("sender header: keeps main content", senderResult, "결과 공유합니다", true);
assertContains("sender header: drops previous", senderResult, "이전 공유", false);

// 7. No cut markers → returns normalized full text
const plainBody = "단순 본문입니다.\n두번째 줄.";
const plainResult = extractPrimaryBodyText(plainBody);
assertContains("plain body: preserves line 1", plainResult, "단순 본문입니다", true);
assertContains("plain body: preserves line 2", plainResult, "두번째 줄", true);

// 8. CRLF normalization
const crlfBody = "결과\r\n4.8/5\r\n-- Forwarded message --\r\n2.0";
const crlfResult = extractPrimaryBodyText(crlfBody);
assertContains("CRLF: keeps before cut", crlfResult, "4.8/5", true);
assertContains("CRLF: drops after cut", crlfResult, "2.0", false);

console.log(`\nTotal: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
