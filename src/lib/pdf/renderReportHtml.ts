import { promises as fs } from "fs";
import path from "path";
import sharp from "sharp";
import type { JobScanResult, SectionScanResult } from "../ingest/scanJobFolder";
import { COVER_FIELD_ORDER } from "../ingest/jobMetadata";
import { applySectionOrder, sectionOrderFor, type JobState, type SectionState } from "../state/jobState";
import { effectiveMultiSelection, isExcluded } from "../state/selection";
import { excelExhibitToPdf } from "./excelExhibit";
import { groupPhotos, selectedPhotoPaths } from "./photoGroups";
import { applyTableEdits, type ParsedTable } from "../ingest/parsers/types";

// APG's real letterhead colors, sampled directly from a completed report (Job #20443): a short
// blue segment at the left of the header bar, gray for the rest of its width.
const APG_BLUE = "#0046a1";
const APG_BAR_GRAY = "#6a7683";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

let logoDataUriCache: string | null = null;

/** APG's logo mark, extracted from a real completed report and stored at `public/apg-logo.jpg`.
 * Cached per process since it's the same file on every page of every report. */
async function logoDataUri(): Promise<string> {
  if (!logoDataUriCache) {
    const buffer = await fs.readFile(path.join(process.cwd(), "public", "apg-logo.jpg"));
    logoDataUriCache = `data:image/jpeg;base64,${buffer.toString("base64")}`;
  }
  return logoDataUriCache;
}

/** The letterhead every non-cover page opens with in APG's usual report format: a small logo top
 * left, the page's title centered next to it, and the blue-to-gray bar underneath. */
function pageHeader(title: string, logo: string): string {
  return `
    <div class="letterhead">
      <img class="logo" src="${logo}" alt="APG" />
      <h1 class="page-title">${escapeHtml(title)}</h1>
    </div>
    <div class="letterhead-bar"></div>`;
}

/** A divider page ahead of a block of appended exhibits -- APG's V&N reports open every block of
 * forms (Serial Number List, Incoming Dimensional Sheets, NDT Reports, ...) with one, since the
 * forms themselves carry no report-level heading. */
function dividerPage(title: string, logo: string): string {
  return `<section class="report-page divider-page">${pageHeader("", logo)}<div class="divider-title">${escapeHtml(title)}</div></section>`;
}

/** data-col carries the raw column name onto each cell so specific columns (e.g. "APG #") can
 * be targeted for centering etc. from CSS without hardcoding table-specific markup here. */
function tdAttrs(col: string, row: Record<string, string | undefined>): string {
  const cls = row[col]?.includes("OUT OF SPEC") ? ' class="fail"' : "";
  return ` data-col="${escapeHtml(col)}"${cls}`;
}

function chunkRows<T>(rows: T[], numChunks: number): T[][] {
  const perChunk = Math.ceil(rows.length / numChunks);
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += perChunk) chunks.push(rows.slice(i, i + perChunk));
  return chunks;
}

/** The source form's own Customer/Date/Page/etc. header block, laid out the same 3-per-row grid
 * the real form prints, right above the data table. */
function renderFormHeader(formHeader: Array<{ label: string; value: string }> | undefined): string {
  if (!formHeader || formHeader.length === 0) return "";
  const cells = formHeader.map(({ label, value }) => `<div class="form-header-cell"><span class="form-header-label">${escapeHtml(label)}</span> ${escapeHtml(value)}</div>`).join("");
  return `<div class="form-header-grid">${cells}</div>`;
}

/** The real form's blank "NOTES:" box for a reviewer's remarks under the table — kept even when
 * there's nothing to say yet, since it's part of the original form's own layout. Renders the
 * tech rep's typed text (SectionState.tableNotes) standing in for what would be handwritten on
 * the paper form. */
function renderNotesBox(text?: string): string {
  const body = text ? `<div class="form-notes-text">${escapeHtml(text).replace(/\n/g, "<br/>")}</div>` : "";
  return `<div class="form-notes-box"><span class="form-notes-label">NOTES:</span>${body}</div>`;
}

/** columnBlocks > 1 reflows a long, simple list (currently just Serial Number List) into that
 * many side-by-side mini-tables instead of one tall single-column table — mirroring the real
 * DS-0554 form's own "three parallel column blocks" layout — so a 90+ row list takes a third as
 * many printed pages instead of running on and on down a single column. */
function renderTable(table: ParsedTable, options?: { columnBlocks?: number; notesText?: string }): string {
  const columnBlocks = options?.columnBlocks ?? 1;
  const notes = table.notes.length ? `<p class="table-notes">${table.notes.map(escapeHtml).join("<br/>")}</p>` : "";
  const formHeaderHtml = renderFormHeader(table.formHeader);
  const notesBoxHtml = table.hasNotesBox ? renderNotesBox(options?.notesText) : "";

  if (columnBlocks > 1 && table.rows.length > columnBlocks) {
    const headerRow = `<tr>${table.columns.map((c) => `<th data-col="${escapeHtml(c)}">${escapeHtml(c)}</th>`).join("")}</tr>`;
    const blocks = chunkRows(table.rows, columnBlocks)
      .map((rowsChunk) => {
        const bodyRows = rowsChunk
          .map((row) => `<tr>${table.columns.map((c) => `<td${tdAttrs(c, row)}>${escapeHtml(row[c] ?? "")}</td>`).join("")}</tr>`)
          .join("");
        return `<table class="table-block">${headerRow}${bodyRows}</table>`;
      })
      .join("");
    return `${formHeaderHtml}<div class="table-columns">${blocks}</div>${notes}${notesBoxHtml}`;
  }

  const headerRow = `<tr>${table.columns.map((c) => `<th data-col="${escapeHtml(c)}">${escapeHtml(c)}</th>`).join("")}</tr>`;
  const bodyRows = table.rows
    .map((row) => `<tr>${table.columns.map((c) => `<td${tdAttrs(c, row)}>${escapeHtml(row[c] ?? "")}</td>`).join("")}</tr>`)
    .join("");
  const summaryRows = (table.summaryRows ?? [])
    .map((row) => `<tr class="summary">${table.columns.map((c) => `<td data-col="${escapeHtml(c)}">${escapeHtml(row[c] ?? "")}</td>`).join("")}</tr>`)
    .join("");
  return `${formHeaderHtml}<table>${headerRow}${bodyRows}${summaryRows}</table>${notes}${notesBoxHtml}`;
}

/** Line-based markup matching APG's usual report style: a short line ending in ":" is a
 * (subheading), a line starting with "- " is a bullet under whatever came before it, "NOTE:" at
 * the start of a line gets bolded, and everything else is a plain paragraph — not one flowing
 * block of prose. Blank lines just separate groups; they don't need their own markup. */
function renderNarrative(text: string | undefined): string {
  if (!text) return `<p class="missing">No draft generated yet for this section.</p>`;

  const parts: string[] = [];
  let listOpen = false;
  const closeList = () => {
    if (listOpen) {
      parts.push("</ul>");
      listOpen = false;
    }
  };

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      closeList();
      continue;
    }
    if (line.startsWith("- ")) {
      if (!listOpen) {
        parts.push(`<ul class="narrative-list">`);
        listOpen = true;
      }
      parts.push(`<li>${escapeHtml(line.slice(2))}</li>`);
      continue;
    }
    closeList();
    if (/^NOTE:/i.test(line)) {
      const rest = line.slice(line.indexOf(":") + 1).trim();
      parts.push(`<p><strong>NOTE:</strong> ${escapeHtml(rest)}</p>`);
    } else if (line.endsWith(":") && line.length <= 60) {
      parts.push(`<p class="subhead">${escapeHtml(line)}</p>`);
    } else {
      parts.push(`<p>${escapeHtml(line)}</p>`);
    }
  }
  closeList();
  return parts.join("");
}

/** Downsizes a photo before embedding it in the report. Report photos are rendered small (a grid
 * tile), but source camera photos can be several MB each at full resolution — a job with 90+
 * selected photos embedded at full size produces an HTML document large enough to crash the PDF
 * renderer outright (a real failure hit while testing photo selection: ~90MB of source JPEGs
 * blew up the CDP connection puppeteer uses to load the page). 1200px on the long edge is more
 * than enough detail for a report exhibit. */
async function photoToDataUri(absolutePath: string): Promise<string> {
  const buffer = await sharp(absolutePath).rotate().resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 72 }).toBuffer();
  return `data:image/jpeg;base64,${buffer.toString("base64")}`;
}

/** One page run per photo group (see photoGroup), each under its own letterhead title, photos in
 * the tech rep's selected order within a group. */
async function renderPhotoPages(section: SectionScanResult, jobRoot: string, sectionState: SectionState | undefined, logo: string): Promise<string> {
  const paths = selectedPhotoPaths(section, sectionState?.selectedPhotoPaths);
  if (paths.length === 0) return `<section class="report-page">${pageHeader(section.title, logo)}<p class="missing">No photos selected.</p></section>`;

  const pages: string[] = [];
  for (const { label, paths: group } of groupPhotos(paths)) {
    const images = await Promise.all(
      group.map(async (relativePath) => {
        try {
          return `<figure><img src="${await photoToDataUri(path.join(jobRoot, relativePath))}" /></figure>`;
        } catch {
          return "";
        }
      })
    );
    pages.push(`<section class="report-page">${pageHeader(label, logo)}<div class="photo-grid">${images.join("")}</div></section>`);
  }
  return pages.join("\n");
}

/** One piece of the final report: either a chunk of our own HTML (to be rendered to PDF via
 * puppeteer) or a real source PDF whose pages get copied in verbatim at this exact point in the
 * document. Splitting the report this way — rather than one HTML string with placeholder pages
 * to find-and-replace afterward — means the real form's pages land at the right spot by
 * construction (each segment's own page count), with no need to search a rendered PDF's text
 * content to locate anything. */
export type ReportSegment = { kind: "html"; html: string } | { kind: "pdf"; path: string };

export interface RenderedReport {
  segments: ReportSegment[];
  /** Relative paths of attach-as-is matches that couldn't be embedded (matched a non-PDF file --
   * e.g. a crack map saved as a photo instead of a PDF). Surfaced to the tech rep via
   * generate-pdf/route.ts's X-Skipped-Attachments header rather than silently dropped. */
  skippedAttachments: string[];
}

const REPORT_STYLES = (apgBlue: string, apgBarGray: string) => `
  body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: #1a1a1a; }
  p { line-height: 1.5; margin: 0 0 10px; }
  /* Underlined subheading (e.g. "Tips:", "Squealer Tip Thickness (E):") — APG's usual way of
     breaking a summary into named categories instead of one flowing paragraph. Extra top margin
     (vs. the 14px this used to be) matches the generous gap between categories in APG's own
     original reports -- see .narrative-section below for why the whole section scaled up. */
  p.subhead { text-decoration: underline; font-weight: 700; margin: 20px 0 0; }
  p.subhead:first-child { margin-top: 0; }
  .narrative-list { margin: 0 0 6px; padding-left: 22px; }
  .narrative-list li { margin-bottom: 1px; line-height: 1.5; }
  /* I&A Summary, FPI & Visual, Dimensional Summary, Recommended Repairs — larger than the base
     body size (which stays small so data tables keep fitting) since these are the sections
     someone actually sits down and reads. Every narrative section shares one size, bold
     underlined subheads included, per tech rep feedback that the summaries should look uniform
     (the I&A Summary and FPI & Visual look was the one they liked; Dimensional Summary used to
     render smaller with non-bold subheads). */
  .narrative-section p, .narrative-section li { font-size: 19px; line-height: 1.6; }
  section { page-break-inside: avoid; }
  section.report-page { page-break-before: always; margin-bottom: 16px; }
  section.table-section { page-break-inside: auto; }
  /* Recommended Repairs' numbered steps flow into two columns instead of one full-width column,
     so short step labels don't waste most of the page's width -- text wraps within each column
     instead. Tighter margins/line-height than the rest of the narrative sections specifically so
     a routine-length list has a real shot at landing on one page; break-inside: avoid per item
     keeps a single step's text from splitting across the column break. Same reasoning as
     .table-section above for allowing the section itself to flow across pages: a step list long
     enough to spill past one page should do that gracefully, not get force-fit or clipped. */
  section.repairs-section { page-break-inside: auto; }
  /* column-fill: auto (the default, "balance", instead spreads steps across both columns to make
     them come out close to equal height, which reads oddly for a numbered procedure -- step 14
     could end up above step 8). auto fills the left column all the way down first, the way the
     steps are actually meant to be read, and only starts the right column once the left one is
     genuinely full. */
  .repairs-columns { column-count: 2; column-gap: 28px; column-fill: auto; }
  /* 16px (was 13px) per tech rep feedback -- closer to the summaries' size so everything looks
     consistent, while still fitting a typical list on one page in two columns. */
  .repairs-columns p, .repairs-columns li { font-size: 16px; line-height: 1.35; margin: 0 0 5px; break-inside: avoid; }
  /* Divider page ahead of a block of appended exhibits (see dividerPage) -- the section title large
     and centered on an otherwise empty page, like the divider slides in APG's own V&N decks. */
  .divider-page { min-height: 900px; }
  .divider-title { text-align: center; font-size: 40px; font-weight: 700; color: ${apgBlue}; padding-top: 340px; }

  /* Letterhead used at the top of every page after the cover, matching APG's standard report
     header: small logo, centered bold title, blue-to-gray bar underneath. The logo is absolutely
     positioned so the title centers over the full page width, not the space left after the logo. */
  .letterhead { position: relative; min-height: 40px; }
  .letterhead .logo { position: absolute; left: 0; top: 0; height: 40px; }
  .letterhead .page-title { text-align: center; font-size: 24px; font-weight: 700; color: #1a1a1a; margin: 0; padding-top: 6px; }
  .letterhead-bar { height: 4px; margin: 6px 0 20px; background: linear-gradient(to right, ${apgBlue} 0 12%, ${apgBarGray} 12% 100%); }

  /* Cover page -- field rows sized to match APG's own original reports (see the narrative-section
     comment above for how these sizes were confirmed). page-break-inside: auto overrides the
     generic "section { page-break-inside: avoid }" above -- a job with enough added custom fields
     (see SectionState.customFields) can genuinely run past one page, and without this override
     the extra rows were getting clipped off the bottom instead of flowing onto a second page, the
     same "let it flow across pages" fix already applied to table-section/repairs-section above. */
  .cover { text-align: center; padding-top: 60px; page-break-inside: auto; }
  .cover-logo { width: 340px; margin-bottom: 24px; }
  /* Bumped again (30px/19px -> 38px/24px) -- still noticeably smaller than APG's own real report
     per a direct tech rep comparison (see the two reference screenshots this size was matched
     against). cover-label widened, and cover-row given more vertical breathing room, to match. */
  .cover h1 { font-size: 38px; margin: 0 0 40px; }
  /* display: block (with width: fit-content + margin: auto standing in for what inline-block used
     to give for free -- shrink-to-content, centered by the parent) instead of inline-block. An
     inline-block is one atomic box for pagination purposes: when it can't fit entirely on the
     current page, the whole thing -- not just the overflow -- moves to the next page, leaving
     page 1 with just the logo and title and nothing else. A block-level box doesn't have that
     restriction, so its .cover-row children (each already page-break-inside: avoid) can split
     across the page boundary wherever they actually run out of room. */
  .cover-fields { display: block; width: fit-content; margin: 0 auto; text-align: left; }
  /* Padding (row-to-row) and gap (label-to-value) both widened per tech rep feedback -- more
     breathing room between each line on the cover page. */
  .cover-row { display: flex; gap: 32px; padding: 18px 0; font-size: 24px; page-break-inside: avoid; }
  .cover-label { width: 250px; flex-shrink: 0; color: #6a6a6a; font-weight: 700; }
  .cover-value { font-weight: 700; color: #1a1a1a; }
  /* The cover's second page (see renderReportSegments -- everything after "Tech Rep" always
     starts a fresh page, per tech rep feedback) reuses .cover for identical centering/typography
     but skips the top padding and doesn't repeat the logo/title. */
  .cover-continued { padding-top: 60px; }

  table { border-collapse: collapse; width: 100%; margin-top: 8px; }
  th, td { border: 1px solid #ccc; padding: 3px 6px; font-size: 9px; }
  th { background: ${apgBlue}; color: white; }
  tr.summary td { font-weight: bold; background: #f0f0f0; }
  td.fail { background: #fff59d; font-weight: bold; }
  th[data-col="APG #"], td[data-col="APG #"],
  th[data-col="Serial #"], td[data-col="Serial #"] { text-align: center; }
  .missing { color: #b00020; font-style: italic; }
  .table-notes { font-size: 9px; color: #555; margin-top: 4px; }
  /* Side-by-side mini-tables (see renderTable's columnBlocks) -- narrower per-block table so a
     long simple list fits several columns across the page instead of one tall single column. */
  .table-columns { display: flex; gap: 10px; align-items: flex-start; }
  .table-columns .table-block { width: auto; flex: 1 1 0; margin-top: 8px; }

  /* Source form's own Customer/Date/Page/etc. header block (see renderFormHeader), laid out as
     the same 3-per-row grid the original form prints, directly above the table. */
  .form-header-grid { display: grid; grid-template-columns: repeat(3, 1fr); border: 1px solid #000; margin-top: 10px; }
  .form-header-cell { border: 1px solid #000; padding: 3px 6px; font-size: 10px; }
  .form-header-label { font-weight: 700; margin-right: 4px; }
  /* The real form's blank "NOTES:" box under the table (see renderNotesBox). */
  .form-notes-box { border: 1px solid #000; min-height: 60px; margin-top: 10px; padding: 4px 6px; }
  .form-notes-label { font-weight: 700; text-decoration: underline; font-size: 10px; }
  .form-notes-text { margin-top: 4px; font-size: 11px; white-space: pre-wrap; }
  .photo-grid { display: flex; flex-wrap: wrap; gap: 8px; }
  .photo-grid figure { width: 30%; margin: 0; }
  .photo-grid img { width: 100%; height: auto; border: 1px solid #ccc; }
  .photo-grid figcaption { font-size: 8px; color: #555; word-break: break-all; }
  /* Reference figure block for a narrative page (currently unused in the V&N build), placed
     after the narrative text it illustrates. */
  .summary-photos { display: flex; gap: 12px; margin-top: 16px; }
  .summary-photos figure { flex: 1 1 0; margin: 0; min-width: 0; }
  .summary-photos img { width: 100%; height: auto; max-height: 320px; object-fit: contain; border: 1px solid #ccc; }
`;

function wrapHtml(bodyHtml: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>${REPORT_STYLES(APG_BLUE, APG_BAR_GRAY)}</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

export const REPAIR_LIST_SECTIONS = new Set(["repairRecommendations", "repairSummary"]);

/** The cover's two pages of label/value rows -- page 1 up to and including Tech Rep, the
 * component-details page after it -- with the tech rep's overrides, custom fields and row order
 * applied and blank rows dropped. Shared by the PDF cover and the PowerPoint cover slides. */
/** "2026-10-23" (how the review screen stores it) → "10/23/2026", how his reports print dates. */
function coverDate(raw: string): string {
  const m = raw.split("T")[0].match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${Number(m[2])}/${Number(m[3])}/${m[1]}` : raw.split("T")[0];
}

export function coverPages(
  scan: JobScanResult,
  state: JobState,
  options?: { keepBlankStandard?: boolean }
): { page1: Array<{ label: string; value: string }>; page2: Array<{ label: string; value: string }> } {
  const coverState = state.sections["cover"];
  const coverOverrides = coverState?.fields ?? {};
  const fixedCoverFields = new Map(
    COVER_FIELD_ORDER.map(({ key, label }) => {
      const raw = (coverOverrides[key as string] ?? (scan.metadata[key] as string) ?? "").toString();
      const value = key === "date" ? coverDate(raw) : raw;
      // Author's own label where it differs ("EQ#" vs "Asset#") -- see SectionState.fieldLabels.
      return [key as string, { label: coverState?.fieldLabels?.[key as string] ?? label, value, standard: true }];
    })
  );
  const customCoverFields = new Map((coverState?.customFields ?? []).map((f) => [f.id, { label: f.label, value: f.value, standard: false }]));
  // Combined key order across both the fixed and custom fields, matching CoverEditor's own
  // fieldOrder -- falls back to "every fixed field, then every custom field" for anything
  // fieldOrder doesn't mention.
  const allCoverKeys = [...fixedCoverFields.keys(), ...customCoverFields.keys()];
  const placedKeys = (coverState?.fieldOrder ?? []).filter((k) => allCoverKeys.includes(k));
  const coverKeyOrder = [...placedKeys, ...allCoverKeys.filter((k) => !placedKeys.includes(k))];
  const ordered = coverKeyOrder
    .map((key) => {
      const f = fixedCoverFields.get(key) ?? customCoverFields.get(key);
      return f ? { key, label: f.label, value: f.value, standard: f.standard } : undefined;
    })
    .filter((f): f is { key: string; label: string; value: string; standard: boolean } => Boolean(f))
    // A blank field prints as a label with nothing after it -- drop it (the PowerPoint keeps blank
    // standard rows, for filling in there; the asset # only when there is one).
    .filter(({ key, label, value, standard }) => label.trim() !== "" && (value.trim() !== "" || (options?.keepBlankStandard && standard && key !== "assetNumber")));
  // The cover always breaks to the component-details page right after Tech Rep (anchored to the
  // field's key, so it holds if Tech Rep is dragged elsewhere); one page when Tech Rep is blank.
  const techRepIndex = ordered.findIndex((f) => f.key === "techRep");
  const strip = (fields: typeof ordered) => fields.map(({ label, value }) => ({ label, value }));
  return techRepIndex === -1
    ? { page1: strip(ordered), page2: [] }
    : { page1: strip(ordered.slice(0, techRepIndex + 1)), page2: strip(ordered.slice(techRepIndex + 1)) };
}

/** Sections that go in the report, in the tech rep's order, minus left-out ones. */
export function reportSections(scanIn: JobScanResult, state: JobState): SectionScanResult[] {
  return applySectionOrder(scanIn.sections, sectionOrderFor(state, scanIn.reportType)).filter((s) => s.id !== "cover" && !isExcluded(s, state.sections[s.id]));
}

/** Whether a section has anything to print behind its divider -- the same rules as sectionExhibits,
 * without opening any files (used to decide which divider slides the PowerPoint export gets). */
export function hasExhibits(section: SectionScanResult, state: JobState): boolean {
  const s = state.sections[section.id];
  if (section.generation === "table-from-source") return (Boolean(section.printPdfFile) && !s?.excludePrintPdf) || Boolean(section.parsedTable?.rows.length);
  if (section.generation === "attach-multi") return effectiveMultiSelection(section, s).length > 0;
  if (section.generation === "attach-as-is") {
    const file = (s?.selectedAttachmentPath && section.matchedFiles.find((f) => f.relativePath === s.selectedAttachmentPath)) || section.matchedFiles[0];
    return Boolean(file && file.ext === ".pdf");
  }
  return false;
}

/** What prints behind a section's divider: the real completed forms / exhibits (PDF pages, or a
 * spreadsheet printed through Excel), or -- for a table section with no print-ready PDF -- this
 * app's own rendered table page. Empty when the section has nothing to show, in which case its
 * divider is left out too. Shared by the plain PDF export and the build-from-PowerPoint export. */
export async function sectionExhibits(section: SectionScanResult, scan: JobScanResult, state: JobState): Promise<{ segments: ReportSegment[]; skipped: string[] }> {
  const id = section.id;
  const segments: ReportSegment[] = [];
  const skipped: string[] = [];

  if (section.generation === "table-from-source") {
    if (section.printPdfFile && !state.sections[id]?.excludePrintPdf) {
      segments.push({ kind: "pdf", path: section.printPdfFile.absolutePath });
    } else {
      const editedTable = section.parsedTable ? applyTableEdits(section.parsedTable, state.sections[id]?.tableEdits) : undefined;
      // A table section with nothing to show is left out entirely rather than printing an empty
      // page; the review screen's omittedReason (page.tsx) mirrors this.
      if (editedTable && editedTable.rows.length > 0) {
        const logo = await logoDataUri();
        const body = renderTable(editedTable, { notesText: state.sections[id]?.tableNotes });
        segments.push({ kind: "html", html: wrapHtml(`<section class="table-section">${pageHeader(section.title, logo)}${body}</section>`) });
      }
    }
  } else if (section.generation === "attach-multi") {
    for (const file of effectiveMultiSelection(section, state.sections[id])) {
      if (file.ext === ".pdf") {
        segments.push({ kind: "pdf", path: file.absolutePath });
        continue;
      }
      // Spreadsheet-only exhibit -- printed through Excel (see excelExhibitToPdf).
      const printed = await excelExhibitToPdf(file.absolutePath, scan.metadata.jobNumber);
      if (printed) segments.push({ kind: "pdf", path: printed });
      else skipped.push(file.relativePath);
    }
  } else if (section.generation === "attach-as-is") {
    // Tech rep's own pick overrides the auto-match (see SectionState.selectedAttachmentPath).
    const selectedPath = state.sections[id]?.selectedAttachmentPath;
    const file = (selectedPath && section.matchedFiles.find((f) => f.relativePath === selectedPath)) || section.matchedFiles[0];
    if (file && file.ext === ".pdf") segments.push({ kind: "pdf", path: file.absolutePath });
    // Matched something that isn't an embeddable PDF (a photo of a scan, say) -- surfaced as
    // skipped rather than silently dropped.
    else if (file) skipped.push(file.relativePath);
  }
  return { segments, skipped };
}

export async function renderReportSegments(scanIn: JobScanResult, state: JobState): Promise<RenderedReport> {
  const scan: JobScanResult = { ...scanIn, sections: reportSections(scanIn, state) };
  const contentFor = (id: string) => state.sections[id]?.content;
  const logo = await logoDataUri();

  const segments: ReportSegment[] = [];
  const skippedAttachments: string[] = [];
  let bodyParts: string[] = [];
  const flush = () => {
    if (bodyParts.length > 0) {
      segments.push({ kind: "html", html: wrapHtml(bodyParts.join("\n")) });
      bodyParts = [];
    }
  };
  const pushExhibits = (exhibits: { segments: ReportSegment[]; skipped: string[] }) => {
    flush();
    segments.push(...exhibits.segments);
    skippedAttachments.push(...exhibits.skipped);
  };

  // Customer-supplied front pages (Calpine's Repair Detail Summary) go ahead of the cover.
  for (const section of scan.sections.filter((s) => s.beforeCover)) pushExhibits(await sectionExhibits(section, scan, state));

  // Cover page: APG's usual look — a large centered logo, the report title, and a left-aligned
  // label/value list; the component-details rows on a second page.
  const { page1, page2 } = coverPages(scan, state);
  const coverRowsHtml = (fields: Array<{ label: string; value: string }>) =>
    fields.map(({ label, value }) => `<div class="cover-row"><span class="cover-label">${escapeHtml(label)}:</span><span class="cover-value">${escapeHtml(value)}</span></div>`).join("");
  bodyParts.push(`
    <section class="cover">
      <img class="cover-logo" src="${logo}" alt="APG" />
      <h1>${escapeHtml(scan.reportType)}</h1>
      <div class="cover-fields">${coverRowsHtml(page1)}</div>
    </section>`);
  if (page2.length > 0) {
    bodyParts.push(`
      <section class="cover cover-continued report-page">
        <div class="cover-fields">${coverRowsHtml(page2)}</div>
      </section>`);
  }

  // Every remaining section in the tech rep's order (dragging a section in the sidebar moves it in
  // the report too), dispatched by generation strategy.
  for (const section of scan.sections) {
    const id = section.id;
    if (section.beforeCover) continue;

    if (section.generation === "llm-narrative") {
      const narrativeHtml = renderNarrative(contentFor(id));
      // Repair Recommendations / Repair Summary are a lead-in line ("APG recommends the following
      // repairs:") over a long list of short step labels -- the lead-in stays full width, the list
      // flows into two columns (see .repairs-columns) so a routine 20-40 step list fits a page.
      const isRepairList = REPAIR_LIST_SECTIONS.has(id);
      let body = narrativeHtml;
      if (isRepairList) {
        const [leadIn, ...rest] = (contentFor(id) ?? "").split("\n");
        body = leadIn?.trim().endsWith(":") ? `<p>${escapeHtml(leadIn.trim())}</p><div class="repairs-columns">${renderNarrative(rest.join("\n"))}</div>` : `<div class="repairs-columns">${narrativeHtml}</div>`;
      }
      const sectionClass = ["report-page", "narrative-section", isRepairList && "repairs-section"].filter(Boolean).join(" ");
      bodyParts.push(`<section class="${sectionClass}">${pageHeader(section.title, logo)}${body}</section>`);
      continue;
    }

    if (section.generation === "llm-vision-select") {
      if (section.divider) bodyParts.push(dividerPage(section.title, logo));
      bodyParts.push(await renderPhotoPages(section, scan.jobRoot, state.sections[id], logo));
      continue;
    }

    const exhibits = await sectionExhibits(section, scan, state);
    skippedAttachments.push(...exhibits.skipped);
    if (exhibits.segments.length === 0) continue; // nothing to show -- leave the whole block (divider too) out
    if (section.divider) bodyParts.push(dividerPage(section.title, logo));
    pushExhibits({ segments: exhibits.segments, skipped: [] });
  }

  flush();
  return { segments, skippedAttachments };
}
