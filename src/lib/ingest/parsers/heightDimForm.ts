import path from "path";
import { loadWorkbook, cellText, cellNumber } from "../excel";
import type { ParsedTable } from "./types";

/**
 * DS-0004 "Tip & Angel Wing Height" form. Layout (confirmed against Job 20443, via the
 * job's actual data source "HEIGHTS - INCOMING.xlsx" — see the ingestion source rules for
 * why that file, not the blank same-named DS-0004 template, is preferred):
 *
 * sheet name contains "1st stg heights"; row 5 = dimension group label per column (with the
 * tolerance note "All Dims +/- 0.025"" in column A); row 6 = spec text per column; row 7 =
 * sub-header (MID/LE/TE/Min/Max); data rows from 8 until a row labelled MIN/AVG/MAX in column A.
 * Columns B-G are nominal-with-tolerance dimensions; columns H-I are direct Min/Max bounds for
 * squealer tip thickness. "MM" in a data cell means not measured.
 */
/** Exported so scanJobFolder.ts's Excel-COM PDF fallback can select the same sheet this parser
 * would, when it needs to render (not just read) this workbook -- see PRINT_PDF_SECTIONS. */
export const HEIGHT_DIM_FORM_SHEET_PATTERN = /1st stg heights|ds-?0004/i;

async function parseHeightDimFormDS0004(absolutePath: string): Promise<ParsedTable | null> {
  const workbook = await loadWorkbook(absolutePath);
  const sheet = workbook.worksheets.find((s) => HEIGHT_DIM_FORM_SHEET_PATTERN.test(s.name));
  if (!sheet) return null;

  const toleranceMatch = cellText(sheet.getRow(5).getCell(1)).match(/\+\/-\s*([\d.]+)/);
  const tolerance = toleranceMatch ? Number(toleranceMatch[1]) : null;

  const dataCols = [2, 3, 4, 5, 6, 7, 8, 9]; // B..I
  const groupLabels = dataCols.map((c) => cellText(sheet.getRow(5).getCell(c)));
  const subLabels = dataCols.map((c) => cellText(sheet.getRow(7).getCell(c)));
  const specText = dataCols.map((c) => cellText(sheet.getRow(6).getCell(c)));

  const columnNames = dataCols.map((c, i) => {
    const group = groupLabels[i].replace(/\s+/g, " ").trim();
    const sub = subLabels[i].trim();
    return group ? `${group} (${sub})` : sub;
  });

  // Columns H/I (indices 6,7 in dataCols) are direct min/max bounds; B-G use nominal +/- tolerance.
  const specNominal = specText.map((t) => {
    const m = t.match(/([\d.]+)/);
    return m ? Number(m[1]) : null;
  });

  const rows: Array<Record<string, string>> = [];
  let outOfSpecCount = 0;
  const notes: string[] = [];
  if (tolerance === null) notes.push("Could not parse the +/- tolerance note; pass/fail was skipped.");

  let r = 8;
  while (r <= sheet.rowCount) {
    const label = cellText(sheet.getRow(r).getCell(1));
    if (/^(min|avg|max)$/i.test(label)) break;
    if (label === "") {
      r++;
      continue;
    }
    const row: Record<string, string> = { "APG #": label };
    let rowHasFailure = false;
    dataCols.forEach((c, i) => {
      const raw = cellText(sheet.getRow(r).getCell(c));
      const colName = columnNames[i];
      if (raw === "" || /^mm$/i.test(raw)) {
        row[colName] = "Not measured";
        return;
      }
      const value = cellNumber(sheet.getRow(r).getCell(c));
      if (value === null) {
        row[colName] = raw;
        return;
      }
      let pass: boolean | null = null;
      if (i === 6) pass = specNominal[6] !== null ? value >= specNominal[6]! : null; // Min bound
      else if (i === 7) pass = specNominal[7] !== null ? value <= specNominal[7]! : null; // Max bound
      else if (tolerance !== null && specNominal[i] !== null) {
        pass = Math.abs(value - specNominal[i]!) <= tolerance;
      }
      row[colName] = pass === null ? String(value) : `${value}${pass ? "" : " (OUT OF SPEC)"}`;
      if (pass === false) rowHasFailure = true;
    });
    if (rowHasFailure) outOfSpecCount++;
    rows.push(row);
    r++;
  }

  // Capture any MIN/AVG/MAX summary rows the source file already computed.
  const summaryRows: Array<Record<string, string>> = [];
  while (r <= sheet.rowCount) {
    const label = cellText(sheet.getRow(r).getCell(1));
    if (!/^(min|avg|max)$/i.test(label)) break;
    const summaryRow: Record<string, string> = { "APG #": label };
    dataCols.forEach((c, i) => {
      summaryRow[columnNames[i]] = cellText(sheet.getRow(r).getCell(c));
    });
    summaryRows.push(summaryRow);
    r++;
  }

  notes.push(
    `Pass/fail for angel-wing and tip-height columns assumes a nominal +/- ${tolerance ?? "?"}" tolerance parsed from the sheet header; squealer tip thickness (Min/Max columns) is checked against the printed bounds directly.`
  );

  return {
    sourceFile: path.basename(absolutePath),
    sheetName: sheet.name,
    columns: ["APG #", ...columnNames],
    rows,
    summaryRows,
    sampleSize: rows.length,
    outOfSpecCount,
    notes,
  };
}

const HEADER_SEARCH_ROW_LIMIT = 40;
const HEADER_SEARCH_COL_LIMIT = 24;

/**
 * 2nd/3rd-stage bucket height form -- a genuinely different layout from DS-0004 above, confirmed
 * against two real jobs (20435 2nd stage, 20436 3rd stage "Tall Buckets"): header row reads "APG
 * #" in column A (found dynamically, not a fixed row -- its position varies by job); one row
 * above that holds each column's nominal spec value, and the row above THAT holds a group label
 * per dimension (e.g. "A - TE", "C - LE Rail Height") which is a genuine Excel merge spanning
 * several columns -- ExcelJS only returns it on the merge's own leftmost column, so it's carried
 * forward through the blank cells to its right, standard merged-header handling, not a guess.
 * Sub-labels (MID/CV/CC/CVZ/CCZ/...) come from the header row itself, one per column.
 *
 * Deliberately does NOT compute pass/fail: this form turned out to carry at least three distinct
 * tolerance conventions across its own columns (symmetric +/- for one group, asymmetric +/-0.030"
 * /-0.060" for another, plus a separately-targeted "Z-Notch Thickness" pair) rather than the one
 * clean min/max-per-column rule the DS-0004 parser above and wallThickness/dovetailDimension all
 * share -- exactly the kind of form-specific convention that turned out to be easy to get wrong
 * on a first guess (see zDropDimension.ts's own real example of that). Shows the raw measurements
 * and each column's own printed nominal value instead, and lets the tech rep judge it directly.
 */
/** The "APG #" anchor cell's own column isn't fixed -- confirmed at column A on one real job and
 * column B on another -- so this searches a few leading columns rather than assuming column A. */
function findApgHeader(sheet: import("exceljs").Worksheet): { row: number; col: number } | null {
  for (let r = 1; r <= Math.min(HEADER_SEARCH_ROW_LIMIT, sheet.rowCount); r++) {
    for (let c = 1; c <= 3; c++) {
      if (/^apg\s*#$/i.test(cellText(sheet.getRow(r).getCell(c)).trim())) return { row: r, col: c };
    }
  }
  return null;
}

async function parseHeightDimFormAlt(absolutePath: string): Promise<ParsedTable | null> {
  const workbook = await loadWorkbook(absolutePath);

  // Several real jobs keep more than one candidate tab -- a partial sample (e.g. "...20 Each")
  // alongside the fuller set (e.g. "...100%") -- so this picks whichever has the most real data
  // rows, not just the first one found (same real bug fixed in zDropDimension.ts). A row only
  // counts if its first measurement column actually has a number, not just a valid-looking APG #
  // label -- confirmed on a real job whose "Qty. 92" tab numbers all 95 rows but never actually
  // records a single measurement in any of them (the tech rep's real numbers only ever made it
  // into the completed PDF for that job), which would otherwise count as "the fuller sheet" and
  // return an all-blank table instead of correctly falling through to that PDF.
  let best: { sheet: import("exceljs").Worksheet; headerRow: number; apgCol: number; dataRowCount: number } | null = null;
  for (const sheet of workbook.worksheets) {
    const header = findApgHeader(sheet);
    if (!header) continue;
    const { row: headerRow, col: apgCol } = header;
    let dataRowCount = 0;
    for (let r = headerRow + 1; r <= sheet.rowCount; r++) {
      const label = cellText(sheet.getRow(r).getCell(apgCol));
      if (/^(min|max|avg)(\s+limit)?$/i.test(label)) break;
      if (/^\d+$/.test(label) && cellNumber(sheet.getRow(r).getCell(apgCol + 1)) !== null) dataRowCount++;
    }
    if (!best || dataRowCount > best.dataRowCount) best = { sheet, headerRow, apgCol, dataRowCount };
  }
  // Every candidate sheet found the header but never actually recorded a measurement -- treat
  // this the same as not finding the form at all, so the caller's usual "blank or unreadable, but
  // the completed print-ready PDF was found" fallback kicks in instead of silently returning a
  // table full of blank cells that would otherwise read as "ready, parsed N rows."
  if (!best || best.dataRowCount === 0) return null;
  const { sheet, headerRow, apgCol } = best;

  const subLabelRow = headerRow;
  const nominalRow = headerRow - 1;
  const groupLabelRow = headerRow - 2;

  const dataCols: number[] = [];
  for (let c = apgCol + 1; c <= HEADER_SEARCH_COL_LIMIT; c++) {
    if (cellText(sheet.getRow(subLabelRow).getCell(c)).trim() === "") break;
    dataCols.push(c);
  }

  let lastGroup = "";
  const groupLabels = dataCols.map((c) => {
    const text = cellText(sheet.getRow(groupLabelRow).getCell(c)).replace(/\s+/g, " ").trim();
    if (text) lastGroup = text;
    return lastGroup;
  });
  const subLabels = dataCols.map((c) => cellText(sheet.getRow(subLabelRow).getCell(c)).trim());
  // A "nominal" cell that isn't a clean plain number is really more spec-note text bleeding into
  // this row (confirmed on a real job: a "Z-Notch Thickness\nTarget 0.140"" group label repeats
  // itself here instead of a real nominal) -- cellNumber's regex-strip would still pull *some*
  // digits out of that and silently mislabel it as a real nominal value, so this requires the raw
  // text to already look like a bare number before trusting it as one.
  const nominalValues = dataCols.map((c) => {
    const raw = cellText(sheet.getRow(nominalRow).getCell(c)).trim();
    return /^[\d.]+$/.test(raw) ? cellNumber(sheet.getRow(nominalRow).getCell(c)) : null;
  });
  const columnNames = dataCols.map((c, i) => (groupLabels[i] ? `${groupLabels[i]} (${subLabels[i]})` : subLabels[i]));

  const rows: Array<Record<string, string>> = [];
  let r = headerRow + 1;
  while (r <= sheet.rowCount) {
    const label = cellText(sheet.getRow(r).getCell(apgCol));
    if (/^(min|max|avg)(\s+limit)?$/i.test(label)) break;
    if (label === "") {
      r++;
      continue;
    }
    const row: Record<string, string> = { "APG #": label };
    dataCols.forEach((c, i) => {
      const value = cellNumber(sheet.getRow(r).getCell(c));
      row[columnNames[i]] = value === null ? "" : String(value);
    });
    rows.push(row);
    r++;
  }

  const summaryRows: Array<Record<string, string>> = [];
  while (r <= sheet.rowCount) {
    const label = cellText(sheet.getRow(r).getCell(apgCol));
    if (!/^(min|max|avg)(\s+limit)?$/i.test(label)) break;
    const summaryRow: Record<string, string> = { "APG #": label };
    dataCols.forEach((c, i) => {
      summaryRow[columnNames[i]] = cellText(sheet.getRow(r).getCell(c));
    });
    summaryRows.push(summaryRow);
    r++;
  }

  const nominalsText = dataCols
    .map((_, i) => (nominalValues[i] !== null ? `${columnNames[i]}: ${nominalValues[i]}"` : null))
    .filter((s): s is string => s !== null)
    .join(", ");

  return {
    sourceFile: path.basename(absolutePath),
    sheetName: sheet.name,
    columns: ["APG #", ...columnNames],
    rows,
    summaryRows,
    sampleSize: rows.length,
    notes: [
      "Pass/fail isn't computed automatically for this form -- it carries more than one tolerance convention across its own columns (see this parser's own comment), so review each measurement against its printed nominal yourself rather than trust an automated flag here.",
      nominalsText ? `Printed nominal values: ${nominalsText}.` : "Could not read this form's own printed nominal values.",
    ],
  };
}

/** Tries the 1st-stage DS-0004 layout first, then the 2nd/3rd-stage layout (see
 * parseHeightDimFormAlt) -- the two are different enough (different tolerance conventions, not
 * just a shifted row range) that unifying them into one strategy the way dovetailDimension.ts
 * does would risk misreading either one, so this just tries each in turn instead. */
export async function parseHeightDimForm(absolutePath: string): Promise<ParsedTable | null> {
  return (await parseHeightDimFormDS0004(absolutePath)) ?? (await parseHeightDimFormAlt(absolutePath));
}
