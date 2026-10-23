import path from "path";
import type ExcelJS from "exceljs";
import { loadWorkbook, cellText, cellNumber } from "./excel";
import type { JobFile } from "./fileWalk";

// The handful of job-specific numbers Alfredo's Engineering Summary quotes, read from the same
// workbooks he reads them from (confirmed against Job 20564's summary, value for value):
//   - "received on 3/18/2026"  ← the 3A Incoming\Shipping photo folder "... 03-18-26"
//   - "total overall area range is at +1.72%"  ← DS-0346 "Nozzle total area % deviation" (F4)
//   - "throat deviations ranging from -0.86% to 3.26%"  ← min/max of its "% Deviation to Design"
//     column (J), one row per throat J1..J48
//   - "flow range on the OD T/E side is at 5.008%"  ← "OD TE Report" sheet's "Range:" cell
// Everything is best-effort: anything not found stays a [bracketed] placeholder in the draft.

export interface JobMeasurements {
  receivedDate?: string;
  areaDeviation?: string;
  throatMin?: string;
  throatMax?: string;
  /** e.g. { "OD T/E": "5.008%", "ID L/E": "10.399%" } */
  flowRanges: Record<string, string>;
}

const pct = (v: number, digits: number, signed: boolean) => `${signed && v > 0 ? "+" : ""}${(v * 100).toFixed(digits)}%`;

function receivedDate(files: JobFile[]): string | undefined {
  const dates: Array<{ d: Date; preferred: boolean }> = [];
  const seen = new Set<string>();
  for (const f of files) {
    if (!/3a\s*incoming\/shipping\//i.test(f.folderPath + "/")) continue;
    for (const part of f.folderPath.split("/")) {
      if (seen.has(part)) continue;
      seen.add(part);
      const m = part.match(/(\d{1,2})[-.](\d{1,2})[-.](\d{2}|\d{4})\b/);
      if (!m) continue;
      const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
      const d = new Date(year, Number(m[1]) - 1, Number(m[2]));
      if (!Number.isNaN(d.getTime())) dates.push({ d, preferred: /in\b|incoming|received|from\s*customer|processed/i.test(part) });
    }
  }
  const pool = dates.some((x) => x.preferred) ? dates.filter((x) => x.preferred) : dates;
  const first = pool.sort((a, b) => a.d.getTime() - b.d.getTime())[0];
  return first ? `${first.d.getMonth() + 1}/${first.d.getDate()}/${first.d.getFullYear()}` : undefined;
}

const AREA_FORM = /ds[\s-]?(0045|0337|0346|0388|0945)|area\s*check/i;
const stemOf = (f: JobFile) => path.basename(f.baseName, f.ext).toLowerCase().replace(/[\s_-]+fs$/, "").trim();

/** The incoming area-check workbook: in 7A, not the FS copy, preferring the one whose PDF print
 * is also in 7A (Job 20564 has both "...INCOMING.xlsx" and "...INCOMING 2.xlsx"; "2" was printed). */
function areaWorkbook(files: JobFile[]): JobFile | undefined {
  const inIa = files.filter((f) => /7a|inspection report/i.test(f.folderPath) && AREA_FORM.test(f.baseName));
  const books = inIa.filter((f) => (f.ext === ".xlsx" || f.ext === ".xlsm") && !/[\s_-]fs\.xls/i.test(f.baseName));
  const printed = new Set(inIa.filter((f) => f.ext === ".pdf").map(stemOf));
  return books.find((b) => printed.has(stemOf(b))) ?? books[0];
}

function readArea(sheet: ExcelJS.Worksheet): Pick<JobMeasurements, "areaDeviation" | "throatMin" | "throatMax"> {
  const out: Pick<JobMeasurements, "areaDeviation" | "throatMin" | "throatMax"> = {};
  // Total: the first number to the right of a "total ... area ... % dev" label in the header block.
  for (let r = 1; r <= 10 && !out.areaDeviation; r++) {
    const row = sheet.getRow(r);
    for (let c = 1; c <= 20; c++) {
      if (!/total.*area.*dev|area.*%\s*dev/i.test(cellText(row.getCell(c)))) continue;
      for (let v = c + 1; v <= c + 6; v++) {
        const n = cellNumber(row.getCell(v));
        if (n !== null && Math.abs(n) < 1) {
          out.areaDeviation = pct(n, 2, true);
          break;
        }
      }
      break;
    }
  }
  // Throats: the airfoil-name column (J1, *J2*, ...) and the first "Design"/"Dev." column after it.
  let airfoilCol = 0;
  const throatRows: number[] = [];
  for (let c = 1; c <= 20 && !airfoilCol; c++) {
    const rows: number[] = [];
    for (let r = 5; r <= Math.min(sheet.rowCount, 120); r++) if (/^\*?J\d+\*?$/i.test(cellText(sheet.getRow(r).getCell(c)).trim())) rows.push(r);
    if (rows.length >= 5) {
      airfoilCol = c;
      throatRows.push(...rows);
    }
  }
  if (!airfoilCol) return out;
  const headerRow = throatRows[0] - 1;
  for (let c = airfoilCol + 1; c <= airfoilCol + 14; c++) {
    const header = [headerRow - 1, headerRow].map((r) => cellText(sheet.getRow(r).getCell(c))).join(" ");
    if (!/design|dev/i.test(header)) continue;
    const values = throatRows.map((r) => cellNumber(sheet.getRow(r).getCell(c))).filter((v): v is number => v !== null && Math.abs(v) < 0.5);
    if (values.length >= throatRows.length / 2) {
      out.throatMin = pct(Math.min(...values), 2, false);
      out.throatMax = pct(Math.max(...values), 2, false);
      break;
    }
  }
  return out;
}

async function readFlowRanges(file: JobFile): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const workbook = await loadWorkbook(file.absolutePath);
  for (const sheet of workbook.worksheets) {
    const side = /od\s*te/i.test(sheet.name) ? "OD T/E" : /id\s*le/i.test(sheet.name) ? "ID L/E" : undefined;
    if (!side || out[side]) continue;
    for (let r = 1; r <= Math.min(sheet.rowCount, 80) && !out[side]; r++) {
      const row = sheet.getRow(r);
      for (let c = 1; c <= 12; c++) {
        if (!/^range:?$/i.test(cellText(row.getCell(c)).trim())) continue;
        const n = cellNumber(row.getCell(c + 1));
        if (n !== null) out[side] = pct(n, 3, false);
        break;
      }
    }
  }
  return out;
}

export async function readJobMeasurements(files: JobFile[]): Promise<JobMeasurements> {
  const result: JobMeasurements = { receivedDate: receivedDate(files), flowRanges: {} };
  const area = areaWorkbook(files);
  if (area) {
    try {
      const workbook = await loadWorkbook(area.absolutePath);
      const sheet = workbook.worksheets.find((s) => /area/i.test(s.name) && s.state !== "hidden") ?? workbook.worksheets[0];
      if (sheet) Object.assign(result, readArea(sheet));
    } catch {
      // unreadable (.xls, locked, ...) -- placeholders stay
    }
  }
  const flow = files.find((f) => /7a|inspection report/i.test(f.folderPath) && /air\s*flow/i.test(f.baseName) && f.ext === ".xlsx" && !/final/i.test(f.baseName));
  if (flow) {
    try {
      result.flowRanges = await readFlowRanges(flow);
    } catch {
      // placeholders stay
    }
  }
  return result;
}
