import type { ReportTemplate } from "./types";

// Final Report -- reverse-engineered from a real completed deliverable (Job 18664, Fredrickson
// Power, plus notes from Jonathan on which exhibits are conditional vs. near-universal). Unlike
// the I&A Report, this has no narrative summary sections at all (no I&A Summary, FPI/Visual
// Summary, or Dimensional Summary -- those describe incoming findings, which this deliverable
// doesn't restate) -- just a Repair Summary (reused from the I&A Report's own recommendedRepairs
// section/data, since it's the same underlying repair-router/CDS source either way -- titled
// differently here per tech rep feedback: a Final Report documents repairs already performed,
// it isn't recommending anything, so "Recommended Repairs" doesn't fit) followed by a run of
// completion-stage re-checks and certifications. Section order here matches the real report's own
// page order as closely as this app's rendering pipeline supports (see renderReportHtml.ts's
// INLINE_ATTACH_SECTIONS): dimensional re-checks and true attach-as-is certifications /
// checklists are genuinely interleaved in the real document, not grouped separately.
//
// Per Jonathan: X-ray & airflow only apply to some jobs (no part-type allowlist, same "just
// missing when absent" pattern as the I&A Report's own Airflow Report); coating cert, shot
// peen/Al seal strip cert, and moment weigh apply to almost every job; heat treat charts and the
// damper pin check are also routine. All of these are genuinely optional at the file-matching
// level regardless -- a job that doesn't have a given exhibit's source file simply doesn't get
// that page, exactly the "conditional logic, not on every report" convention already established
// for the I&A Report's own optional sections.
export const finalReportTemplate: ReportTemplate = {
  reportType: "Final Report",
  sections: [
    {
      id: "cover",
      title: "Title / Cover",
      sourceRules: [{ kind: "jobMetadata" }],
      generation: "template",
      automationConfidence: "high",
    },
    {
      id: "recommendedRepairs",
      title: "Repair Summary",
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
      id: "finalSerialNumberList",
      title: "Final Ship Serial Number List",
      // Same DS-0554 workbook family as the I&A Report's own Serial Number List, just the
      // as-shipped/final-stage export -- confirmed against Job 18664: "...Final Ship SN List
      // 5-30-26.xlsx" carries the exact same "DS-0554 serial number sheet" tab.
      sourceRules: [
        {
          kind: "filenamePattern",
          pattern: /final.*ship.*sn|ds-?0554.*final/i,
          excludePattern: /no-?ship/i,
          requiredExtensions: [".xlsx"],
        },
      ],
      generation: "table-from-source",
      automationConfidence: "high",
    },
    {
      id: "finalScrapReport",
      title: "Final Scrap SN List",
      // Same workbook as Final Ship Serial Number List above, not a separate file -- its "blade
      // bucket scrap" tab.
      sourceRules: [
        {
          kind: "filenamePattern",
          pattern: /final.*ship.*sn|ds-?0554.*final/i,
          excludePattern: /no-?ship/i,
          requiredExtensions: [".xlsx"],
        },
      ],
      generation: "table-from-source",
      automationConfidence: "high",
    },
    {
      id: "preWeldHeatTreatChart",
      title: "Pre-Weld Heat Treat Chart",
      sourceRules: [{ kind: "filenamePattern", pattern: /pre.?weld/i, requiredExtensions: [".pdf"] }],
      generation: "attach-as-is",
      automationConfidence: "high",
    },
    {
      id: "postWeldHeatTreatChart",
      title: "Post-Weld Heat Treat Chart",
      sourceRules: [{ kind: "filenamePattern", pattern: /post.?weld/i, requiredExtensions: [".pdf"] }],
      generation: "attach-as-is",
      automationConfidence: "high",
    },
    {
      id: "xRayInspection",
      title: "X-Ray Inspection",
      sourceRules: [{ kind: "filenamePattern", pattern: /x.?ray/i, requiredExtensions: [".pdf"] }],
      generation: "attach-as-is",
      automationConfidence: "high",
    },
    {
      // Named "Final NDT.pdf" per a tech rep, no real completed report to reverse-engineer an
      // exact page position from (unlike most of this template's other sections) -- placed here,
      // grouped with X-Ray Inspection, since both are NDT-type re-checks; move it if it turns out
      // to print somewhere else on the real form.
      id: "finalNdt",
      title: "Final NDT",
      sourceRules: [{ kind: "filenamePattern", pattern: /final.*ndt|ndt.*final/i, requiredExtensions: [".pdf"] }],
      generation: "attach-as-is",
      automationConfidence: "high",
    },
    {
      id: "finalWallThickness",
      title: "Final Wall Thickness Dimensions",
      // Same real form as the I&A Report's own Wall Thickness (confirmed against Job 18664:
      // "Final UT.xlsx" is the same "DS-0007 FA R1 wall thickness" sheet layout), just the
      // post-repair measurement instead of incoming.
      sourceRules: [{ kind: "filenamePattern", pattern: /final.*ut|ut.*final/i, preferFolder: /ndt/i, requiredExtensions: [".xlsx"] }],
      generation: "table-from-source",
      automationConfidence: "high",
    },
    {
      // Named "Z Notch Dimensions.pdf" / "Bucket Dimensions.pdf" per a tech rep -- attach-as-is,
      // not a parsed table, since no sample file was available to reverse-engineer a column
      // layout from. Grouped with the other dimensional re-checks; see finalNdt's own comment on
      // page-position uncertainty.
      id: "zNotchDimensions",
      title: "Z Notch Dimensions",
      sourceRules: [{ kind: "filenamePattern", pattern: /z[\s-]?notch.*dimension/i, requiredExtensions: [".pdf"] }],
      generation: "attach-as-is",
      automationConfidence: "high",
    },
    {
      id: "postCoatHeatTreatChart",
      title: "Post-HVOF Coat Diffusion Heat Treat Chart",
      sourceRules: [{ kind: "filenamePattern", pattern: /post.?coat/i, requiredExtensions: [".pdf"] }],
      generation: "attach-as-is",
      automationConfidence: "high",
    },
    {
      id: "finalAgeHeatTreatChart",
      title: "Post-TBC Coat Diffusion + Final Age Heat Treat Chart",
      sourceRules: [{ kind: "filenamePattern", pattern: /\bage\b/i, requiredExtensions: [".pdf"] }],
      generation: "attach-as-is",
      automationConfidence: "high",
    },
    {
      id: "coatingCertification",
      title: "APG Coating Certification",
      sourceRules: [{ kind: "filenamePattern", pattern: /coating.*cert/i, requiredExtensions: [".pdf"] }],
      generation: "attach-as-is",
      automationConfidence: "high",
    },
    {
      id: "finalHeightDimForm",
      title: "Final Height Dimensions",
      // Same real form as the I&A Report's own Height Dim Form -- confirmed against Job 18664:
      // "...heights FINAL.xlsx" uses the exact same APG#-anchored layout, just under a "DS-0006"
      // sheet name instead of "DS-0004"/"1st stg heights" -- found by parseHeightDimForm's
      // content-based fallback strategy regardless of sheet name, no changes needed there.
      sourceRules: [{ kind: "filenamePattern", pattern: /heights?.*final|final.*heights?/i, requiredExtensions: [".xlsx"] }],
      generation: "table-from-source",
      automationConfidence: "high",
    },
    {
      id: "finalAirflowReport",
      title: "Final Air Flow",
      sourceRules: [{ kind: "filenamePattern", pattern: /total.*flow|airflow/i, requiredExtensions: [".xlsx"] }],
      generation: "table-from-source",
      automationConfidence: "high",
    },
    {
      id: "shotPeenAlSealStripCert",
      title: "APG Shot Peen & Al Seal Strip Certification",
      sourceRules: [{ kind: "filenamePattern", pattern: /shot.?peen/i, requiredExtensions: [".pdf"] }],
      generation: "attach-as-is",
      automationConfidence: "high",
    },
    {
      id: "damperPinCheck",
      title: "Damper Pin Rock Check",
      sourceRules: [{ kind: "filenamePattern", pattern: /damper.*pin/i, requiredExtensions: [".pdf"] }],
      generation: "attach-as-is",
      automationConfidence: "high",
    },
    {
      id: "finalPhotoSet",
      title: "Final Photos",
      // Same folder convention as the I&A Report's own Photo Set -- just prefers the "3C Final"
      // stage grouping instead of "3A Incoming" (see photoSelect.ts's selectBestPhotos
      // preferredStage param).
      sourceRules: [{ kind: "folderPattern", pattern: /pictures/i, fileExtensions: [".jpg", ".jpeg", ".png"] }],
      generation: "llm-vision-select",
      automationConfidence: "medium",
      alwaysReview: true,
    },
    {
      id: "finalMomentWeigh",
      title: "Final Moment Weigh",
      sourceRules: [{ kind: "filenamePattern", pattern: /moment.*weigh/i, requiredExtensions: [".pdf"] }],
      generation: "attach-as-is",
      automationConfidence: "high",
    },
  ],
};
