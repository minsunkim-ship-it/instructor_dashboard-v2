/**
 * xlsx-minimal-reader — pure Node 의존 없는 minimal xlsx 리더
 *
 * 외부 패키지 없이 ZIP 파싱 + XML 파싱으로 첫 시트의 rows[][]를 추출.
 * ZIP 형식: https://en.wikipedia.org/wiki/ZIP_(file_format)
 * xlsx 구조: xl/sharedStrings.xml (문자열 풀) + xl/worksheets/sheet1.xml (셀 데이터)
 *
 * 제한:
 *  - DEFLATE (method=8) + Stored (method=0)만 지원. Zip64 미지원 (대용량 파일은 실패).
 *  - 첫 시트만 읽음. (catalog의 worksheetGid 매칭 후 다른 시트도 가능하나, 만족도 시트는 첫 시트가 일반적)
 *  - 수식 결과(<v>)만 사용. inline string도 지원.
 *  - 날짜 셀은 raw 숫자(serial) 또는 string 그대로 반환. 호출자가 변환.
 */
import { inflateRawSync } from "node:zlib";

const SIG_LOCAL_FILE = 0x04034b50;
const SIG_CENTRAL_DIR = 0x02014b50;
const SIG_EOCD = 0x06054b50;

interface ZipEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

function readUInt32LE(buf: Buffer, off: number): number {
  return buf.readUInt32LE(off);
}
function readUInt16LE(buf: Buffer, off: number): number {
  return buf.readUInt16LE(off);
}

function findEocdOffset(buf: Buffer): number {
  // EOCD signature in last 64KB. Search backwards.
  const minOffset = Math.max(0, buf.length - 65536 - 22);
  for (let i = buf.length - 22; i >= minOffset; i--) {
    if (readUInt32LE(buf, i) === SIG_EOCD) return i;
  }
  return -1;
}

function parseZipEntries(buf: Buffer): ZipEntry[] {
  const eocdOff = findEocdOffset(buf);
  if (eocdOff === -1) throw new Error("EOCD not found — not a valid ZIP");
  const cdSize = readUInt32LE(buf, eocdOff + 12);
  const cdOff = readUInt32LE(buf, eocdOff + 16);
  const totalEntries = readUInt16LE(buf, eocdOff + 10);

  const entries: ZipEntry[] = [];
  let p = cdOff;
  const cdEnd = cdOff + cdSize;
  for (let i = 0; i < totalEntries && p < cdEnd; i++) {
    if (readUInt32LE(buf, p) !== SIG_CENTRAL_DIR) {
      throw new Error(`Bad central directory at offset ${p}`);
    }
    const compressionMethod = readUInt16LE(buf, p + 10);
    const compressedSize = readUInt32LE(buf, p + 20);
    const uncompressedSize = readUInt32LE(buf, p + 24);
    const fileNameLen = readUInt16LE(buf, p + 28);
    const extraLen = readUInt16LE(buf, p + 30);
    const commentLen = readUInt16LE(buf, p + 32);
    const localHeaderOffset = readUInt32LE(buf, p + 42);
    const name = buf.slice(p + 46, p + 46 + fileNameLen).toString("utf-8");
    entries.push({
      name,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    p += 46 + fileNameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntry(buf: Buffer, entry: ZipEntry): Buffer {
  const p = entry.localHeaderOffset;
  if (readUInt32LE(buf, p) !== SIG_LOCAL_FILE) {
    throw new Error(`Bad local header at offset ${p}`);
  }
  const fileNameLen = readUInt16LE(buf, p + 26);
  const extraLen = readUInt16LE(buf, p + 28);
  const dataOff = p + 30 + fileNameLen + extraLen;
  const compressed = buf.slice(dataOff, dataOff + entry.compressedSize);

  if (entry.compressionMethod === 0) return compressed; // stored
  if (entry.compressionMethod === 8) return inflateRawSync(compressed); // deflate
  throw new Error(`Unsupported compression method ${entry.compressionMethod}`);
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

function parseSharedStrings(xml: string): string[] {
  // <si>...<t>text</t>...</si> 또는 <si><r>...<t>text</t></r></si>
  const result: string[] = [];
  const siRegex = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = siRegex.exec(xml)) !== null) {
    const inner = m[1];
    // <t>...</t> 모두 모아서 concat
    const tRegex = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let combined = "";
    let tm: RegExpExecArray | null;
    while ((tm = tRegex.exec(inner)) !== null) {
      combined += tm[1];
    }
    result.push(decodeXmlEntities(combined));
  }
  return result;
}

function colLettersToIndex(letters: string): number {
  let n = 0;
  for (let i = 0; i < letters.length; i++) {
    n = n * 26 + (letters.charCodeAt(i) - 64);
  }
  return n - 1;
}

function parseSheetXml(xml: string, sharedStrings: string[]): string[][] {
  // <row r="N">...<c r="A1" t="s"><v>0</v></c>...</row>
  const rows: string[][] = [];
  const rowRegex = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let m: RegExpExecArray | null;
  while ((m = rowRegex.exec(xml)) !== null) {
    const inner = m[1];
    const cells: string[] = [];
    const cellRegex = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^/]*)\/>/g;
    let cm: RegExpExecArray | null;
    while ((cm = cellRegex.exec(inner)) !== null) {
      const attrs = cm[1] ?? cm[3] ?? "";
      const body = cm[2] ?? "";
      const refMatch = attrs.match(/r="([A-Z]+)(\d+)"/);
      if (!refMatch) continue;
      const colIdx = colLettersToIndex(refMatch[1]);
      const typeMatch = attrs.match(/t="([^"]*)"/);
      const cellType = typeMatch?.[1] ?? "";

      let value = "";
      if (cellType === "s") {
        const vMatch = body.match(/<v>([\s\S]*?)<\/v>/);
        if (vMatch) {
          const idx = parseInt(vMatch[1], 10);
          value = sharedStrings[idx] ?? "";
        }
      } else if (cellType === "inlineStr") {
        const tMatch = body.match(/<t\b[^>]*>([\s\S]*?)<\/t>/);
        value = tMatch ? decodeXmlEntities(tMatch[1]) : "";
      } else if (cellType === "str" || cellType === "b") {
        const vMatch = body.match(/<v>([\s\S]*?)<\/v>/);
        value = vMatch ? decodeXmlEntities(vMatch[1]) : "";
      } else {
        // numeric / date / general
        const vMatch = body.match(/<v>([\s\S]*?)<\/v>/);
        value = vMatch ? vMatch[1] : "";
      }

      while (cells.length < colIdx) cells.push("");
      cells[colIdx] = value;
    }
    rows.push(cells);
  }
  return rows;
}

function parseAllSheets(
  workbookXml: string
): Array<{ sheetName: string; rId: string; sheetId: string }> {
  const result: Array<{ sheetName: string; rId: string; sheetId: string }> = [];
  const re = /<sheet\b([^/]+)\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(workbookXml)) !== null) {
    const attrs = m[1];
    const nameMatch = attrs.match(/name="([^"]*)"/);
    const rIdMatch = attrs.match(/r:id="([^"]*)"/);
    const sheetIdMatch = attrs.match(/sheetId="([^"]*)"/);
    if (nameMatch && rIdMatch) {
      result.push({
        sheetName: nameMatch[1],
        rId: rIdMatch[1],
        sheetId: sheetIdMatch?.[1] ?? "",
      });
    }
  }
  return result;
}

function parseRelTarget(relsXml: string, rId: string): string | null {
  const re = new RegExp(`<Relationship[^>]*Id="${rId}"[^>]*Target="([^"]+)"`);
  const m = relsXml.match(re);
  return m ? m[1] : null;
}

export interface XlsxSheet {
  sheetName: string;
  rows: string[][];
}

/**
 * xlsx 바이트를 받아 모든 시트의 rows[][] 추출.
 */
export function parseXlsxBufferAllSheets(xlsxBytes: Buffer): XlsxSheet[] {
  const entries = parseZipEntries(xlsxBytes);
  const entryByName = new Map(entries.map((e) => [e.name, e]));

  const wbEntry = entryByName.get("xl/workbook.xml");
  if (!wbEntry) throw new Error("xl/workbook.xml not found");
  const workbookXml = readEntry(xlsxBytes, wbEntry).toString("utf-8");
  const sheetMetas = parseAllSheets(workbookXml);
  if (sheetMetas.length === 0) throw new Error("No sheets in workbook");

  const relsEntry = entryByName.get("xl/_rels/workbook.xml.rels");
  if (!relsEntry) throw new Error("xl/_rels/workbook.xml.rels not found");
  const relsXml = readEntry(xlsxBytes, relsEntry).toString("utf-8");

  let sharedStrings: string[] = [];
  const sstEntry = entryByName.get("xl/sharedStrings.xml");
  if (sstEntry) {
    const sstXml = readEntry(xlsxBytes, sstEntry).toString("utf-8");
    sharedStrings = parseSharedStrings(sstXml);
  }

  const sheets: XlsxSheet[] = [];
  for (const meta of sheetMetas) {
    const target = parseRelTarget(relsXml, meta.rId);
    if (!target) continue;
    const sheetPath = target.startsWith("/")
      ? target.slice(1)
      : `xl/${target.replace(/^\.\.\//, "")}`;
    const sheetEntry = entryByName.get(sheetPath);
    if (!sheetEntry) continue;
    const sheetXml = readEntry(xlsxBytes, sheetEntry).toString("utf-8");
    const rows = parseSheetXml(sheetXml, sharedStrings);
    sheets.push({ sheetName: meta.sheetName, rows });
  }
  return sheets;
}

/**
 * 첫 시트만 추출 (간단 호환 함수).
 */
export function parseXlsxBuffer(xlsxBytes: Buffer): XlsxSheet {
  const all = parseXlsxBufferAllSheets(xlsxBytes);
  if (all.length === 0) throw new Error("No sheets parsed");
  return all[0];
}
