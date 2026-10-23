import path from "path";
import type { JobScanResult } from "../ingest/scanJobFolder";
import { loadJobState, updateSectionStates, type JobState, type SectionState } from "../state/jobState";
import {
  adaptPriorSummary,
  buildEngineeringSummaryDraft,
  buildRepairRecommendationsDraft,
  buildRepairSummaryDraft,
  recommendationsToSummary,
} from "./narrative";
import { findPriorReport, readPriorDraft, type PriorDraft } from "./priorReport";
import { selectBestPhotos } from "./photoSelect";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Automatic draft generation failed.";
}

// The prior-report lookup reads a 30–80 MB deck off the network drive -- done at most once per job
// per server session, and only when a section actually needs a fresh draft.
const priorCache = new Map<string, Promise<PriorDraft | null>>();

export function priorDraftFor(scan: JobScanResult): Promise<PriorDraft | null> {
  let p = priorCache.get(scan.jobRoot);
  if (!p) {
    p = findPriorReport(scan.jobRoot, scan.metadata, "ia")
      .then((prior) => (prior ? readPriorDraft(prior) : null))
      .catch(() => null);
    priorCache.set(scan.jobRoot, p);
  }
  return p;
}

const seededLabel = (prior: PriorDraft) => `Job ${prior.source.jobNumber} (${path.basename(prior.source.file)})`;

/** The inputs the router-based Engineering Summary skeleton needs, pulled from a scan. */
export function engineeringSummaryInputs(scan: JobScanResult) {
  const byId = new Map(scan.sections.map((s) => [s.id, s]));
  const summary = byId.get("engineeringSummary");
  const ndt = byId.get("incomingNdt");
  return {
    metadata: scan.metadata,
    router: summary?.parsedRouter,
    measurements: scan.measurements,
    dimFileNames: (byId.get("incomingDimensional")?.matchedFiles ?? []).map((f) => f.baseName.replace(/\.pdf$/i, "")),
    crackMapAvailable: (ndt?.matchedFiles ?? []).some((f) => /crack/i.test(f.baseName)),
    metSampleAvailable: byId.get("metallurgicalReport")?.status === "ready" || byId.get("metallurgicalReport")?.status === "needs-attention",
  };
}

type Draft = { content: string; seededFrom?: string };

/** Engineering Summary: the last same-product report's wording with this job's values swapped in,
 * else the router-based skeleton. */
export function engineeringSummaryDraft(scan: JobScanResult, prior: PriorDraft | null, source: "auto" | "router" = "auto"): Draft {
  if (source === "auto" && prior?.engineeringSummary) {
    return { content: adaptPriorSummary(prior.engineeringSummary, scan.measurements), seededFrom: seededLabel(prior) };
  }
  return { content: buildEngineeringSummaryDraft(engineeringSummaryInputs(scan)) };
}

/** Repair Recommendations: the last same-product report's list (his own customer-facing wording),
 * else the repair router's op labels. */
export function repairRecommendationsDraft(scan: JobScanResult, prior: PriorDraft | null, source: "auto" | "router" = "auto"): Draft | null {
  if (source === "auto" && prior?.repairRecommendations) return { content: prior.repairRecommendations, seededFrom: seededLabel(prior) };
  const router = scan.sections.find((s) => s.id === "repairRecommendations" || s.id === "repairSummary")?.parsedRouter;
  return router ? { content: buildRepairRecommendationsDraft(router) } : null;
}

/** Repair Summary: this job's own Repair Recommendations in the past tense (exactly how Alfredo
 * writes it), else the last same-product report's recommendations, else the repair router. */
export function repairSummaryDraft(scan: JobScanResult, state: JobState, prior: PriorDraft | null, source: "auto" | "router" = "auto"): Draft | null {
  const ownRecs = state.sections["repairRecommendations"]?.content?.trim();
  if (source === "auto" && ownRecs) return { content: recommendationsToSummary(ownRecs), seededFrom: "this job's Repair Recommendations" };
  if (source === "auto" && prior?.repairRecommendations) return { content: recommendationsToSummary(prior.repairRecommendations), seededFrom: seededLabel(prior) };
  const router = scan.sections.find((s) => s.id === "repairSummary")?.parsedRouter;
  return router ? { content: buildRepairSummaryDraft(router) } : null;
}

/**
 * Runs once per job-folder scan to build the best-supported initial draft for every narrative and
 * photo section, so the tech rep opens to a draft to review rather than a row of empty boxes.
 * Narrative drafts start from the most recent finished report of the same product (see
 * priorReport.ts), with this job's measured values swapped in; without one, they fall back to the
 * router-based drafts. Only the photo set optionally calls a vision model. Never overwrites a
 * section a human has already touched (has content, a photo selection, or was acknowledged), so
 * re-running this on a rescan is safe. Patches are applied in one batched write.
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
  const asPatch = (id: string, draft: Draft | null, missingReason: string): PatchEntry =>
    draft ? [id, { content: draft.content, seededFrom: draft.seededFrom, draftError: undefined, lastGeneratedAt: stamp() }] : missingDataStep(id, missingReason);

  const narrativeIds = ["engineeringSummary", "repairRecommendations", "repairSummary"].filter((id) => bySectionId.has(id) && isUntouched(id));
  const prior = narrativeIds.length > 0 ? await priorDraftFor(scan) : null;

  // Recommendations first: on a job drafted straight from the Repair Report, the Repair Summary
  // is built from the same recommendations text.
  const recsState = { ...existingState, sections: { ...existingState.sections } };
  if (narrativeIds.includes("engineeringSummary")) jobs.push(asPatch("engineeringSummary", engineeringSummaryDraft(scan, prior), ""));
  if (narrativeIds.includes("repairRecommendations")) {
    const draft = repairRecommendationsDraft(scan, prior);
    jobs.push(asPatch("repairRecommendations", draft, "No earlier report for this product and no repair router were found — draft this section manually."));
    if (draft) recsState.sections.repairRecommendations = { ...recsState.sections.repairRecommendations, content: draft.content };
  }
  if (narrativeIds.includes("repairSummary")) {
    jobs.push(asPatch("repairSummary", repairSummaryDraft(scan, recsState, prior), "No repair recommendations, earlier report or repair router were found — draft this section manually."));
  }

  // Cover: the last report's full Tech Rep name ("Alfredo Resendiz T." where the router just says
  // "Alfredo T") and material, when this job hasn't set them -- same person, same product.
  if (prior && !existingState.sections.cover?.acknowledged) {
    const fields = { ...existingState.sections.cover?.fields };
    const priorRep = prior.coverFields["Tech Rep"];
    const firstWord = (s: string) => s.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    let changed = false;
    if (!fields.techRep && priorRep && (!scan.metadata.techRep || firstWord(priorRep) === firstWord(scan.metadata.techRep))) {
      fields.techRep = priorRep;
      changed = true;
    }
    if (!fields.material && !scan.metadata.material && prior.coverFields["Material"]) {
      fields.material = prior.coverFields["Material"];
      changed = true;
    }
    if (changed) jobs.push(["cover", { fields }]);
  }

  // Whichever photo-set sections this template has -- "photoSet" (incoming-stage photos) and/or
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
