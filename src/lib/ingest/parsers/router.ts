import path from "path";
import type ExcelJS from "exceljs";
import { loadWorkbook, cellText } from "../excel";

export interface RouterOperation {
  sequence: string;
  label: string;
  note: string;
  workCenter: string;
  /** Column K "Type (L, M, O)": L = labor op, M = material line (weld wire, braze powder,
   * helicoils, seals -- listed as ops so they get costed), O = outside vendor. Blank if unset. */
  opType: string;
  /** Which router sheet the op came from -- "Master" on a standard router; on a multi-sheet "PSM"
   * router (Job 20505) one of "Nozzle repair" / "Packing repair" / "Fixture check, coat,
   * assemble", which the Repair Report groups under its own subheadings. */
  block: string;
  /** Whether this operation is actually in scope for this job. Determined from the note/label
   * text itself ("not selected" / "not required" / a label starting with "No ...") rather than
   * the Quantity or cost columns — those are driven by live cross-sheet formulas this app does not
   * evaluate. The V&N router template uses the same convention ("No Incoming Airflow", "Preweld
   * not selected"), confirmed against Jobs 20312 and 20505. */
  active: boolean;
}

/** A data-sheet form the router calls for under one of its operations -- V&N routers list them
 * right under the op ("2000 Record incoming dimensions" → C16 "DS-0047" / D16 "F7EA 1st Stage
 * Nozzle Dims and Drop", ...). The most reliable machine-readable list of which DS forms a given
 * product actually gets, and in what order. */
export interface RouterFormRef {
  form: string;
  title: string;
  sequence: string;
  /** Whether the op it sits under is in scope (see RouterOperation.active). */
  active: boolean;
}

export interface ParsedRouter {
  sourceFile: string;
  sheetName: string;
  /** Router sheets in report order (see RouterOperation.block) -- one entry ("Master") on a
   * standard router. */
  blocks: string[];
  operations: RouterOperation[];
  formRefs: RouterFormRef[];
  /** From the "Pricing" sheet's header block (J1:M3) -- blank when the sheet isn't there. */
  pricing: { description: string; customer: string; techRep: string; date: string; selectedOptions: string[] };
}

const EXCLUSION_PATTERN = /\bnot\s+selected\b|\bnot\s+required\b/i;
const FORM_NUMBER = /^(DS|CDS|F)[\s-]?\d{2,4}(-\d+)?$/i;

export function normalizeFormNumber(form: string): string {
  const m = form.trim().match(/^([a-z]+)[\s-]?(\d+)/i);
  return m ? `${m[1].toUpperCase()}-${m[2].padStart(4, "0")}` : form.trim().toUpperCase();
}

function readPricing(workbook: ExcelJS.Workbook): ParsedRouter["pricing"] {
  const empty = { description: "", customer: "", techRep: "", date: "", selectedOptions: [] as string[] };
  const sheet = workbook.worksheets.find((s) => /^pricing$/i.test(s.name.trim()));
  if (!sheet) return empty;
  // Label/value pairs: J1 Customer → K1, L1 Salesman → M1, J2 Job number → K2, L2 Tech Rep → M2,
  // L3 Date → M3. Read by label rather than fixed cell so a shifted column doesn't misread.
  const labelled: Record<string, string> = {};
  for (let r = 1; r <= 3; r++) {
    const row = sheet.getRow(r);
    for (let c = 1; c <= 15; c++) {
      const label = cellText(row.getCell(c)).trim().toLowerCase();
      if (label) labelled[label] = cellText(row.getCell(c + 1)).trim();
    }
  }
  // Options table: "Options | ... | Y/N" header, one option per row with "Y" in the Y/N column.
  const selectedOptions: string[] = [];
  let ynCol = 0;
  for (let r = 1; r <= Math.min(sheet.rowCount, 60); r++) {
    const row = sheet.getRow(r);
    if (!ynCol) {
      for (let c = 1; c <= 15; c++) if (/^y\s*\/\s*n$/i.test(cellText(row.getCell(c)).trim())) ynCol = c;
      continue;
    }
    if (/^y(es)?$/i.test(cellText(row.getCell(ynCol)).trim())) {
      const option = cellText(row.getCell(1)).trim();
      if (option) selectedOptions.push(option);
    }
  }
  return {
    description: cellText(sheet.getRow(1).getCell(1)).trim(),
    customer: labelled["customer"] ?? "",
    techRep: labelled["tech rep"] ?? "",
    date: labelled["date"] ?? "",
    selectedOptions,
  };
}

/** A router-layout sheet: the "Type (L, M, O)" column header in K1:K4 above numbered ops. */
function isRouterSheet(sheet: ExcelJS.Worksheet): boolean {
  for (let r = 1; r <= 6; r++) if (/\(\s*l\s*,\s*m\s*,\s*o\s*\)/i.test(cellText(sheet.getRow(r).getCell(11)))) return true;
  return false;
}

/** Report order for a multi-sheet router's blocks: segment/vane work, then packing/ring work,
 * then fixture/coat/assembly last (the order Job 20505's Repair Report lists them in). */
function blockRank(name: string): number {
  if (/assembl|fixture|coat/i.test(name)) return 2;
  if (/packing|ring|diaphragm/i.test(name)) return 1;
  return 0;
}

function parseOperations(sheet: ExcelJS.Worksheet, operations: RouterOperation[], formRefs: RouterFormRef[]) {
  const block = sheet.name.trim();
  let current: RouterOperation | undefined;
  for (let r = 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const sequence = cellText(row.getCell(1));
    if (/^\d{3,6}$/.test(sequence)) {
      const label = cellText(row.getCell(2)).trim();
      const workCenter = cellText(row.getCell(12)).trim(); // col L
      const opType = cellText(row.getCell(11)).trim().toUpperCase(); // col K
      // The row immediately below is only a note row if it isn't itself the next operation's
      // header (i.e. it has no sequence number of its own) — some operations have no note at all.
      const nextRowSequence = cellText(sheet.getRow(r + 1).getCell(1));
      const note = /^\d{3,6}$/.test(nextRowSequence) ? "" : cellText(sheet.getRow(r + 1).getCell(2)).trim();
      const active = !EXCLUSION_PATTERN.test(`${label} ${note}`) && !/^(no|not)\s/i.test(label);
      current = { sequence, label, note, workCenter, opType, block, active };
      operations.push(current);
      continue;
    }
    const form = cellText(row.getCell(3)).trim();
    if (current && FORM_NUMBER.test(form)) {
      formRefs.push({ form: normalizeFormNumber(form), title: cellText(row.getCell(4)).trim(), sequence: current.sequence, active: current.active });
    }
  }
}

export async function parseRouter(absolutePath: string): Promise<ParsedRouter | null> {
  const workbook = await loadWorkbook(absolutePath);
  const master = workbook.worksheets.find((s) => /^master$/i.test(s.name.trim()));
  const sheets = master
    ? [master]
    : workbook.worksheets
        // "Optional steps (i.e. coating)" is a catalog of add-on ops to paste in, not work in scope.
        .filter((s) => isRouterSheet(s) && !/optional/i.test(s.name))
        .sort((a, b) => blockRank(a.name) - blockRank(b.name));
  if (sheets.length === 0) return null;

  const operations: RouterOperation[] = [];
  const formRefs: RouterFormRef[] = [];
  for (const sheet of sheets) parseOperations(sheet, operations, formRefs);

  return {
    sourceFile: path.basename(absolutePath),
    sheetName: sheets.map((s) => s.name).join(", "),
    blocks: sheets.map((s) => s.name.trim()),
    operations,
    formRefs,
    pricing: readPricing(workbook),
  };
}
