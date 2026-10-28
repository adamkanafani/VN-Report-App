import crypto from "crypto";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { loadWorkbook, cellText } from "../ingest/excel";
import { renderXlsxSheetToPdf } from "../ingest/parsers/xlsxToPdf";
import { toLongPath } from "../util/longPath";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Which sheet of an exhibit workbook is this job's. Most DS sheets have exactly one, but the NDT
 * workbooks (DS-0688 core/cover sign-off) carry one sheet per turbine model -- "F7EA 1ST NOZZLE",
 * "F7FA 2ND NOZZLE", "W501D5A ROW 3 VANES", ... -- with only the job's own sheet filled in, its job
 * number in the header (M1). So: the first visible sheet whose top rows mention the job number,
 * else the first visible sheet. */
async function pickSheet(xlsxPath: string, jobNumber: string): Promise<string | undefined> {
  try {
    const workbook = await loadWorkbook(xlsxPath);
    const visible = workbook.worksheets.filter((s) => s.state !== "hidden" && s.state !== "veryHidden");
    if (jobNumber) {
      for (const sheet of visible) {
        for (let r = 1; r <= 6; r++) {
          const row = sheet.getRow(r);
          for (let c = 1; c <= 20; c++) if (cellText(row.getCell(c)).includes(jobNumber)) return sheet.name;
        }
      }
    }
    return visible[0]?.name;
  } catch {
    return undefined;
  }
}

/** Prints a spreadsheet-only exhibit (no PDF of it in the job folder) to PDF through the local
 * Excel install, for embedding in the report like any other exhibit. Cached under the Windows temp
 * folder -- never written into the job folder itself -- and reused until the source workbook
 * changes. (Temp specifically: on APG machines Excel's ExportAsFixedFormat fails with "Document not
 * saved" when writing anywhere else under AppData\Local, e.g. next to the job-state files.) Returns
 * null if Excel isn't available or the print fails; the caller reports the file as skipped rather
 * than failing the whole report. */
export async function excelExhibitToPdf(xlsxPath: string, jobNumber: string): Promise<string | null> {
  const sheet = await pickSheet(xlsxPath, jobNumber);
  const cacheDir = path.join(os.tmpdir(), "VNReportApp-rendered", crypto.createHash("sha256").update(xlsxPath).digest("hex").slice(0, 16));
  // Excel can't open a workbook whose full path is over 218 characters ("Unable to get the Open
  // property of the Workbooks class") -- and job folder paths routinely are, on T: and even more so
  // in a OneDrive copy. So Excel always opens a short-path copy in the cache folder, refreshed
  // whenever the original changes (its timestamp is carried over, which keeps the PDF cache valid).
  let source: string;
  try {
    await fs.mkdir(cacheDir, { recursive: true });
    const original = await fs.stat(toLongPath(xlsxPath));
    source = path.join(cacheDir, `source${path.extname(xlsxPath)}`);
    const copy = await fs.stat(source).catch(() => null);
    if (!copy || Math.abs(copy.mtimeMs - original.mtimeMs) > 1000) {
      await fs.copyFile(toLongPath(xlsxPath), source);
      await fs.utimes(source, original.atime, original.mtime);
    }
  } catch {
    return null;
  }
  return renderXlsxSheetToPdf(source, sheet ? new RegExp(`^${escapeRegExp(sheet)}$`) : /.^/, cacheDir);
}
