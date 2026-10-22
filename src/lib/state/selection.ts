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
