import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
import os from "os";

export interface SectionState {
  /** Current draft/content text (narrative sections), or a JSON-serialized table edit, etc. */
  content?: string;
  /** For photo-select sections: the reviewer-confirmed selection. */
  selectedPhotoPaths?: string[];
  /** For the I&A Summary narrative section only: whether to embed APG's standard 7FA
   * modification-reference diagram (a fixed illustration, not one of the job's own photos --
   * every 7FA I&A report includes it, showing the six standard modification callouts against a
   * generic bucket drawing) below the summary text. Defaults to on for any job whose turbine
   * model is a 7FA variant (see renderReportHtml.ts's renderStandardDiagram) -- set to false here
   * to leave it out for a specific job; there's no per-job photo picker for this, since it's the
   * same fixed reference image on every 7FA job, not something to select per job. */
  includeStandardDiagram?: boolean;
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
  /** True once a human has looked at this section and accepted it, even if status was
   * "needs-attention" or "missing" — lets "Generate Report" proceed deliberately. */
  acknowledged?: boolean;
  lastGeneratedAt?: string;
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
  return path.join(base, "TechRepReportApp", "jobs");
}

function stateFilePath(jobRoot: string): string {
  const hash = crypto.createHash("sha256").update(jobRoot).digest("hex").slice(0, 16);
  return path.join(stateDir(), `${hash}.json`);
}

export async function loadJobState(jobRoot: string): Promise<JobState> {
  const filePath = stateFilePath(jobRoot);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as JobState;
  } catch {
    return { jobRoot, sections: {} };
  }
}

export async function saveJobState(state: JobState): Promise<void> {
  const filePath = stateFilePath(state.jobRoot);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(state, null, 2), "utf-8");
}

export async function updateSectionState(jobRoot: string, sectionId: string, patch: Partial<SectionState>): Promise<JobState> {
  const state = await loadJobState(jobRoot);
  state.sections[sectionId] = { ...state.sections[sectionId], ...patch };
  await saveJobState(state);
  return state;
}

/** Applies patches for several sections in one read-modify-write. Calling `updateSectionState`
 * concurrently for different sections is a lost-update race — each call reads the whole file,
 * so whichever write lands last wins and silently drops the others. Anything that patches more
 * than one section around the same time (e.g. drafting several sections in parallel) must batch
 * through here instead. */
export async function updateSectionStates(jobRoot: string, patches: Record<string, Partial<SectionState>>): Promise<JobState> {
  const state = await loadJobState(jobRoot);
  for (const [sectionId, patch] of Object.entries(patches)) {
    state.sections[sectionId] = { ...state.sections[sectionId], ...patch };
  }
  await saveJobState(state);
  return state;
}

export async function updateSectionOrder(jobRoot: string, order: string[]): Promise<JobState> {
  const state = await loadJobState(jobRoot);
  state.sectionOrder = order;
  await saveJobState(state);
  return state;
}
