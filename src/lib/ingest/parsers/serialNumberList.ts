import path from "path";
import type ExcelJS from "exceljs";
import { loadWorkbook, cellText } from "../excel";
import type { ParsedTable } from "./types";

/**
 * DS-0404 "Serial number recording sheet" -- the V&N serial list. Layout (confirmed against Jobs
 * 20312, 19512 and 20505): sheet "DS-0404 serial number sheet"; H4/I4 = "Job number"; row 7 =
 * "Frame" (GE) or "Part name" (vanes) in A with the value in C; header row 8 = Position # (A),
 * Serial # (C), Drawing #'s (E), Old Job #'s (G), with the "Other numbers, boroscope,
 * thermocouple, ..." label one row higher in I6; data from row 9 down to a "Recorded by" footer.
 *
 * Quirks handled here, all seen on real sheets:
 * - `"` ditto marks meaning "same as the row above" (Job 20312's Drawing #'s / Old Job #'s).
 * - Continuation rows with the position (and often the serial) left blank -- vane sheets list
 *   several rows per position, and GE S1N's retaining ring halves spill extra drawing/other
 *   numbers onto the rows below. A blank position carries the previous one forward; a row with no
 *   serial either is folded into the row above instead of becoming a row of its own.
 * - Sub-blocks introduced by a bare label row ("Retaining Ring" above its UH/LH rows on GE S1N),
 *   which prefixes the positions under it.
 */

const COLUMNS = ["Position #", "Serial #", "Drawing #'s", "Old Job #'s", "Other Numbers"] as const;
const SOURCE_COLS = [1, 3, 5, 7, 9]; // A, C, E, G, I

const isDitto = (v: string) => /^["“”'\s]+$/.test(v) && v.includes('"');

function findHeaderRow(sheet: ExcelJS.Worksheet): number {
  for (let r = 1; r <= Math.min(sheet.rowCount, 30); r++) {
    const a = cellText(sheet.getRow(r).getCell(1));
    const c = cellText(sheet.getRow(r).getCell(3));
    if (/position|segment|vane/i.test(a) && /serial/i.test(c)) return r;
  }
  return 8;
}

function findLabelledValue(sheet: ExcelJS.Worksheet, label: RegExp, maxRow: number): string {
  for (let r = 1; r <= maxRow; r++) {
    const row = sheet.getRow(r);
    for (let c = 1; c <= 12; c++) {
      if (label.test(cellText(row.getCell(c)).trim())) {
        for (let v = c + 1; v <= c + 3; v++) {
          const value = cellText(row.getCell(v)).trim();
          if (value) return value;
        }
      }
    }
  }
  return "";
}

/** Frame / part name off the sheet header ("F7EA N1", "W501D5A ROW 3 VANES") -- also used by
 * jobMetadata.ts to fill in the cover's Turbine Model when nothing better is on file. */
export async function readSerialListFrame(absolutePath: string): Promise<string> {
  const workbook = await loadWorkbook(absolutePath);
  const sheet = workbook.worksheets.find((s) => /ds-?0404|serial number/i.test(s.name)) ?? workbook.worksheets[0];
  return sheet ? findLabelledValue(sheet, /^(frame|part name)$/i, 8) : "";
}

export async function parseSerialNumberList(absolutePath: string): Promise<ParsedTable | null> {
  const workbook = await loadWorkbook(absolutePath);
  const sheet = workbook.worksheets.find((s) => /ds-?0404|serial number/i.test(s.name));
  if (!sheet) return null;

  const headerRow = findHeaderRow(sheet);
  const rows: Array<Record<string, string>> = [];
  let group = "";
  let lastPosition = "";
  let recordedBy = "";
  let recordedDate = "";

  for (let r = headerRow + 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const raw = SOURCE_COLS.map((c) => cellText(row.getCell(c)).trim());
    if (/^recorded by/i.test(raw[0])) {
      recordedBy = raw[1];
      // A date-typed cell reads back as a full ISO timestamp -- print it the way the form does.
      const parsed = /^\d{4}-\d{2}-\d{2}T/.test(raw[4]) ? new Date(raw[4]) : null;
      recordedDate = parsed && !Number.isNaN(parsed.getTime()) ? parsed.toLocaleDateString("en-US", { timeZone: "UTC" }) : raw[4];
      break;
    }
    if (raw.every((v) => v === "")) continue;

    const [position, serial, ...rest] = raw;
    // A cell merged across the row reads back as the same value in every column it spans.
    const restFilled = [serial, ...rest].some((v) => v !== "" && v !== position);

    // A bare label row ("Retaining Ring", often merged across the whole row) opening a sub-block.
    if (position && !/^\d/.test(position) && !restFilled && position.length > 3) {
      group = position;
      lastPosition = "";
      continue;
    }

    const prev = rows[rows.length - 1];
    // No position and no serial: extra numbers spilling over from the row above.
    if (!position && !serial && prev) {
      COLUMNS.slice(2).forEach((col, i) => {
        const v = rest[i];
        if (v && !isDitto(v)) prev[col] = prev[col] ? `${prev[col]} / ${v}` : v;
      });
      continue;
    }

    if (position) lastPosition = position;
    const record: Record<string, string> = { "Position #": group ? `${group} ${lastPosition}`.trim() : lastPosition, "Serial #": serial };
    COLUMNS.slice(2).forEach((col, i) => {
      const v = rest[i];
      record[col] = isDitto(v) ? (prev?.[col] ?? "") : v;
    });
    if (isDitto(serial)) record["Serial #"] = prev?.["Serial #"] ?? "";
    rows.push(record);
  }

  // Drop the unused, numbered-but-blank positions a fixed-size form leaves at the bottom.
  while (rows.length > 0 && Object.entries(rows[rows.length - 1]).every(([k, v]) => k === "Position #" || v === "")) rows.pop();

  const withSerial = rows.filter((r) => r["Serial #"] !== "");
  const notes: string[] = [];
  const blank = rows.filter((r) => r["Serial #"] === "");
  if (blank.length > 0) notes.push(`Position(s) ${blank.map((r) => r["Position #"]).join(", ")} have no serial number recorded.`);

  const formHeader = [
    { label: "Job #:", value: findLabelledValue(sheet, /^job (number|#)/i, 6) },
    { label: "Frame / Part:", value: findLabelledValue(sheet, /^(frame|part name)$/i, headerRow) },
    { label: "Recorded by:", value: [recordedBy, recordedDate].filter(Boolean).join(" — ") },
  ].filter((h) => h.value);

  return {
    sourceFile: path.basename(absolutePath),
    sheetName: sheet.name,
    columns: [...COLUMNS],
    rows,
    sampleSize: withSerial.length,
    populationSize: rows.length,
    notes,
    formHeader,
  };
}
