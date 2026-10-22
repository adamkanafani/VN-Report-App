import path from "path";
import type { AutomationConfidence, GenerationStrategy, ReportTemplate, SectionConfig } from "../report-templates/types";
import { walkJobFolder, type JobFile } from "./fileWalk";
import { findCandidates } from "./matchSource";
import { resolveJobMetadata, type JobMetadata } from "./jobMetadata";
import { parseSerialNumberList } from "./parsers/serialNumberList";
import { parseHeightDimForm, HEIGHT_DIM_FORM_SHEET_PATTERN } from "./parsers/heightDimForm";
import { parseDovetailDimension, DOVETAIL_SHEET_PATTERN } from "./parsers/dovetailDimension";
import { parseZDropDimension, Z_DROP_SHEET_PATTERN } from "./parsers/zDropDimension";
import { parseWallThickness, WALL_THICKNESS_SHEET_PATTERN } from "./parsers/wallThickness";
import { parseScrapReport } from "./parsers/scrapReport";
import { parseSNRecordingSheet } from "./parsers/snRecordingSheet";
import { parseAirflowReport, AIRFLOW_SHEET_PATTERN } from "./parsers/airflowReport";
import { parseRouter, type ParsedRouter } from "./parsers/router";
import { parseRepairCds } from "./parsers/repairCds";
import { extractEmbeddedPhotos } from "./parsers/photoTemplatePdf";
import { xlsxHasEmbeddedImages, renderXlsxSheetToPdf } from "./parsers/xlsxToPdf";
import type { ParsedTable } from "./parsers/types";
import { identifyByContent } from "./contentIdentify";

export type SectionStatus = "ready" | "needs-attention" | "missing";

export interface SectionScanResult {
  id: string;
  title: string;
  generation: GenerationStrategy;
  automationConfidence: AutomationConfidence;
  alwaysReview?: boolean;
  dependsOnSections?: string[];
  status: SectionStatus;
  statusReason: string;
  matchedFiles: JobFile[];
  parsedTable?: ParsedTable;
  parsedRouter?: ParsedRouter;
  /** A print-ready PDF of the same completed form (see PRINT_PDF_SECTIONS) -- when one exists,
   * the report embeds this verbatim instead of our own re-rendered table, since the original
   * carries formatting, diagrams, and small details a re-parsed data table can't reproduce. */
  printPdfFile?: JobFile;
  /** Every file the tech rep has manually attached to this section (see manualAttachmentsFor),
   * regardless of whether it ended up being the one actually used -- shown in the review screen as
   * removable chips next to "Insert files manually", separate from matchedFiles (which is
   * whichever file(s) generation actually settled on). Always present (possibly empty) on a
   * file-backed section; absent on the llm-vision-select (Photo Set) and dependent-section
   * branches, which don't go through manualAttachmentsFor at all. */
  manualAttachments?: JobFile[];
}

export interface JobScanResult {
  jobRoot: string;
  reportType: string;
  metadata: JobMetadata;
  fileCount: number;
  sections: SectionScanResult[];
}

const TABLE_PARSERS: Record<string, (path: string) => Promise<ParsedTable | null>> = {
  serialNumberList: parseSerialNumberList,
  heightDimForm: parseHeightDimForm,
  dovetailDimension: parseDovetailDimension,
  zDropDimension: parseZDropDimension,
  wallThickness: parseWallThickness,
  airflowReport: parseAirflowReport,
  // Final Report's own dimensional re-checks -- same real form, same layout, just the
  // post-repair/final-stage workbook instead of the incoming one (confirmed against Job 18664:
  // "Final UT.xlsx" is the exact same "DS-0007 FA R1 wall thickness" sheet parseWallThickness
  // already handles, "Total Flow.xlsx" the exact same "Airflow Rpt" sheet parseAirflowReport
  // already handles, and "...heights FINAL.xlsx" the same APG#-anchored layout
  // parseHeightDimForm's content-based strategy already finds regardless of sheet name) -- no new
  // parsing logic needed, just a second section id pointed at the final-stage file.
  finalHeightDimForm: parseHeightDimForm,
  finalWallThickness: parseWallThickness,
  finalAirflowReport: parseAirflowReport,
  // Final Report's own as-shipped Serial Number List -- same DS-0554 sheet layout as the I&A
  // Report's own serialNumberList, just the final-stage workbook (see finalSerialNumberList's own
  // comment in final-report.ts). Missed on the first pass -- without this, the section matched its
  // file and showed "ready" from the generic fallback below, but rendered as an empty table since
  // nothing had actually parsed it (caught via a real PDF-outline diff against Job 18664).
  finalSerialNumberList: parseSerialNumberList,
};

// Sub-tabs of the SAME Serial Number List workbook serialNumberList already parses (see
// scrapReport.ts / snRecordingSheet.ts) -- matched by the same sourceRules/candidate file as
// that section, just reading a different sheet. Handled separately from TABLE_PARSERS above
// because a zero-row result from either of these is a real, honest answer (nothing scrapped,
// no prior history recorded) rather than a parsing failure -- TABLE_PARSERS' own loop treats
// zero rows as "try the next candidate, then fall back to needs-attention," which would be the
// wrong read here.
const OPTIONAL_SUBSHEET_PARSERS: Record<string, (path: string) => Promise<ParsedTable | null>> = {
  scrapReport: parseScrapReport,
  snRecordingSheet: parseSNRecordingSheet,
  // Final Report's own scrap/prior-history tabs -- confirmed against Job 18664: the "Final Ship
  // SN List" / "Final Scrap SN List" workbooks carry the exact same "DS-0554 serial number
  // sheet" / "DS-0404 SN Recording Sheet" / "DS-0554 Blade Bucket scrap" tabs as the incoming
  // workbook, just for the final/as-shipped set.
  finalScrapReport: parseScrapReport,
};

const ROUTER_SECTIONS = new Set(["fpiVisual", "recommendedRepairs"]);
// Sections that are just a real, completed exhibit slotted in verbatim -- no data to parse out of
// them at all, only a file to find (see ATTACH_AS_IS_NO_PARSE's own handling below). The Final
// Report ones (confirmed against Job 18664) are each their own standalone certification/checklist
// document, not something this app re-derives from source data the way the dimensional forms are.
const ATTACH_AS_IS_NO_PARSE = new Set([
  "chemTest",
  "crackMap",
  "metallurgicalReport",
  "preWeldHeatTreatChart",
  "postWeldHeatTreatChart",
  "postCoatHeatTreatChart",
  "finalAgeHeatTreatChart",
  "xRayInspection",
  "coatingCertification",
  "shotPeenAlSealStripCert",
  "damperPinCheck",
  "finalMomentWeigh",
  "finalNdt",
  "zNotchDimensions",
]);

// File types identifyByContent can actually be handed (a PDF as Claude's native document block,
// an image as a normal vision image block) when falling back to content-based identification.
const CONTENT_SCAN_EXTENSIONS = new Set([".pdf", ".jpg", ".jpeg", ".png"]);
// Where these exhibits actually turn up in practice (see chemTest's own preferFolder, and the
// same reasoning) -- tried first, not exclusively, so a job that keeps its paperwork somewhere
// else entirely still gets searched, just after the likelier spots.
const LIKELY_EXHIBIT_FOLDER = /reports|qa/i;

/** These forms exist on disk twice: an .xlsx we parse for data (dimensional pass/fail, the
 * sample size other narrative sections reference) and a completed, print-ready PDF of the exact
 * same form -- diagrams, colored callouts, and all. Serial Number List is deliberately excluded:
 * that one's report presentation is this app's own header/notes-box layout, not a PDF swap.
 * Airflow Report works the same way -- its own "Total Airflow ( Incoming )" PDF, when found, is
 * what the generated report actually embeds; the parsed table below is just the review preview.
 * Z-Drop Dimensions (2nd/3rd stage buckets only, no 1st-stage equivalent -- see
 * zDropDimension.ts) follows the same pattern. */
const PRINT_PDF_SECTIONS = new Set([
  "heightDimForm",
  "dovetailDimension",
  "zDropDimension",
  "wallThickness",
  "airflowReport",
  "finalHeightDimForm",
  "finalWallThickness",
  "finalAirflowReport",
]);

/** Which worksheet to render for each of PRINT_PDF_SECTIONS, when falling back to rendering the
 * data spreadsheet itself via Excel (see renderXlsxSheetToPdf) because no standalone PDF exists.
 * Matches each parser's own sheet-selection pattern so it's the same sheet either way. */
const PRINT_PDF_SHEET_PATTERNS: Record<string, RegExp> = {
  heightDimForm: HEIGHT_DIM_FORM_SHEET_PATTERN,
  dovetailDimension: DOVETAIL_SHEET_PATTERN,
  zDropDimension: Z_DROP_SHEET_PATTERN,
  wallThickness: WALL_THICKNESS_SHEET_PATTERN,
  airflowReport: AIRFLOW_SHEET_PATTERN,
  finalHeightDimForm: HEIGHT_DIM_FORM_SHEET_PATTERN,
  finalWallThickness: WALL_THICKNESS_SHEET_PATTERN,
  finalAirflowReport: AIRFLOW_SHEET_PATTERN,
};

// Shared with the /api/manual-attachment route, which is the only writer of this convention: a
// file the tech rep manually attached (because the automatic file-matching found nothing, or
// found the wrong thing) lives at "<jobRoot>/_Manual Attachments/<sectionId>/<filename>" -- a
// real file inside the job folder like any other, picked up by the normal walk below and
// associated with its section by folder path rather than by filename pattern. No separate
// storage or job-state field needed; a rescan is all it takes to pick one up.
const MANUAL_ATTACHMENTS_DIR = "_Manual Attachments";

function manualAttachmentsFor(sectionId: string, files: JobFile[]): JobFile[] {
  const prefix = `${MANUAL_ATTACHMENTS_DIR}/${sectionId}`;
  return files.filter((f) => f.folderPath === prefix);
}

/** Re-runs a section's own filename-pattern sourceRules but requiring a .pdf instead of its
 * usual spreadsheet extension, to find the completed print-ready form alongside the data
 * spreadsheet the app actually parses (see PRINT_PDF_SECTIONS). */
function findPrintPdf(section: SectionConfig, files: JobFile[]): JobFile | undefined {
  const pdfRules = section.sourceRules
    .filter((r): r is Extract<typeof r, { kind: "filenamePattern" }> => r.kind === "filenamePattern")
    .map((r) => ({ ...r, requiredExtensions: [".pdf"] }));
  const matches = findCandidates(pdfRules, files);
  return matches[0]?.candidates[0];
}

/** Scrap Report / SN Recording Sheet don't work like PRINT_PDF_SECTIONS above -- their own
 * sourceRules point at the Serial Number List workbook (the same one serialNumberList parses),
 * so swapping its extension to .pdf would just find Serial Number List's own PDF, not a scrap- or
 * other-number-specific one. These two need their own dedicated filename pattern for the real,
 * standalone print-ready export instead (confirmed against Job 20591: "...Serial Number List
 * SCRAP.pdf" and "...Serial OTHER Number List INCOMING.pdf" are both separate files from the
 * main "...INCOMING.xlsx"/"...INCOMING.pdf" pair). */
const OPTIONAL_SUBSHEET_PDF_PATTERNS: Record<string, RegExp> = {
  scrapReport: /ds-?0554.*scrap|serial.*number.*scrap|scrap.*serial/i,
  snRecordingSheet: /other.*number|serial.*other|sn.*recording/i,
  // Final Report's own scrap export -- confirmed against Job 18664: "SCRAP SN List 5-30-26.pdf",
  // a plainer name than the incoming-stage equivalent's, so the pattern is looser to match.
  finalScrapReport: /scrap.*(sn|serial|number)/i,
};

/** Best-effort vision-based fallback for a section's real exhibit when filename matching didn't
 * turn up a good candidate (see contentIdentify.ts's identifyByContent for what "good" means
 * here and why this degrades to nothing without an API key). `exclude` skips files already known
 * as filename-matched candidates, so a rescan doesn't re-spend a vision call on a file we've
 * already decided belongs to this section. */
async function findContentBasedMatches(sectionId: string, files: JobFile[], exclude: Set<string>) {
  const contentCandidates = files
    .filter((f) => CONTENT_SCAN_EXTENSIONS.has(f.ext))
    .filter((f) => !exclude.has(f.relativePath))
    .filter((f) => !/(^|\/)_/.test(f.folderPath) && !/pictures/i.test(f.folderPath))
    // Reports/QA folders are where these exhibits actually live in practice (same reasoning as
    // chemTest's own preferFolder) -- tried first so the concurrency cap in identifyByContent
    // spends itself on the likeliest candidates on a job with a lot of loose PDFs scattered around.
    .sort((a, b) => Number(!LIKELY_EXHIBIT_FOLDER.test(a.folderPath)) - Number(!LIKELY_EXHIBIT_FOLDER.test(b.folderPath)));
  return identifyByContent(sectionId, contentCandidates);
}

/** Some jobs never had a standalone print-ready PDF made at all -- the completed form (with its
 * measurement diagrams, callouts, etc.) exists only as pictures embedded directly in the data
 * spreadsheet itself. ExcelJS can read that sheet's cell values but has no rendering capability,
 * so when that's the only source available, this renders the sheet to a cached PDF via a real
 * Excel install instead of silently dropping those pictures and showing our own bare data table. */
async function renderEmbeddedXlsxAsPrintPdf(section: SectionConfig, xlsxPath: string, jobRoot: string): Promise<JobFile | undefined> {
  const sheetPattern = PRINT_PDF_SHEET_PATTERNS[section.id];
  if (!sheetPattern) return undefined;
  if (!(await xlsxHasEmbeddedImages(xlsxPath))) return undefined;
  const cacheDir = path.join(path.dirname(xlsxPath), "_Rendered PDFs");
  const rendered = await renderXlsxSheetToPdf(xlsxPath, sheetPattern, cacheDir);
  return rendered ? jobFileFromAbsolutePath(rendered, jobRoot) : undefined;
}

/** Builds a JobFile for a file that isn't a real member of the job folder walk — e.g. a photo
 * extracted from a template PDF into a cache folder alongside it. Mirrors fileWalk.ts's own
 * field conventions (forward-slash relative path, etc.) so it behaves like any other JobFile to
 * the rest of the pipeline (the photo-file API route, the PDF renderer, photo selection). */
function jobFileFromAbsolutePath(absolutePath: string, jobRoot: string): JobFile {
  const relativePath = path.relative(jobRoot, absolutePath).split(path.sep).join("/");
  const folderPath = path.dirname(relativePath) === "." ? "" : path.dirname(relativePath).split(path.sep).join("/");
  return { absolutePath, relativePath, baseName: path.basename(absolutePath), ext: path.extname(absolutePath).toLowerCase(), folderPath };
}

async function scanFileBackedSection(section: SectionConfig, files: JobFile[], jobRoot: string, metadata: JobMetadata): Promise<SectionScanResult> {
  const base = {
    id: section.id,
    title: section.title,
    generation: section.generation,
    automationConfidence: section.automationConfidence,
    alwaysReview: section.alwaysReview,
    // Computed unconditionally (cheap -- just a filter over the already-loaded file list) so every
    // return path below carries it automatically, regardless of which branch a given section takes
    // -- the review screen shows these as removable chips next to "Insert files manually"
    // (see manualAttachmentsFor's own comment for the on-disk convention).
    manualAttachments: manualAttachmentsFor(section.id, files),
  };

  if (section.generation === "llm-vision-select") {
    const folderRules = section.sourceRules.filter((r) => r.kind === "folderPattern");
    const folderMatches = findCandidates(folderRules, files);
    let photoFiles = folderMatches.flatMap((m) => m.candidates);
    let extractedFromTemplate = false;

    if (photoFiles.length === 0) {
      // No raw photo folder — fall back to a "photo template" PDF some tech reps paste incoming
      // photos into directly, instead of keeping loose image files.
      const templateRules = section.sourceRules.filter((r) => r.kind === "filenamePattern");
      const templateMatches = findCandidates(templateRules, files);
      const templateFile = templateMatches[0]?.candidates[0];
      if (templateFile) {
        const outDir = path.join(path.dirname(templateFile.absolutePath), "_Extracted Photos", path.basename(templateFile.baseName, templateFile.ext));
        try {
          const extractedPaths = await extractEmbeddedPhotos(templateFile.absolutePath, outDir);
          photoFiles = extractedPaths.map((p) => jobFileFromAbsolutePath(p, jobRoot));
          extractedFromTemplate = photoFiles.length > 0;
        } catch {
          // Malformed/encrypted PDF, etc. — fall through to "missing" below.
        }
      }
    }

    if (photoFiles.length === 0) {
      return { ...base, status: "missing", statusReason: "No photo folder or photo-template PDF found for this job.", matchedFiles: [] };
    }
    return {
      ...base,
      status: "ready",
      statusReason: `${photoFiles.length} candidate photo(s) found${extractedFromTemplate ? " (extracted from the photo-template PDF)" : ""}; selection always needs human confirmation.`,
      matchedFiles: photoFiles,
    };
  }

  // A file the tech rep manually attached because the automatic match found nothing (or found
  // the wrong thing) -- see manualAttachmentsFor's own comment. Treated as the highest-priority
  // candidate below, ahead of anything the filename/folder pattern rules turned up on their own,
  // since a human explicitly chose it. Same list as base.manualAttachments above -- reused here
  // rather than recomputed.
  const manualFiles = base.manualAttachments;
  const manualPdf = manualFiles.find((f) => f.ext === ".pdf");

  // Computed once, up front, regardless of whether the section's usual data spreadsheet is even
  // present -- a job can have the completed print-ready PDF (see PRINT_PDF_SECTIONS) without a
  // matching .xlsx at all (e.g. Wall Thickness data that only ever existed as a PDF for a given
  // job), and that PDF is still strictly better than showing "missing" or a table we made up.
  const printPdfFile = PRINT_PDF_SECTIONS.has(section.id) ? (findPrintPdf(section, files) ?? manualPdf) : undefined;

  const ruleMatches = findCandidates(section.sourceRules, files);
  if (manualFiles.length > 0) {
    // A manually-attached file can coincidentally also satisfy the section's own filename/folder
    // pattern (e.g. a tech rep sensibly naming it "... Met Report.pdf" for metallurgicalReport,
    // whose own pattern is exactly /met.*report/i) -- dedupe by relativePath so it doesn't show
    // up twice, once from each source, as the identical candidate.
    const manualPaths = new Set(manualFiles.map((f) => f.relativePath));
    if (ruleMatches.length > 0) {
      ruleMatches[0] = { ...ruleMatches[0], candidates: [...manualFiles, ...ruleMatches[0].candidates.filter((f) => !manualPaths.has(f.relativePath))] };
    } else {
      ruleMatches.push({ rule: section.sourceRules[0], candidates: manualFiles });
    }
  }
  if (ruleMatches.length === 0) {
    if (printPdfFile) {
      return {
        ...base,
        status: "ready",
        statusReason: `No data spreadsheet was found, but the completed form was found and will be embedded in the report as-is.`,
        matchedFiles: [printPdfFile],
        printPdfFile,
      };
    }

    // Filename matching found literally nothing -- before giving up, see if any PDF/image
    // elsewhere in the job folder is actually the exhibit under a generic name (a shop scanner's
    // own naming, not APG's convention). Only worth trying for the sections that are attached
    // verbatim rather than parsed: a data spreadsheet still has to match its own known column
    // layout to be usable, so a content guess wouldn't help those the way it can for "is this
    // PDF a crack map" -- something a vision call can answer even off a pure scanned image with
    // no text layer at all. Every match here is still surfaced as needing confirmation, never
    // silently trusted the way a filename match is (see the status below).
    if (ATTACH_AS_IS_NO_PARSE.has(section.id)) {
      const contentMatches = await findContentBasedMatches(section.id, files, new Set());
      if (contentMatches.length > 0) {
        return {
          ...base,
          status: "needs-attention",
          statusReason: `No file matched by name, but ${contentMatches.length} candidate${
            contentMatches.length > 1 ? "s were" : " was"
          } identified by its content instead — confirm this is the right exhibit before generating the report.`,
          matchedFiles: contentMatches.map((m) => m.file),
        };
      }
    }

    return { ...base, status: "missing", statusReason: "No matching source file found in the job folder.", matchedFiles: [] };
  }

  if (ROUTER_SECTIONS.has(section.id)) {
    for (const match of ruleMatches) {
      for (const candidate of match.candidates) {
        try {
          // Some customers' jobs have no repair-router file at all -- a "Repair CDS" reference
          // workbook stands in for Recommended Repairs on those (see repairCds.ts's own comment);
          // tried second since the vast majority of jobs are router-based and CDS's own real
          // sheets simply won't be there for them, so this always falls through cheaply.
          const parsed = (await parseRouter(candidate.absolutePath)) ?? (await parseRepairCds(candidate.absolutePath, metadata));
          if (parsed && parsed.operations.length > 0) {
            const activeCount = parsed.operations.filter((o) => o.active).length;
            return {
              ...base,
              status: "ready",
              statusReason: `${activeCount} of ${parsed.operations.length} router operations are in scope for this job.`,
              matchedFiles: [candidate],
              parsedRouter: parsed,
            };
          }
        } catch {
          // try the next candidate
        }
      }
    }
    return {
      ...base,
      status: "needs-attention",
      statusReason: "Found a router file but could not read any operations from its Master sheet.",
      matchedFiles: ruleMatches[0].candidates.slice(0, 1),
    };
  }

  const optionalSubsheetParser = OPTIONAL_SUBSHEET_PARSERS[section.id];
  if (optionalSubsheetParser) {
    // A manually-attached file (see manualPdf/manualFiles above) is an explicit human override --
    // embed it outright, same as every other manually-attached section, without waiting on the
    // xlsx tab to also show real rows. The tech rep attaching one here almost always means the
    // xlsx side wasn't giving the right answer (or didn't have this tab at all), so gating it
    // behind that same parse would defeat the point of overriding it.
    if (manualPdf) {
      return {
        ...base,
        status: "ready",
        statusReason: `Manually attached: "${manualPdf.relativePath}" will be embedded in the report as-is.`,
        matchedFiles: [manualPdf],
        printPdfFile: manualPdf,
      };
    }

    // A real, standalone print-ready export of this exact tab -- separate file from the workbook
    // itself (see OPTIONAL_SUBSHEET_PDF_PATTERNS' own comment). Found up front, same as
    // PRINT_PDF_SECTIONS elsewhere, but only actually used below once there's real data to show:
    // embedding it over a genuinely blank tab would print a page nobody asked for.
    const pdfPattern = OPTIONAL_SUBSHEET_PDF_PATTERNS[section.id];
    const subsheetPrintPdf = pdfPattern ? files.find((f) => f.ext === ".pdf" && pdfPattern.test(f.baseName)) : undefined;

    for (const match of ruleMatches) {
      for (const candidate of match.candidates) {
        try {
          const parsed = await optionalSubsheetParser(candidate.absolutePath);
          if (!parsed) continue; // this candidate's workbook doesn't have the tab at all -- try the next one
          // Unlike TABLE_PARSERS below, a zero-row result here is a real, honest answer (nothing
          // scrapped yet, no prior history recorded) rather than a parsing failure -- see
          // scrapReport.ts / snRecordingSheet.ts's own comments.
          const hasData = parsed.rows.length > 0;
          const embedPdf = hasData ? subsheetPrintPdf : undefined;
          return {
            ...base,
            status: "ready",
            statusReason: hasData
              ? embedPdf
                ? `Parsed ${parsed.rows.length} row(s) from "${candidate.relativePath}"; the completed form will be embedded in the report as-is.`
                : `Parsed ${parsed.rows.length} row(s) from "${candidate.relativePath}".`
              : `Found "${candidate.relativePath}", but this tab is currently blank for this job.`,
            matchedFiles: embedPdf ? [embedPdf] : [candidate],
            parsedTable: parsed,
            printPdfFile: embedPdf,
          };
        } catch {
          // try the next candidate
        }
      }
    }
    // The workbook itself was found (ruleMatches is non-empty, or scanFileBackedSection would
    // have returned "missing" already above) but none of its candidates had this specific tab --
    // an older workbook revision without a Scrap or SN Recording Sheet tab. That's genuinely
    // "missing" (the capability isn't in this job's workbook), distinct from "blank" (the tab
    // exists but has nothing recorded in it yet).
    return {
      ...base,
      status: "missing",
      statusReason: "This job's Serial Number List workbook doesn't have this tab.",
      matchedFiles: [],
    };
  }

  if (ATTACH_AS_IS_NO_PARSE.has(section.id)) {
    let candidates = ruleMatches[0].candidates;
    // A filename match existing doesn't guarantee it's the *right* file -- e.g. a Purchase
    // Requisition can share enough wording with the real exhibit's naming convention to match by
    // accident, while the actual vendor cert sits under a completely generic scan filename
    // elsewhere. Run the same content-based check used for the zero-match case here too, so the
    // real exhibit still surfaces as an option even when a wrong (but plausible-looking) filename
    // match already exists -- merged in and deduped rather than replacing the filename match, so
    // the tech rep sees both and picks.
    const contentMatches = await findContentBasedMatches(
      section.id,
      files,
      new Set(candidates.map((f) => f.relativePath))
    );
    if (contentMatches.length > 0) {
      candidates = [...candidates, ...contentMatches.map((m) => m.file)];
    }

    const candidate = candidates[0];
    const ambiguous = candidates.length > 1;
    return {
      ...base,
      status: ambiguous ? "needs-attention" : "ready",
      statusReason: ambiguous
        ? `${candidates.length} candidate files matched; using "${candidate.relativePath}" by default — pick the right one below.`
        : `Matched "${candidate.relativePath}".`,
      // All of them, not just the auto-pick -- the review screen lets the tech rep choose among
      // these directly (see AttachAsIs / selectedAttachmentPath) instead of only ever seeing
      // whichever one this heuristic happened to land on.
      matchedFiles: candidates,
    };
  }

  const parser = TABLE_PARSERS[section.id];
  if (parser) {
    for (const match of ruleMatches) {
      for (const candidate of match.candidates) {
        try {
          const parsed = await parser(candidate.absolutePath);
          if (parsed && parsed.rows.length > 0) {
            // No standalone print-ready PDF on disk -- if this same spreadsheet has its own
            // embedded pictures (measurement diagrams, callouts), render that sheet to a PDF via
            // Excel rather than dropping those pictures and showing just our own data table.
            const resolvedPrintPdf = printPdfFile ?? (await renderEmbeddedXlsxAsPrintPdf(section, candidate.absolutePath, jobRoot));
            return {
              ...base,
              status: "ready",
              statusReason: resolvedPrintPdf
                ? `Parsed ${parsed.rows.length} row(s) from "${candidate.relativePath}"; the completed form will be embedded in the report as-is.`
                : `Parsed ${parsed.rows.length} row(s) from "${candidate.relativePath}".`,
              matchedFiles: [candidate],
              parsedTable: parsed,
              printPdfFile: resolvedPrintPdf,
            };
          }
        } catch {
          // try the next candidate — e.g. a same-named blank template
        }
      }
    }
    // The spreadsheet exists but every candidate was blank/unreadable -- if the completed PDF is
    // still there, use that rather than reporting "needs attention" over a form the report was
    // never going to need data out of anyway.
    if (printPdfFile) {
      return {
        ...base,
        status: "ready",
        statusReason: `The data spreadsheet appears blank or unreadable, but the completed form was found and will be embedded in the report as-is.`,
        matchedFiles: [printPdfFile],
        printPdfFile,
      };
    }
    return {
      ...base,
      status: "needs-attention",
      statusReason: "Found a matching file, but it appears to be blank or in an unexpected format.",
      matchedFiles: ruleMatches[0].candidates.slice(0, 1),
    };
  }

  // Fallback for any section without a bespoke parser or special-case above.
  const candidate = ruleMatches[0].candidates[0];
  return { ...base, status: "ready", statusReason: `Matched "${candidate.relativePath}".`, matchedFiles: [candidate] };
}

function scanDependentSection(section: SectionConfig, resolved: Map<string, SectionScanResult>): SectionScanResult {
  const base = {
    id: section.id,
    title: section.title,
    generation: section.generation,
    automationConfidence: section.automationConfidence,
    alwaysReview: section.alwaysReview,
    dependsOnSections: section.dependsOnSections,
    matchedFiles: [] as JobFile[],
  };
  const deps = (section.dependsOnSections ?? []).map((id) => resolved.get(id)).filter(Boolean) as SectionScanResult[];
  if (deps.length === 0) {
    return { ...base, status: "missing", statusReason: "No dependent sections were resolved." };
  }
  if (deps.every((d) => d.status === "ready")) {
    return { ...base, status: "ready", statusReason: "All source sections are ready to synthesize from." };
  }
  if (deps.some((d) => d.status !== "missing")) {
    return {
      ...base,
      status: "needs-attention",
      statusReason: `Can draft a partial summary, but ${deps.filter((d) => d.status !== "ready").map((d) => d.title).join(", ")} need attention first.`,
    };
  }
  return { ...base, status: "missing", statusReason: "None of the source sections this depends on are available." };
}

export async function scanJobFolder(jobRoot: string, template: ReportTemplate): Promise<JobScanResult> {
  const files = await walkJobFolder(jobRoot);
  const metadata = await resolveJobMetadata(jobRoot, files);

  const resolved = new Map<string, SectionScanResult>();

  // Pass 1: sections backed directly by files (or job metadata).
  for (const section of template.sections) {
    if (section.generation === "template") {
      resolved.set(section.id, {
        id: section.id,
        title: section.title,
        generation: section.generation,
        automationConfidence: section.automationConfidence,
        status: "ready",
        statusReason: `From ${metadata.source}.`,
        matchedFiles: [],
      });
      continue;
    }
    if (section.dependsOnSections) continue; // pass 2
    resolved.set(section.id, await scanFileBackedSection(section, files, jobRoot, metadata));
  }

  // Pass 2: sections synthesized from other sections' results.
  for (const section of template.sections) {
    if (!section.dependsOnSections) continue;
    resolved.set(section.id, scanDependentSection(section, resolved));
  }

  // Preserve the template's declared section order in the result.
  const sections = template.sections.map((s) => resolved.get(s.id)!);

  return { jobRoot, reportType: template.reportType, metadata, fileCount: files.length, sections };
}
