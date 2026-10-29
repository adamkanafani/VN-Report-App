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
  const paths = sectionState?.selectedAttachmentPaths ?? section.defaultSelectedPaths ?? [];
  return paths.map((p) => byPath.get(p)).filter((f): f is JobFile => Boolean(f));
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

/** A photo section's picked photos, in the tech rep's order, for one report. The I&A and the Final
 * Report keep separate picks (the Final usually carries far fewer incoming photos); a report with no
 * pick of its own yet starts from the shared one (the automatic pre-selection). */
export function photoSelection(sectionState: Pick<SectionState, "selectedPhotoPaths" | "selectedPhotoPathsByReport"> | undefined, reportType: string): string[] | undefined {
  return sectionState?.selectedPhotoPathsByReport?.[reportKey(reportType)] ?? sectionState?.selectedPhotoPaths;
}
