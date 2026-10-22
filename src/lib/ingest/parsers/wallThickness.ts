import path from "path";
import { loadWorkbook, cellText, cellNumber } from "../excel";
import type { ParsedTable } from "./types";

/**
 * UT wall-thickness form. Sheet name contains "wall thickness" or "DS-0002"/"DS-0007" — real
 * jobs use more than one variant of this form depending on part/frame (confirmed against real
 * data: Job 20443's 7EA-style "DS-0002 EA" form has 6 measurement columns with one universal
 * minimum-limit row, while Job 20591's 7FA-style "DS-0007 FA" form has 8 measurement columns
 * with a *separate* minimum limit per height-% position). Rather than hardcode either variant's
 * row numbers (which silently misreads the other -- confirmed via a real 20591 scan producing
 * blank/duplicate column names, since its header row is 4 rows lower and it has 2 extra
 * columns), the header row is located by searching for the "APG #" label real forms all seem to
 * print in column B, and everything else -- the measurement column count, their names, and how
 * many minimum-limit rows precede them -- is derived from there.
 */
/** Exported so scanJobFolder.ts's Excel-COM PDF fallback can select the same sheet this parser
 * would, when it needs to render (not just read) this workbook -- see PRINT_PDF_SECTIONS. */
export const WALL_THICKNESS_SHEET_PATTERN = /wall thickness|ds-?0002|ds-?0007/i;

const MEASURE_COL_START = 5; // column E, first measurement column in every variant seen so far
const HEADER_ROW_SEARCH_LIMIT = 40;

export async function parseWallThickness(absolutePath: string): Promise<ParsedTable | null> {
  const workbook = await loadWorkbook(absolutePath);
  const sheet = workbook.worksheets.find((s) => WALL_THICKNESS_SHEET_PATTERN.test(s.name));
  if (!sheet) return null;

  let headerRow = -1;
  for (let r = 1; r <= Math.min(HEADER_ROW_SEARCH_LIMIT, sheet.rowCount); r++) {
    if (/^apg\s*#$/i.test(cellText(sheet.getRow(r).getCell(2)))) {
      headerRow = r;
      break;
    }
  }
  if (headerRow === -1) return null; // layout not recognized -- surface as "missing", not a crash

  // Measurement columns run contiguously from column E until the header row's own text runs out.
  const measureCols: number[] = [];
  for (let c = MEASURE_COL_START; ; c++) {
    if (cellText(sheet.getRow(headerRow).getCell(c)) === "") break;
    measureCols.push(c);
  }
  const columnNames = measureCols.map((c) => cellText(sheet.getRow(headerRow).getCell(c)));

  // Minimum-limit row(s) directly above the header: one row if the limit is universal (DS-0002),
  // or several -- one per height-% position -- if it varies by height (DS-0007). Walk upward
  // while a row has at least one numeric value in the measurement columns; a row keyed by height
  // (column C holds a number) is looked up per data row's own height, otherwise it applies to
  // every row regardless of height.
  const limitsByHeight = new Map<number, (number | null)[]>();
  let universalLimits: (number | null)[] | null = null;
  for (let r = headerRow - 1; r >= 1; r--) {
    const values = measureCols.map((c) => cellNumber(sheet.getRow(r).getCell(c)));
    if (values.every((v) => v === null)) break;
    const height = cellNumber(sheet.getRow(r).getCell(3));
    if (height !== null) limitsByHeight.set(height, values);
    else universalLimits = values;
  }
  const limitsFor = (height: number | null): (number | null)[] => {
    if (height !== null && limitsByHeight.has(height)) return limitsByHeight.get(height)!;
    return universalLimits ?? [];
  };

  const rows: Array<Record<string, string>> = [];
  const bucketNumbers = new Set<string>();
  const bucketFailed = new Set<string>();

  let r = headerRow + 1;
  while (r <= sheet.rowCount) {
    const heightLabel = cellText(sheet.getRow(r).getCell(3));
    if (/^min$/i.test(heightLabel)) break;
    const apgNum = cellText(sheet.getRow(r).getCell(2));
    if (apgNum === "" && heightLabel === "") {
      r++;
      continue;
    }
    bucketNumbers.add(apgNum);
    const limits = limitsFor(cellNumber(sheet.getRow(r).getCell(3)));
    const row: Record<string, string> = { "APG #": apgNum, "Height %": heightLabel };
    measureCols.forEach((c, i) => {
      const value = cellNumber(sheet.getRow(r).getCell(c));
      const limit = limits[i] ?? null;
      if (value === null) {
        row[columnNames[i]] = "";
        return;
      }
      const pass = limit !== null ? value >= limit : null;
      row[columnNames[i]] = pass === null ? String(value) : `${value}${pass ? "" : " (OUT OF SPEC)"}`;
      if (pass === false) bucketFailed.add(apgNum);
    });
    rows.push(row);
    r++;
  }
  const outOfSpecCount = bucketFailed.size;

  // Summary row shows whichever limit applies most often (the universal one if there is one,
  // otherwise the first height-keyed row) -- a per-height breakdown belongs in the data rows
  // themselves, not squeezed into one summary line.
  const displayLimits = universalLimits ?? limitsByHeight.values().next().value ?? [];
  const summaryRows: Array<Record<string, string>> = [
    {
      "APG #": "Spec minimum",
      "Height %": "",
      ...Object.fromEntries(columnNames.map((name, i) => [name, displayLimits[i] == null ? "" : String(displayLimits[i])])),
    },
  ];

  return {
    sourceFile: path.basename(absolutePath),
    sheetName: sheet.name,
    columns: ["APG #", "Height %", ...columnNames],
    rows,
    summaryRows,
    sampleSize: bucketNumbers.size,
    outOfSpecCount,
    notes: [`${bucketFailed.size} of ${bucketNumbers.size} bucket(s) have at least one reading below the printed minimum limit.`],
  };
}
