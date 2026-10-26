import { promises as fs } from "fs";
import crypto from "crypto";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { PDFDocument } from "pdf-lib";
import type { JobScanResult } from "../ingest/scanJobFolder";
import type { JobState } from "../state/jobState";
import { reportSections, sectionExhibits, type ReportSegment } from "../pdf/renderReportHtml";
import { appendPdfPages } from "../pdf/generateReport";
import { htmlToPdf } from "../pdf/htmlToPdf";
import { readDeck } from "./readDeck";
import { sectionForTitle } from "../report-templates/titles";

const execFileAsync = promisify(execFile);

// Builds the finished PDF from the tech rep's own edited PowerPoint, the way Alfredo builds his
// today: the deck exported to PDF, with each block's real completed forms (DS sheets, NDT reports,
// heat treat charts, coating cert, ...) inserted right after its divider slide, and any customer
// front pages (Calpine's Repair Detail Summary) ahead of the cover -- confirmed page for page
// against his Job 20564 I&A and Repair Report PDFs. He can edit, reorder or delete slides freely;
// divider slides are found by their text, not their position.

// Opens read-only and exports without hidden slides, so PDF page N is the deck's Nth visible slide.
// Written to %TEMP% -- Office on APG machines won't save into other AppData folders (see
// excelExhibit.ts).
const EXPORT_PS1 = `
param([Parameter(Mandatory=$true)][string]$InputPath, [Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference = "Stop"
$ppt = New-Object -ComObject PowerPoint.Application
$pres = $null
try {
  $pres = $ppt.Presentations.Open($InputPath, -1, 0, 0)
  # ppSaveAsPDF = 32. Hidden slides are left out (PowerPoint's default), which the caller checks
  # by comparing the page count against the deck's visible slides.
  $pres.SaveAs($OutputPath, 32)
} finally {
  if ($pres) { $pres.Close() }
  $ppt.Quit()
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($ppt) | Out-Null
  [System.GC]::Collect()
}
`;

async function exportDeckToPdf(deckPath: string, pdfPath: string, workDir: string): Promise<void> {
  const script = path.join(workDir, "export-deck.ps1");
  await fs.writeFile(script, EXPORT_PS1, "utf8");
  try {
    await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-InputPath", deckPath, "-OutputPath", pdfPath], {
      timeout: 5 * 60_000,
    });
    await fs.access(pdfPath);
  } catch (err) {
    const detail = err instanceof Error ? err.message.split("\n").slice(-4).join(" ") : String(err);
    throw new Error(`PowerPoint couldn't export the deck to PDF. Make sure PowerPoint is installed and the file isn't open with unsaved changes. (${detail})`);
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9&]+/g, " ").trim();

async function appendSegments(doc: PDFDocument, segments: ReportSegment[]) {
  for (const segment of segments) {
    if (segment.kind === "pdf") {
      await appendPdfPages(doc, segment.path);
    } else {
      const pageDoc = await PDFDocument.load(new Uint8Array(await htmlToPdf(segment.html)));
      (await doc.copyPages(pageDoc, pageDoc.getPageIndices())).forEach((p) => doc.addPage(p));
    }
  }
}

export interface FinalFromDeckResult {
  buffer: Buffer;
  skippedAttachments: string[];
  /** Sections with exhibits whose divider slide wasn't found in the deck (renamed or deleted) --
   * their exhibits are left out, and the tech rep is told which. */
  unmatchedSections: string[];
}

export async function buildFinalPdfFromDeck(scan: JobScanResult, state: JobState, deck: Buffer): Promise<FinalFromDeckResult> {
  const workDir = path.join(os.tmpdir(), "VNReportApp-deck", crypto.randomUUID());
  await fs.mkdir(workDir, { recursive: true });
  try {
    const deckPath = path.join(workDir, "deck.pptx");
    const deckPdfPath = path.join(workDir, "deck.pdf");
    await fs.writeFile(deckPath, deck);
    const [slides] = await Promise.all([readDeck(deck), exportDeckToPdf(deckPath, deckPdfPath, workDir)]);
    const visible = slides.filter((s) => !s.hidden);
    const deckPdf = await PDFDocument.load(new Uint8Array(await fs.readFile(deckPdfPath)));
    if (deckPdf.getPageCount() !== visible.length) {
      throw new Error(`The exported deck has ${deckPdf.getPageCount()} pages but ${visible.length} visible slides -- can't line exhibits up with divider slides.`);
    }

    const sections = reportSections(scan, state);
    const exhibitSections = sections.filter((s) => s.generation !== "llm-narrative" && s.generation !== "llm-vision-select" && s.generation !== "template");
    const dividerSections = exhibitSections.filter((s) => !s.beforeCover);
    const used = new Set<string>();
    const skippedAttachments: string[] = [];

    const out = await PDFDocument.create();
    // Customer-supplied front pages first.
    for (const section of exhibitSections.filter((s) => s.beforeCover)) {
      const ex = await sectionExhibits(section, scan, state);
      skippedAttachments.push(...ex.skipped);
      await appendSegments(out, ex.segments);
    }
    for (const [i, slide] of visible.entries()) {
      const [page] = await out.copyPages(deckPdf, [i]);
      out.addPage(page);
      // A divider slide is one whose entire text is a section's title -- or another author's name
      // for the same block ("Flow Test" for "Incoming Air Flow", "Heat Treat Chart" for "...Charts";
      // see titles.ts) -- split over two lines or not.
      const section = slide.pictures === 0 && slide.text.length <= 60 ? (dividerSections.find((s) => norm(s.title) === norm(slide.text)) ?? sectionForTitle(dividerSections, slide.text)) : undefined;
      if (!section || used.has(section.id)) continue;
      used.add(section.id);
      const ex = await sectionExhibits(section, scan, state);
      skippedAttachments.push(...ex.skipped);
      await appendSegments(out, ex.segments);
    }

    const unmatched: string[] = [];
    for (const section of exhibitSections.filter((s) => !s.beforeCover && !used.has(s.id))) {
      const ex = await sectionExhibits(section, scan, state);
      if (ex.segments.length > 0) unmatched.push(section.title);
    }
    return { buffer: Buffer.from(await out.save()), skippedAttachments, unmatchedSections: unmatched };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
