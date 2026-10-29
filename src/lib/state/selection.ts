import type { JobFile } from "../ingest/fileWalk";
import type { SectionState } from "./jobState";

/** An attach-multi section's exhibits in print order: the tech rep's own ticked list once they've
 * changed anything, otherwise the scan's default selection -- either way limited to files still in
 * the candidate list (a ticked file since deleted or rejected is simply skipped). Shared by the PDF
 * renderer and the review screen's "won't be in the report" check, so both agree. Kept free of any
 * server-only imports since the review screen (a client component) uses it too. */
export function effectiveMultiSelection(
  section: { matchedFiles: JobFile[]; defaultSelectedPaths?: string[] },
  sectionState: Pick<SectionState, "selectedAttachmentPaths"> | undefined
): JobFile[] {
  const byPath = new Map(section.matchedFiles.map((f) => [f.relativePath, f]));
  // A ticked sheet whose Fleet Service twin is what this version lists instead ("... INCOMING.pdf"
  // ↔ "... INCOMING FS.pdf") stands for that twin, so one ticked list serves both versions.
  const byTwin = new Map(section.matchedFiles.map((f) => [twinKey(f.relativePath), f]));
  const paths = sectionState?.selectedAttachmentPaths ?? section.defaultSelectedPaths ?? [];
  const out: JobFile[] = [];
  for (const p of paths) {
    const f = byPath.get(p) ?? byTwin.get(twinKey(p));
    if (f && !out.includes(f)) out.push(f);
  }
  return out;
}

/** A path with any trailing " FS" dropped from its file name, so a sheet and its FS copy match. */
function twinKey(relativePath: string): string {
  return relativePath.toLowerCase().replace(/[\s_-]+fs(\.[a-z0-9]+)$/, "$1").replace(/\s+/g, " ");
}

/** Whether a section is left out of the generated report: the tech rep's own choice (the ✕ on its
 * sidebar tab) when they've made one, otherwise the template's default (SectionConfig.
 * defaultExcluded -- e.g. the Repair Report's repeated incoming blocks). */
export function isExcluded(section: { defaultExcluded?: boolean }, sectionState: Pick<SectionState, "excludeFromReport"> | undefined): boolean {
  return sectionState?.excludeFromReport ?? Boolean(section.defaultExcluded);
}

/** "ia" / "final" from either the review screen's report id or a template's report name
 * ("Incoming Report" / "Repair Report"). */
export function reportKey(reportType: string): "ia" | "final" {
  return /repair|final/i.test(reportType) ? "final" : "ia";
}
