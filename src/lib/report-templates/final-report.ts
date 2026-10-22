import type { ReportTemplate } from "./types";
import {
  COATING_CERT_RULES,
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

// V&N "Repair Report" (the Final / completion deliverable). Reverse-engineered from real completed
// reports -- Jobs 19512 (W501D5A R3V), 20505 (Dow F7FA S2N) and 20564 (Calpine F7FA S1N). It
// repeats the Incoming Engineering Summary verbatim, then (on two of the three) re-appends the
// incoming exhibits, before the repair-stage content: Repair Summary, final dimensional sheets,
// final NDT, final photographs, airflow (flow-tested parts only), heat treat charts, coating cert.
//
// Section ids shared with the Incoming Report (cover, engineeringSummary, serialNumberList, the
// incoming exhibit blocks, metallurgicalReport) deliberately reuse the same saved state, so a tech
// rep's edits/picks made on the I&A carry over instead of being redone. Any repeated incoming block
// a given customer doesn't want can be dropped with the ✕ on its sidebar tab (Job 20564's report
// leaves them all out).
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
      preselectPattern: /incoming|crack|ut\b|red\s*dye|visual|fpi|vpi/i,
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
      id: "metallurgicalReport",
      title: "Metallurgical Sample Analysis",
      sourceRules: MET_REPORT_RULES,
      generation: "attach-as-is",
      automationConfidence: "high",
      divider: true,
    },
    {
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
      title: "Final NDT Reports",
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
