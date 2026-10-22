import { NextRequest, NextResponse } from "next/server";
import { scanJobFolder } from "@/lib/ingest/scanJobFolder";
import { resolveReportTemplate } from "@/lib/report-templates";
import { updateSectionState, loadJobState } from "@/lib/state/jobState";
import { buildEngineeringSummaryDraft, buildRepairRecommendationsDraft, buildRepairSummaryDraft, reviseSection } from "@/lib/draft/narrative";
import { engineeringSummaryInputs } from "@/lib/draft/autoDraft";
import { selectBestPhotos } from "@/lib/draft/photoSelect";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { jobRoot, sectionId, instruction, reportType } = body as { jobRoot: string; sectionId: string; instruction?: string; reportType?: string };
  if (!jobRoot || !sectionId) return NextResponse.json({ error: "jobRoot and sectionId are required" }, { status: 400 });

  try {
    const scanResult = await scanJobFolder(jobRoot, resolveReportTemplate(reportType));
    const section = scanResult.sections.find((s) => s.id === sectionId);
    if (!section) return NextResponse.json({ error: `Unknown section ${sectionId}` }, { status: 404 });

    const jobState = await loadJobState(jobRoot);
    let content: string | undefined;
    let selectedPhotoPaths: string[] | undefined;

    if (section.generation === "llm-vision-select") {
      const result = await selectBestPhotos(section.matchedFiles, sectionId === "finalPhotoSet" ? "final" : "incoming");
      content = result.raw;
      selectedPhotoPaths = result.includedPaths;
    } else if (section.generation === "llm-narrative") {
      // The deterministic draft, rebuilt fresh -- what an empty section starts from, and what a
      // request with no instruction ("regenerate") returns as-is.
      let fresh = "";
      if (sectionId === "engineeringSummary") fresh = buildEngineeringSummaryDraft(engineeringSummaryInputs(scanResult));
      else if (section.parsedRouter && sectionId === "repairRecommendations") fresh = buildRepairRecommendationsDraft(section.parsedRouter);
      else if (section.parsedRouter && sectionId === "repairSummary") fresh = buildRepairSummaryDraft(section.parsedRouter);

      if (instruction) {
        const currentDraft = jobState.sections[sectionId]?.content || fresh;
        content = await reviseSection({ title: section.title, currentDraft, instruction, ctx: { metadata: scanResult.metadata } });
      } else {
        if (!fresh) return NextResponse.json({ error: "No source data to draft this section from" }, { status: 400 });
        content = fresh;
      }
    } else {
      return NextResponse.json({ error: `Section ${sectionId} does not support drafting` }, { status: 400 });
    }

    const newState = await updateSectionState(jobRoot, sectionId, {
      content,
      selectedPhotoPaths,
      draftError: undefined,
      lastGeneratedAt: new Date().toISOString(),
    });
    return NextResponse.json({ content, selectedPhotoPaths, state: newState.sections[sectionId] });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Draft generation failed" }, { status: 500 });
  }
}
