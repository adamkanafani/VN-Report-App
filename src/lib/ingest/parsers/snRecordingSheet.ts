import path from "path";
import { loadWorkbook, cellText } from "../excel";
import type { ParsedTable } from "./types";

/**
 * DS-0404 "SN Recording Sheet" -- another sub-sheet of the same Serial Number List workbook, for
 * a bucket's history from before it ever arrived at APG: prior job number(s) it was repaired
 * under (its own column appears twice -- a bucket can carry up to two prior-job markings), other
 * vendor/shop markings found on the part, and freeform comments. Layout (confirmed against Job
 * 20591): header row 8 (Position #, Previous Job # x2, Other Numbers, Comments); data starts
 * row 9; ends in a form-revision footer row (e.g. "DS-0404 revised 12/15/14") whose Position #
 * cell is text, not a number, so the same numeric-Position check that skips gaps also skips it.
 *
 * Real jobs only ever seem to use a subset of these four columns -- a job that only records prior
 * job numbers never touches Other Numbers or Comments at all. Columns that are empty across every
 * row this job actually has data for are dropped from the output table entirely (see
 * scanJobFolder.ts's caller), rather than printing blank columns nobody filled in.
 *
 * Same "blank is a valid, honest answer" reasoning as scrapReport.ts: most buckets on most jobs
 * have no prior-repair history at all, and a zero-row result here means exactly that, not that
 * parsing failed.
 */
export async function parseSNRecordingSheet(absolutePath: string): Promise<ParsedTable | null> {
  const workbook = await loadWorkbook(absolutePath);
  const sheet = workbook.worksheets.find((s) => /sn recording sheet|ds-?0404/i.test(s.name));
  if (!sheet) return null;

  const colIndex = { position: 1, prevJob1: 3, prevJob2: 5, otherNumbers: 7, comments: 9 };
  const allColumns = ["Position #", "Previous Job # (1)", "Previous Job # (2)", "Other Numbers", "Comments"];

  const allRows: Array<Record<string, string>> = [];
  for (let r = 9; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const position = cellText(row.getCell(colIndex.position));
    if (!/^\d+$/.test(position)) continue; // skips gaps and the trailing form-revision footer row

    allRows.push({
      "Position #": position,
      "Previous Job # (1)": cellText(row.getCell(colIndex.prevJob1)),
      "Previous Job # (2)": cellText(row.getCell(colIndex.prevJob2)),
      "Other Numbers": cellText(row.getCell(colIndex.otherNumbers)),
      Comments: cellText(row.getCell(colIndex.comments)),
    });
  }

  const populationSize = allRows.length;
  const dataColumns = allColumns.slice(1); // everything except the Position # anchor
  const historyRows = allRows.filter((r) => dataColumns.some((c) => r[c] !== ""));

  // Only keep columns that have at least one real value among the rows we're actually going to
  // show -- e.g. don't print an empty "Other Numbers" column when this job never used it.
  const usedColumns = dataColumns.filter((c) => historyRows.some((r) => r[c] !== ""));
  const columns = ["Position #", ...usedColumns];
  const rows = historyRows.map((r) => {
    const trimmed: Record<string, string> = { "Position #": r["Position #"] };
    for (const c of usedColumns) trimmed[c] = r[c];
    return trimmed;
  });

  return {
    sourceFile: path.basename(absolutePath),
    sheetName: sheet.name,
    columns,
    rows,
    sampleSize: rows.length,
    populationSize,
    notes:
      rows.length > 0
        ? [`${rows.length} of ${populationSize} buckets in this set have recorded prior-repair history or other markings.`]
        : [`No prior-repair history or other markings were recorded for this set.`],
  };
}
