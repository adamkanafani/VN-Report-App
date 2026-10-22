import path from "path";
import { loadWorkbook, cellText, cellNumber } from "../excel";
import type { ParsedTable } from "./types";

/**
 * "Total Airflow (Incoming)" workbook -- a separate file from the dimensional forms, not a tab
 * within one of them, routinely produced for 7FA 1st-stage buckets and 501F 1st-/2nd-stage
 * buckets (and other airfoil parts on customer request), so most jobs simply won't have this
 * file at all -- that absence is itself the "conditional logic" the report needs: no special
 * part-type check here, this section is just "missing" like any other optional exhibit when
 * there's nothing to show, same as Metallurgical Report or Crack Map on a job that doesn't need
 * one. Layout (confirmed against Job 20591): sheet name "Airflow Rpt" (the formatted, print-ready
 * view -- a separate "Airflow Data" sheet holds the raw per-reading source data it's built from,
 * which this doesn't need to touch). Header rows 1-3 (Job #, Part Name, Customer); two-line
 * column headers on rows 5-6; data from row 7, one row per airflow reading (a bucket can be
 * measured more than once if a first reading looks off, so row count can run higher than the
 * bucket count -- this reports both numbers separately rather than conflating them).
 *
 * Whenever a print-ready PDF of this exact workbook also exists (see PRINT_PDF_SECTIONS in
 * scanJobFolder.ts), that PDF is what the generated report actually embeds -- this parsed table
 * is only ever the on-screen review preview.
 */
export const AIRFLOW_SHEET_PATTERN = /airflow rpt|airflow report/i;

const COLUMNS = ["Date", "Time", "APG Number", "Wcor Measure", "Raw Mass Flow Rate", "Part Pressure", "Part Temp", "Patm"];

/** The Time column reads back as a full ISO date string (Excel's own "day 0" placeholder date
 * for a time-only cell), not just a clock time -- keep only the HH:MM:SS portion for display. */
function timeOnly(text: string): string {
  const isoTimePart = text.match(/T(\d{2}:\d{2}:\d{2})/);
  return isoTimePart ? isoTimePart[1] : text;
}

export async function parseAirflowReport(absolutePath: string): Promise<ParsedTable | null> {
  const workbook = await loadWorkbook(absolutePath);
  const sheet = workbook.worksheets.find((s) => AIRFLOW_SHEET_PATTERN.test(s.name));
  if (!sheet) return null;

  const jobNumber = cellText(sheet.getRow(1).getCell(6));
  const partName = cellText(sheet.getRow(2).getCell(6));
  const customer = cellText(sheet.getRow(3).getCell(6));
  const formHeader = [
    { label: "APG Job #", value: jobNumber },
    { label: "Part Name", value: partName },
    { label: "Customer", value: customer },
  ].filter((h) => h.value !== "");

  const rows: Array<Record<string, string>> = [];
  const bucketNumbers = new Set<string>();

  for (let r = 7; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const apgNumber = cellText(row.getCell(3));
    if (apgNumber === "") continue; // gap or end of the real data

    bucketNumbers.add(apgNumber);
    const fmt = (n: number | null, digits: number) => (n === null ? "" : n.toFixed(digits));
    rows.push({
      Date: cellText(row.getCell(1)),
      Time: timeOnly(cellText(row.getCell(2))),
      "APG Number": apgNumber,
      "Wcor Measure": fmt(cellNumber(row.getCell(4)), 6),
      "Raw Mass Flow Rate": fmt(cellNumber(row.getCell(5)), 6),
      "Part Pressure": fmt(cellNumber(row.getCell(6)), 3),
      "Part Temp": fmt(cellNumber(row.getCell(7)), 3),
      Patm: fmt(cellNumber(row.getCell(8)), 3),
    });
  }

  const notes = [`${rows.length} reading(s) across ${bucketNumbers.size} bucket(s)${rows.length !== bucketNumbers.size ? " (some measured more than once)" : ""}.`];

  return {
    sourceFile: path.basename(absolutePath),
    sheetName: sheet.name,
    columns: COLUMNS,
    rows,
    sampleSize: bucketNumbers.size,
    notes,
    formHeader,
  };
}
