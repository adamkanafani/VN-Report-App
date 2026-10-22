import type { ReportTemplate } from "./types";
import { iaReportTemplate } from "./ia-report";
import { finalReportTemplate } from "./final-report";

/** The two report types a tech rep can build for a job, picked on the app's very first screen
 * before choosing a job folder -- so scanning/drafting/rendering all know from the start which
 * section list to use, rather than assuming I&A Report everywhere. */
export type ReportTypeId = "ia" | "final";

export const REPORT_TYPES: Array<{ id: ReportTypeId; label: string; template: ReportTemplate }> = [
  { id: "ia", label: "I&A Report", template: iaReportTemplate },
  { id: "final", label: "Final Report", template: finalReportTemplate },
];

const TEMPLATES: Record<ReportTypeId, ReportTemplate> = {
  ia: iaReportTemplate,
  final: finalReportTemplate,
};

/** Resolves a report-type id (as sent by the client) to its ReportTemplate config -- defaults to
 * the I&A Report for anything missing or unrecognized, so a caller that hasn't been updated to
 * send one yet keeps behaving exactly as it did before this selection existed. */
export function resolveReportTemplate(reportType: string | undefined): ReportTemplate {
  return TEMPLATES[reportType as ReportTypeId] ?? iaReportTemplate;
}
