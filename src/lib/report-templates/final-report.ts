import type { ReportTemplate } from "./types";
import {
  COATING_CERT_RULES,
  CUSTOMER_PAGES_RULES,
  FINAL_AIRFLOW_RULES,
  FINAL_DIM_RULES,
  FINAL_NDT_RULES,
  HEAT_TREAT_RULES,
  IA_ROUTER_RULES,
  INCOMING_DIM_RULES,
  INCOMING_NDT_RULES,
  MET_REPORT_RULES,
  PHOTO_RULES,
  REPAIR_ROUTER_RULES,
  SERIAL_LIST_RULES,
} from "./vn-rules";

// V&N "Repair Report" (the Final / completion deliverable). Order and titles match Alfredo
// Resendiz's Repair Report deck for Job 20564 (Calpine F7FA S1N): cover + component details, the
// Incoming Engineering Summary repeated verbatim, Serial Number List, Repair Summary, then divider
// slides each followed by their exhibits -- Final Dimensional Sheets, Final NDT Report, Final
// Photographs, Air Flow Test (flow-tested parts only), Heat Treat Charts, Coating Certification.
//
// Some of his Repair Reports (Job 20505) and Elmer Gomez's vane reports (Job 19512) also re-append
// the incoming exhibit blocks; 20564's doesn't. Those blocks are kept here but start out left out
// of the report (defaultExcluded) -- one click on the sidebar adds any of them back.
//
// Section ids shared with the Incoming Report (cover, engineeringSummary, serialNumberList, the
// incoming exhibit blocks, metallurgicalReport) deliberately reuse the same saved state, so edits
// and picks made on the I&A carry over instead of being redone.
export const finalReportTemplate: ReportTemplate = {
  reportType: "Repair Report",
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
      id: "engineeringSummary",
      title: "Incoming Engineering Summary",
      sourceRules: IA_ROUTER_RULES,
      generation: "llm-narrative",
      automationConfidence: "medium",
      alwaysReview: true,
    },
    {
      id: "serialNumberList",
      title: "Serial Number List",
      // The real completed DS-0404 form, embedded as-is like every other data sheet (Alfredo's
      // reports print the DS-0404 itself behind the divider) -- not a re-typed table.
      sourceRules: SERIAL_LIST_RULES,
      generation: "attach-multi",
      automationConfidence: "high",
      selectOne: true,
      divider: true,
    },
    {
      id: "incomingDimensional",
      title: "Incoming Dimensional Sheets",
      sourceRules: INCOMING_DIM_RULES,
      generation: "attach-multi",
      automationConfidence: "high",
      divider: true,
      defaultExcluded: true,
    },
    {
      id: "incomingNdt",
      title: "Incoming NDT Reports",
      sourceRules: INCOMING_NDT_RULES,
      generation: "attach-multi",
      automationConfidence: "medium",
      preselectPattern: /incoming|crack|ut\b|red\s*dye|visual|fpi|vpi|f-?306/i,
      divider: true,
      defaultExcluded: true,
    },
    {
      id: "photoSet",
      title: "Incoming Photographs",
      sourceRules: PHOTO_RULES,
      generation: "llm-vision-select",
      automationConfidence: "medium",
      alwaysReview: true,
      divider: true,
      defaultExcluded: true,
    },
    {
      id: "metallurgicalReport",
      title: "Metallurgical Sample Analysis",
      sourceRules: MET_REPORT_RULES,
      generation: "attach-as-is",
      automationConfidence: "high",
      divider: true,
      defaultExcluded: true,
    },
    {
      // His Repair Summary is his own I&A Repair Recommendations put in the past tense, line for
      // line (confirmed on Job 20564) -- see autoDraft.ts. Falls back to the repair router.
      id: "repairSummary",
      title: "Repair Summary",
      sourceRules: REPAIR_ROUTER_RULES,
      generation: "llm-narrative",
      automationConfidence: "high",
      alwaysReview: true,
    },
    {
      id: "finalDimensional",
      title: "Final Dimensional Sheets",
      sourceRules: FINAL_DIM_RULES,
      generation: "attach-multi",
      automationConfidence: "high",
      preferPattern: /final/i,
      divider: true,
    },
    {
      id: "finalNdt",
      title: "Final NDT Report",
      sourceRules: FINAL_NDT_RULES,
      generation: "attach-multi",
      automationConfidence: "high",
      divider: true,
    },
    {
      id: "finalPhotoSet",
      title: "Final Photographs",
      sourceRules: PHOTO_RULES,
      generation: "llm-vision-select",
      automationConfidence: "medium",
      alwaysReview: true,
      divider: true,
    },
    {
      // Flow-tested parts only (F7FA S1N in the jobs surveyed); simply absent on everything else.
      id: "finalAirflow",
      title: "Air Flow Test",
      sourceRules: FINAL_AIRFLOW_RULES,
      generation: "attach-multi",
      automationConfidence: "high",
      divider: true,
    },
    {
      id: "finalHeatTreatCharts",
      title: "Heat Treat Charts",
      sourceRules: HEAT_TREAT_RULES,
      generation: "attach-multi",
      sortBy: "date",
      automationConfidence: "high",
      divider: true,
    },
    {
      id: "coatingCertification",
      title: "Coating Certification",
      sourceRules: COATING_CERT_RULES,
      generation: "attach-multi",
      automationConfidence: "high",
      divider: true,
    },
  ],
};
