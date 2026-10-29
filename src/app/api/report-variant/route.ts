import { NextRequest, NextResponse } from "next/server";
import { resolveReportTemplate } from "@/lib/report-templates";
import { loadJobState, saveJobState, type ReportVariant } from "@/lib/state/jobState";

/** Switches a job's report between the standard version and Calpine's Fleet Service (FS) copy --
 * the review screen rescans afterwards so the FS sheets and text show up. */
export async function POST(request: NextRequest) {
  const { jobRoot, reportType, variant } = (await request.json()) as { jobRoot?: string; reportType?: string; variant?: ReportVariant };
  if (!jobRoot || (variant !== "standard" && variant !== "fs")) return NextResponse.json({ error: "jobRoot and variant are required" }, { status: 400 });
  const state = await loadJobState(jobRoot);
  state.reportVariant = { ...state.reportVariant, [resolveReportTemplate(reportType).reportType]: variant };
  await saveJobState(state);
  return NextResponse.json({ ok: true });
}
