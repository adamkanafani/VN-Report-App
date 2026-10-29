import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { resolveReportTemplate } from "@/lib/report-templates";
import { mutateJobState, updateCustomSections } from "@/lib/state/jobState";

/** Add / rename / delete a tech-rep-added section on one job's report (see JobState.customSections).
 * Deleting only drops the section from the report -- any files attached to it stay in the job
 * folder's "_Manual Attachments" folder. */
export async function POST(request: NextRequest) {
  const { jobRoot, reportType, action, id, title } = (await request.json()) as {
    jobRoot?: string;
    reportType?: string;
    action?: "add" | "rename" | "delete" | "retitle";
    id?: string;
    title?: string;
  };
  if (!jobRoot || !action) return NextResponse.json({ error: "jobRoot and action are required" }, { status: 400 });
  const cleanTitle = (title ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  if ((action === "add" || action === "rename") && !cleanTitle) return NextResponse.json({ error: "Give the section a title." }, { status: 400 });
  if (action !== "add" && !id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const template = resolveReportTemplate(reportType);

  // A built-in section's divider title for this job (see JobState.sectionTitles) -- a blank title
  // goes back to the standard one.
  if (action === "retitle") {
    await mutateJobState(jobRoot, (state) => {
      const titles = { ...state.sectionTitles?.[template.reportType] };
      if (cleanTitle) titles[id!] = cleanTitle;
      else delete titles[id!];
      state.sectionTitles = { ...state.sectionTitles, [template.reportType]: titles };
    });
    const standard = template.sections.find((s) => s.id === id)?.title ?? cleanTitle;
    return NextResponse.json({ section: { id, title: cleanTitle || standard } });
  }

  let section: { id: string; title: string } | undefined;
  const state = await updateCustomSections(jobRoot, template.reportType, (sections) => {
    if (action === "add") {
      section = { id: `custom-${crypto.randomUUID().slice(0, 8)}`, title: cleanTitle };
      return [...sections, section];
    }
    if (action === "rename") return sections.map((s) => (s.id === id ? (section = { ...s, title: cleanTitle }) : s));
    return sections.filter((s) => s.id !== id);
  });
  return NextResponse.json({ section, customSections: state.customSections?.[template.reportType] ?? [] });
}
