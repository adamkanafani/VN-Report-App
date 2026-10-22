import path from "path";
import { loadWorkbook, cellText } from "../excel";
import type { ParsedTable } from "./types";

/**
 * DS-0554's "scrap" tab -- a sub-sheet of the same Serial Number List workbook, not a separate
 * file. Layout (confirmed against Job 20591): sheet name contains "blade bucket scrap"; header
 * row 8 (APG #, Serial #, Scrap Reason, I&A, Pre-Weld, Post-Weld, Coat, Coat/Final -- the last
 * five are "place an X in the pertinent column" markers for which stage the part was scrapped
 * at, per row 6/7's own instructions); data starts row 9. Serial # is itself a formula reference
 * back into the main "...serial number sheet" tab (same bucket list, same row order), so every
 * bucket in the job always has a row here whether or not it was actually scrapped -- only the
 * ones with a Scrap Reason or a stage marker filled in are real scrap determinations. The sheet
 * also ends in a COUNTIF-formula totals row (blank APG #/Serial #) that must not be read as a
 * 93rd bucket.
 *
 * Jonathan's workflow (review indications/photos -> physically verify the part -> determine
 * scrap -> update this tab -> generate the report) means this genuinely starts out all-blank for
 * a job and fills in as review happens -- a blank result here is not a parsing failure, it's an
 * honest "nothing scrapped yet" (or "nothing ever will be"), and the caller (scanJobFolder.ts)
 * is expected to treat a zero-row result as valid, not as "needs attention."
 */
export async function parseScrapReport(absolutePath: string): Promise<ParsedTable | null> {
  const workbook = await loadWorkbook(absolutePath);
  const sheet = workbook.worksheets.find((s) => /blade bucket scrap|ds-?0554.*scrap/i.test(s.name));
  if (!sheet) return null;

  const columns = ["APG #", "Serial #", "Scrap Reason", "I&A", "Pre-Weld", "Post-Weld", "Coat", "Coat/Final"];
  const colIndex = { apg: 1, serial: 2, reason: 3, ia: 4, preWeld: 5, postWeld: 6, coat: 7, coatFinal: 8 };

  const allRows: Array<Record<string, string>> = [];
  for (let r = 9; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const apgNum = cellText(row.getCell(colIndex.apg));
    // A mid-job bucket replacement gets a letter suffix instead of a new number (e.g. "78R") --
    // only a leading digit run is required, not a pure integer, so that row isn't dropped outright
    // (see serialNumberList.ts's identical fix for the same DS-0554 "APG #" column convention).
    if (!/^\d+/.test(apgNum)) continue; // skips gaps and the trailing COUNTIF totals row

    allRows.push({
      "APG #": apgNum,
      "Serial #": cellText(row.getCell(colIndex.serial)),
      "Scrap Reason": cellText(row.getCell(colIndex.reason)),
      "I&A": cellText(row.getCell(colIndex.ia)),
      "Pre-Weld": cellText(row.getCell(colIndex.preWeld)),
      "Post-Weld": cellText(row.getCell(colIndex.postWeld)),
      Coat: cellText(row.getCell(colIndex.coat)),
      "Coat/Final": cellText(row.getCell(colIndex.coatFinal)),
    });
  }

  const populationSize = allRows.length;
  // Only the buckets with an actual scrap call recorded -- everyone else in the sheet is just
  // the un-scrapped rest of the set, carried along by the same formula reference as everyone else.
  const scrapRows = allRows.filter((r) => columns.slice(2).some((c) => r[c] !== ""));

  return {
    sourceFile: path.basename(absolutePath),
    sheetName: sheet.name,
    columns,
    rows: scrapRows,
    sampleSize: scrapRows.length,
    populationSize,
    // Per tech rep feedback, the generated report no longer prints a "N of M buckets have a scrap
    // determination recorded" line under this table -- the table itself (zero rows when nothing's
    // been scrapped yet) already says that.
    notes: [],
  };
}
