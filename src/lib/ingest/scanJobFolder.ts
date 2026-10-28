import path from "path";
import { promises as fs } from "fs";
import { toLongPath } from "../util/longPath";
import type { AutomationConfidence, GenerationStrategy, ReportTemplate, SectionConfig } from "../report-templates/types";
import { walkJobFolder, type JobFile } from "./fileWalk";
import { findCandidates } from "./matchSource";
import { resolveJobMetadata, type JobMetadata } from "./jobMetadata";
import { readJobMeasurements, type JobMeasurements } from "./measurements";
import { parseRouter, normalizeFormNumber, type ParsedRouter } from "./parsers/router";
import { extractEmbeddedPhotos } from "./parsers/photoTemplatePdf";
import type { ParsedTable } from "./parsers/types";
import { identifyByContent } from "./contentIdentify";
import { IA_ROUTER_RULES, REPAIR_ROUTER_RULES } from "../report-templates/vn-rules";

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
  /** attach-multi sections: which of matchedFiles start out selected, in report order (see
   * SectionConfig.preselectPattern). The tech rep's own SectionState.selectedAttachmentPaths, once
   * saved, replaces this. */
  defaultSelectedPaths?: string[];
  /** Copied from SectionConfig for the renderer / review screen. */
  divider?: boolean;
  beforeCover?: boolean;
  defaultExcluded?: boolean;
  custom?: boolean;
  aliases?: string[];
}

export interface JobScanResult {
  jobRoot: string;
  reportType: string;
  metadata: JobMetadata;
  /** Received date + area / throat / flow values read from this job's own sheets, for the drafts. */
  measurements: JobMeasurements;
  fileCount: number;
  sections: SectionScanResult[];
}

const TABLE_PARSERS: Record<string, (path: string) => Promise<ParsedTable | null>> = {
};

// Narrative sections drafted from a router workbook: the Incoming Engineering Summary from the I&A
// router (which DS forms / inspections were called for), Repair Recommendations and Repair Summary
// from the repair router (the repair op sequence).
const ROUTER_SECTIONS = new Set(["engineeringSummary", "repairRecommendations", "repairSummary"]);
// Single-file exhibits slotted in verbatim -- no data to parse, only a file to find.
const ATTACH_AS_IS_NO_PARSE = new Set(["metallurgicalReport"]);

// File types identifyByContent can actually be handed (a PDF as Claude's native document block,
// an image as a normal vision image block) when falling back to content-based identification.
const CONTENT_SCAN_EXTENSIONS = new Set([".pdf", ".jpg", ".jpeg", ".png"]);
// Where these exhibits actually turn up in practice -- tried first, not exclusively.
const LIKELY_EXHIBIT_FOLDER = /7 reports|7a|reports|qa/i;

/** These forms exist on disk twice: an .xlsx we parse for data and a completed, print-ready PDF of
 * the exact same form. The real V&N reports embed the DS-0404 print itself after its divider. */
const PRINT_PDF_SECTIONS = new Set<string>();

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

/** Builds a JobFile for a file that isn't a real member of the job folder walk — e.g. a photo
 * extracted from a template PDF into a cache folder alongside it. Mirrors fileWalk.ts's own
 * field conventions (forward-slash relative path, etc.) so it behaves like any other JobFile to
 * the rest of the pipeline (the photo-file API route, the PDF renderer, photo selection). */
function jobFileFromAbsolutePath(absolutePath: string, jobRoot: string): JobFile {
  const relativePath = path.relative(jobRoot, absolutePath).split(path.sep).join("/");
  const folderPath = path.dirname(relativePath) === "." ? "" : path.dirname(relativePath).split(path.sep).join("/");
  return { absolutePath, relativePath, baseName: path.basename(absolutePath), ext: path.extname(absolutePath).toLowerCase(), folderPath };
}

/** Parses each router workbook at most once per scan -- the I&A router feeds both the Engineering
 * Summary and the DS-form ordering below, and the repair router both repair sections. */
type RouterCache = Map<string, Promise<ParsedRouter | null>>;
function cachedRouter(cache: RouterCache, file: JobFile): Promise<ParsedRouter | null> {
  let p = cache.get(file.absolutePath);
  if (!p) {
    p = parseRouter(file.absolutePath).catch(() => null);
    cache.set(file.absolutePath, p);
  }
  return p;
}

/** The DS form number a file name carries ("DS-0047 F7EA 1st stage ..." → "DS-0047"), if any. */
function formNumberOf(baseName: string): string | undefined {
  const m = baseName.match(/(^|[^a-z])(ds[\s-]?\d{3,4})/i);
  return m ? normalizeFormNumber(m[2]) : undefined;
}

/**
 * attach-multi: a run of real completed exhibits (DS data-sheet prints, NDT forms, heat treat
 * charts, coating certs) appended verbatim after the section's divider page. Every matching PDF is
 * a candidate, and so is a spreadsheet with no PDF of the same name beside it -- final-stage DS
 * sheets often only ever exist as .xlsx (Job 20505's 7B), and get printed through Excel at
 * report-generation time (see excelExhibit.ts). Same-named duplicates in two folders (e.g. a copy
 * under 7A's "New folder") are collapsed to the shortest path. Ordered the way the job's own
 * routers list the forms (see RouterFormRef), which is the order APG's real reports print them in;
 * anything the routers don't mention follows by name.
 */
async function scanMultiSection(
  section: SectionConfig,
  files: JobFile[],
  base: Omit<SectionScanResult, "status" | "statusReason" | "matchedFiles">,
  formOrder: string[]
): Promise<SectionScanResult> {
  const matched = findCandidates(section.sourceRules, files).flatMap((m) => m.candidates);
  const manual = base.manualAttachments ?? [];

  // Field-service duplicates ("DS-0319 ... INCOMING FS.pdf" beside "DS-0319 ... INCOMING.pdf", Job
  // 20564) are the same sheet re-exported for a short customer copy of the report -- collapsed into
  // the standard file, but kept when the FS copy is the only one (his F-306-01 final NDT).
  const isFs = (f: JobFile) => /[\s_-]fs$/i.test(path.basename(f.baseName, f.ext).trim());
  const stem = (f: JobFile) =>
    path.basename(f.baseName, f.ext).toLowerCase().replace(/[\s_-]+fs$/, "").replace(/\s+/g, " ").trim();
  const seen = new Map<string, JobFile>();
  for (const f of [...manual, ...matched]) {
    const key = `${stem(f)}${f.ext}`;
    const existing = seen.get(key);
    const better =
      !existing ||
      (isFs(existing) && !isFs(f)) ||
      (isFs(existing) === isFs(f) && f.relativePath.length < existing.relativePath.length);
    if (better) seen.set(key, f);
  }
  const unique = [...seen.values()];
  const pdfStems = new Set(unique.filter((f) => f.ext === ".pdf").map(stem));
  // A spreadsheet only counts when there's no PDF print of the same sheet anywhere in the section
  // (7A often has the PDFs loose and the working .xlsx copies tucked in a "New folder" below).
  const candidates = unique.filter((f) => f.ext === ".pdf" || !pdfStems.has(stem(f)));
  const excelOnly = candidates.filter((f) => f.ext !== ".pdf");

  const rank = (f: JobFile) => {
    const form = formNumberOf(f.baseName);
    const i = form ? formOrder.indexOf(form) : -1;
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  if (section.sortBy === "date") {
    // Heat treat charts print in the order the cycles were run (Alfredo's 20564 Repair Report:
    // preweld 4/15 → post weld 8/15 → post-coat 9/15 → post C&A 10/2) -- the files' own dates,
    // since their names ("205642-001 POST C & A R# ...") don't sort that way.
    const mtimes = new Map(
      await Promise.all(candidates.map(async (f) => [f.relativePath, (await fs.stat(toLongPath(f.absolutePath)).catch(() => null))?.mtimeMs ?? 0] as const))
    );
    candidates.sort((a, b) => (mtimes.get(a.relativePath) ?? 0) - (mtimes.get(b.relativePath) ?? 0) || a.baseName.localeCompare(b.baseName, undefined, { numeric: true }));
  } else {
    candidates.sort((a, b) => rank(a) - rank(b) || a.baseName.localeCompare(b.baseName, undefined, { numeric: true }));
  }

  const manualPaths = new Set(manual.map((f) => f.relativePath));
  let pool = candidates.filter((f) => !section.preselectPattern || section.preselectPattern.test(f.baseName));
  if (section.preferPattern && pool.some((f) => section.preferPattern!.test(f.baseName))) pool = pool.filter((f) => section.preferPattern!.test(f.baseName));
  // A workbook of a DS form that's already here as a PDF is a working copy, not another sheet --
  // e.g. 20564's "7A\20564 FA 1ST STG INCOMING\DS-0325 (CJ) ... INCOMING.xlsx" beside the printed
  // "DS-0325 ... INCOMING.pdf" (the inspector's initials make the names differ). Listed, not ticked.
  // Same for a data workbook whose prints are here under longer names -- "F7FA S1N Incoming Air
  // Flow.xlsx" beside "... Air Flow ID.pdf" / "... Air Flow OD.pdf" (20564): the PDFs are what prints.
  const pdfs = candidates.filter((f) => f.ext === ".pdf");
  const pdfForms = new Set(pdfs.map((f) => formNumberOf(f.baseName)).filter(Boolean));
  const isWorkingCopy = (f: JobFile) =>
    f.ext !== ".pdf" && ((formNumberOf(f.baseName) !== undefined && pdfForms.has(formNumberOf(f.baseName))) || pdfs.some((p) => stem(p).startsWith(stem(f))));
  const workingCopies = candidates.filter((f) => !manualPaths.has(f.relativePath) && isWorkingCopy(f));
  pool = pool.filter((f) => !workingCopies.includes(f));
  let defaultSelectedPaths = candidates.filter((f) => manualPaths.has(f.relativePath) || pool.includes(f)).map((f) => f.relativePath);
  if (section.selectOne && candidates.length > 0) {
    // One form: a manually attached file wins outright; otherwise PDF over workbook, "INCOMING"
    // over other copies, the report folder (7A) over subfolders, then the shortest path.
    const score = (f: JobFile) =>
      (manualPaths.has(f.relativePath) ? 0 : 1000) +
      (f.ext === ".pdf" ? 0 : 100) +
      (/incoming/i.test(f.baseName) ? 0 : 10) +
      (/^7 reports\/7a[^/]*$/i.test(f.folderPath) ? 0 : 5) +
      f.relativePath.length / 1000;
    defaultSelectedPaths = [[...candidates].sort((a, b) => score(a) - score(b))[0].relativePath];
  }

  if (candidates.length === 0) {
    const statusReason = section.custom
      ? "Add this section's file(s) below — PDFs go in as-is, Excel files are printed through Excel."
      : "No matching files found in the job folder.";
    return { ...base, status: "missing", statusReason, matchedFiles: [], defaultSelectedPaths: [] };
  }
  // A single-form section with its one form picked is done; extra copies sitting unticked
  // (a working .xlsx, a field-service print) aren't something to chase.
  // Working copies left unticked aren't something to chase either -- only real unticked candidates.
  const unselected = section.selectOne ? 0 : candidates.filter((f) => !defaultSelectedPaths.includes(f.relativePath) && !workingCopies.includes(f)).length;
  const printedThroughExcel = excelOnly.filter((f) => defaultSelectedPaths.includes(f.relativePath)).length;
  return {
    ...base,
    status: unselected > 0 ? "needs-attention" : "ready",
    statusReason: [
      section.selectOne
        ? `Using "${defaultSelectedPaths[0]}"${candidates.length > 1 ? ` — ${candidates.length - 1} other cop${candidates.length > 2 ? "ies" : "y"} listed below if that's not the right one` : ""}.`
        : `${candidates.length} file(s) found; ${defaultSelectedPaths.length} selected for the report.`,
      !section.selectOne && workingCopies.length > 0 ? `${workingCopies.length} Excel working cop${workingCopies.length > 1 ? "ies" : "y"} of sheets already here as PDF left unticked.` : "",
      unselected > 0 ? `${unselected} left unticked — check whether they belong.` : "",
      printedThroughExcel > 0 ? `${printedThroughExcel} only exist as Excel files and will be printed through Excel when the report is generated.` : "",
    ]
      .filter(Boolean)
      .join(" "),
    matchedFiles: candidates,
    defaultSelectedPaths,
  };
}

async function scanFileBackedSection(section: SectionConfig, files: JobFile[], jobRoot: string, routers: RouterCache, formOrder: string[]): Promise<SectionScanResult> {
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
    divider: section.divider,
    beforeCover: section.beforeCover,
    defaultExcluded: section.defaultExcluded,
    custom: section.custom,
    aliases: section.aliases,
  };

  if (section.generation === "attach-multi") return await scanMultiSection(section, files, base, formOrder);

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
          const parsed = await cachedRouter(routers, candidate);
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
            const resolvedPrintPdf = printPdfFile;
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

  // Form order for attach-multi sections: every DS form the I&A router calls for, then any extra
  // ones only the repair router lists (final-stage re-checks), in router order.
  const routers: RouterCache = new Map();
  const formOrder: string[] = [];
  for (const rules of [IA_ROUTER_RULES, REPAIR_ROUTER_RULES]) {
    const file = findCandidates(rules, files)[0]?.candidates[0];
    if (!file) continue;
    const router = await cachedRouter(routers, file);
    for (const ref of router?.formRefs ?? []) if (!formOrder.includes(ref.form)) formOrder.push(ref.form);
  }

  // Pass 1: sections backed directly by files (or job metadata).
  for (const section of template.sections) {
    if (section.generation === "template") {
      resolved.set(section.id, {
        id: section.id,
        title: section.title,
        generation: section.generation,
        automationConfidence: section.automationConfidence,
        status: "ready",
        statusReason: `From ${metadata.sources.join(", ")}.`,
        matchedFiles: [],
      });
      continue;
    }
    if (section.dependsOnSections) continue; // pass 2
    resolved.set(section.id, await scanFileBackedSection(section, files, jobRoot, routers, formOrder));
  }

  // Pass 2: sections synthesized from other sections' results.
  for (const section of template.sections) {
    if (!section.dependsOnSections) continue;
    resolved.set(section.id, scanDependentSection(section, resolved));
  }

  // Preserve the template's declared section order in the result.
  const sections = template.sections.map((s) => resolved.get(s.id)!);

  const measurements = await readJobMeasurements(files);
  return { jobRoot, reportType: template.reportType, metadata, measurements, fileCount: files.length, sections };
}
