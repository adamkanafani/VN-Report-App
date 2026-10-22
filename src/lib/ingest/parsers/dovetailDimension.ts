import path from "path";
import { loadWorkbook, cellText, cellNumber } from "../excel";
import type { ParsedTable } from "./types";

/**
 * "Dovetail (Root) Dimension Inspection" -- confirmed to use the SAME internal layout across at
 * least two different form numbers so far: DS-1017 (1st stage, Job 20443) and DS-0460 (2nd/3rd
 * stage, "F7EA Stage 2 and 3 Bucket Dovetail Inspection Data Sheet", Job 20435). Header row: "APG
 * Bucket #" in columns A/B, then bucket numbers duplicated across pairs of columns starting at C
 * (a spot-check sample, not the full population), ending in an AVG column. Data rows: one row per
 * (dimension letter x LE/Mid/TE position), each duplicated across two identical physical rows;
 * column A holds the dimension letter with its spec min/max embedded as text (e.g. "A\n0.795\"
 * 0.815\""), column B the position label. The only real difference between the two confirmed
 * variants is how many dimension letters/measurement rows there are (3 for DS-1017, 4 for
 * DS-0460) -- rather than hardcode either one's exact row range (the DS-1017-only assumption this
 * used to make, which meant 2nd/3rd-stage jobs came back "missing" outright since their sheet
 * isn't literally named "DS-1017" or "dovetail"), both the header row and the data row range are
 * now found by their own content -- the "APG Bucket #" anchor and "stop at the first blank
 * column A", the same read-the-real-structure approach used for wallThickness.ts's own real
 * multi-variant bug, and for zDropDimension.ts's new form.
 */
export const DOVETAIL_SHEET_PATTERN = /dovetail|ds-?1017|ds-?0460/i;

const HEADER_SEARCH_ROW_LIMIT = 40;
const HEADER_SEARCH_COL_LIMIT = 24;

interface HeaderLocation {
  sheetName: string;
  headerRow: number;
  bucketCols: number[];
  avgCol: number | null;
}

function findHeader(sheet: import("exceljs").Worksheet): HeaderLocation | null {
  for (let r = 1; r <= Math.min(HEADER_SEARCH_ROW_LIMIT, sheet.rowCount); r++) {
    const anchor = [1, 2].some((c) => /^apg (bucket )?#$/i.test(cellText(sheet.getRow(r).getCell(c)).trim()));
    if (!anchor) continue;
    const bucketCols: number[] = [];
    let avgCol: number | null = null;
    for (let c = 3; c <= HEADER_SEARCH_COL_LIMIT; c++) {
      const text = cellText(sheet.getRow(r).getCell(c)).trim();
      if (/^avg$/i.test(text)) {
        avgCol = c;
        break;
      }
      if (text !== "") bucketCols.push(c);
    }
    // Bucket numbers are duplicated across pairs of columns (see this file's own comment) --
    // every other column is the same value repeated, so keep just one column per pair.
    const dedupedCols = bucketCols.filter((_, i) => i % 2 === 0);
    if (dedupedCols.length > 0) return { sheetName: sheet.name, headerRow: r, bucketCols: dedupedCols, avgCol };
  }
  return null;
}

export async function parseDovetailDimension(absolutePath: string): Promise<ParsedTable | null> {
  const workbook = await loadWorkbook(absolutePath);

  let found: HeaderLocation | null = null;
  let sheet: import("exceljs").Worksheet | null = null;
  for (const ws of workbook.worksheets) {
    const location = findHeader(ws);
    if (location) {
      found = location;
      sheet = ws;
      break;
    }
  }
  if (!found || !sheet) return null;

  const { headerRow, bucketCols, avgCol } = found;
  const bucketLabels = bucketCols.map((c) => cellText(sheet!.getRow(headerRow).getCell(c)));

  const rows: Array<Record<string, string>> = [];
  const notes: string[] = [];
  let outOfSpecCount = 0;

  for (let r = headerRow + 1; r <= sheet.rowCount; r += 2) {
    const specText = cellText(sheet.getRow(r).getCell(1));
    if (specText === "") break; // end of the measurement block -- everything past here is blank or a footer notice
    const position = cellText(sheet.getRow(r).getCell(2));
    const letterMatch = specText.match(/^([A-Z])/);
    const numbers = specText.match(/[\d.]+/g);
    const letter = letterMatch ? letterMatch[1] : "?";
    const min = numbers && numbers.length >= 1 ? Number(numbers[0]) : null;
    const max = numbers && numbers.length >= 2 ? Number(numbers[1]) : null;

    const row: Record<string, string> = {
      Dimension: `${letter} (${min ?? "?"}"–${max ?? "?"}")`,
      Position: position,
    };
    let rowHasFailure = false;
    bucketCols.forEach((c, i) => {
      const value = cellNumber(sheet!.getRow(r).getCell(c));
      const label = bucketLabels[i];
      if (value === null) {
        row[`Bucket ${label}`] = "";
        return;
      }
      const pass = min !== null && max !== null ? value >= min && value <= max : null;
      row[`Bucket ${label}`] = pass === null ? String(value) : `${value}${pass ? "" : " (OUT OF SPEC)"}`;
      if (pass === false) rowHasFailure = true;
    });
    if (avgCol !== null) {
      const avgValue = cellNumber(sheet.getRow(r).getCell(avgCol));
      row["AVG"] = avgValue === null ? "" : String(avgValue);
    }
    if (rowHasFailure) outOfSpecCount++;
    rows.push(row);
  }

  const sampledBuckets = new Set(bucketLabels).size;
  notes.push(
    `This form samples ${sampledBuckets} bucket(s) (APG # ${bucketLabels.join(", ")}), not the full population — treat this as a spot-check, not a 100% inspection.`
  );

  return {
    sourceFile: path.basename(absolutePath),
    sheetName: found.sheetName,
    columns: ["Dimension", "Position", ...bucketLabels.map((l) => `Bucket ${l}`), ...(avgCol !== null ? ["AVG"] : [])],
    rows,
    sampleSize: sampledBuckets,
    outOfSpecCount,
    notes,
  };
}
