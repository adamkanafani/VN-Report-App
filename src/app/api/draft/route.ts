import { NextRequest, NextResponse } from "next/server";
import { scanJobFolder } from "@/lib/ingest/scanJobFolder";
import { templateForJob } from "@/lib/report-templates/forJob";
import { updateSectionState, loadJobState } from "@/lib/state/jobState";
import { reviseSection } from "@/lib/draft/narrative";
import { REPAIR_LIST_SECTIONS } from "@/lib/pdf/renderReportHtml";
import { compactDraft, engineeringSummaryDraft, ownIaDraftFor, priorDraftFor, repairRecommendationsDraft, repairSummaryDraft } from "@/lib/draft/autoDraft";
import { reportKey } from "@/lib/state/selection";
import { selectBestPhotos } from "@/lib/draft/photoSelect";

/** Redraft one section. With an `instruction`, Claude revises the current text; without one the
 * section is rebuilt from scratch -- `source: "auto"` (default) starts from the last report of the
 * same product the way the initial scan does, `source: "router"` uses only this job's routers. */
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { jobRoot, sectionId, instruction, reportType, source } = body as {
    jobRoot: string;
    sectionId: string;
    instruction?: string;
    reportType?: string;
    source?: "auto" | "router";
  };
  if (!jobRoot || !sectionId) return NextResponse.json({ error: "jobRoot and sectionId are required" }, { status: 400 });

  try {
    const scanResult = await scanJobFolder(jobRoot, await templateForJob(jobRoot, reportType));
    const section = scanResult.sections.find((s) => s.id === sectionId);
    if (!section) return NextResponse.json({ error: `Unknown section ${sectionId}` }, { status: 404 });

    const jobState = await loadJobState(jobRoot);
    // On the Fleet Service version the repair lists have their own shorter text (compactContent).
    const fsText = scanResult.variant === "fs" && REPAIR_LIST_SECTIONS.has(sectionId);
    let content: string | undefined;
    let selectedPhotoPaths: string[] | undefined;
    let seededFrom: string | undefined;

    if (section.generation === "llm-vision-select") {
      const result = await selectBestPhotos(section.matchedFiles, sectionId === "finalPhotoSet" ? "final" : "incoming");
      content = result.raw;
      selectedPhotoPaths = result.includedPaths;
    } else if (section.generation === "llm-narrative") {
      if (instruction) {
        const current = (fsText && jobState.sections[sectionId]?.compactContent) || jobState.sections[sectionId]?.content || "";
        content = await reviseSection({ title: section.title, currentDraft: current, instruction, ctx: { metadata: scanResult.metadata } });
        seededFrom = jobState.sections[sectionId]?.seededFrom;
      } else {
        const mode = source ?? "auto";
        const prior = mode === "auto" ? await priorDraftFor(scanResult) : null;
        // "Start over" on a Repair Report goes back to this job's own I&A deck first, like the scan.
        const own = mode === "auto" ? await ownIaDraftFor(scanResult, scanResult.reportType) : null;
        const draft =
          (fsText && mode === "auto" ? compactDraft(sectionId, jobState, prior, own) : null) ??
          (sectionId === "engineeringSummary"
            ? engineeringSummaryDraft(scanResult, prior, mode, own)
            : sectionId === "repairRecommendations"
              ? repairRecommendationsDraft(scanResult, prior, mode, own)
              : sectionId === "repairSummary"
                ? repairSummaryDraft(scanResult, jobState, prior, mode, own)
                : null);
        if (!draft) return NextResponse.json({ error: "No source data to draft this section from" }, { status: 400 });
        content = draft.content;
        seededFrom = draft.seededFrom;
      }
    } else {
      return NextResponse.json({ error: `Section ${sectionId} does not support drafting` }, { status: 400 });
    }

    const newState = await updateSectionState(jobRoot, sectionId, {
      ...(fsText ? { compactContent: content } : { content }),
      selectedPhotoPaths,
      // A fresh photo pick replaces this report's own pick too (see photoPick in photoGroups.ts).
      ...(selectedPhotoPaths && {
        selectedPhotoPathsByReport: { ...jobState.sections[sectionId]?.selectedPhotoPathsByReport, [reportKey(reportType ?? "ia")]: selectedPhotoPaths },
      }),
      seededFrom,
      draftError: undefined,
      lastGeneratedAt: new Date().toISOString(),
    });
    return NextResponse.json({ content, selectedPhotoPaths, state: newState.sections[sectionId] });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Draft generation failed" }, { status: 500 });
  }
}
