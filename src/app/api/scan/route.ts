import { NextRequest, NextResponse } from "next/server";
import { scanJobFolder } from "@/lib/ingest/scanJobFolder";
import { resolveReportTemplate } from "@/lib/report-templates";
import { loadJobState, saveJobState, applySectionOrder, ensureReportStartDate } from "@/lib/state/jobState";
import { autoDraftJob } from "@/lib/draft/autoDraft";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const jobRoot: string | undefined = body.jobRoot;
  if (!jobRoot) return NextResponse.json({ error: "jobRoot is required" }, { status: 400 });

  try {
    const scanResult = await scanJobFolder(jobRoot, resolveReportTemplate(body.reportType));
    // Best-effort: builds the initial draft for every AI-assisted section right here, so the
    // tech rep lands on a completed draft to review rather than a page of "Generate" buttons.
    // Never throws — per-section failures are recorded as `draftError` on that section alone.
    await autoDraftJob(scanResult);
    const state = await loadJobState(jobRoot);
    // First time this job's ever been scanned: lock in today as the cover's "Date" -- the day
    // the tech rep actually started the report, not a date pulled from some source file (or left
    // blank). A no-op on every later scan once that's set.
    if (ensureReportStartDate(state)) await saveJobState(state);

    const sections = scanResult.sections.map((section) => {
      const sectionState = state.sections[section.id] ?? {};

      let matchedFiles = section.matchedFiles;
      let status = section.status;
      let statusReason = section.statusReason;
      // A tech rep can reject one of the auto-matched candidates for an attach-as-is exhibit
      // outright (see AttachAsIs's own "x" on each candidate) -- persisted by relativePath rather
      // than deleting the file itself, since the file is often still legitimately in the job
      // folder, just not the right one for this section. Filtered back out here on every scan so
      // a rejected candidate doesn't keep reappearing after a rescan, and status/statusReason are
      // recomputed the same way scanJobFolder itself would for whatever's left.
      if (section.generation === "attach-as-is" && sectionState.excludedMatchedPaths?.length) {
        const excluded = new Set(sectionState.excludedMatchedPaths);
        const filtered = matchedFiles.filter((f) => !excluded.has(f.relativePath));
        if (filtered.length !== matchedFiles.length) {
          matchedFiles = filtered;
          if (filtered.length === 0) {
            status = "missing";
            statusReason = "No matching source file found in the job folder.";
          } else if (filtered.length === 1) {
            status = "ready";
            statusReason = `Matched "${filtered[0].relativePath}".`;
          } else {
            status = "needs-attention";
            statusReason = `${filtered.length} candidate files matched; using "${filtered[0].relativePath}" by default — pick the right one below.`;
          }
        }
      }

      // Every narrative section (I&A Summary, FPI/Visual, ...) still drafts a best-effort partial
      // from whatever job metadata is on hand even when its usual source data wasn't found (see
      // autoDraftJob's own comments) -- so "missing" here would be actively misleading once that
      // draft has real text in it: the tech rep would see a fully-written section right there in
      // the panel while the sidebar insists there's nothing to look at. Reporting "missing" is
      // only honest when the panel is genuinely empty too; once a draft exists, "needs attention"
      // is the true state -- something was written, but from thinner source data than usual, so it
      // needs a closer read than a normal "ready" section would.
      const hasDraftedContent = section.generation === "llm-narrative" && Boolean(sectionState.content?.trim());
      const effectiveStatus = status === "missing" && hasDraftedContent ? "needs-attention" : status;
      const effectiveStatusReason =
        effectiveStatus !== status
          ? `${statusReason} A draft was still generated from the available job metadata — review it carefully, since the usual source data wasn't found.`
          : statusReason;
      return { ...section, matchedFiles, status: effectiveStatus, statusReason: effectiveStatusReason, state: sectionState };
    });

    // Reorders both the sidebar and, via renderReportHtml.ts's renderReportSegments (which applies
    // this same sectionOrder to its own scan of the job folder), the generated report's own page
    // order -- see JobState.sectionOrder's own comment.
    const orderedSections = applySectionOrder(sections, state.sectionOrder);

    return NextResponse.json({ ...scanResult, sections: orderedSections, sectionOrder: state.sectionOrder });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Scan failed" }, { status: 500 });
  }
}
