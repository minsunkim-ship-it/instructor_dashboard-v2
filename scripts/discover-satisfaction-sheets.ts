/**
 * discover-satisfaction-sheets.ts — 카탈로그 미등록 만족도 시트 자동 발견 (read-only)
 *
 * Source:
 *   1. SatisfactionImportItem (gmail_summary): 본문/첨부에서 spreadsheet ID 추출
 *   2. ImportItem.sourceRef.spreadsheet_id 분석
 *   3. Drive metadata fetch — 시트 title 확인
 *
 * 분류:
 *   - 카탈로그 등록: catalog source_key + spreadsheetId 매칭
 *   - 미등록 후보 (high confidence): "만족도" 키워드 포함 + 헤더 분석 OK
 *   - 미등록 후보 (low confidence): 키워드만 매칭
 *
 * 산출:
 *   reports/catalog-discovery.md       ← 운영팀 인계 보고서
 *   reports/catalog-discovery-draft.json  ← catalog 등록 draft (운영팀 머지)
 *
 * 자기 의심:
 *   - 자동 등록 X. 보고서만 생성.
 *   - 회사명/강사 추측 X. 메타만 추출.
 *   - 헤더 검증으로 false positive 차단.
 */
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { prisma } from "@/lib/prisma";
import { exchangeGoogleUserAccessToken } from "@/lib/google-user-oauth";
import { loadDotEnv } from "./lib/audit-helpers.ts";

const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
const SHEETS_API_BASE = "https://sheets.googleapis.com/v4";

interface DiscoveredSheet {
  spreadsheetId: string;
  title: string | null;
  mimeType: string | null;
  modifiedTime: string | null;
  inCatalog: boolean;
  catalogKey: string | null;
  evidenceFromGmailThreads: string[];
  classification: "satisfaction_response" | "lecture_mgmt" | "unknown";
  confidence: "high" | "medium" | "low";
  reason: string;
  candidateInstructors: string[];
  candidateCompany: string | null;
}

async function fetchDriveMetadata(
  accessToken: string,
  fileId: string
): Promise<{ title: string | null; mimeType: string | null; modifiedTime: string | null }> {
  try {
    const res = await fetch(
      `${DRIVE_API_BASE}/files/${fileId}?fields=name,mimeType,modifiedTime&supportsAllDrives=true`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!res.ok) return { title: null, mimeType: null, modifiedTime: null };
    const data = (await res.json()) as { name?: string; mimeType?: string; modifiedTime?: string };
    return {
      title: data.name ?? null,
      mimeType: data.mimeType ?? null,
      modifiedTime: data.modifiedTime ?? null,
    };
  } catch {
    return { title: null, mimeType: null, modifiedTime: null };
  }
}

async function fetchSheetHeader(
  accessToken: string,
  spreadsheetId: string
): Promise<string[] | null> {
  try {
    const res = await fetch(
      `${SHEETS_API_BASE}/spreadsheets/${spreadsheetId}/values/A1:AB1`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { values?: string[][] };
    return data.values?.[0] ?? null;
  } catch {
    return null;
  }
}

function classifyHeader(header: string[] | null): {
  classification: DiscoveredSheet["classification"];
  confidence: DiscoveredSheet["confidence"];
  reason: string;
} {
  if (!header || header.length === 0)
    return { classification: "unknown", confidence: "low", reason: "header read 실패" };
  const joined = header.join("|").toLowerCase();
  // 1. google_forms_response: 타임스탬프 + 만족도
  const hasTimestamp = /타임스탬프|timestamp/i.test(joined);
  const hasSatisfaction = /만족도|만족|satisfaction|평점/i.test(joined);
  if (hasTimestamp && hasSatisfaction)
    return {
      classification: "satisfaction_response",
      confidence: "high",
      reason: `header에 타임스탬프 + 만족도 컬럼 확인`,
    };
  // 2. lecture_mgmt: 강사 + 강의계약 / 운영 / 체크리스트
  const hasInstructor = /강사/i.test(joined);
  const hasLectureMgmt = /계약|운영|체크리스트|일정|스케줄|차수|회차/i.test(joined);
  if (hasInstructor && hasLectureMgmt)
    return {
      classification: "lecture_mgmt",
      confidence: "high",
      reason: "header에 강사+운영/계약/체크리스트 — 강의관리 시트",
    };
  // 3. 만족도 키워드만 있고 응답시트 패턴 아님
  if (hasSatisfaction)
    return {
      classification: "unknown",
      confidence: "medium",
      reason: "만족도 컬럼 있으나 응답시트 패턴 미확인",
    };
  return {
    classification: "unknown",
    confidence: "low",
    reason: `header 첫 행: ${header.slice(0, 5).join(" | ")}`,
  };
}

async function main() {
  await loadDotEnv(path.join(process.cwd(), ".env"));
  const token = await exchangeGoogleUserAccessToken();

  // 1. catalog 로드 (등록된 spreadsheetId set)
  const catalogPath = path.resolve(process.cwd(), "data/satisfaction-sheet-catalog.json");
  const catalogRaw = await readFile(catalogPath, "utf-8").catch(() => null);
  type CatalogEntry = { key: string; spreadsheetId: string; title?: string };
  const catalog: CatalogEntry[] = [];
  if (catalogRaw) {
    try {
      const parsed = JSON.parse(catalogRaw) as { sources?: CatalogEntry[] };
      if (Array.isArray(parsed.sources)) catalog.push(...parsed.sources);
    } catch {}
  }
  // 코드 SOURCES 추가
  const codeSources: CatalogEntry[] = [
    { key: "kt_ai_campus", spreadsheetId: "1nXK-uXlBIYbPtRpTPSk2t9l5MJFJmCUAwYFzoDbaf3s" },
    { key: "hyundai_mobis_llm", spreadsheetId: "1hyTlx8sHf-YgqCduFG6WyUZbTW7LRKLgr-74Ug16tDo" },
    { key: "hyundai_mobis_llm_2", spreadsheetId: "1lBcnn_IiEdAYLF_-36l5McFUtRgDU-aYsFfSUpDd1gs" },
    { key: "hyundai_mobis_llm_3", spreadsheetId: "1KNgGwYWdieFnfrz64gvz6l_oqIRSkePhy2cpdIzh1L0" },
    { key: "hyundai_mobis_llm_4", spreadsheetId: "170_wjDPSZGo6NeKDiC9CpmUwoApBBJeoeCJ5U1PHQbI" },
    { key: "woori_ax_forms", spreadsheetId: "19v7sdw0w6D1f-t91ptvUM5hzPbyngPgkgSHhVI1l9aM" },
  ];
  catalog.push(...codeSources);
  const catalogIds = new Map<string, string>();
  for (const c of catalog) {
    if (c.spreadsheetId) catalogIds.set(c.spreadsheetId, c.key);
  }

  // 2. SatisfactionImportItem 의 sourceRef.spreadsheet_id 추출 (gmail_summary 위주)
  const items = await prisma.satisfactionImportItem.findMany({
    where: { sourceType: { in: ["gmail_summary"] } },
    select: {
      candidateName: true,
      candidateCompanyName: true,
      candidateCourseName: true,
      sourceRef: true,
      rawPayload: true,
      normalizedPayload: true,
    },
  });

  // spreadsheet ID 추출 함수
  function extractSpreadsheetIds(text: string | null | undefined): string[] {
    if (!text) return [];
    const re = /spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/g;
    const ids = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) ids.add(m[1]);
    return Array.from(ids);
  }

  const spreadsheetEvidence = new Map<
    string,
    {
      threadIds: Set<string>;
      candidateInstructors: Set<string>;
      candidateCompanies: Set<string>;
    }
  >();
  for (const it of items) {
    const ref = it.sourceRef as Record<string, unknown> | null;
    const sourceRefs = ref ? (ref.source_refs as Array<Record<string, unknown>> | undefined) : undefined;
    const threadId =
      sourceRefs?.[0]?.source_ref &&
      typeof (sourceRefs[0].source_ref as Record<string, unknown>).thread_id === "string"
        ? ((sourceRefs[0].source_ref as Record<string, unknown>).thread_id as string)
        : null;
    const ids = new Set<string>();
    // raw payload 본문에서 ID 추출
    const raw = it.rawPayload as Record<string, unknown> | null;
    if (raw) {
      for (const v of Object.values(raw)) {
        if (typeof v === "string") {
          extractSpreadsheetIds(v).forEach((id) => ids.add(id));
        }
      }
    }
    const norm = it.normalizedPayload as Record<string, unknown> | null;
    if (norm) {
      for (const v of Object.values(norm)) {
        if (typeof v === "string") {
          extractSpreadsheetIds(v).forEach((id) => ids.add(id));
        }
      }
    }
    for (const id of ids) {
      const e =
        spreadsheetEvidence.get(id) ??
        {
          threadIds: new Set<string>(),
          candidateInstructors: new Set<string>(),
          candidateCompanies: new Set<string>(),
        };
      if (threadId) e.threadIds.add(threadId);
      if (it.candidateName) e.candidateInstructors.add(it.candidateName);
      if (it.candidateCompanyName) e.candidateCompanies.add(it.candidateCompanyName);
      spreadsheetEvidence.set(id, e);
    }
  }

  console.log(`gmail ImportItem ${items.length}건에서 ${spreadsheetEvidence.size}개 spreadsheet ID 추출`);

  // 3. 각 spreadsheet 메타 fetch + classify
  const discovered: DiscoveredSheet[] = [];
  let i = 0;
  for (const [spreadsheetId, evidence] of spreadsheetEvidence) {
    i++;
    if (i % 10 === 0) console.log(`  [${i}/${spreadsheetEvidence.size}] processing...`);
    const meta = await fetchDriveMetadata(token, spreadsheetId);
    const isInCatalog = catalogIds.has(spreadsheetId);
    let classification: DiscoveredSheet["classification"] = "unknown";
    let confidence: DiscoveredSheet["confidence"] = "low";
    let reason = "";
    if (isInCatalog) {
      classification = "satisfaction_response";
      confidence = "high";
      reason = "이미 catalog 등록됨";
    } else {
      // header check
      const header = await fetchSheetHeader(token, spreadsheetId);
      const cls = classifyHeader(header);
      classification = cls.classification;
      confidence = cls.confidence;
      reason = cls.reason;
    }

    discovered.push({
      spreadsheetId,
      title: meta.title,
      mimeType: meta.mimeType,
      modifiedTime: meta.modifiedTime,
      inCatalog: isInCatalog,
      catalogKey: catalogIds.get(spreadsheetId) ?? null,
      evidenceFromGmailThreads: Array.from(evidence.threadIds).slice(0, 5),
      classification,
      confidence,
      reason,
      candidateInstructors: Array.from(evidence.candidateInstructors).slice(0, 5),
      candidateCompany:
        evidence.candidateCompanies.size > 0
          ? Array.from(evidence.candidateCompanies).slice(0, 3).join(",")
          : null,
    });
  }

  // 4. 분류
  const inCatalog = discovered.filter((d) => d.inCatalog);
  const newHigh = discovered.filter(
    (d) => !d.inCatalog && d.classification === "satisfaction_response"
  );
  const newLectureMgmt = discovered.filter(
    (d) => !d.inCatalog && d.classification === "lecture_mgmt"
  );
  const newUnknown = discovered.filter((d) => !d.inCatalog && d.classification === "unknown");

  const md: string[] = [];
  md.push("# Catalog 자동 발견 보고서");
  md.push(`Generated at: ${new Date().toISOString()}`);
  md.push(`Gmail ImportItem ${items.length}건에서 spreadsheet ID ${spreadsheetEvidence.size}개 추출`);
  md.push("");
  md.push("## 분류 결과");
  md.push(`- 이미 catalog 등록: ${inCatalog.length}건`);
  md.push(`- **신규 후보 (high — 만족도 응답 시트 확실)**: ${newHigh.length}건`);
  md.push(`- 강의관리 시트 (만족도 X): ${newLectureMgmt.length}건`);
  md.push(`- unknown (수동 검토 필요): ${newUnknown.length}건`);
  md.push("");

  md.push("## 신규 등록 후보 (high confidence) — 운영팀 catalog 등록 권장");
  md.push("| spreadsheetId | title | candidate company | candidate instructor | gmail threads |");
  md.push("|---|---|---|---|---|");
  for (const d of newHigh) {
    md.push(
      `| ${d.spreadsheetId.slice(0, 12)}... | ${(d.title ?? "—").slice(0, 50)} | ${d.candidateCompany ?? "—"} | ${d.candidateInstructors.join(",") || "—"} | ${d.evidenceFromGmailThreads.length} |`
    );
  }
  md.push("");

  md.push("## 강의관리 시트 — catalog 등록 X (만족도 시트 아님)");
  md.push("| spreadsheetId | title | reason |");
  md.push("|---|---|---|");
  for (const d of newLectureMgmt) {
    md.push(`| ${d.spreadsheetId.slice(0, 12)}... | ${(d.title ?? "—").slice(0, 50)} | ${d.reason} |`);
  }
  md.push("");

  md.push("## Unknown — 수동 검토 필요");
  for (const d of newUnknown.slice(0, 30)) {
    md.push(`- ${d.spreadsheetId.slice(0, 12)} | ${d.title ?? "—"} | ${d.reason}`);
  }

  // catalog draft JSON
  const draft = newHigh.map((d, i) => ({
    key: `auto_discovered_${Date.now()}_${i}`,
    sourceType: "google_forms",
    spreadsheetId: d.spreadsheetId,
    worksheetGid: 0,
    title: d.title ?? "",
    range: "A1:AB1000",
    sourceKind: "google_forms_response",
    instructorHint: d.candidateInstructors[0] ?? null,
    note: `자동 발견. gmail threads: ${d.evidenceFromGmailThreads.length}건. 운영자 검토 후 등록.`,
  }));

  const reportDir = path.resolve(process.cwd(), "reports");
  await mkdir(reportDir, { recursive: true });
  await writeFile(path.join(reportDir, "catalog-discovery.md"), md.join("\n"), "utf-8");
  await writeFile(
    path.join(reportDir, "catalog-discovery-draft.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), candidates: draft }, null, 2),
    "utf-8"
  );
  await writeFile(
    path.join(reportDir, "catalog-discovery.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), discovered }, null, 2),
    "utf-8"
  );

  console.log(`\n=== 요약 ===`);
  console.log(`이미 등록: ${inCatalog.length} / 신규 후보(high): ${newHigh.length}`);
  console.log(`강의관리(차단): ${newLectureMgmt.length} / unknown: ${newUnknown.length}`);
  console.log(`Saved: reports/catalog-discovery.md`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
