import { NextRequest, NextResponse } from "next/server";
import { scanJobFolder } from "@/lib/ingest/scanJobFolder";
import { resolveReportTemplate } from "@/lib/report-templates";
import { updateSectionState, loadJobState } from "@/lib/state/jobState";
import { draftFpiVisual, draftRecommendedRepairs, draftDimensionalSummary, draftIaSummary } from "@/lib/draft/narrative";
import { selectBestPhotos } from "@/lib/draft/photoSelect";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { jobRoot, sectionId, instruction, reportType } = body as { jobRoot: string; sectionId: string; instruction?: string; reportType?: string };
  if (!jobRoot || !sectionId) return NextResponse.json({ error: "jobRoot and sectionId are required" }, { status: 400 });

  try {
    const scanResult = await scanJobFolder(jobRoot, resolveReportTemplate(reportType));
    const bySectionId = new Map(scanResult.sections.map((s) => [s.id, s]));
    const section = bySectionId.get(sectionId);
    if (!section) return NextResponse.json({ error: `Unknown section ${sectionId}` }, { status: 404 });

    const jobState = await loadJobState(jobRoot);
    const previousDraft = jobState.sections[sectionId]?.content;
    const ctx = { metadata: scanResult.metadata, instruction, previousDraft };

    let content: string | undefined;
    let selectedPhotoPaths: string[] | undefined;

    switch (sectionId) {
      case "fpiVisual": {
        // Unlike recommendedRepairs below, this section still has something honest to say from
        // job metadata + crack-map presence alone when there's no router file -- see
        // buildFpiVisualDraft/draftFpiVisual -- so a missing router no longer blocks drafting or
        // revising this section outright.
        const crackMapAvailable = bySectionId.get("crackMap")?.status !== "missing";
        content = await draftFpiVisual(section.parsedRouter, ctx, crackMapAvailable);
        break;
      }
      case "recommendedRepairs": {
        if (!section.parsedRouter) return NextResponse.json({ error: "No router data available" }, { status: 400 });
        content = await draftRecommendedRepairs(section.parsedRouter, ctx);
        break;
      }
      case "dimensionalSummary": {
        // See autoDraft.ts's dimInput -- a section can be "ready" off its print-ready PDF alone
        // with no readable spreadsheet, and the draft needs to know that to avoid calling it
        // missing.
        const dimInput = (id: string) => {
          const s = bySectionId.get(id);
          return s ? { table: s.parsedTable, hasPdf: Boolean(s.printPdfFile) } : undefined;
        };
        content = await draftDimensionalSummary(
          {
            heightDimForm: dimInput("heightDimForm"),
            dovetailDimension: dimInput("dovetailDimension"),
            zDropDimension: dimInput("zDropDimension"),
            wallThickness: dimInput("wallThickness"),
          },
          ctx
        );
        break;
      }
      case "iaSummary": {
        const depIds = section.dependsOnSections ?? [];
        const depDrafts: Record<string, string> = {};
        for (const depId of depIds) {
          const depContent = jobState.sections[depId]?.content;
          if (depContent) depDrafts[depId] = depContent;
        }
        content = await draftIaSummary(depDrafts, ctx);
        break;
      }
      case "photoSet":
      case "finalPhotoSet": {
        const result = await selectBestPhotos(section.matchedFiles, sectionId === "finalPhotoSet" ? "final" : "incoming");
        content = result.raw;
        selectedPhotoPaths = result.includedPaths;
        break;
      }
      default:
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
