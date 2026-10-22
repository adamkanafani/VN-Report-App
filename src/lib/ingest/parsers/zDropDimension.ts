import path from "path";
import { loadWorkbook, cellText, cellNumber } from "../excel";
import type { ParsedTable } from "./types";

/**
 * DS-0459 "Z-Drop Dimensions" (aka "Z Notch Dimensions" in some job folders' own filenames) --
 * a dimensional check specific to 2nd/3rd stage buckets with no 1st-stage equivalent at all
 * (confirmed against a real completed 2nd-stage report, Job 20435: CVZ/CCZ are two raw Z-height
 * measurements per bucket, and "Z to Z" -- their difference -- is the actual dimension checked
 * against a printed target/tolerance).
 *
 * Real-world layout varies more than most forms in this app -- confirmed against two different
 * jobs' actual workbooks:
 * - Job 20435 (2nd stage): the form's own blank template tab ("DS-0459 Z dims") sits alongside a
 *   SECOND tab holding the real per-bucket incoming measurements ("All 92 bucket front page").
 * - Job 20436 (3rd stage, filename doesn't even say "notch" or "drop" -- just "Z dimensions"):
 *   TWO real-data tabs exist side by side, a partial sample ("...20 pieces") and the fuller set
 *   ("...95 pieces") -- picking whichever sheet is merely non-blank would grab the smaller sample
 *   over the real population depending on which happens to come first in the workbook.
 * Rather than hardcode a row/column layout or a sheet name the way the 1st-stage dovetail parser
 * used to (see dovetailDimension.ts's own real multi-variant bug), this searches every sheet in
 * the workbook for the header row this form always seems to print ("APG #" / "CVZ" / "CCZ" / "Z
 * to Z"), and picks whichever candidate sheet has the MOST real data rows under it -- not just the
 * first non-blank one -- so a partial-sample tab never wins over the fuller set sitting right next
 * to it.
 */
export const Z_DROP_SHEET_PATTERN = /z[\s-]?drop|z[\s-]?notch|z\s*dim|ds-?0459/i;

const HEADER_SEARCH_ROW_LIMIT = 40;
const HEADER_SEARCH_COL_LIMIT = 12;

interface HeaderLocation {
  sheetName: string;
  headerRow: number;
  apgCol: number;
  cvzCol: number;
  cczCol: number;
  zToZCol: number;
}

function findHeaderInSheet(sheet: import("exceljs").Worksheet): HeaderLocation | null {
  for (let r = 1; r <= Math.min(HEADER_SEARCH_ROW_LIMIT, sheet.rowCount); r++) {
    let apgCol = -1;
    let cvzCol = -1;
    let cczCol = -1;
    let zToZCol = -1;
    for (let c = 1; c <= HEADER_SEARCH_COL_LIMIT; c++) {
      const text = cellText(sheet.getRow(r).getCell(c)).trim().toUpperCase();
      if (text === "APG #") apgCol = c;
      else if (text === "CVZ") cvzCol = c;
      else if (text === "CCZ") cczCol = c;
      else if (text === "Z TO Z") zToZCol = c;
    }
    if (apgCol !== -1 && cvzCol !== -1 && cczCol !== -1 && zToZCol !== -1) {
      return { sheetName: sheet.name, headerRow: r, apgCol, cvzCol, cczCol, zToZCol };
    }
  }
  return null;
}

/** Reads whatever "<label>: <value>" or "<label>\n<value-adjacent-cell>" pairs this form's own
 * header block happens to carry (APG Job#, Date, Inspector, Alloy, Target spec, ...) -- searched
 * the same bounded area rather than fixed cells, since exact column placement isn't load-bearing
 * for what's ultimately just a display block above the table (see renderFormHeader). The target
 * label itself varies by job -- a bare "Target" on one job, "Target Z to Z = " on another -- so
 * this matches "Target" as a prefix and normalizes the stored label to just "Target", rather than
 * requiring an exact match that only one of the two real jobs actually prints. */
function readFormHeader(sheet: import("exceljs").Worksheet): Array<{ label: string; value: string }> {
  const fields: Array<{ label: string; value: string }> = [];
  const seen = new Set<string>();
  for (let r = 1; r <= HEADER_SEARCH_ROW_LIMIT; r++) {
    for (let c = 1; c <= HEADER_SEARCH_COL_LIMIT; c++) {
      const raw = cellText(sheet.getRow(r).getCell(c)).trim();
      if (!raw) continue;
      const stripped = raw.replace(/:$/, "").trim();
      const label = /^target\b/i.test(stripped) ? "Target" : stripped;
      if (!/^(APG Job#|Job#|Date|Inspector|Alloy|Target)$/i.test(label)) continue;
      if (seen.has(label)) continue;
      const value = cellText(sheet.getRow(r).getCell(c + 1)).trim();
      if (!value) continue;
      seen.add(label);
      fields.push({ label, value: label.toLowerCase() === "date" ? value.split("T")[0] : value });
    }
  }
  return fields;
}

export async function parseZDropDimension(absolutePath: string): Promise<ParsedTable | null> {
  const workbook = await loadWorkbook(absolutePath);

  let best: { location: HeaderLocation; sheet: import("exceljs").Worksheet; dataRowCount: number } | null = null;
  for (const sheet of workbook.worksheets) {
    const location = findHeaderInSheet(sheet);
    if (!location) continue;
    let dataRowCount = 0;
    for (let r = location.headerRow + 1; r <= sheet.rowCount; r++) {
      if (/^\d+$/.test(cellText(sheet.getRow(r).getCell(location.apgCol)))) dataRowCount++;
    }
    // Prefer whichever candidate sheet has the most real data rows -- not just the first
    // non-blank one -- so a partial-sample tab (e.g. "...20 pieces") never wins over the fuller
    // set sitting right next to it in the same workbook (see this parser's own top comment). A
    // blank template sheet (0 rows) still wins over finding nothing at all.
    if (!best || dataRowCount > best.dataRowCount) best = { location, sheet, dataRowCount };
  }
  if (!best) return null;

  const { location, sheet, dataRowCount } = best;
  const hasData = dataRowCount > 0;
  const formHeader = readFormHeader(sheet);
  const target = formHeader.find((f) => f.label.toLowerCase() === "target")?.value;

  // No automatic pass/fail here, unlike wallThickness/dovetailDimension/heightDimForm -- tried it
  // against this form's own printed "1.218" ± 0.012" target on a real completed job (20435) and
  // it flagged the majority of buckets as out of spec, while that same job's own signed-off I&A
  // narrative states plainly that Z-Notch Drop was "found to be within APG limits" for the whole
  // set. That contradiction means this form's real pass/fail convention isn't a plain "nominal ±
  // tolerance" window the way it is on the forms above -- guessing at one and printing "OUT OF
  // SPEC" next to numbers a tech rep already reviewed and passed would be actively misleading, so
  // this leaves the raw measurements and the printed target both visible and lets the tech rep
  // apply their own judgment instead, the same as this app defers on any other genuinely unclear
  // call it can't confidently automate.
  const rows: Array<Record<string, string>> = [];
  if (hasData) {
    for (let r = location.headerRow + 1; r <= sheet.rowCount; r++) {
      const apgNum = cellText(sheet.getRow(r).getCell(location.apgCol));
      if (!/^\d+$/.test(apgNum)) continue; // stop at the first non-numeric row (blank gap, summary row, etc.)
      const cvz = cellNumber(sheet.getRow(r).getCell(location.cvzCol));
      const ccz = cellNumber(sheet.getRow(r).getCell(location.cczCol));
      const zToZ = cellNumber(sheet.getRow(r).getCell(location.zToZCol));
      rows.push({
        "APG #": apgNum,
        CVZ: cvz === null ? "" : String(cvz),
        CCZ: ccz === null ? "" : String(ccz),
        "Z to Z": zToZ === null ? "" : zToZ.toFixed(4),
      });
    }
  }

  return {
    sourceFile: path.basename(absolutePath),
    sheetName: location.sheetName,
    formHeader,
    columns: ["APG #", "CVZ", "CCZ", "Z to Z"],
    rows,
    sampleSize: rows.length,
    notes: [
      target
        ? `Printed target for "Z to Z" is ${target} -- pass/fail isn't computed automatically here; review against the target yourself the way this form's numbers were reviewed on a real completed job.`
        : "Could not find this form's own printed target/tolerance -- review the measurements yourself.",
    ],
  };
}
