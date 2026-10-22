export interface ParsedTable {
  sourceFile: string;
  sheetName: string;
  columns: string[];
  rows: Array<Record<string, string>>;
  /** Pre-computed or derived summary row(s) (label -> value per column). */
  summaryRows?: Array<Record<string, string>>;
  /** How many distinct buckets/serials actually have data in this table. */
  sampleSize: number;
  /** Total population for the job, when known (e.g. from the serial number list), for
   * comparison against sampleSize so a partial sample is visible, not silently implied full. */
  populationSize?: number;
  /** How many rows/buckets have at least one out-of-spec reading, if pass/fail was computed. */
  outOfSpecCount?: number;
  /** Assumptions, caveats, anything a reviewer should know before trusting this table. */
  notes: string[];
  /** The form's own header block (e.g. DS-0554's Customer/Date/Page/Insp/Cast P/N row), read
   * straight from the same source cells the real form prints — shown above the table so the
   * report matches the original form's layout instead of just the data grid. */
  formHeader?: Array<{ label: string; value: string }>;
  /** Freeform "NOTES:" box the real form prints under the table, for a reviewer's handwritten
   * remarks — kept as its own box (even when empty) rather than folded into `notes`, which are
   * this app's own automated caveats, not part of the original form. */
  hasNotesBox?: boolean;
}

/** Applies manually-entered cell corrections (see SectionState.tableEdits) on top of a
 * freshly-parsed table. Edits are keyed "<row index>:<column name>" against the table's own row
 * order — stable because a given section's table always comes from the same parser/source shape,
 * so the same row keeps the same index scan to scan. Returns a new table; never mutates the one
 * passed in, since callers (the review screen, report generation) also read the un-edited version. */
export function applyTableEdits(table: ParsedTable, edits: Record<string, string> | undefined): ParsedTable {
  if (!edits || Object.keys(edits).length === 0) return table;
  const rows = table.rows.map((row, i) => {
    let changed = false;
    const next = { ...row };
    for (const c of table.columns) {
      const key = `${i}:${c}`;
      if (Object.prototype.hasOwnProperty.call(edits, key)) {
        next[c] = edits[key];
        changed = true;
      }
    }
    return changed ? next : row;
  });
  return { ...table, rows };
}
