import { NextRequest, NextResponse } from "next/server";
import { scanJobFolder } from "@/lib/ingest/scanJobFolder";
import { templateForJob } from "@/lib/report-templates/forJob";
import { loadJobState } from "@/lib/state/jobState";
import { buildDeck, deckFileName } from "@/lib/pptx/buildDeck";

/** The report as an editable PowerPoint deck in Alfredo's format (see buildDeck.ts). */
export async function POST(request: NextRequest) {
  const { jobRoot, reportType } = (await request.json()) as { jobRoot?: string; reportType?: string };
  if (!jobRoot) return NextResponse.json({ error: "jobRoot is required" }, { status: 400 });
  try {
    const scan = await scanJobFolder(jobRoot, await templateForJob(jobRoot, reportType));
    const state = await loadJobState(jobRoot);
    const buffer = await buildDeck(scan, state);
    const name = deckFileName(scan);
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(name)}"`,
        "X-File-Name": encodeURIComponent(name),
      },
    });
  } catch (err) {
    console.error("deck failed:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "PowerPoint export failed" }, { status: 500 });
  }
}
