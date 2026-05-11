/**
 * unit-test-xlsx-reader.ts — minimal xlsx parser 단위 테스트 (read-only)
 *
 * Drive에서 Office file 다운로드 후 parseXlsxBuffer로 파싱.
 * 첫 5행 출력해서 헤더 구조 확인.
 */
import path from "node:path";
import { exchangeGoogleUserAccessToken } from "@/lib/google-user-oauth";
import { parseXlsxBufferAllSheets } from "@/lib/xlsx-minimal-reader";
import { loadDotEnv } from "./lib/audit-helpers.ts";

const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";

async function downloadXlsx(token: string, fileId: string): Promise<Buffer> {
  const res = await fetch(`${DRIVE_API_BASE}/files/${fileId}?alt=media&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  await loadDotEnv(path.join(process.cwd(), ".env"));
  const token = await exchangeGoogleUserAccessToken();

  const targets = [
    { key: "woori_bank_ax_2604_2611", id: "1_ejiRquc49YdsFyBQYWwcpQ-4eiBCrXw" },
    { key: "home_n_service_dt_2506_2512", id: "1ank_wF-S3MklrLtBOdEtxxaTWnOhA_T-" },
    { key: "shinsegae_dept_genai_2503_2505", id: "1wNu58RdO4Gtt4cOFoPTQUqBbFY1WU78m" },
  ];

  for (const t of targets) {
    console.log(`\n=== ${t.key} ===`);
    try {
      const bytes = await downloadXlsx(token, t.id);
      console.log(`  download: ${bytes.length} bytes`);
      const sheets = parseXlsxBufferAllSheets(bytes);
      console.log(`  sheets: ${sheets.length}`);
      for (const sh of sheets) {
        console.log(`  --- "${sh.sheetName}" / rows: ${sh.rows.length} ---`);
        for (let i = 0; i < Math.min(3, sh.rows.length); i++) {
          const row = sh.rows[i] ?? [];
          console.log(
            `    [${i}]: ${row.slice(0, 10).map((c) => (c.length > 25 ? c.slice(0, 23) + ".." : c)).join(" | ")}`
          );
        }
      }
    } catch (err) {
      console.log(`  ❌ ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
