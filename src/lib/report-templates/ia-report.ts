import type { ReportTemplate } from "./types";

// Section order, source rules, and generation strategy for the I&A Report.
// Reverse-engineered from a real completed job (APG Job 20443) plus the
// company's own "TR Summary" tracker tab (Claudability ratings carried over
// into `automationConfidence`).
//
// This array's order is also the sidebar's order (scanJobFolder.ts preserves it verbatim into
// JobScanResult.sections) -- kept matching the actual generated PDF's own section order rather
// than an independent ordering, so paging down the review sidebar lines up with paging through
// the final report. The attach-as-is exhibits (Metallurgical Report, Chem Test, Crack Map) are
// last in both because generateReport.ts's ATTACH_AS_IS_ORDER appends them verbatim at the very
// end of the assembled PDF, after every other section's content.
export const iaReportTemplate: ReportTemplate = {
  reportType: "I&A Report",
  sections: [
    {
      id: "cover",
      title: "Title / Cover",
      sourceRules: [{ kind: "jobMetadata" }],
      generation: "template",
      automationConfidence: "high",
    },
    {
      id: "iaSummary",
      title: "I&A Summary",
      sourceRules: [],
      dependsOnSections: ["fpiVisual", "dimensionalSummary", "recommendedRepairs"],
      generation: "llm-narrative",
      automationConfidence: "high",
    },
    {
      id: "fpiVisual",
      title: "FPI & Visual Inspection Summary",
      sourceRules: [
        {
          kind: "filenamePattern",
          pattern: /(^|[^a-z])ia[_ -]?router/i,
          excludePattern: /^copy of/i,
          requiredExtensions: [".xlsm", ".xlsx"],
        },
      ],
      generation: "llm-narrative",
      automationConfidence: "high",
    },
    {
      id: "dimensionalSummary",
      title: "Dimensional Inspection Summary",
      sourceRules: [],
      dependsOnSections: ["heightDimForm", "dovetailDimension", "wallThickness"],
      generation: "llm-narrative",
      automationConfidence: "high",
      alwaysReview: true,
    },
    {
      id: "recommendedRepairs",
      title: "Recommended Repairs",
      sourceRules: [
        {
          kind: "filenamePattern",
          pattern: /repair[_ -]?router/i,
          excludePattern: /^copy of/i,
          requiredExtensions: [".xlsm", ".xlsx"],
        },
        {
          // Some customers' jobs have no repair-router file at all -- a "Repair CDS" reference
          // workbook stands in instead (see repairCds.ts), confirmed against Job 20436 ("Repair
          // CDS.xlsm") and Job 20668, a different customer unit/contract ("CDS Repair.xlsm" --
          // word order isn't consistent).
          kind: "filenamePattern",
          pattern: /repair\s*cds|cds\s*repair/i,
          requiredExtensions: [".xlsm", ".xlsx"],
        },
      ],
      generation: "llm-narrative",
      automationConfidence: "high",
    },
    {
      id: "serialNumberList",
      title: "Serial Number List",
      sourceRules: [
        {
          kind: "filenamePattern",
          pattern: /ds-?0554.*incoming/i,
          requiredExtensions: [".xlsx"],
        },
        {
          kind: "filenamePattern",
          pattern: /ds-?0554/i,
          excludePattern: /in.?process|final/i,
          requiredExtensions: [".xlsx"],
        },
      ],
      generation: "table-from-source",
      automationConfidence: "high",
    },
    {
      id: "scrapReport",
      title: "Scrap Report",
      // Same workbook as Serial Number List, not a separate file -- this reads its "blade bucket
      // scrap" tab instead of the main serial number sheet.
      sourceRules: [
        {
          kind: "filenamePattern",
          pattern: /ds-?0554.*incoming/i,
          requiredExtensions: [".xlsx"],
        },
        {
          kind: "filenamePattern",
          pattern: /ds-?0554/i,
          excludePattern: /in.?process|final/i,
          requiredExtensions: [".xlsx"],
        },
      ],
      generation: "table-from-source",
      automationConfidence: "high",
    },
    {
      id: "snRecordingSheet",
      title: "Serial Number Recording Sheet",
      // Same workbook as Serial Number List again -- its "DS-0404 SN Recording Sheet" tab.
      sourceRules: [
        {
          kind: "filenamePattern",
          pattern: /ds-?0554.*incoming/i,
          requiredExtensions: [".xlsx"],
        },
        {
          kind: "filenamePattern",
          pattern: /ds-?0554/i,
          excludePattern: /in.?process|final/i,
          requiredExtensions: [".xlsx"],
        },
      ],
      generation: "table-from-source",
      automationConfidence: "high",
    },
    {
      id: "heightDimForm",
      title: "Height Dim Form",
      sourceRules: [
        {
          // "heights...incoming" (1st stage) or "height form...incoming" (2nd/3rd stage,
          // confirmed against Job 20436's "...height form tall buckets Incoming.xlsx" -- no "s"
          // on "height" at all, so the 1st-stage-only pattern this used to be missed it outright).
          kind: "filenamePattern",
          pattern: /heights?.*incoming/i,
          requiredExtensions: [".xlsx"],
        },
        {
          kind: "filenamePattern",
          pattern: /ds-?0004/i,
          excludePattern: /in.?process|final/i,
          requiredExtensions: [".xlsx"],
        },
      ],
      generation: "table-from-source",
      automationConfidence: "high",
    },
    {
      id: "dovetailDimension",
      title: "Dovetail Dimension Inspection",
      sourceRules: [
        {
          kind: "filenamePattern",
          pattern: /dovetail.*incoming/i,
          requiredExtensions: [".xlsx"],
        },
        {
          // Form number varies by bucket stage -- DS-1017 for 1st stage, DS-0460 ("Stage 2 and
          // 3 Bucket Dovetail Inspection Data Sheet") for 2nd/3rd -- confirmed both use the same
          // internal layout (see dovetailDimension.ts), so one section covers all of them.
          kind: "filenamePattern",
          pattern: /ds-?1017|ds-?0460/i,
          excludePattern: /in.?process|final/i,
          requiredExtensions: [".xlsx"],
        },
      ],
      generation: "table-from-source",
      automationConfidence: "high",
    },
    {
      id: "zDropDimension",
      title: "Z-Drop Dimensions",
      sourceRules: [
        {
          // "Z drop"/"Z notch" (2nd stage) or just "Z dimensions" (3rd stage, confirmed against
          // Job 20436 -- same form, filename just doesn't say drop/notch at all).
          kind: "filenamePattern",
          pattern: /z[\s_-]?(drop|notch|dimensions?).*incoming/i,
          requiredExtensions: [".xlsx"],
        },
        {
          kind: "filenamePattern",
          pattern: /ds-?0459/i,
          excludePattern: /in.?process|final/i,
          requiredExtensions: [".xlsx"],
        },
      ],
      generation: "table-from-source",
      automationConfidence: "high",
    },
    {
      id: "wallThickness",
      title: "Wall Thickness",
      sourceRules: [
        {
          kind: "filenamePattern",
          pattern: /incoming.*ut|ut.*incoming|ds-?0002/i,
          preferFolder: /ndt/i,
          requiredExtensions: [".xlsx"],
        },
      ],
      generation: "table-from-source",
      automationConfidence: "high",
    },
    {
      id: "airflowReport",
      title: "Airflow Report",
      sourceRules: [
        {
          kind: "filenamePattern",
          pattern: /airflow/i,
          requiredExtensions: [".xlsx"],
        },
      ],
      generation: "table-from-source",
      automationConfidence: "high",
    },
    {
      id: "photoSet",
      title: "Photo Set",
      sourceRules: [
        {
          kind: "folderPattern",
          pattern: /pictures/i,
          fileExtensions: [".jpg", ".jpeg", ".png"],
        },
        {
          // Fallback for jobs that paste incoming photos directly into a template document
          // instead of keeping loose files in a Pictures folder — only used when the folder
          // rule above finds nothing; see scanFileBackedSection's llm-vision-select branch.
          kind: "filenamePattern",
          pattern: /photo.*template/i,
          requiredExtensions: [".pdf"],
        },
      ],
      generation: "llm-vision-select",
      automationConfidence: "medium",
      alwaysReview: true,
    },
    {
      id: "metallurgicalReport",
      title: "Metallurgical Report",
      sourceRules: [
        {
          kind: "filenamePattern",
          pattern: /met.*report/i,
          requiredExtensions: [".pdf"],
        },
      ],
      generation: "attach-as-is",
      automationConfidence: "high",
    },
    {
      id: "chemTest",
      title: "Chem Test",
      sourceRules: [
        {
          kind: "filenamePattern",
          pattern: /chem.*(strip|test)/i,
          requiredExtensions: [".pdf"],
          preferFolder: /reports/i,
        },
      ],
      generation: "attach-as-is",
      automationConfidence: "high",
    },
    {
      id: "crackMap",
      title: "Crack Map",
      sourceRules: [
        {
          kind: "filenamePattern",
          pattern: /crack[_ -]?map/i,
          requiredExtensions: [".pdf", ".jpg", ".jpeg", ".png"],
        },
      ],
      generation: "attach-as-is",
      automationConfidence: "high",
      alwaysReview: true,
    },
  ],
};
