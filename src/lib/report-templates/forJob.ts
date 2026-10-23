import type { ReportTemplate, SectionConfig } from "./types";
import { resolveReportTemplate } from "./index";
import { loadJobState } from "../state/jobState";

/** A tech-rep-added section: their own title over files they attach by hand (stored under
 * "_Manual Attachments/<id>/" like every other manual attachment), printed the same way as the
 * built-in exhibit blocks -- its own divider page / slide, then the files. */
export function customSectionConfig(custom: { id: string; title: string }): SectionConfig {
  return {
    id: custom.id,
    title: custom.title,
    sourceRules: [],
    generation: "attach-multi",
    automationConfidence: "high",
    divider: true,
    custom: true,
  };
}

/** The report template for this job: the standard section list plus any sections the tech rep
 * added for this job and report type (see JobState.customSections). Every scan of a job goes
 * through here, so the review screen, the PowerPoint and both PDF exports see the same list. */
export async function templateForJob(jobRoot: string, reportType: string | undefined): Promise<ReportTemplate> {
  const template = resolveReportTemplate(reportType);
  const state = await loadJobState(jobRoot);
  const custom = state.customSections?.[template.reportType] ?? [];
  if (custom.length === 0) return template;
  return { ...template, sections: [...template.sections, ...custom.map(customSectionConfig)] };
}
