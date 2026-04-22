import {
  CRON_SECRET_HEADER,
  isAuthorizedCronRequest,
  isValidCronSecret,
} from "@/lib/cron-auth";

let passed = 0;
let failed = 0;

function assertEq(label: string, actual: unknown, expected: unknown): void {
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

console.log("Cron auth helper");
console.log("");

process.env.CRON_SECRET = "top-secret";
assertEq("matching secret is accepted", isValidCronSecret("top-secret"), true);
assertEq("mismatched secret is rejected", isValidCronSecret("wrong"), false);
assertEq("missing secret is rejected", isValidCronSecret(null), false);

const authorizedRequest = new Request("http://localhost/api/refresh/cron", {
  headers: { [CRON_SECRET_HEADER]: "top-secret" },
});
assertEq(
  "request helper accepts matching header",
  isAuthorizedCronRequest(authorizedRequest),
  true
);

const unauthorizedRequest = new Request("http://localhost/api/refresh/cron");
assertEq(
  "request helper rejects missing header",
  isAuthorizedCronRequest(unauthorizedRequest),
  false
);

delete process.env.CRON_SECRET;
assertEq(
  "request helper rejects when env secret is unset",
  isAuthorizedCronRequest(authorizedRequest),
  false
);

console.log(`\nTotal: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
