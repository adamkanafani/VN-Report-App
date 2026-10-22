import { promises as fs } from "fs";
import { PDFDocument } from "pdf-lib";
import { scanJobFolder } from "../ingest/scanJobFolder";
import { resolveReportTemplate } from "../report-templates";
import { loadJobState } from "../state/jobState";
import { renderReportSegments } from "./renderReportHtml";
import { htmlToPdf } from "./htmlToPdf";
import { toLongPath } from "../util/longPath";

const READ_RETRY_ATTEMPTS = 3;
const READ_RETRY_DELAY_MS = 500;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reads a file with a couple of short retries before giving up. Most of the time a failure here
 * is one of two things: the tech reps' mapped T:\ network share dropping or staling out an idle
 * connection, or (confirmed firsthand against a real 271-character path under a OneDrive-synced
 * job folder) the combined job-folder/exhibit path breaching Windows' classic 260-character
 * MAX_PATH -- toLongPath handles the latter outright, and the retry loop covers the former, which
 * a longer path alone wouldn't fix. Either way Node previously surfaced this as a bare `UNKNOWN:
 * unknown error, read` with no indication of which file it was even trying to read; the rethrown
 * error after retries names the actual file so it's actually actionable. */
async function readFileWithRetry(sourcePath: string): Promise<Buffer> {
  const longPath = toLongPath(sourcePath);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= READ_RETRY_ATTEMPTS; attempt++) {
    try {
      return await fs.readFile(longPath);
    } catch (err) {
      lastErr = err;
      if (attempt < READ_RETRY_ATTEMPTS) await delay(READ_RETRY_DELAY_MS * attempt);
    }
  }
  const reason = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`Couldn't read "${sourcePath}" after ${READ_RETRY_ATTEMPTS} attempts (${reason}). This is usually a dropped connection to a network drive -- browse to the file in File Explorer to reconnect it, then try generating the report again.`);
}

/** Copies every page of a source PDF onto `doc`, in order. Used for every real completed form or
 * after-the-fact exhibit renderReportSegments interleaves as a "pdf" segment -- each one's pages
 * land exactly where our own table/placeholder would have gone, by construction. */
async function appendPdfPages(doc: PDFDocument, sourcePath: string): Promise<void> {
  const bytes = await readFileWithRetry(sourcePath);
  // pdf-lib's load() rejects a Node Buffer outright ("provide binary data as Uint8Array, rather
  // than Buffer") despite Buffer being a Uint8Array subclass -- normalize explicitly.
  const srcDoc = await PDFDocument.load(new Uint8Array(bytes));
  const pages = await doc.copyPages(srcDoc, srcDoc.getPageIndices());
  pages.forEach((p) => doc.addPage(p));
}

export async function generateReportPdf(jobRoot: string, reportType?: string): Promise<{ buffer: Buffer; skippedAttachments: string[] }> {
  const scan = await scanJobFolder(jobRoot, resolveReportTemplate(reportType));
  const state = await loadJobState(jobRoot);
  const { segments, skippedAttachments } = await renderReportSegments(scan, state);

  // Build the report by rendering each HTML segment to its own small PDF (via puppeteer) and
  // copying in each "pdf" segment's real pages verbatim, in order -- so a completed source form
  // or after-the-fact exhibit's pages land exactly where renderReportSegments placed them (its
  // own scan.sections order, reflecting the tech rep's custom sectionOrder), with no separate
  // end-of-document pass and no need to locate anything in an already-rendered PDF afterward.
  const finalDoc = await PDFDocument.create();
  for (const segment of segments) {
    if (segment.kind === "html") {
      const pageBytes = await htmlToPdf(segment.html);
      const pageDoc = await PDFDocument.load(new Uint8Array(pageBytes));
      const pages = await finalDoc.copyPages(pageDoc, pageDoc.getPageIndices());
      pages.forEach((p) => finalDoc.addPage(p));
    } else {
      await appendPdfPages(finalDoc, segment.path);
    }
  }

  const finalBytes = await finalDoc.save();
  return { buffer: Buffer.from(finalBytes), skippedAttachments };
}
