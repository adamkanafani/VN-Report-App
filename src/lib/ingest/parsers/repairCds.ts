import path from "path";
import { loadWorkbook, cellText } from "../excel";
import type { ParsedRouter } from "./router";
import type { JobMetadata } from "../jobMetadata";

/**
 * "Repair CDS" ("Condition Data Sheet") workbook -- confirmed against Job 20436 (3rd stage
 * buckets, customer APS), the source for Recommended Repairs when a job has no repair-router
 * file at all (none of this customer's jobs seem to use one). This is nothing like a router: it's
 * a single company-wide reference workbook covering a whole engine's worth of part types (fuel
 * nozzles, liners, xfire tubes, bullhorns, R1N/R2N/R3N nozzles, R1S/R2S/R3S stator blades,
 * R1B/R2B/R3B buckets, ...), not a job-specific operation sequence -- so this picks out just the
 * bucket-row sheets relevant to the current job (by parsing the "1st/2nd/3rd stage" ordinal out
 * of the job's own metadata into an "R<n>B" suffix) and reads two things from them:
 *
 * - A "<suffix> details" sheet, whose row 10 (found by its "Inspect & Advise Scope" label, not a
 *   fixed row) headers a shared step list plus three scope tiers ("Light"/"Average"/"Heavy" on
 *   this job -- the exact wording isn't assumed) side by side.
 * - A "F7EA <suffix> repair backup" sheet with two tables: which of those three scope tiers is
 *   actually selected for this job (a "Base scopes" table with a lone "Y" in its own "Selected"
 *   column, matched to the details sheet's tiers by left-to-right/top-to-bottom position, since
 *   the two sheets don't even use the same names for the tiers -- "Minor/Average/Major repair"
 *   here vs "Light/Average/Heavy Repair" there), and which individual add-on options were also
 *   selected (a separate "Workscope Options" table, same "Y"-in-"Selected" convention).
 *
 * Combines the shared steps + the selected tier's steps + the selected options into one ordered
 * list and returns it in the same ParsedRouter shape a real router produces, so it flows through
 * the exact same Recommended Repairs drafting this app already has -- the step wording here is
 * this workbook's own terse category labels, not the fuller hand-written phrasing a real
 * completed report for this same job used, so a tech rep should expect to polish it (the same
 * "Revise with instruction" pass a router-sourced job would use for customer-facing wording).
 *
 * Verified against exactly one real job so far -- if another job's Repair CDS turns out to lay
 * its tables out differently, this should fail closed (return null) rather than misread it, which
 * every step below is written to do.
 */
// Word order varies -- confirmed against two real jobs: "Repair CDS.xlsm" (Job 20436) and "CDS
// Repair.xlsm" (Job 20668, a different customer unit/contract) both name the same kind of file.
export const REPAIR_CDS_PATTERN = /repair\s*cds|cds\s*repair/i;

function stageSuffix(metadata: JobMetadata): string | null {
  const text = `${metadata.component} ${metadata.part}`;
  const match = text.match(/(\d)(?:st|nd|rd|th)\s*stage/i);
  return match ? `R${match[1]}B` : null;
}

/** Resolves a cell that may be a plain value or (as most cells in this workbook are) a formula
 * referencing another sheet -- cellText already unwraps a formula's cached `.result`, this just
 * documents why that matters here specifically: almost every cell this parser reads is a
 * cross-sheet reference, not a literal value. */
function text(sheet: import("exceljs").Worksheet, row: number, col: number): string {
  return cellText(sheet.getRow(row).getCell(col)).trim();
}

interface SelectedTable {
  selectedCol: number;
  rows: number[]; // in top-to-bottom order
}

/** Finds a small table of rows each flagged "Y"/blank in their own "Selected" column, anchored by
 * a section-label cell in column 3 -- used for both "Base scopes" (3 fixed tier rows) and
 * "Workscope Options" (a variable-length list) on the one real workbook this was built against.
 * The two don't actually share a layout, confirmed directly: "Base scopes"' own row also carries
 * the "Selected" header in the same row (not a row below it), while "Workscope Options" has no
 * "Selected" header of its own at all -- its rows just reuse whichever column the base-scopes
 * table already established. `knownSelectedCol` lets the options-table call reuse that column
 * instead of searching for a header that was never actually there. */
function findSelectedTable(sheet: import("exceljs").Worksheet, sectionLabelPattern: RegExp, rowLimit: number, knownSelectedCol?: number): SelectedTable | null {
  for (let r = 1; r <= Math.min(rowLimit, sheet.rowCount); r++) {
    if (!sectionLabelPattern.test(text(sheet, r, 3))) continue;

    let selectedCol = knownSelectedCol ?? -1;
    if (selectedCol === -1) {
      // Search the label's own row first (that's where "Base scopes" actually keeps it), then a
      // couple of rows below in case a future workbook lays it out that way instead.
      for (let hr = r; hr <= Math.min(r + 3, sheet.rowCount) && selectedCol === -1; hr++) {
        for (let c = 1; c <= 14; c++) {
          if (/^selected$/i.test(text(sheet, hr, c))) {
            selectedCol = c;
            break;
          }
        }
      }
    }
    if (selectedCol === -1) return null;

    const rows: number[] = [];
    for (let dr = r + 1; dr <= sheet.rowCount; dr++) {
      if (text(sheet, dr, 3) === "" && text(sheet, dr, 1) === "") break; // blank row ends the table
      rows.push(dr);
    }
    return { selectedCol, rows };
  }
  return null;
}

export async function parseRepairCds(absolutePath: string, metadata: JobMetadata): Promise<ParsedRouter | null> {
  const suffix = stageSuffix(metadata);
  if (!suffix) return null;

  const workbook = await loadWorkbook(absolutePath);
  const detailsSheet = workbook.worksheets.find((s) => new RegExp(`${suffix}\\s+details`, "i").test(s.name.trim()));
  const backupSheet = workbook.worksheets.find((s) => new RegExp(`${suffix}\\s+repair\\s+backup`, "i").test(s.name.trim()));
  if (!detailsSheet || !backupSheet) return null;

  // Which of the 3 base-scope tiers (Minor/Average/Major, or however this job's workbook labels
  // them) is selected for this job -- by row position within the table, not by name, since the
  // details sheet uses different tier names than the backup sheet does.
  const baseScopes = findSelectedTable(backupSheet, /^base scopes$/i, 20);
  if (!baseScopes || baseScopes.rows.length === 0) return null;
  const selectedTierIndex = baseScopes.rows.findIndex((r) => text(backupSheet, r, baseScopes.selectedCol) === "Y");
  if (selectedTierIndex === -1) return null; // quote not yet finalized -- nothing to draft from

  // The details sheet's own header row: "Inspect & Advise Scope" (shared steps, every tier gets
  // these) followed by the tier columns, left to right, in the same order as the tier rows above
  // -- found by that anchor text, not a fixed row/column. Capped to the same count as the
  // base-scopes table's own row count (rather than "every non-blank column to the right", which
  // would also catch this sheet's own "Options" column -- a real column, just not a repair tier).
  let detailsHeaderRow = -1;
  let sharedCol = -1;
  const tierCols: number[] = [];
  for (let r = 1; r <= Math.min(20, detailsSheet.rowCount); r++) {
    for (let c = 1; c <= 14; c++) {
      if (/^inspect\s*&\s*advise\s*scope$/i.test(text(detailsSheet, r, c))) {
        sharedCol = c;
        detailsHeaderRow = r;
      }
    }
    if (sharedCol !== -1) {
      for (let c = sharedCol + 1; c <= 14 && tierCols.length < baseScopes.rows.length; c++) {
        if (text(detailsSheet, r, c) !== "") tierCols.push(c);
      }
      break;
    }
  }
  if (sharedCol === -1 || tierCols.length <= selectedTierIndex) return null;
  const tierCol = tierCols[selectedTierIndex];

  // A hard backstop for where the real step lists end: "Shop manhours" is this sheet's own next
  // labeled row after them (a labor-hours summary, not a step). Needed because the shared column
  // specifically has real steps (rows 12-17 on the one real job this was built against) followed,
  // after a blank gap, by unrelated footnote prose in that SAME column -- reading blindly to the
  // bottom of the sheet would fold that footnote in as if it were more repair steps.
  let shopManhoursRow = detailsSheet.rowCount + 1;
  for (let r = detailsHeaderRow + 1; r <= detailsSheet.rowCount; r++) {
    if (/^shop\s*manhours$/i.test(text(detailsSheet, r, 1))) {
      shopManhoursRow = r;
      break;
    }
  }

  const readColumn = (col: number): string[] => {
    const values: string[] = [];
    for (let r = detailsHeaderRow + 1; r < shopManhoursRow; r++) {
      const v = text(detailsSheet, r, col);
      if (!v) continue;
      if (/^note\s*:/i.test(v)) break; // footnote prose, not a step -- stop this column here
      values.push(v);
    }
    return values;
  };

  const steps = [...readColumn(sharedCol), ...readColumn(tierCol)];

  // Individually-selected add-on options, from the same "Selected" convention in two more small
  // tables on the backup sheet ("Workscope Options" and "Coating options") -- these are real,
  // separately-priced scope items (Z-notch prep, cutter tooth removal, rail coating, ...) the
  // tech rep chose in addition to the base repair tier above.
  for (const pattern of [/^workscope options$/i, /^coating options$/i]) {
    const table = findSelectedTable(backupSheet, pattern, 30, baseScopes.selectedCol);
    if (!table) continue;
    for (const r of table.rows) {
      if (text(backupSheet, r, table.selectedCol) !== "Y") continue;
      const label = text(backupSheet, r, 1);
      if (label && !/is not an option/i.test(label)) steps.push(label);
    }
  }

  if (steps.length === 0) return null;

  return {
    sourceFile: path.basename(absolutePath),
    sheetName: `${detailsSheet.name} / ${backupSheet.name}`,
    operations: steps.map((label, i) => ({
      sequence: String(i + 1),
      label,
      note: "",
      workCenter: "",
      active: true,
    })),
  };
}
