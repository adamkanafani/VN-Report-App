import type { JobScanResult } from "../ingest/scanJobFolder";
import { loadJobState, updateSectionStates, type SectionState } from "../state/jobState";
import { buildEngineeringSummaryDraft, buildRepairRecommendationsDraft, buildRepairSummaryDraft } from "./narrative";
import { selectBestPhotos } from "./photoSelect";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Automatic draft generation failed.";
}

/** The inputs buildEngineeringSummaryDraft needs, pulled from a scan -- shared with /api/draft so
 * a revise-with-instruction on an empty section starts from the same skeleton. */
export function engineeringSummaryInputs(scan: JobScanResult) {
  const byId = new Map(scan.sections.map((s) => [s.id, s]));
  const summary = byId.get("engineeringSummary");
  const ndt = byId.get("incomingNdt");
  return {
    metadata: scan.metadata,
    router: summary?.parsedRouter,
    dimFileNames: (byId.get("incomingDimensional")?.matchedFiles ?? []).map((f) => f.baseName.replace(/\.pdf$/i, "")),
    crackMapAvailable: (ndt?.matchedFiles ?? []).some((f) => /crack/i.test(f.baseName)),
    metSampleAvailable: byId.get("metallurgicalReport")?.status === "ready" || byId.get("metallurgicalReport")?.status === "needs-attention",
  };
}

/**
 * Runs once per job-folder scan to build the best-supported initial draft for every narrative and
 * photo section, so the tech rep opens to a draft to review rather than a row of empty boxes. All
 * narrative drafts are deterministic (job metadata + router data, no API call); only the photo set
 * optionally calls a vision model, and degrades to "include everything" without one. Never
 * overwrites a section a human has already touched (has content, a photo selection, or was
 * acknowledged), so re-running this on a rescan is safe. Patches are applied in one batched write
 * (concurrent single-section writes against the same state file would race).
 */
export async function autoDraftJob(scan: JobScanResult): Promise<void> {
  const jobRoot = scan.jobRoot;
  const bySectionId = new Map(scan.sections.map((s) => [s.id, s]));
  const existingState = await loadJobState(jobRoot);

  const isUntouched = (id: string): boolean => {
    const s = existingState.sections[id];
    return !s?.content && !(s?.selectedPhotoPaths && s.selectedPhotoPaths.length > 0) && !s?.acknowledged;
  };
  const stamp = () => new Date().toISOString();

  type PatchEntry = [string, Partial<SectionState>] | null;
  const jobs: Array<Promise<PatchEntry> | PatchEntry> = [];
  const missingDataStep = (id: string, reason: string): PatchEntry => (isUntouched(id) ? [id, { draftError: reason }] : null);

  // Drafts even without an I&A router -- the opening paragraph and subsection scaffold still come
  // from job metadata; only the router-derived inspection list / DS form bullets are thinner.
  if (bySectionId.has("engineeringSummary") && isUntouched("engineeringSummary")) {
    jobs.push(["engineeringSummary", { content: buildEngineeringSummaryDraft(engineeringSummaryInputs(scan)), draftError: undefined, lastGeneratedAt: stamp() }]);
  }

  for (const [id, build] of [
    ["repairRecommendations", buildRepairRecommendationsDraft],
    ["repairSummary", buildRepairSummaryDraft],
  ] as const) {
    const section = bySectionId.get(id);
    if (!section) continue;
    if (section.parsedRouter) {
      if (isUntouched(id)) jobs.push([id, { content: build(section.parsedRouter), draftError: undefined, lastGeneratedAt: stamp() }]);
    } else {
      jobs.push(missingDataStep(id, "No repair router was found for this job — draft this section manually."));
    }
  }

  // Whichever photo-set section this template has -- "photoSet" (incoming-stage photos) or
  // "finalPhotoSet" (final-stage) -- see selectBestPhotos' preferredStage param.
  for (const [id, preferredStage] of [
    ["photoSet", "incoming"],
    ["finalPhotoSet", "final"],
  ] as const) {
    const photoSection = bySectionId.get(id);
    if (!photoSection) continue;
    if (photoSection.matchedFiles.length > 0) {
      if (isUntouched(id)) {
        jobs.push(
          selectBestPhotos(photoSection.matchedFiles, preferredStage)
            .then((result): PatchEntry => [id, { selectedPhotoPaths: result.includedPaths, content: result.raw, draftError: undefined, lastGeneratedAt: stamp() }])
            .catch((err): PatchEntry => [id, { draftError: errorMessage(err) }])
        );
      }
    } else {
      jobs.push(missingDataStep(id, "No photo folder was found for this job."));
    }
  }

  const results = await Promise.all(jobs);
  const patches = Object.fromEntries(results.filter((e): e is [string, Partial<SectionState>] => e !== null));
  if (Object.keys(patches).length > 0) await updateSectionStates(jobRoot, patches);
}
