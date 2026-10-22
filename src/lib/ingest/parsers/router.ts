import path from "path";
import { loadWorkbook, cellText } from "../excel";

export interface RouterOperation {
  sequence: string;
  label: string;
  note: string;
  workCenter: string;
  /** Whether this operation is actually in scope for this job. Determined from the note/label
   * text itself ("not selected" / "not required" / a label starting with "No ...") rather than
   * the Quantity or cost columns — those are driven by live cross-sheet formulas
   * (e.g. `IF(Pricing!$I$29=...)`) that this workbook does not always save a cached result for,
   * so a naive reader (including an earlier hand-rolled XML pass over this same file) can
   * misread them as unresolved. The prose the router itself displays turned out to be a
   * reliable, formula-free signal instead: confirmed against every excluded row in both of
   * Job 20443's router workbooks. */
  active: boolean;
}

export interface ParsedRouter {
  sourceFile: string;
  sheetName: string;
  operations: RouterOperation[];
}

const EXCLUSION_PATTERN = /\bnot\s+selected\b|\bnot\s+required\b/i;

export async function parseRouter(absolutePath: string): Promise<ParsedRouter | null> {
  const workbook = await loadWorkbook(absolutePath);
  const sheet = workbook.worksheets.find((s) => /^master$/i.test(s.name.trim()));
  if (!sheet) return null;

  const operations: RouterOperation[] = [];

  for (let r = 1; r <= sheet.rowCount; r++) {
    const sequence = cellText(sheet.getRow(r).getCell(1));
    if (!/^\d{3,6}$/.test(sequence)) continue; // not an operation header row

    const label = cellText(sheet.getRow(r).getCell(2)).trim();
    const workCenter = cellText(sheet.getRow(r).getCell(12)).trim(); // col L
    // The row immediately below is only a note row if it isn't itself the next operation's
    // header (i.e. it has no sequence number of its own) — some operations have no note at all.
    const nextRowSequence = cellText(sheet.getRow(r + 1).getCell(1));
    const note = /^\d{3,6}$/.test(nextRowSequence) ? "" : cellText(sheet.getRow(r + 1).getCell(2)).trim();
    const combined = `${label} ${note}`;
    const active = !EXCLUSION_PATTERN.test(combined) && !/^no\s/i.test(label);

    operations.push({ sequence, label, note, workCenter, active });
  }

  return { sourceFile: path.basename(absolutePath), sheetName: sheet.name, operations };
}
