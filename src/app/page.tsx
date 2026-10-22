"use client";

import { useEffect, useRef, useState } from "react";
import type { JobScanResult, SectionScanResult } from "@/lib/ingest/scanJobFolder";
import type { JobFile } from "@/lib/ingest/fileWalk";
import { COVER_FIELD_ORDER } from "@/lib/ingest/jobMetadata";
import type { SectionState } from "@/lib/state/jobState";

type SectionWithState = SectionScanResult & { state: SectionState };
type ScanResponse = Omit<JobScanResult, "sections"> & { sections: SectionWithState[]; sectionOrder?: string[] };

// Kept as a small literal here rather than importing from "@/lib/report-templates" -- this is a
// client component, and the two ids are all it actually needs; resolving which real
// ReportTemplate each one maps to happens entirely server-side (see resolveReportTemplate).
type ReportTypeId = "ia" | "final";
const REPORT_TYPE_OPTIONS: Array<{ id: ReportTypeId; label: string; description: string }> = [
  {
    id: "ia",
    label: "I&A Report",
    description: "Inspect & Advise",
  },
  {
    id: "final",
    label: "Final Report",
    description: "The completion deliverable",
  },
];

function ReportTypePicker({ onChosen }: { onChosen: (id: ReportTypeId) => void }) {
  return (
    <div className="folder-picker">
      <div className="app-logo">
        <AppLogoMark />
        <h1>Report Builder</h1>
      </div>
      <div className="app-logo-bar" />
      <p className="folder-picker-subtitle">Which report are you building?</p>
      <div className="folder-picker-card">
        <div className="report-type-options">
          {REPORT_TYPE_OPTIONS.map((opt) => (
            <button key={opt.id} className="report-type-option" onClick={() => onChosen(opt.id)}>
              <span className="report-type-option-label">{opt.label}</span>
              <span className="report-type-option-description">{opt.description}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Why a section won't appear in the generated report, if it won't: "removed" (the tech rep took
 * it out with the ✕), or "empty" (a table section with no data and no completed form to embed --
 * renderReportHtml.ts leaves these out automatically). Mirrors that file's own checks. */
function omittedReason(s: SectionWithState): "removed" | "empty" | null {
  if (s.state.excludeFromReport) return "removed";
  if (s.generation === "table-from-source") {
    const printPdfInUse = Boolean(s.printPdfFile) && !s.state.excludePrintPdf;
    if (!printPdfInUse && (!s.parsedTable || s.parsedTable.rows.length === 0)) return "empty";
  }
  return null;
}

function StatusBadge({ status, acknowledged, omitted }: { status: string; acknowledged?: boolean; omitted?: "removed" | "empty" | null }) {
  if (omitted) return <span className="status-badge omitted">{omitted === "removed" ? "Removed" : "Not in report"}</span>;
  // "ready" means the data/draft is there, not that a person has looked at it — don't let that
  // read as done until the tech rep actually clicks "Tech Rep Reviewed". But once they do,
  // that click is the tech rep vouching for the section themselves -- show it as Ready (green)
  // even if it started out missing or needs-attention, rather than still flagging it red/yellow.
  const effectiveStatus = acknowledged ? "ready" : status;
  const label = acknowledged ? "Ready" : status === "ready" ? "Ready for Review" : status.replace("-", " ");
  return <span className={`status-badge ${effectiveStatus}`}>{label}</span>;
}

function FolderIcon() {
  // A clean minimal folder glyph in the brand navy (currentColor), replacing the 📁 emoji --
  // renders identically everywhere instead of varying by OS/browser emoji font.
  return (
    <svg className="folder-icon" viewBox="0 0 20 16" width="16" height="16" fill="none" aria-hidden="true">
      <path
        d="M1 3a1 1 0 0 1 1-1h4.5l1.5 1.8H18a1 1 0 0 1 1 1V13a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V3Z"
        fill="currentColor"
        opacity="0.9"
      />
    </svg>
  );
}

/** The APG mark, either plain (the usual static header) or `animated` -- a pale grayscale copy of
 * the same image sits underneath a full-color copy whose clip-path is animated top-to-bottom on
 * a loop, so color appears to "pour" down through the mark while a job is being scanned/drafted.
 * Two copies of the same PNG rather than a real fill-percentage effect, since this is a fixed
 * raster image (no path data to animate a stroke/fill along) and there's no real progress
 * percentage to report anyway -- it's a "still working" indicator, not a progress bar. */
function AppLogoMark({ animated }: { animated?: boolean }) {
  if (!animated) {
    return <img src="/apg-mark-transparent.png" alt="" className="app-logo-icon" />;
  }
  return (
    <span className="app-logo-mark">
      <img src="/apg-mark-transparent.png" alt="" className="app-logo-mark-img app-logo-mark-base" />
      <img src="/apg-mark-transparent.png" alt="" className="app-logo-mark-img app-logo-mark-fill" />
    </span>
  );
}

// Matches the same sentinel in /api/browse's route -- requesting this "dir" returns the drives
// list (Windows Explorer's "This PC") instead of a real folder's contents.
const DRIVES_ROOT = "__DRIVES__";

interface FolderSearchResult {
  relativePath: string;
  fullPath: string;
}

function FolderPicker({ onJobFolderChosen, onBack }: { onJobFolderChosen: (path: string) => void; onBack: () => void }) {
  const [dir, setDir] = useState<string | null>(null);
  const [folders, setFolders] = useState<string[]>([]);
  const [parent, setParent] = useState<string | null>(null);
  const [isDriveList, setIsDriveList] = useState(false);
  // Which quick-start tab is active -- purely a UI highlight, doesn't affect what gets fetched.
  // Set on every explicit navigation, not just the two tab buttons, so "Up one level" out of a
  // This-PC-rooted path (e.g. up from T:\ to the drives list) still shows "This PC" highlighted
  // rather than silently reverting to "OneDrive".
  const [source, setSource] = useState<"onedrive" | "thisPc">("onedrive");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Search state, separate from the normal single-level browsing above -- a query searches
  // recursively downward from the current folder (see /api/browse's searchFolders) instead of
  // just filtering what's already listed, since the whole point is finding a job folder buried
  // a level or two down in a "massive" Working Jobs tree without knowing which bucket it's in.
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<FolderSearchResult[] | null>(null);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [searching, setSearching] = useState(false);

  const load = async (target?: string) => {
    setLoading(true);
    setQuery("");
    setSearchResults(null);
    try {
      const url = target ? `/api/browse?dir=${encodeURIComponent(target)}` : "/api/browse";
      const res = await fetch(url);
      const data = await res.json();
      if (!res.ok) {
        setError(data.error);
        return;
      }
      setError(null);
      setDir(data.dir);
      setParent(data.parent);
      setFolders(data.folders);
      setIsDriveList(!!data.isDriveList);
      setSource(target === DRIVES_ROOT || data.isDriveList ? "thisPc" : target ? source : "onedrive");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Fetch-on-mount: `load` intentionally omitted from deps (stable enough for this one-shot
    // initial listing) and its setState calls happen after an await, not synchronously.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, []);

  // Debounced so typing a full job number doesn't fire a recursive filesystem search per
  // keystroke -- only once things settle for 300ms. Cleared (not searched) once the box is
  // emptied, and this whole effect is skipped while browsing the drives list, which has no real
  // `dir` to search under.
  useEffect(() => {
    if (!dir || isDriveList) return;
    if (!query.trim()) {
      setSearchResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const handle = setTimeout(async () => {
      try {
        const res = await fetch(`/api/browse?dir=${encodeURIComponent(dir)}&q=${encodeURIComponent(query.trim())}`);
        const data = await res.json();
        if (res.ok) {
          setSearchResults(data.results ?? []);
          setSearchTruncated(!!data.truncated);
        }
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(handle);
  }, [query, dir, isDriveList]);

  const searchActive = searchResults !== null;

  return (
    <div className="folder-picker">
      <div className="app-logo">
        <AppLogoMark />
        <h1>Report Builder</h1>
      </div>
      <div className="app-logo-bar" />
      <p className="folder-picker-subtitle">Pick the job folder to scan.</p>
      <div className="folder-picker-card">
        <div className="toolbar" style={{ marginBottom: 4 }}>
          <button className="secondary" onClick={onBack}>
            ← Change report type
          </button>
        </div>
        {/* Two starting points, side by side -- OneDrive (the usual "Tech Rep Automation" job
            folders) and This PC (any local or mapped network drive, e.g. a company T: drive)
            -- rather than only ever starting from one default location. */}
        <div className="folder-source-tabs">
          <button className={`folder-source-tab ${source === "onedrive" ? "active" : ""}`} onClick={() => load()}>
            ☁️ OneDrive
          </button>
          <button className={`folder-source-tab ${source === "thisPc" ? "active" : ""}`} onClick={() => load(DRIVES_ROOT)}>
            💻 This PC
          </button>
        </div>
        <p className="job-path">{isDriveList ? "This PC" : dir}</p>
        {error && (
          <p className="folder-picker-error" style={{ color: "#a4141a" }}>
            {error}
          </p>
        )}
        {!isDriveList && (
          <div className="folder-search">
            <input
              type="text"
              className="folder-search-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search job folders inside here…"
            />
            {query && (
              <button className="folder-search-clear" onClick={() => setQuery("")} aria-label="Clear search">
                ✕
              </button>
            )}
            {searching && <span className="folder-search-status">Searching…</span>}
          </div>
        )}
        <div className="toolbar">
          <button className="secondary" disabled={!parent} onClick={() => parent && load(parent)}>
            Up one level
          </button>
          {dir && <button onClick={() => onJobFolderChosen(dir)}>Use this folder</button>}
        </div>
        {searchActive ? (
          searchResults && searchResults.length === 0 ? (
            <div className="folder-list-empty">No folders matching &quot;{query}&quot; found inside here.</div>
          ) : (
            <>
              <div className="folder-list folder-list-enter" key="search">
                {(searchResults ?? []).map((r) => (
                  <button key={r.fullPath} onClick={() => load(r.fullPath)}>
                    <FolderIcon /> {r.relativePath}
                  </button>
                ))}
              </div>
              {searchTruncated && (
                <p className="folder-search-hint">Showing the first {searchResults?.length} matches — narrow your search for more precise results.</p>
              )}
            </>
          )
        ) : loading ? (
          <div className="folder-list-loading">Loading…</div>
        ) : folders.length === 0 ? (
          <div className="folder-list-empty">{isDriveList ? "No drives found." : "No subfolders here."}</div>
        ) : (
          <div className="folder-list folder-list-enter" key={dir ?? "root"}>
            {folders.map((f) => (
              <button key={f} onClick={() => load(isDriveList ? f : dir ? `${dir.replace(/\\$/, "")}\\${f}` : f)}>
                <FolderIcon /> {f}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Stable per-row id for a custom cover field (see SectionState.customFields), so a saved
// fieldOrder can keep referencing a row across edits to its own label/value. crypto.randomUUID
// isn't available on very old browsers, hence the fallback -- collision odds are irrelevant here
// (a handful of rows on one job's cover page, not a distributed system).
function genId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2);
}

function chunkRows<T>(rows: T[], numChunks: number): T[][] {
  const perChunk = Math.ceil(rows.length / numChunks);
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += perChunk) chunks.push(rows.slice(i, i + perChunk));
  return chunks;
}

// Sections where the tech rep can manually attach a file -- always available, not just when
// automatic matching found nothing, since a confident-looking match can still be the wrong file
// (see ManualAttachmentUpload and scanJobFolder.ts's manualAttachmentsFor). Deliberately not every
// file-backed section: Photo Set is a multi-file selection, not one exhibit, so hand-attaching a
// single file there doesn't make sense the same way. Scrap Report / SN Recording Sheet normally
// read a tab out of the Serial Number List workbook rather than a standalone file, but a manually
// attached PDF still works for them -- it's treated as the real, standalone print-ready export of
// that tab (see scanJobFolder.ts's OPTIONAL_SUBSHEET_PARSERS handling of manualPdf) and embedded
// outright, overriding whatever the xlsx tab itself parsed to.
const MANUAL_ATTACHMENT_SECTIONS = new Set([
  "chemTest",
  "crackMap",
  "serialNumberList",
  "scrapReport",
  "snRecordingSheet",
  "heightDimForm",
  "dovetailDimension",
  "zDropDimension",
  "wallThickness",
  "metallurgicalReport",
  "airflowReport",
  // Final Report's own sections -- same reasoning as their I&A counterparts above.
  "finalSerialNumberList",
  "finalScrapReport",
  "finalHeightDimForm",
  "finalWallThickness",
  "finalAirflowReport",
  "preWeldHeatTreatChart",
  "postWeldHeatTreatChart",
  "xRayInspection",
  "finalNdt",
  "zNotchDimensions",
  "postCoatHeatTreatChart",
  "finalAgeHeatTreatChart",
  "coatingCertification",
  "shotPeenAlSealStripCert",
  "damperPinCheck",
  "finalMomentWeigh",
]);

function ManualAttachmentUpload({
  jobRoot,
  sectionId,
  manualAttachments,
  onUploaded,
  hint,
}: {
  jobRoot: string;
  sectionId: string;
  /** Everything currently manually attached to this section (see SectionScanResult.
   * manualAttachments) -- shown as removable chips right next to the upload button. */
  manualAttachments?: JobFile[];
  onUploaded: () => void;
  hint?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<string | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  const inputId = `manual-attach-${sectionId}`;

  // Accepts one or more files at once (a multi-page cert scanned as separate images, or just
  // several to compare) and adds them alongside whatever's already matched/attached -- doesn't
  // touch the current selection, since a tech rep adding a file often just wants a second one on
  // hand to compare or swap to later, not to immediately replace what's already selected.
  const handleFiles = async (files: File[]) => {
    setBusy(true);
    try {
      const form = new FormData();
      form.append("jobRoot", jobRoot);
      form.append("sectionId", sectionId);
      for (const file of files) form.append("file", file);
      const res = await fetch("/api/manual-attachment", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Upload failed");
      // The file(s) now sit inside the job folder itself (see manualAttachmentsFor's convention),
      // so a full rescan is what actually picks them up -- there's no lighter-weight update that
      // would parse it, resolve a print-PDF pairing, etc.
      onUploaded();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  // Counts nested drag-enter/leave pairs rather than toggling on every one -- dragging over a
  // child element (the button, a chip) fires its own enter/leave against the same drop zone, and
  // without counting, that flickers the "dragging" highlight off the instant the cursor crosses
  // into any of them instead of staying on for the whole time something's dragged over the box.
  const dragDepth = useRef(0);
  const onDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current += 1;
    if (e.dataTransfer.types.includes("Files")) setDragging(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onDragOver = (e: React.DragEvent) => {
    // Required for onDrop to ever fire at all -- a plain <div> refuses drops by default.
    e.preventDefault();
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) handleFiles(files);
  };

  const removeFile = async (baseName: string) => {
    setRemoving(baseName);
    try {
      const res = await fetch("/api/manual-attachment", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobRoot, sectionId, fileName: baseName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Remove failed");
      onUploaded();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Remove failed");
    } finally {
      setRemoving(undefined);
    }
  };

  return (
    <div
      className={`manual-attachment ${dragging ? "dragging" : ""}`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="manual-attachment-row">
        <input
          id={inputId}
          type="file"
          multiple
          className="manual-attachment-input"
          disabled={busy}
          onChange={(e) => {
            // Snapshotted into a real array *before* clearing the input -- e.target.files is a
            // live FileList tied to the input's own current value, not an independent copy, so
            // clearing e.target.value right after reading it (to let picking the exact same file
            // again re-fire onChange) could empty this same reference out from under handleFiles
            // before it ever ran. That's exactly what silently ate every click-to-browse upload:
            // drag-and-drop was never affected since DataTransfer.files isn't tied to any input.
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (files.length > 0) handleFiles(files);
          }}
        />
        <label htmlFor={inputId} className={`manual-attachment-btn ${busy ? "busy" : ""}`}>
          📎 {busy ? "Uploading…" : "Insert files manually"}
        </label>
        {/* Every file currently manually attached to this section -- hover a chip to reveal its
            own "x" and pull just that one back out, without disturbing anything else attached
            here or whatever's currently selected. */}
        {manualAttachments?.map((f) => (
          <span key={f.relativePath} className="manual-attachment-chip" title={f.baseName}>
            <span className="manual-attachment-chip-name">{f.baseName}</span>
            <button
              type="button"
              className="manual-attachment-chip-remove"
              disabled={removing === f.baseName}
              onClick={() => removeFile(f.baseName)}
              title={`Remove ${f.baseName}`}
            >
              ✕
            </button>
          </span>
        ))}
      </div>
      <p className="manual-attachment-hint">
        {hint ?? "Didn't find it automatically? If you have this file somewhere else on your computer, add it here."} Or drag and drop it anywhere
        in this box.
      </p>
    </div>
  );
}

function TablePreview({
  jobRoot,
  section,
  onRefresh,
  patchSectionState,
}: {
  jobRoot: string;
  section: SectionWithState;
  onRefresh: () => void;
  patchSectionState: (sectionId: string, patch: Partial<SectionState>) => void;
}) {
  const table = section.parsedTable;
  // Keyed "<row index>:<column name>" against the table's own row order -- see
  // SectionState.tableEdits / applyTableEdits. Local state so typing doesn't round-trip to the
  // server on every keystroke; an explicit Save persists it (same pattern as CoverEditor).
  const [edits, setEdits] = useState<Record<string, string>>(section.state.tableEdits ?? {});
  const [notesText, setNotesText] = useState(section.state.tableNotes ?? "");
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Always available, even when a good match (a parsed table and/or a print-ready PDF) was
  // already found -- automatic matching can still land on the wrong file, so the tech rep always
  // has a direct way to swap in a different one, not only when nothing was found at all.
  const insertFile = MANUAL_ATTACHMENT_SECTIONS.has(section.id) && (
    <ManualAttachmentUpload
      jobRoot={jobRoot}
      sectionId={section.id}
      manualAttachments={section.manualAttachments}
      onUploaded={onRefresh}
      hint={table || section.printPdfFile ? "Not the right file? Add the correct one manually here." : undefined}
    />
  );

  if (!table) {
    // No data spreadsheet to show as a table, but the completed print-ready PDF was found (see
    // scanJobFolder.ts's PRINT_PDF_SECTIONS) and is what the report actually uses -- the
    // statusReason above this already explains that, so don't also claim there's "no data", just
    // still offer a way to swap that PDF for a different one.
    if (section.printPdfFile) return <div>{insertFile}</div>;
    return (
      <div>
        <p className="section-reason">No table data available.</p>
        {insertFile}
      </div>
    );
  }

  // A genuinely empty table (Scrap Report / SN Recording Sheet with nothing recorded for this
  // job yet) -- an empty grid with headers and no rows reads as broken, not "nothing to report".
  // table.notes already carries a plain-English explanation for exactly this case.
  if (table.rows.length === 0 && (table.summaryRows ?? []).length === 0) {
    return (
      <div>
        {table.notes.map((n, i) => (
          <p key={i} className="section-reason">
            {n}
          </p>
        ))}
        {insertFile}
      </div>
    );
  }

  const cellValue = (rowIndex: number, col: string, raw: string) => edits[`${rowIndex}:${col}`] ?? raw ?? "";

  const editCell = (rowIndex: number, col: string, value: string) => {
    setEdits((prev) => ({ ...prev, [`${rowIndex}:${col}`]: value }));
    setDirty(true);
  };

  const save = async () => {
    setBusy(true);
    try {
      await fetch("/api/section-state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobRoot, sectionId: section.id, patch: { tableEdits: edits, tableNotes: notesText } }),
      });
      // This component remounts fresh (re-deriving `edits`/`notesText` from section.state) every
      // time its tab is switched away from and back to -- without patching the saved values into
      // the parent's own `scan` state right here, a save that genuinely succeeded on disk still
      // looked like it vanished the moment you came back to this tab, because the remount was
      // reading `section.state` from before this save ever happened.
      patchSectionState(section.id, { tableEdits: edits, tableNotes: notesText });
      setDirty(false);
    } finally {
      setBusy(false);
    }
  };

  // Serial Number List is a long, simple 3-column list (matching the real DS-0554 form, which
  // itself lays it out as three parallel column blocks) -- reflowing it the same way here keeps
  // the on-screen review matching what actually prints, instead of one tall single column.
  const columnBlocks = section.id === "serialNumberList" && table.rows.length > 3 ? 3 : 1;
  // chunkRows slices rows into sequential ranges (chunk 0 = rows[0..perChunk-1], chunk 1 =
  // rows[perChunk..2*perChunk-1], ...), so a row's real index -- the one edits are keyed
  // against -- is derivable from its chunk and its position within it, without chunkRows itself
  // needing to carry indices through.
  const perChunk = Math.ceil(table.rows.length / columnBlocks);

  // Keyed by column index, not the column name itself -- a source form's own header row can
  // repeat or leave blank a label (confirmed on a real job: a wall-thickness form variant with an
  // unlabeled/merged header cell produced two blank column names), and React requires unique keys
  // regardless of what the underlying data looks like.
  const headerCells = table.columns.map((c, ci) => (
    <th key={ci} data-col={c}>
      {c}
    </th>
  ));

  const editableCell = (rowIndex: number, c: string, row: Record<string, string>, colIndex: number) => {
    const value = cellValue(rowIndex, c, row[c]);
    return (
      <td key={colIndex} data-col={c} className={value.includes("OUT OF SPEC") ? "fail" : ""}>
        <input type="text" className="table-cell-input" value={value} onChange={(e) => editCell(rowIndex, c, e.target.value)} />
      </td>
    );
  };

  return (
    <div style={{ overflowX: "auto" }}>
      <p className="file-count">
        Source: {table.sourceFile} — sheet &quot;{table.sheetName}&quot; — {table.sampleSize} row(s)
        {table.populationSize ? ` of ${table.populationSize}` : ""}
        {typeof table.outOfSpecCount === "number" ? ` — ${table.outOfSpecCount} out of spec` : ""}
      </p>
      <p className="file-count">Click any cell to correct it — a typo'd serial, a re-measured value. Save when you're done.</p>
      {table.notes.map((n, i) => (
        <p key={i} className="confidence-note">
          {n}
        </p>
      ))}
      {table.formHeader && table.formHeader.length > 0 && (
        <div className="form-header-grid">
          {table.formHeader.map(({ label, value }) => (
            <div className="form-header-cell" key={label}>
              <span className="form-header-label">{label}</span> {value}
            </div>
          ))}
        </div>
      )}
      {columnBlocks > 1 ? (
        <div className="table-columns">
          {chunkRows(table.rows, columnBlocks).map((rowsChunk, blockIdx) => (
            <table className="preview-table table-block" key={blockIdx}>
              <thead>
                <tr>{headerCells}</tr>
              </thead>
              <tbody>
                {rowsChunk.map((row, i) => {
                  const rowIndex = blockIdx * perChunk + i;
                  return <tr key={rowIndex}>{table.columns.map((c, ci) => editableCell(rowIndex, c, row, ci))}</tr>;
                })}
              </tbody>
            </table>
          ))}
        </div>
      ) : (
        <table className="preview-table">
          <thead>
            <tr>{headerCells}</tr>
          </thead>
          <tbody>
            {table.rows.map((row, i) => (
              <tr key={i}>{table.columns.map((c, ci) => editableCell(i, c, row, ci))}</tr>
            ))}
            {(table.summaryRows ?? []).map((row, i) => (
              <tr key={`summary-${i}`} style={{ fontWeight: 700, background: "#f0f0f0" }}>
                {table.columns.map((c, ci) => (
                  <td key={ci} data-col={c}>
                    {row[c]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {table.hasNotesBox && (
        <div className="form-notes-box">
          <span className="form-notes-label">NOTES:</span>
          <textarea
            className="form-notes-input"
            value={notesText}
            onChange={(e) => {
              setNotesText(e.target.value);
              setDirty(true);
            }}
            placeholder="Type any remarks here — same as writing on the paper form."
          />
        </div>
      )}
      <div className="toolbar">
        <button disabled={busy || !dirty} onClick={save}>
          {busy ? "Saving..." : dirty ? "Save changes" : "Saved"}
        </button>
      </div>
      {insertFile}
    </div>
  );
}

function NarrativeEditor({
  jobRoot,
  section,
  onUpdated,
  turbineModel,
}: {
  jobRoot: string;
  section: SectionWithState;
  onUpdated: (content: string) => void;
  turbineModel: string;
}) {
  // Keyed by section.id in SectionPanel below, so this remounts (and re-derives its initial
  // state from `section`) whenever the reviewer switches sections — no sync effect needed.
  const [draft, setDraft] = useState(section.state.content ?? "");
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);

  const runDraft = async (withInstruction?: string) => {
    setBusy(true);
    try {
      const res = await fetch("/api/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobRoot, sectionId: section.id, instruction: withInstruction }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setDraft(data.content ?? "");
      onUpdated(data.content ?? "");
      setInstruction("");
    } catch (e) {
      alert(e instanceof Error ? e.message : "Draft failed");
    } finally {
      setBusy(false);
    }
  };

  const saveManualEdit = async () => {
    setBusy(true);
    try {
      await fetch("/api/section-state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobRoot, sectionId: section.id, patch: { content: draft, draftError: null } }),
      });
      onUpdated(draft);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {section.state.draftError && !draft && (
        <p className="confidence-note" style={{ color: "#a4141a" }}>
          ⚠ Automatic draft generation didn&apos;t produce a draft for this section: {section.state.draftError} Write it manually below, or use &quot;Revise with
          instruction&quot; to ask Claude for a fresh attempt.
        </p>
      )}
      <textarea className="draft-textarea" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="No draft yet — flagged for manual review." />
      <div className="toolbar">
        <button className="secondary" disabled={busy} onClick={saveManualEdit}>
          Save Edit
        </button>
      </div>
      <div className="toolbar">
        <input
          type="text"
          placeholder="Instruction for Claude, e.g. 'make this more concise'"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
        />
        <button disabled={busy || !instruction} onClick={() => runDraft(instruction)}>
          Revise with instruction
        </button>
      </div>
      {section.id === "iaSummary" && <StandardDiagramToggle jobRoot={jobRoot} section={section} turbineModel={turbineModel} />}
    </div>
  );
}

// Every real 7FA I&A report includes the same fixed reference diagram on its Engineering Summary
// page (see renderReportHtml.ts's renderStandardDiagram) -- this mirrors that same 7FA check so
// the toggle only shows up on the jobs it actually applies to.
const SEVEN_FA_PATTERN = /^F?7FA/i;

/** Lets the tech rep turn APG's standard 7FA modification-reference diagram on or off for this
 * job's I&A Summary page. On by default for any 7FA job (matching the real completed report,
 * which always includes it) -- this is a fixed illustration, not one of the job's own photos, so
 * there's nothing to pick, just whether to include it. */
function StandardDiagramToggle({ jobRoot, section, turbineModel }: { jobRoot: string; section: SectionWithState; turbineModel: string }) {
  const isSevenFA = SEVEN_FA_PATTERN.test(turbineModel.trim());
  // Keyed by section.id in SectionPanel below, so a section switch remounts this fresh.
  const [included, setIncluded] = useState(section.state.includeStandardDiagram ?? isSevenFA);
  const [busy, setBusy] = useState(false);

  if (!isSevenFA) return null;

  const toggle = async () => {
    const next = !included;
    setIncluded(next);
    setBusy(true);
    try {
      await fetch("/api/section-state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobRoot, sectionId: "iaSummary", patch: { includeStandardDiagram: next } }),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="standard-diagram-toggle">
      <h3 style={{ fontSize: 14, margin: "20px 0 4px" }}>Standard 7FA Reference Diagram</h3>
      <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: busy ? "default" : "pointer" }}>
        <input type="checkbox" checked={included} disabled={busy} onChange={toggle} />
        <span className="file-count" style={{ margin: 0 }}>
          Include APG&apos;s standard 7FA modification-reference diagram on this page — every 7FA report includes it by
          default; uncheck to leave it out for this job.
        </span>
      </label>
      {included && (
        <img
          src="/reference/7fa-modification-diagram.png"
          alt="Standard 7FA modification-reference diagram"
          style={{ maxWidth: 320, marginTop: 8, border: "1px solid #ccc", borderRadius: 4 }}
        />
      )}
    </div>
  );
}

const PHOTOS_PER_PAGE = 60;

function PhotoSetEditor({ jobRoot, section }: { jobRoot: string; section: SectionWithState }) {
  // Keyed by section.id in SectionPanel below, so a section switch remounts this fresh.
  const [selected, setSelected] = useState<string[]>(section.state.selectedPhotoPaths ?? []);
  const [filter, setFilter] = useState<"all" | "selected">("all");
  const [page, setPage] = useState(0);
  const [showAll, setShowAll] = useState(false);

  const toggle = async (relativePath: string) => {
    const next = selected.includes(relativePath) ? selected.filter((p) => p !== relativePath) : [...selected, relativePath];
    setSelected(next);
    await fetch("/api/section-state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobRoot, sectionId: section.id, patch: { selectedPhotoPaths: next } }),
    });
  };

  const changeFilter = (next: "all" | "selected") => {
    setFilter(next);
    setPage(0);
  };

  // "selected" is whatever's currently checked -- the AI's initial pick, plus any manual
  // adjustments the tech rep has made since -- so this filter always reflects the live set,
  // not a frozen snapshot of the original auto-selection.
  const filtered = filter === "selected" ? section.matchedFiles.filter((f) => selected.includes(f.relativePath)) : section.matchedFiles;

  const totalPages = Math.max(1, Math.ceil(filtered.length / PHOTOS_PER_PAGE));
  const clampedPage = Math.min(page, totalPages - 1);
  const shown = showAll ? filtered : filtered.slice(clampedPage * PHOTOS_PER_PAGE, clampedPage * PHOTOS_PER_PAGE + PHOTOS_PER_PAGE);

  return (
    <div>
      {/* No section-reason paragraph here -- SectionPanel already shows section.statusReason
          once, generically, above whichever type-specific editor renders (this one included).
          A second copy here was printing "N candidate photo(s) found..." twice in a row. */}
      {section.state.draftError && (
        <p className="confidence-note" style={{ color: "#a4141a" }}>
          ⚠ Automatic photo pre-selection didn&apos;t run: {section.state.draftError} Select photos manually below.
        </p>
      )}
      <p className="file-count">
        Incoming/NDT photos are preselected automatically, minus duplicates and unusable shots — click any photo to toggle it in/out of the final selection.{" "}
        {selected.length} selected.
      </p>

      <div className="photo-filter-tabs">
        <button className={`photo-filter-tab ${filter === "selected" ? "active" : ""}`} onClick={() => changeFilter("selected")}>
          Selected ({selected.length})
        </button>
        <button className={`photo-filter-tab ${filter === "all" ? "active" : ""}`} onClick={() => changeFilter("all")}>
          All ({section.matchedFiles.length})
        </button>
      </div>

      {filtered.length === 0 ? (
        <p className="file-count">No photos in this view yet — toggle some on from &quot;All&quot;.</p>
      ) : (
        <div className="photo-grid">
          {shown.map((f) => (
            <div key={f.relativePath} className={`photo-tile ${selected.includes(f.relativePath) ? "selected" : ""}`} onClick={() => toggle(f.relativePath)}>
              <img
                src={`/api/photo-file?jobRoot=${encodeURIComponent(jobRoot)}&path=${encodeURIComponent(f.relativePath)}`}
                alt={f.relativePath}
                loading="lazy"
              />
              <div className="caption">{f.relativePath.split("/").pop()}</div>
            </div>
          ))}
        </div>
      )}

      {filtered.length > PHOTOS_PER_PAGE &&
        (showAll ? (
          <div className="photo-pagination">
            <span className="photo-page-label">Showing all {filtered.length} photos.</span>
            <button
              className="photo-page-btn"
              onClick={() => {
                setShowAll(false);
                setPage(0);
              }}
            >
              Paginate instead
            </button>
          </div>
        ) : (
          <div className="photo-pagination">
            <button className="photo-page-btn" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={clampedPage === 0}>
              ← Prev
            </button>
            <span className="photo-page-label">
              Page {clampedPage + 1} of {totalPages}
            </span>
            <button className="photo-page-btn" onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={clampedPage >= totalPages - 1}>
              Next →
            </button>
            <button className="photo-page-btn" onClick={() => setShowAll(true)}>
              Show all {filtered.length}
            </button>
          </div>
        ))}
    </div>
  );
}

function AttachAsIs({ jobRoot, section, onRefresh }: { jobRoot: string; section: SectionWithState; onRefresh: () => void }) {
  const candidates = section.matchedFiles;
  // Keyed by section.id in SectionPanel above, so this remounts (and re-derives its initial
  // selection from `section`) whenever the reviewer switches sections — no sync effect needed.
  const [selected, setSelected] = useState<string | undefined>(section.state.selectedAttachmentPath ?? candidates[0]?.relativePath);
  const [hovered, setHovered] = useState<string | undefined>(undefined);
  const [excluding, setExcluding] = useState<string | undefined>(undefined);

  const choose = async (relativePath: string) => {
    setSelected(relativePath);
    await fetch("/api/section-state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobRoot, sectionId: section.id, patch: { selectedAttachmentPath: relativePath } }),
    });
  };

  // Rejects a wrong auto-matched candidate outright -- e.g. a Purchase Requisition that happened
  // to match the Chem Test filename pattern (see excludedMatchedPaths's own comment). The file
  // itself is left alone on disk; only its relativePath is remembered so /api/scan filters it back
  // out of matchedFiles on every future rescan, instead of it reappearing every time.
  const excludeCandidate = async (relativePath: string) => {
    setExcluding(relativePath);
    try {
      const nextExcluded = [...(section.state.excludedMatchedPaths ?? []), relativePath];
      const res = await fetch("/api/section-state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobRoot, sectionId: section.id, patch: { excludedMatchedPaths: nextExcluded } }),
      });
      if (!res.ok) throw new Error("Failed to remove candidate");
      if (selected === relativePath) setSelected(undefined);
      if (hovered === relativePath) setHovered(undefined);
      onRefresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to remove candidate");
    } finally {
      setExcluding(undefined);
    }
  };

  const fileUrl = (relativePath: string) => `/api/photo-file?jobRoot=${encodeURIComponent(jobRoot)}&path=${encodeURIComponent(relativePath)}`;

  if (candidates.length === 0) {
    return (
      <div>
        <p className="section-reason">No file found — this exhibit will be missing from the generated report unless you add one to the job folder.</p>
        {MANUAL_ATTACHMENT_SECTIONS.has(section.id) && (
          <ManualAttachmentUpload jobRoot={jobRoot} sectionId={section.id} manualAttachments={section.manualAttachments} onUploaded={onRefresh} />
        )}
      </div>
    );
  }

  if (candidates.length === 1) {
    return (
      <div>
        <p className="section-reason" style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
          <button
            type="button"
            className="exclude-print-pdf-btn"
            disabled={excluding === candidates[0].relativePath}
            onClick={() => excludeCandidate(candidates[0].relativePath)}
            title="Not the right file — stop matching it automatically for this section"
          >
            ✕
          </button>
          <span>
            Attached as-is: <strong>{candidates[0].relativePath}</strong>
          </span>
        </p>
        {/* Always available, even for a confident filename match -- automatic matching can still
            pick the wrong file (confirmed on a real job: a Purchase Requisition happened to match
            the Chem Test filename pattern while the real vendor certificate sat under a generic
            scanner filename elsewhere), so the tech rep always has a direct way to override it,
            not only when the match already reads as uncertain. */}
        {MANUAL_ATTACHMENT_SECTIONS.has(section.id) && (
          <ManualAttachmentUpload
            jobRoot={jobRoot}
            sectionId={section.id}
            manualAttachments={section.manualAttachments}
            onUploaded={onRefresh}
            hint="Not the right file? Add the correct one manually here."
          />
        )}
      </div>
    );
  }

  // What the preview panel shows: whichever candidate the cursor is directly over, or (the vast
  // majority of the time) your actual pick. Previously this fell back to nothing at all once the
  // cursor left a candidate row, which meant moving the mouse down toward the preview itself --
  // or anywhere else past the candidate list -- left the last-hovered row "stuck" as the preview,
  // even though the cursor was no longer anywhere near it. Falling back to `selected` instead of
  // `undefined`, and clearing `hovered` the moment the cursor leaves a given row (not just the
  // whole picker), means the preview always reads as "what's actually selected" the instant
  // you're not deliberately pointing at a different candidate to compare it.
  const previewTarget = hovered ?? selected;

  return (
    <div>
      <p className="section-reason">
        {candidates.length} files could be this section&apos;s real exhibit — pick which one is actually correct. Your pick is what gets attached
        to the generated report. Hover a file to preview it.
      </p>
      <div className="attachment-picker">
        <div className="attachment-candidates">
          {candidates.map((f) => (
            <div
              key={f.relativePath}
              className={`attachment-candidate ${selected === f.relativePath ? "selected" : ""}`}
              onMouseEnter={() => setHovered(f.relativePath)}
              onMouseLeave={() => setHovered(undefined)}
            >
              <button type="button" className="attachment-candidate-select" onClick={() => choose(f.relativePath)}>
                {selected === f.relativePath ? "✓ " : ""}
                {f.relativePath}
              </button>
              <button
                type="button"
                className="attachment-candidate-remove"
                disabled={excluding === f.relativePath}
                onClick={() => excludeCandidate(f.relativePath)}
                title={`Not this one — remove "${f.relativePath}" from the candidate list`}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        {previewTarget && (
          <div className="attachment-preview">
            <iframe key={previewTarget} src={fileUrl(previewTarget)} title={previewTarget} />
          </div>
        )}
      </div>
      {/* Escape hatch for when none of the candidates above are actually right. */}
      {MANUAL_ATTACHMENT_SECTIONS.has(section.id) && (
        <ManualAttachmentUpload jobRoot={jobRoot} sectionId={section.id} manualAttachments={section.manualAttachments} onUploaded={onRefresh} />
      )}
    </div>
  );
}

function CoverEditor({
  jobRoot,
  section,
  metadata,
  patchSectionState,
}: {
  jobRoot: string;
  section: SectionWithState;
  metadata: JobScanResult["metadata"];
  patchSectionState: (sectionId: string, patch: Partial<SectionState>) => void;
}) {
  // Keyed by section.id in SectionPanel below, so this remounts fresh if the job is rescanned.
  const initial: Record<string, string> = {};
  for (const { key } of COVER_FIELD_ORDER) {
    const raw = (section.state.fields?.[key as string] ?? (metadata[key] as string) ?? "").toString();
    initial[key as string] = key === "date" ? raw.split("T")[0] : raw;
  }
  const [values, setValues] = useState(initial);
  // Extra label/value rows beyond the fixed COVER_FIELD_ORDER set, for whatever a specific job
  // needs called out that none of the standard fields cover (see SectionState.customFields). A
  // row saved before ids existed gets one generated here, purely for this session's reordering --
  // harmless if it changes between sessions since nothing else keys off it.
  const [customFields, setCustomFields] = useState(() => (section.state.customFields ?? []).map((f) => ({ ...f, id: f.id ?? genId() })));
  // Combined display order across BOTH the fixed fields (by key) and custom fields (by id) -- lets
  // any field move anywhere in the list, not just within its own fixed/custom group. Falls back to
  // "every fixed field in COVER_FIELD_ORDER's own order, then every custom field in the order they
  // were added" the first time a job's cover is opened (see SectionState.fieldOrder's own comment).
  const [rowOrder, setRowOrder] = useState<string[]>(() => {
    const allKeys = [...COVER_FIELD_ORDER.map(({ key }) => key as string), ...customFields.map((f) => f.id)];
    const placed = (section.state.fieldOrder ?? []).filter((k) => allKeys.includes(k));
    const rest = allKeys.filter((k) => !placed.includes(k));
    return [...placed, ...rest];
  });
  const [busy, setBusy] = useState(false);
  // Which row is being dragged / currently dragged over, purely for visual feedback -- see the
  // sidebar's own draggingSectionId/dragOverSectionId for the same pattern.
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    try {
      const patch = { fields: values, customFields, fieldOrder: rowOrder };
      await fetch("/api/section-state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobRoot, sectionId: section.id, patch }),
      });
      // This component remounts fresh (re-deriving local state from section.state) every time its
      // tab is switched away from and back to -- without patching the saved values into the
      // parent's own `scan` state right here, a save that genuinely succeeded on disk still looked
      // like it vanished the moment you came back to this tab, because the remount was reading
      // `section.state` from before this save ever happened.
      patchSectionState(section.id, patch);
    } finally {
      setBusy(false);
    }
  };

  const editCustomField = (id: string, patch: Partial<{ label: string; value: string }>) =>
    setCustomFields((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));

  const addCustomField = () => {
    const id = genId();
    setCustomFields((prev) => [...prev, { id, label: "", value: "" }]);
    setRowOrder((prev) => [...prev, id]);
  };

  const removeCustomField = (id: string) => {
    setCustomFields((prev) => prev.filter((f) => f.id !== id));
    setRowOrder((prev) => prev.filter((k) => k !== id));
  };

  // Drags `draggedKey` out of the order and back in immediately before `targetKey` -- same
  // remove-then-reinsert-at-the-target's-post-removal-index approach as the sidebar's own
  // reorderSections, so the arithmetic doesn't have to special-case which direction it moved.
  const reorderRow = (draggedKey: string, targetKey: string) => {
    if (draggedKey === targetKey) return;
    setRowOrder((prev) => {
      const next = [...prev];
      const from = next.indexOf(draggedKey);
      if (from === -1) return prev;
      const [moved] = next.splice(from, 1);
      const to = next.indexOf(targetKey);
      next.splice(to === -1 ? from : to, 0, moved);
      return next;
    });
  };

  const fixedByKey = new Map(COVER_FIELD_ORDER.map((f) => [f.key as string, f]));
  const customById = new Map(customFields.map((f) => [f.id, f]));

  return (
    <div>
      <div className="cover-table-wrap">
        <table className="preview-table cover-table" style={{ maxWidth: 680 }}>
          <tbody>
            {rowOrder.map((key) => {
              const fixed = fixedByKey.get(key);
              const custom = customById.get(key);
              // Only this handle carries `draggable` -- the <tr> itself is the drop TARGET (drag
              // events below), not the drag source, so grabbing text inside one of the row's own
              // inputs to select it doesn't get hijacked as a row-drag (same handle/row split as
              // the sidebar's own section-drag-handle).
              const dragHandle = (
                <td className="field-reorder-cell">
                  <span
                    className="field-drag-handle"
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = "move";
                      setDraggingKey(key);
                    }}
                    onDragEnd={() => {
                      setDraggingKey(null);
                      setDragOverKey(null);
                    }}
                    title="Drag to reorder"
                    aria-hidden="true"
                  >
                    ⠿
                  </span>
                </td>
              );
              // key is passed directly on each <tr> below, not through this spread -- React warns
              // (and won't reliably use it for reconciliation) when a spread object carries `key`.
              const rowProps = {
                className: `${draggingKey === key ? "dragging-row" : ""} ${
                  dragOverKey === key && draggingKey && draggingKey !== key ? "drag-over-row" : ""
                }`,
                onDragEnter: (e: React.DragEvent) => {
                  e.preventDefault();
                  if (draggingKey && draggingKey !== key) setDragOverKey(key);
                },
                onDragOver: (e: React.DragEvent) => e.preventDefault(),
                onDrop: (e: React.DragEvent) => {
                  e.preventDefault();
                  if (draggingKey) reorderRow(draggingKey, key);
                  setDraggingKey(null);
                  setDragOverKey(null);
                },
              };
              if (fixed) {
                return (
                  <tr key={key} {...rowProps}>
                    {dragHandle}
                    <th style={{ width: 170, textAlign: "left" }}>{fixed.label}</th>
                    <td>
                      <input
                        type="text"
                        style={{ width: "100%" }}
                        value={values[key]}
                        onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                      />
                    </td>
                  </tr>
                );
              }
              if (!custom) return null; // a stale key from a previous session (e.g. a since-removed custom field) -- skip rather than crash
              return (
                <tr key={key} {...rowProps}>
                  {dragHandle}
                  <th style={{ width: 170, textAlign: "left" }}>
                    <input
                      type="text"
                      placeholder="Field name"
                      style={{ width: "100%", fontWeight: 700, color: "#ffffff" }}
                      value={custom.label}
                      onChange={(e) => editCustomField(key, { label: e.target.value })}
                    />
                  </th>
                  <td style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <input type="text" style={{ width: "100%" }} value={custom.value} onChange={(e) => editCustomField(key, { value: e.target.value })} />
                    <button type="button" className="attachment-candidate-remove" title="Remove this field" onClick={() => removeCustomField(key)}>
                      ✕
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="toolbar">
        <button type="button" className="secondary" onClick={addCustomField}>
          + Add field
        </button>
        <button disabled={busy} onClick={save}>
          {busy ? "Saving..." : "Save"}
        </button>
      </div>
    </div>
  );
}

function SectionPanel({
  jobRoot,
  section,
  metadata,
  onRefresh,
  onReviewed,
  onToggleExcluded,
  patchSectionState,
}: {
  jobRoot: string;
  section: SectionWithState;
  metadata: JobScanResult["metadata"];
  onRefresh: () => void;
  onReviewed: (acknowledged: boolean) => void;
  onToggleExcluded: (excluded: boolean) => void;
  patchSectionState: (sectionId: string, patch: Partial<SectionState>) => void;
}) {
  const omitted = omittedReason(section);
  // The completed print-ready PDF scanJobFolder.ts found for this section (see PRINT_PDF_SECTIONS)
  // is normally embedded verbatim over this app's own re-rendered table -- almost always right,
  // but the tech rep always has a direct way to say "no, just use the table" instead. Excluding it
  // doesn't change what's found on disk, just whether generateReport.ts uses it (see
  // renderReportHtml.ts's own excludePrintPdf check) -- toggled back on the same way.
  const setExcludePrintPdf = async (excluded: boolean) => {
    await fetch("/api/section-state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobRoot, sectionId: section.id, patch: { excludePrintPdf: excluded } }),
    });
    onRefresh();
  };
  const printPdfExcluded = Boolean(section.printPdfFile) && Boolean(section.state.excludePrintPdf);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <h2 style={{ margin: 0 }}>{section.title}</h2>
        <button className={section.state.acknowledged ? "secondary" : ""} onClick={() => onReviewed(!section.state.acknowledged)}>
          {section.state.acknowledged ? "✓ Reviewed" : "Tech Rep Reviewed"}
        </button>
      </div>
      <div className="title-row" style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, marginTop: 8 }}>
        <StatusBadge status={section.status} acknowledged={section.state.acknowledged} omitted={omitted} />
        <span className="confidence-tag">automation confidence: {section.automationConfidence}</span>
      </div>
      {omitted === "removed" && (
        <p className="section-reason">
          This section is removed — it won&apos;t appear in the generated report.{" "}
          <button className="link-button" onClick={() => onToggleExcluded(false)}>
            Add it back
          </button>
        </p>
      )}
      {omitted === "empty" && (
        <p className="section-reason">There&apos;s no data for this section, so it will be left out of the generated report automatically.</p>
      )}
      {printPdfExcluded ? (
        <p className="section-reason">
          The completed form found for this section is excluded — this section&apos;s own table will be used in the generated report instead.{" "}
          <button className="link-button" onClick={() => setExcludePrintPdf(false)}>
            Use the completed form instead
          </button>
        </p>
      ) : (
        <p className="section-reason" style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
          {section.printPdfFile && (
            <button
              className="exclude-print-pdf-btn"
              title="Don't use the auto-detected completed form — use this section's own table instead"
              onClick={() => setExcludePrintPdf(true)}
            >
              ✕
            </button>
          )}
          <span>{section.statusReason}</span>
        </p>
      )}
      {/* Keyed on lastGeneratedAt too, not just section.id -- a Rescan while this section is
          already open re-runs autoDraftJob in the background and can fill in a draft that was
          previously empty (e.g. a source file that wasn't found before now is). Without this,
          the editor's local `draft` state was set once at mount and never picked up content
          that appeared behind it, so the box kept showing "no draft yet" until the reviewer
          clicked to a different section and back. */}
      {section.generation === "llm-narrative" && (
        <NarrativeEditor
          key={`${section.id}-${section.state.lastGeneratedAt ?? ""}`}
          jobRoot={jobRoot}
          section={section}
          onUpdated={onRefresh}
          turbineModel={metadata.turbineModel}
        />
      )}
      {section.generation === "table-from-source" && (
        <TablePreview key={section.id} jobRoot={jobRoot} section={section} onRefresh={onRefresh} patchSectionState={patchSectionState} />
      )}
      {section.generation === "llm-vision-select" && <PhotoSetEditor key={section.id} jobRoot={jobRoot} section={section} />}
      {section.generation === "attach-as-is" && <AttachAsIs key={section.id} jobRoot={jobRoot} section={section} onRefresh={onRefresh} />}
      {section.generation === "template" && (
        <CoverEditor key={section.id} jobRoot={jobRoot} section={section} metadata={metadata} patchSectionState={patchSectionState} />
      )}
    </div>
  );
}

export default function Home() {
  const [reportType, setReportType] = useState<ReportTypeId | null>(null);
  const [jobRoot, setJobRoot] = useState<string | null>(null);
  const [scan, setScan] = useState<ScanResponse | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  // Which sidebar row is being dragged / currently dragged over, purely for the drag-and-drop
  // visual feedback below (dimming the dragged row, highlighting the drop target) -- the actual
  // reorder itself only happens on drop, via reorderSections.
  const [draggingSectionId, setDraggingSectionId] = useState<string | null>(null);
  const [dragOverSectionId, setDragOverSectionId] = useState<string | null>(null);

  const runScan = async (root: string) => {
    setLoading(true);
    try {
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobRoot: root, reportType }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setScan(data);
      setSelectedId((prev) => prev ?? data.sections[0]?.id ?? null);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Scan failed");
    } finally {
      setLoading(false);
    }
  };

  const chooseFolder = async (path: string) => {
    setJobRoot(path);
    await runScan(path);
  };

  // Folds a just-saved patch into this section's state right here in `scan`, instead of only
  // writing it to disk -- every section editor unmounts and remounts fresh (re-deriving its local
  // state from section.state) whenever its tab is switched away from and back to, or another
  // section's edit triggers a re-render. Without this, a save that genuinely succeeded on disk
  // still looked like it vanished the moment you returned to that tab, because the remount was
  // reading `scan` from before the save ever happened -- a full onRefresh() rescan would also fix
  // it, but is far heavier than a plain metadata/table edit needs (it re-walks the whole job
  // folder and re-drafts every AI section).
  const patchSectionState = (sectionId: string, patch: Partial<SectionState>) => {
    setScan((prev) =>
      prev ? { ...prev, sections: prev.sections.map((s) => (s.id === sectionId ? { ...s, state: { ...s.state, ...patch } } : s)) } : prev
    );
  };

  // Reorders the sidebar, and -- since the generated report follows this same order too (see
  // JobState.sectionOrder's own comment) -- the report itself. Drags `draggedId` out of the list
  // and back in immediately before `targetId`, recomputing the target's index AFTER the removal
  // (its own index shifts by one whenever the dragged item started above it) rather than doing the
  // arithmetic by hand. Optimistic: applies to `scan.sections` immediately so the row visibly
  // moves before the save round-trips, same pattern as patchSectionState above.
  const reorderSections = (draggedId: string, targetId: string) => {
    if (!scan || !jobRoot || draggedId === targetId) return;
    const ids = scan.sections.map((s) => s.id);
    const from = ids.indexOf(draggedId);
    if (from === -1) return;
    const [moved] = ids.splice(from, 1);
    const to = ids.indexOf(targetId);
    ids.splice(to === -1 ? from : to, 0, moved);

    setScan((prev) => {
      if (!prev) return prev;
      const byId = new Map(prev.sections.map((s) => [s.id, s]));
      return { ...prev, sections: ids.map((id) => byId.get(id)!), sectionOrder: ids };
    });
    fetch("/api/section-order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobRoot, order: ids }),
    });
  };

  // Marking a section reviewed also jumps to the next one in the list — the whole point is to
  // let a tech rep move through the report top-to-bottom without hunting for the next tab
  // themselves. Only advances when marking AS reviewed, not when undoing it.
  // The ✕ on a sidebar tab: leave this section out of the generated report (or add it back).
  // Optimistic like patchSectionState; the section stays in the list, dimmed, so it's reversible.
  const setExcludeFromReport = async (sectionId: string, excluded: boolean) => {
    if (!jobRoot) return;
    patchSectionState(sectionId, { excludeFromReport: excluded });
    await fetch("/api/section-state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobRoot, sectionId, patch: { excludeFromReport: excluded } }),
    });
  };

  const markReviewed = async (sectionId: string, acknowledged: boolean) => {
    if (!jobRoot || !scan) return;
    patchSectionState(sectionId, { acknowledged });
    if (acknowledged) {
      const idx = scan.sections.findIndex((s) => s.id === sectionId);
      const next = scan.sections[idx + 1];
      if (next) setSelectedId(next.id);
    }
    await fetch("/api/section-state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobRoot, sectionId, patch: { acknowledged } }),
    });
  };

  const generateReport = async () => {
    if (!jobRoot) return;
    setGenerating(true);
    try {
      const res = await fetch("/api/generate-pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobRoot, reportType }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${scan?.metadata.jobNumber ?? "report"}-${reportType === "final" ? "Final" : "IA"}-Report.pdf`;
      // Appended to the DOM (some browsers won't fire the download from a detached anchor) and the
      // object URL is kept alive for a beat after the click instead of revoked immediately -- a
      // Final Report's PDF runs several MB (all those inline exhibits/photos), and revoking
      // synchronously raced the browser's own read of the blob on exactly that larger file, so it
      // reported a "saved" download that was actually truncated and wouldn't open. The I&A Report's
      // smaller PDF rarely hit the race, which is why this only showed up on Final Reports.
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (e) {
      alert(e instanceof Error ? e.message : "PDF generation failed");
    } finally {
      setGenerating(false);
    }
  };

  // Which report to build is chosen once, up front -- before a job folder is even picked -- so
  // every request from here on (scan, draft, generate) already knows which section list to use
  // instead of assuming I&A Report by default.
  if (!reportType) {
    return <ReportTypePicker onChosen={setReportType} />;
  }

  if (!jobRoot) {
    return <FolderPicker onJobFolderChosen={chooseFolder} onBack={() => setReportType(null)} />;
  }

  if (!scan) {
    return (
      <div className="folder-picker">
        <div className="app-logo">
          <AppLogoMark animated={loading} />
          <h1>Report Builder</h1>
        </div>
        <div className="app-logo-bar" />
        <p className="folder-picker-subtitle">{loading ? "Analyzing job files and building the initial draft…" : "Something went wrong loading this job."}</p>
        <div className="folder-picker-card">
          <p className="job-path">{jobRoot}</p>
          {loading && <p className="section-reason">This reads every matched file and drafts each AI-assisted section — usually a minute or two.</p>}
          <div className="toolbar">
            <button className="secondary" onClick={() => setJobRoot(null)}>
              ← Change folder
            </button>
          </div>
        </div>
      </div>
    );
  }

  const selectedSection = scan.sections.find((s) => s.id === selectedId) ?? scan.sections[0];
  // A section that isn't going into the report (removed, or an empty table section) can't need
  // attention.
  const allAddressed = scan.sections.every((s) => s.status === "ready" || s.state.acknowledged || omittedReason(s));

  return (
    <div className="app-shell">
      <header className="app-header">
        <button
          className="secondary"
          title="Start over with a different report type"
          onClick={() => {
            setReportType(null);
            setJobRoot(null);
          }}
        >
          {REPORT_TYPE_OPTIONS.find((o) => o.id === reportType)?.label ?? "Report type"}
        </button>
        <button className="secondary" onClick={() => setJobRoot(null)}>
          ← Change folder
        </button>
        <span className="job-path">{jobRoot}</span>
        <span className="file-count">
          Job #{scan.metadata.jobNumber} · {scan.metadata.customer} · {scan.metadata.part} · Qty {scan.metadata.quantity}
        </span>
        <button disabled={loading} className="secondary" onClick={() => runScan(jobRoot)}>
          {loading ? "Scanning..." : "Rescan"}
        </button>
      </header>
      <div className="app-body">
        <nav className="sidebar">
          <div className="sidebar-scroll">
            {scan.sections.map((s) => (
              // Reorder -- groups related tabs together for review (e.g. every heat-treat chart
              // back to back on a job that needs that), and moves them the same way in the
              // generated report's own page order (see JobState.sectionOrder). The drag handle
              // span (not this whole row) is what actually carries `draggable` -- it's the
              // drag SOURCE, while this row is the drop TARGET, standard HTML5 dnd split so
              // grabbing the handle doesn't fight with clicking the select button right next to it.
              <div
                key={s.id}
                className={`section-item ${s.id === selectedSection.id ? "active" : ""} ${omittedReason(s) ? "omitted" : ""} ${
                  draggingSectionId === s.id ? "dragging" : ""
                } ${dragOverSectionId === s.id && draggingSectionId && draggingSectionId !== s.id ? "drag-over" : ""}`}
                onDragEnter={(e) => {
                  e.preventDefault();
                  if (draggingSectionId && draggingSectionId !== s.id) setDragOverSectionId(s.id);
                }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (draggingSectionId) reorderSections(draggingSectionId, s.id);
                  setDraggingSectionId(null);
                  setDragOverSectionId(null);
                }}
              >
                <span
                  className="section-drag-handle"
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = "move";
                    setDraggingSectionId(s.id);
                  }}
                  onDragEnd={() => {
                    setDraggingSectionId(null);
                    setDragOverSectionId(null);
                  }}
                  title={`Drag to reorder "${s.title}"`}
                  aria-hidden="true"
                >
                  ⠿
                </span>
                <button type="button" className="section-item-select" onClick={() => setSelectedId(s.id)}>
                  <div className="title-row">
                    <span>{s.title}</span>
                    <StatusBadge status={s.status} acknowledged={s.state.acknowledged} omitted={omittedReason(s)} />
                  </div>
                  <div className="confidence-tag">{s.automationConfidence} confidence</div>
                </button>
                {s.id !== "cover" && (
                  <button
                    type="button"
                    className="section-remove-btn"
                    title={s.state.excludeFromReport ? `Add "${s.title}" back to the report` : `Leave "${s.title}" out of the report`}
                    onClick={() => setExcludeFromReport(s.id, !s.state.excludeFromReport)}
                  >
                    {s.state.excludeFromReport ? "↺" : "✕"}
                  </button>
                )}
              </div>
            ))}
            <div className="sidebar-logo-spacer" aria-hidden="true">
              <img src="/apg-logo-transparent.png" alt="" className="sidebar-logo-img" />
            </div>
          </div>
        </nav>
        <main className="main-panel">
          <SectionPanel
            jobRoot={jobRoot}
            section={selectedSection}
            metadata={scan.metadata}
            onRefresh={() => runScan(jobRoot)}
            onReviewed={(acknowledged) => markReviewed(selectedSection.id, acknowledged)}
            onToggleExcluded={(excluded) => setExcludeFromReport(selectedSection.id, excluded)}
            patchSectionState={patchSectionState}
          />
        </main>
      </div>
      <footer className="app-header" style={{ justifyContent: "flex-end" }}>
        {!allAddressed && <span className="confidence-note">Some sections still need attention.</span>}
        <button className="generate-report" disabled={generating} onClick={generateReport}>
          {generating ? "Generating..." : "Generate Report"}
        </button>
      </footer>
      {/* Same fill-loop mark as the initial job-scan screen, in an overlay rather than a full
          page swap -- assembling the final PDF (rendering every section, copying in real exhibit
          pages) takes a few seconds to over a minute depending on the job, and the tech rep
          shouldn't lose their place in the review screen underneath while it runs. */}
      {generating && (
        <div className="generating-overlay">
          <div className="generating-overlay-card">
            <AppLogoMark animated />
            <p className="generating-overlay-text">Generating report…</p>
            <p className="generating-overlay-hint">Assembling every section and exhibit into the final PDF.</p>
          </div>
        </div>
      )}
    </div>
  );
}
