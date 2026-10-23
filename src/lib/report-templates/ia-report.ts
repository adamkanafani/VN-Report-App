import type { ReportTemplate } from "./types";
import {
  CUSTOMER_PAGES_RULES,
  HEAT_TREAT_RULES,
  IA_ROUTER_RULES,
  INCOMING_AIRFLOW_RULES,
  INCOMING_DIM_RULES,
  INCOMING_NDT_RULES,
  MET_REPORT_RULES,
  PHOTO_RULES,
  REPAIR_ROUTER_RULES,
  SERIAL_LIST_RULES,
} from "./vn-rules";

// V&N "Incoming Report" (the I&A / Inspect & Advise deliverable). Section order and titles match
// Alfredo Resendiz's own I&A deck for Job 20564 (Calpine F7FA S1N) -- the same order his other ~90
// GE nozzle I&A reports use: cover + component details, Incoming Engineering Summary, Repair
// Recommendations, then divider slides each followed by their appended exhibits (Serial Number
// List, Incoming Dimensional Sheets, Incoming NDT Reports, Incoming Photographs, Incoming Air Flow,
// Heat Treat Charts, Metallurgical Sample Analysis). Section titles double as the divider slides'
// text in the generated PowerPoint, and are how the final-PDF step finds where each block's
// exhibits go -- keep them in step with what his decks say.
//
// This array's order is also the sidebar's default order and the generated report's default page
// order; the tech rep can drag either to reorder (see JobState.sectionOrders).
export const iaReportTemplate: ReportTemplate = {
  reportType: "Incoming Report",
  sections: [
    {
      id: "cover",
      title: "Title / Cover",
      sourceRules: [{ kind: "jobMetadata" }],
      generation: "template",
      automationConfidence: "high",
    },
    {
      id: "customerPages",
      title: "Customer Pages (before cover)",
      sourceRules: CUSTOMER_PAGES_RULES,
      generation: "attach-multi",
      automationConfidence: "medium",
      beforeCover: true,
    },
    {
      // Shared with the Repair Report, which repeats it verbatim -- one section id, so the tech
      // rep's edits here carry straight over (job state is per job folder, not per report).
      id: "engineeringSummary",
      title: "Incoming Engineering Summary",
      sourceRules: IA_ROUTER_RULES,
      generation: "llm-narrative",
      automationConfidence: "medium",
      alwaysReview: true,
    },
    {
      id: "repairRecommendations",
      title: "Repair Recommendations",
      sourceRules: REPAIR_ROUTER_RULES,
      generation: "llm-narrative",
      automationConfidence: "high",
      alwaysReview: true,
    },
    {
      id: "serialNumberList",
      title: "Serial Number List",
      sourceRules: SERIAL_LIST_RULES,
      generation: "table-from-source",
      automationConfidence: "high",
      divider: true,
    },
    {
      id: "incomingDimensional",
      title: "Incoming Dimensional Sheets",
      sourceRules: INCOMING_DIM_RULES,
      generation: "attach-multi",
      automationConfidence: "high",
      divider: true,
    },
    {
      id: "incomingNdt",
      title: "Incoming NDT Reports",
      sourceRules: INCOMING_NDT_RULES,
      generation: "attach-multi",
      automationConfidence: "medium",
      // Vendor scanner output ("SFallbrook 26042915160.pdf") also lands in 7D -- listed, but
      // left unticked until someone confirms what it is.
      preselectPattern: /incoming|crack|ut\b|red\s*dye|visual|fpi|vpi|f-?306/i,
      divider: true,
    },
    {
      id: "photoSet",
      title: "Incoming Photographs",
      sourceRules: PHOTO_RULES,
      generation: "llm-vision-select",
      automationConfidence: "medium",
      alwaysReview: true,
      divider: true,
    },
    {
      id: "incomingAirflow",
      title: "Incoming Air Flow",
      sourceRules: INCOMING_AIRFLOW_RULES,
      generation: "attach-multi",
      automationConfidence: "high",
      divider: true,
    },
    {
      id: "heatTreatCharts",
      title: "Heat Treat Charts",
      sourceRules: HEAT_TREAT_RULES,
      generation: "attach-multi",
      sortBy: "date",
      automationConfidence: "medium",
      // At I&A time only the pre-weld cycle has been run; later charts in 7C belong to the
      // Repair Report.
      preselectPattern: /pre[\s-]?weld/i,
      divider: true,
    },
    {
      id: "metallurgicalReport",
      title: "Metallurgical Sample Analysis",
      sourceRules: MET_REPORT_RULES,
      generation: "attach-as-is",
      automationConfidence: "high",
      divider: true,
    },
  ],
};
