import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
import os from "os";

export type ReportVariant = "standard" | "fs";

export interface SectionState {
  /** Current draft/content text (narrative sections), or a JSON-serialized table edit, etc. */
  content?: string;
  /** The Fleet Service (FS) version's text for a section that's shorter there -- Calpine's FS
   * Repair Recommendations / Repair Summary (Job 20992). Blank means the FS version prints `content`. */
  compactContent?: string;
  /** For photo-select sections: the reviewer-confirmed selection. */
  selectedPhotoPaths?: string[];
  /** The same pick per report ("ia" / "final") once the tech rep changes it for that report -- see
   * photoPick in photoGroups.ts. */
  selectedPhotoPathsByReport?: Record<string, string[]>;
  /** Photos the tech rep moved to a different photo group ("NDT Photos" for a shot the shop saved
   * under Incoming), by relative path → group title. */
  photoGroupOverrides?: Record<string, string>;
  /** Per report ("ia" / "final"): the slot each placed photo sits in within its group (page =
   * slot / 6), so a page can be started before the one above it is full -- see layoutGroup. */
  photoSlotsByReport?: Record<string, Record<string, number>>;
  /** For the cover section: reviewer overrides/fill-ins for fields with no reliable auto-source
   * (Tech Rep, Customer PO, Prior Repair, Coating, ...), keyed the same as JobMetadata. */
  fields?: Record<string, string>;
  /** For the cover section: extra label/value rows a tech rep has added beyond the fixed
   * COVER_FIELD_ORDER set (see CoverEditor's "+ Add field") -- some jobs need to call out
   * something the standard fields don't cover. An array, not a Record, so insertion order (the
   * order the tech rep typed them in) is preserved; a row with either side left blank is dropped
   * from the generated report the same way a blank standard field already is. Each row gets a
   * stable id at creation (see CoverEditor) so fieldOrder below can reference it even as its own
   * label/value are edited later. */
  customFields?: Array<{ id: string; label: string; value: string }>;
  /** For the cover section: the tech rep's own display order for every row, standard and custom
   * mixed together -- entries are a standard field's key (e.g. "customer") or a custom field's id
   * (see customFields above). Lets a specific field be moved anywhere in the list, not just
   * reordered within its own standard/custom group. Rows not mentioned here (a standard field
   * never touched, or a custom field added after this was last saved) render after everything
   * that is, in their own default order -- see CoverEditor/renderReportHtml's orderCoverRows. */
  fieldOrder?: string[];
  /** For the cover section: label overrides for standard fields, keyed like JobMetadata -- e.g.
   * "EQ#" for assetNumber on Elmer Gomez's Calpine vane reports where Alfredo writes "Asset#". */
  fieldLabels?: Record<string, string>;
  /** True once a human has looked at this section and accepted it, even if status was
   * "needs-attention" or "missing" — lets "Generate Report" proceed deliberately. */
  acknowledged?: boolean;
  lastGeneratedAt?: string;
  /** For narrative sections: where the current draft's wording came from when it was started from
   * a past report of the same product (see draft/priorReport.ts), e.g. "Job 19933 (19933 Emissions
   * F7FA S1N IA Report.pptx)" -- shown above the editor so the tech rep knows what to check. */
  seededFrom?: string;
  /** Set when automatic draft generation (on job-folder scan) couldn't produce content for this
   * section — missing source data, a missing API key, a failed request, etc. Surfaced in the UI
   * as an explicit "needs human review" flag instead of silently leaving the section blank.
   * Cleared as soon as content is successfully generated or edited. */
  draftError?: string;
  /** For attach-as-is sections (chem test, crack map, met report) where more than one file
   * matched the naming pattern: the tech rep's own pick of which one is actually the real
   * exhibit, by relativePath. Overrides the auto-picked candidate for report generation. */
  selectedAttachmentPath?: string;
  /** For attach-as-is sections: candidate files (by relativePath) the tech rep has explicitly
   * rejected as wrong via the "x" on that candidate -- e.g. a Purchase Requisition that happened
   * to match the Chem Test filename pattern. The file itself is left alone on disk (it may still
   * be legitimate, just not for THIS section); only filtered back out of matchedFiles on every
   * scan (see /api/scan) so a rejected candidate doesn't keep reappearing on rescan. */
  excludedMatchedPaths?: string[];
  /** For attach-multi sections (dimensional sheets, NDT reports, heat treat charts, ...): the
   * tech rep's own ticked set of exhibits, by relativePath, in the order they print. Unset until
   * the tech rep changes anything, in which case SectionScanResult.defaultSelectedPaths applies. */
  selectedAttachmentPaths?: string[];
  /** For table-from-source sections (Serial Number List, Height Dim Form, Dovetail Dimension,
   * Wall Thickness): manual corrections to individual cells of the freshly-parsed table -- a
   * typo'd serial number, a re-measured value, etc. Keyed "<row index>:<column name>" against
   * that table's own row order (see applyTableEdits), and applied on top of the parse on every
   * render, in both the review screen and the generated PDF -- never written back to the source
   * spreadsheet itself. */
  tableEdits?: Record<string, string>;
  /** Freeform text for the real form's own blank "NOTES:" box under the table -- a reviewer's
   * typed remarks standing in for what would be handwritten on the paper form, not one of this
   * app's own automated notes (which live in ParsedTable.notes instead). */
  tableNotes?: string;
  /** For table-from-source sections where a completed, print-ready PDF of the real form was also
   * found on disk (see scanJobFolder.ts's PRINT_PDF_SECTIONS): true to leave that auto-detected
   * PDF out of the generated report and use this app's own re-rendered table instead. The auto-
   * match is usually right, but the tech rep always has a direct way to say "no, just use the
   * table" -- same "human pick overrides the automatic one" convention as selectedAttachmentPath
   * above, just an exclude rather than a swap since there's only ever one auto-detected PDF here. */
  excludePrintPdf?: boolean;
  /** True to leave this whole section out of the generated report -- the tech rep's own "this job
   * doesn't need that page" (e.g. Wall Thickness on solid buckets), via the ✕ on its sidebar tab.
   * Reversible; the section stays in the sidebar, dimmed, so it can be added back. Separate from
   * renderReportHtml.ts's automatic omission of table sections that simply have no data. */
  excludeFromReport?: boolean;
}

export interface JobState {
  jobRoot: string;
  /** Per report type: which version is being built -- the standard report or Calpine's shorter
   * Fleet Service ("FS") copy. Standard when unset. */
  reportVariant?: Record<string, ReportVariant>;
  sections: Record<string, SectionState>;
  /** The tech rep's own order for this job's report sections, by id -- lets related sections (e.g.
   * every heat-treat chart) be grouped together even when the report template's own default order
   * interleaves them with other sections. Drives BOTH the review sidebar's order and the generated
   * report's own page order (see /api/scan/route.ts's reordering of scan.sections, which
   * renderReportHtml.ts's renderReportSegments then renders straight through in that same order) --
   * a tech rep dragging a section in the sidebar is deliberately choosing where it lands in the
   * final report, not just tidying the review screen. Sections not listed here (a job that's never
   * been reordered, or a section added to the template after this was last saved) render after
   * everything that is, in the template's own default order -- see /api/scan's orderSections. */
  sectionOrder?: string[];
  /** Same as sectionOrder, but kept per report type (keyed by ReportTemplate.reportType) -- the
   * Incoming and Repair reports share one job's state (so shared sections carry over), but their
   * page orders are independent. sectionOrder above is only read as a fallback for old state. */
  sectionOrders?: Record<string, string[]>;
  /** Sections the tech rep added to this job's report (keyed by ReportTemplate.reportType, like
   * sectionOrders): an id ("custom-…", also the "_Manual Attachments" folder its files go in) and
   * the title printed on its divider. See report-templates/forJob.ts. */
  customSections?: Record<string, Array<{ id: string; title: string }>>;
  /** Section titles that differ from the template's (keyed by report type, then section id) --
   * the author's own divider wording taken from the last same-product report ("Flow Test",
   * "Heat Treat Chart"), or the tech rep's own rename. Printed on the divider page / slide. */
  sectionTitles?: Record<string, Record<string, string>>;
  /** Report types whose layout (titles, optional blocks, cover labels) has already been taken from
   * the last same-product report -- done once per job, so later edits are never overwritten. */
  layoutSeeded?: Record<string, string>;
}

/** Reorders `sections` per the tech rep's own sectionOrder (see JobState.sectionOrder's own
 * comment) -- shared by /api/scan/route.ts (the review sidebar) and renderReportHtml.ts's
 * renderReportSegments (the generated report), so both actually walk the same order rather than
 * each reimplementing this placed-then-unplaced merge slightly differently. Sections in `order`
 * render first, in that order; anything not mentioned (a fresh job, or a section the template
 * added after `order` was last saved) keeps its own relative order, appended after everything
 * that is placed. */
export function applySectionOrder<T extends { id: string }>(sections: T[], order: string[] | undefined): T[] {
  if (!order || order.length === 0) return sections;
  const byId = new Map(sections.map((s) => [s.id, s]));
  const placed = order.map((id) => byId.get(id)).filter((s): s is T => Boolean(s));
  const placedIds = new Set(placed.map((s) => s.id));
  return [...placed, ...sections.filter((s) => !placedIds.has(s.id))];
}

/** On a job's very first scan (no cover date saved yet), locks in today's date as the cover
 * page's "Date" field -- the day the tech rep actually started this report, not whatever date (if
 * any) happened to get parsed from a source file. Returns true if it set something (caller should
 * then saveJobState); a no-op on every later scan once a date -- auto-set or the tech rep's own
 * manual entry via CoverEditor -- is already there, so it never fights a later edit. */
export function ensureReportStartDate(state: JobState): boolean {
  if (state.sections.cover?.fields?.date) return false;
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  state.sections.cover = { ...state.sections.cover, fields: { ...state.sections.cover?.fields, date: today } };
  return true;
}

function stateDir(): string {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(base, "VNReportApp", "jobs");
}

function stateFilePath(jobRoot: string): string {
  const hash = crypto.createHash("sha256").update(jobRoot).digest("hex").slice(0, 16);
  return path.join(stateDir(), `${hash}.json`);
}

/** A job's saved state. Only a job with no file yet starts empty: a file that won't read or parse
 * (caught mid-write by another save, or held by a virus scan) is retried, then reported -- it used
 * to come back as a brand-new empty job, which the next save then wrote over every draft, photo
 * pick and setting the tech rep had (seen on the 20564 test copy, 10/29). */
export async function loadJobState(jobRoot: string): Promise<JobState> {
  const filePath = stateFilePath(jobRoot);
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      return JSON.parse(raw) as JobState;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { jobRoot, sections: {} };
      lastError = err;
      await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
    }
  }
  throw new Error(`Couldn't read this job's saved review state (${filePath}): ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

/** Written to a temporary file and renamed over the old one, so a reader never sees half a file. */
export async function saveJobState(state: JobState): Promise<void> {
  const filePath = stateFilePath(state.jobRoot);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(temp, JSON.stringify(state, null, 2), "utf-8");
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(temp, filePath);
      return;
    } catch (err) {
      // Windows can refuse the replace for a moment while something else has the file open.
      if (attempt >= 5) {
        await fs.unlink(temp).catch(() => {});
        throw err;
      }
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }
}

// One change at a time per job: every read-modify-write of a job's state goes through
// mutateJobState, so two saves landing together (a photo pick and a rescan, say) apply one after the
// other instead of the later one writing back a copy that's missing the earlier one's change.
const jobLocks = new Map<string, Promise<unknown>>();

/** Loads the job's state, lets `change` edit it, and saves it -- queued behind any other change to
 * the same job. */
export function mutateJobState(jobRoot: string, change: (state: JobState) => void | Promise<void>): Promise<JobState> {
  const previous = jobLocks.get(jobRoot) ?? Promise.resolve();
  const run = previous
    .catch(() => {})
    .then(async () => {
      const state = await loadJobState(jobRoot);
      await change(state);
      await saveJobState(state);
      return state;
    });
  jobLocks.set(jobRoot, run);
  run.finally(() => {
    if (jobLocks.get(jobRoot) === run) jobLocks.delete(jobRoot);
  }).catch(() => {});
  return run;
}

export function updateSectionState(jobRoot: string, sectionId: string, patch: Partial<SectionState>): Promise<JobState> {
  return mutateJobState(jobRoot, (state) => {
    state.sections[sectionId] = { ...state.sections[sectionId], ...patch };
  });
}

/** Applies patches for several sections in one read-modify-write. Calling `updateSectionState`
 * concurrently for different sections is a lost-update race — each call reads the whole file,
 * so whichever write lands last wins and silently drops the others. Anything that patches more
 * than one section around the same time (e.g. drafting several sections in parallel) must batch
 * through here instead. */
export function updateSectionStates(jobRoot: string, patches: Record<string, Partial<SectionState>>): Promise<JobState> {
  return mutateJobState(jobRoot, (state) => {
    for (const [sectionId, patch] of Object.entries(patches)) {
      state.sections[sectionId] = { ...state.sections[sectionId], ...patch };
    }
  });
}

export function updateSectionOrder(jobRoot: string, reportType: string, order: string[]): Promise<JobState> {
  return mutateJobState(jobRoot, (state) => {
    state.sectionOrders = { ...state.sectionOrders, [reportType]: order };
  });
}

/** This report type's saved section order (see JobState.sectionOrders). */
export function sectionOrderFor(state: JobState, reportType: string): string[] | undefined {
  return state.sectionOrders?.[reportType] ?? state.sectionOrder;
}

export async function updateCustomSections(
  jobRoot: string,
  reportType: string,
  update: (sections: Array<{ id: string; title: string }>) => Array<{ id: string; title: string }>
): Promise<JobState> {
  return mutateJobState(jobRoot, (state) => {
    state.customSections = { ...state.customSections, [reportType]: update(state.customSections?.[reportType] ?? []) };
  });
}
