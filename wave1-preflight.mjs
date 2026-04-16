import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execSync } from "node:child_process";

import { PrismaClient } from "@prisma/client";

const ROOT = process.cwd();

const REQUIRED_DOCS = [
  "docs/11_wave1_tasks.md",
  "docs/12_parallel_bundle_guardrails.md",
  "docs/13_parallel_bundle_prompts.md",
  "docs/14_wave1_preflight_checklist.md",
];

const REQUIRED_ENVS = [
  "DATABASE_URL",
  "NOTION_API_KEY",
  "NOTION_DATABASE_ID",
  "SALESMAP_SNAPSHOT_PATH",
  "SLACK_BOT_TOKEN",
  "SLACK_WORKSPACE_ID",
  "GMAIL_CLIENT_ID",
  "GMAIL_CLIENT_SECRET",
  "GMAIL_REFRESH_TOKEN",
  "GMAIL_ACCOUNT_EMAIL",
  "GMAIL_TARGET_ADDRESSES",
  "GOOGLE_SERVICE_ACCOUNT_JSON",
  "GOOGLE_CONTRACTS_SPREADSHEET_ID",
];

const COMMON_FIXED_PATHS = [
  "docs/",
  "prisma/schema.prisma",
  "src/lib/score-recalculator.ts",
  "src/lib/pipeline/satisfaction-applier.ts",
  "src/lib/pipeline/activity-applier.ts",
  "src/lib/google-user-oauth.ts",
];

function loadEnvFile() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function gitChangedFiles() {
  const out = execSync("git status --porcelain", {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();

  if (!out) return [];

  return out
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

function checkDocs() {
  const missing = REQUIRED_DOCS.filter((relPath) => {
    return !fs.existsSync(path.join(ROOT, relPath));
  });

  return {
    ok: missing.length === 0,
    missing,
  };
}

function checkEnvs() {
  loadEnvFile();

  const missing = REQUIRED_ENVS.filter((key) => !process.env[key]);
  return {
    ok: missing.length === 0,
    missing,
  };
}

function checkCommonFixedItems() {
  const changed = gitChangedFiles();

  const violations = changed.filter((changedPath) => {
    return COMMON_FIXED_PATHS.some((fixedPath) => {
      return fixedPath.endsWith("/")
        ? changedPath.startsWith(fixedPath)
        : changedPath === fixedPath;
    });
  });

  return {
    ok: violations.length === 0,
    violations,
  };
}

async function checkGroup3Baseline() {
  loadEnvFile();
  const prisma = new PrismaClient();

  try {
    const [
      contractTypeCount,
      detailTypeCount,
      fulltimeCount,
      feeFixConfigCount,
    ] = await Promise.all([
      prisma.teachingHistory.count({ where: { contractType: { not: null } } }),
      prisma.teachingHistory.count({ where: { detailType: { not: null } } }),
      prisma.instructor.count({ where: { isFulltime: true } }),
      prisma.feeFixConfig.count(),
    ]);

    return {
      ok:
        contractTypeCount > 0 &&
        detailTypeCount > 0 &&
        fulltimeCount > 0 &&
        feeFixConfigCount >= 0,
      counts: {
        contractTypeCount,
        detailTypeCount,
        fulltimeCount,
        feeFixConfigCount,
      },
      violations: [
        contractTypeCount === 0 ? "teaching_histories.contract_type empty" : null,
        detailTypeCount === 0 ? "teaching_histories.detail_type empty" : null,
        fulltimeCount === 0 ? "instructors.is_fulltime has no true rows" : null,
      ].filter(Boolean),
    };
  } finally {
    await prisma.$disconnect();
  }
}

function checkBuild() {
  try {
    execSync("npm run build", {
      cwd: ROOT,
      stdio: "pipe",
      encoding: "utf8",
    });
    return { ok: true, error: null };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function printSection(title, ok, lines = []) {
  console.log(`\n[${ok ? "PASS" : "FAIL"}] ${title}`);
  for (const line of lines) {
    console.log(`- ${line}`);
  }
}

async function main() {
  const buildRequested = process.argv.includes("--with-build");

  const docs = checkDocs();
  const envs = checkEnvs();
  const commonFixed = checkCommonFixedItems();
  const baseline = await checkGroup3Baseline();
  const build = buildRequested ? checkBuild() : { ok: true, skipped: true };

  printSection("필수 문서 존재", docs.ok, docs.ok ? REQUIRED_DOCS : docs.missing);
  printSection(
    "필수 환경변수",
    envs.ok,
    envs.ok ? REQUIRED_ENVS : envs.missing.map((key) => `missing: ${key}`)
  );
  printSection(
    "공통 고정 항목 변경 여부",
    commonFixed.ok,
    commonFixed.ok
      ? ["공통 고정 항목 변경 없음"]
      : commonFixed.violations.map((file) => `changed: ${file}`)
  );
  printSection("Group 3 선행 데이터", baseline.ok, [
    `contract_type count: ${baseline.counts.contractTypeCount}`,
    `detail_type count: ${baseline.counts.detailTypeCount}`,
    `is_fulltime=true count: ${baseline.counts.fulltimeCount}`,
    `fee_fix_configs count: ${baseline.counts.feeFixConfigCount}`,
    ...baseline.violations,
  ]);

  if (buildRequested) {
    printSection(
      "공통 build",
      build.ok,
      build.ok ? ["npm run build passed"] : [build.error ?? "build failed"]
    );
  } else {
    printSection("공통 build", true, ["skipped (run with --with-build)"]);
  }

  const overall =
    docs.ok && envs.ok && commonFixed.ok && baseline.ok && build.ok;

  console.log("\n==============================");
  console.log(overall ? "START OK" : "START BLOCKED");
  console.log("==============================");

  process.exitCode = overall ? 0 : 1;
}

await main();
