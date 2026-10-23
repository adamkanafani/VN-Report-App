import { NextRequest, NextResponse } from "next/server";
import { scanJobFolder } from "@/lib/ingest/scanJobFolder";
import { resolveReportTemplate } from "@/lib/report-templates";
import { loadJobState } from "@/lib/state/jobState";
import { buildFinalPdfFromDeck } from "@/lib/pptx/finalFromDeck";

/** The finished report PDF from the tech rep's edited PowerPoint (multipart: file, jobRoot,
 * reportType) -- see finalFromDeck.ts. */
export async function POST(request: NextRequest) {
  const form = await request.formData();
  const jobRoot = form.get("jobRoot");
  const reportType = form.get("reportType");
  const file = form.get("file");
  if (typeof jobRoot !== "string" || !jobRoot) return NextResponse.json({ error: "jobRoot is required" }, { status: 400 });
  if (!(file instanceof File) || !/\.pptx$/i.test(file.name)) return NextResponse.json({ error: "Choose the edited .pptx file." }, { status: 400 });
  try {
    const scan = await scanJobFolder(jobRoot, resolveReportTemplate(typeof reportType === "string" ? reportType : undefined));
    const state = await loadJobState(jobRoot);
    const result = await buildFinalPdfFromDeck(scan, state, Buffer.from(await file.arrayBuffer()));
    return new NextResponse(new Uint8Array(result.buffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(file.name.replace(/\.pptx$/i, ".pdf"))}"`,
        "X-File-Name": encodeURIComponent(file.name.replace(/\.pptx$/i, ".pdf")),
        "X-Skipped-Attachments": encodeURIComponent(JSON.stringify(result.skippedAttachments)),
        "X-Unmatched-Sections": encodeURIComponent(JSON.stringify(result.unmatchedSections)),
      },
    });
  } catch (err) {
    console.error("final-from-deck failed:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Building the PDF failed" }, { status: 500 });
  }
}
