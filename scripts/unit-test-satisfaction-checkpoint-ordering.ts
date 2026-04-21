import { readFile } from "node:fs/promises";
import path from "node:path";

let passed = 0;
let failed = 0;

function pass(label: string): void {
  console.log(`  [PASS] ${label}`);
  passed++;
}
function fail(label: string, detail?: string): void {
  console.log(`  [FAIL] ${label}`);
  if (detail) console.log(`    ${detail}`);
  failed++;
}

console.log("Checkpoint ordering — saveSatisfactionGmailCheckpoint must run AFTER applySatisfactionImports");
console.log("");
console.log("  Structural test: verifies the order of call sites in refresh/route.ts runSatisfaction(),");
console.log("  so a regression that moves checkpoint save before apply is caught at CI / dev time.");
console.log("");

const refreshPath = path.join(
  process.cwd(),
  "src/app/api/refresh/route.ts"
);
const source = await readFile(refreshPath, "utf8");

// Locate runSatisfaction function body
const fnMatch = source.match(
  /async function runSatisfaction\([\s\S]*?\n\}\n/
);
if (!fnMatch) {
  fail("locate runSatisfaction()", "could not find function in refresh/route.ts");
  console.log(`\nTotal: ${passed} passed, ${failed} failed`);
  process.exitCode = 1;
  // eslint-disable-next-line no-process-exit
  process.exit();
}
pass("locate runSatisfaction()");

const body = fnMatch[0];

const applyIdx = body.indexOf("applySatisfactionImports(");
const saveIdx = body.indexOf("saveSatisfactionGmailCheckpoint(");

if (applyIdx === -1) {
  fail("apply call present", "applySatisfactionImports() not found in runSatisfaction()");
} else {
  pass("apply call present");
}

if (saveIdx === -1) {
  fail(
    "checkpoint save call present",
    "saveSatisfactionGmailCheckpoint() not found in runSatisfaction()"
  );
} else {
  pass("checkpoint save call present");
}

if (applyIdx !== -1 && saveIdx !== -1) {
  if (saveIdx > applyIdx) {
    pass(`ordering: save (@${saveIdx}) after apply (@${applyIdx})`);
  } else {
    fail(
      "ordering: save must be AFTER apply",
      `apply@${applyIdx}, save@${saveIdx} — checkpoint is advanced before apply, risking data loss on apply failure`
    );
  }
}

// Also check that checkpoint save is NOT inside the try/catch that swallows gmail errors
const tryIdx = body.indexOf("// Gmail satisfaction");
const catchIdx = body.indexOf("} catch (err) {", tryIdx);
if (tryIdx !== -1 && catchIdx !== -1 && saveIdx !== -1) {
  if (saveIdx > catchIdx) {
    pass("save is outside the gmail-only try/catch (so it skips on apply throw)");
  } else {
    fail(
      "save must be outside the gmail-only try/catch",
      `save@${saveIdx} is still inside gmail try/catch (ends @${catchIdx}) — if normalize throws, save still runs`
    );
  }
}

console.log(`\nTotal: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
