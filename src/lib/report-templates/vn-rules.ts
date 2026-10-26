import type { SourceMatchRule } from "./types";

// File-matching rules shared by the V&N Incoming (I&A) and Repair (Final) reports. Built from a
// survey of real V&N job folders (Jobs 18042, 19512, 20174, 20312, 20321, 20342, 20505, 20564,
// 20978 -- GE 1st/2nd/3rd stage nozzles and Siemens/Westinghouse row 1/3 vanes), which all follow
// the same folder template:
//
//   <job>\<job> ... inspect and advise router.xlsm / IA Router.xlsm      (job root)
//   <job>\<job> ... repair router.xlsm / ...REPAIR ... PSM.xlsm           (job root)
//   3 Pictures\3A Incoming\{Shipping,Hardware,NDT-1\<part>}, 3C Final\Final
//   7 Reports\7A Inspection Report   incoming DS-xxxx prints, DS-0404, met report
//   7 Reports\7B Final Report        final DS-xxxx prints (+ "Pre-coat"/"IN PROCESS" subfolders)
//   7 Reports\7C Heat Treat          furnace run charts + vendor certs
//   7 Reports\7D NDT                 INCOMING/FINAL <part> NDT workbooks + PDF prints
//   9 Coating                        coating certificate of conformance

/** "Copy of ..." duplicates live in "2 Customer Quote & PO" -- never the working file. */
const NOT_A_COPY = /^copy of/i;

export const IA_ROUTER_RULES: SourceMatchRule[] = [
  {
    // "inspect and advise router", "I and A Router", "IA Router", "F7FA__NOZZLER1__IA Router".
    kind: "filenamePattern",
    pattern: /(^|[^a-z])(ia|i\s*and\s*a|i&a|inspect\s*and\s*advise)[\s_-]*router/i,
    excludePattern: NOT_A_COPY,
    requiredExtensions: [".xlsm", ".xlsx"],
  },
];

export const REPAIR_ROUTER_RULES: SourceMatchRule[] = [
  {
    // "repair router", "Rep router", "...REPAIR ... PSM.xlsm".
    kind: "filenamePattern",
    pattern: /rep(air)?[\s_-]*router|repair.*psm/i,
    excludePattern: NOT_A_COPY,
    requiredExtensions: [".xlsm", ".xlsx"],
  },
];

/** DS-0404 "Serial number recording sheet" -- always in 7A. Inspector-initial variants like
 * "(CJ)" / "(TH)" are the same form. Both the PDF print and the workbook match: the report uses
 * the PDF, or prints the workbook through Excel when there's no PDF (see SectionConfig.selectOne). */
export const SERIAL_LIST_RULES: SourceMatchRule[] = [
  {
    kind: "filenamePattern",
    pattern: /ds-?0404|serial\s*number\s*(recording|list)/i,
    excludePattern: /^copy of|final/i,
    preferFolder: /7a|inspection report/i,
    requiredExtensions: [".pdf", ".xlsx"],
  },
];

/** Any DS-numbered data sheet print. DS-0404 is its own section; DS-0688 is the core/cover NDT
 * sign-off sheet, which belongs with the NDT reports. */
const DS_SHEET = /(^|[^a-z])ds[\s-]?\d{3,4}/i;
const NOT_DIMENSIONAL = /ds[\s-]?0404|ds[\s-]?0688|serial\s*number|crack|(ia|incoming|repair)\s*report|cert|air\s*flow/i;
const IN_PROCESS_FOLDER = /pre[\s-]?coat|in[\s-]?process|post[\s-]?weld/i;

export const INCOMING_DIM_RULES: SourceMatchRule[] = [
  {
    kind: "filenamePattern",
    pattern: DS_SHEET,
    excludePattern: NOT_DIMENSIONAL,
    folder: /7a|inspection report/i,
    requiredExtensions: [".pdf", ".xlsx", ".xlsm"],
  },
];

export const FINAL_DIM_RULES: SourceMatchRule[] = [
  {
    kind: "filenamePattern",
    pattern: /(^|[^a-z])ds[\s-]?\d{3,4}/i,
    excludePattern: NOT_DIMENSIONAL,
    folder: /7b|final report/i,
    excludeFolder: IN_PROCESS_FOLDER,
    requiredExtensions: [".pdf", ".xlsx", ".xlsm"],
  },
];

/** 7D NDT holds every stage's workbooks side by side, named by stage + part ("INCOMING CORES &
 * COVERS", "FINAL RED DYE", "PRE COAT VISUAL", ...) -- stage comes from the name. Crack maps
 * sometimes sit in 7A instead (Job 19512), so they get their own rule. */
export const INCOMING_NDT_RULES: SourceMatchRule[] = [
  {
    kind: "filenamePattern",
    pattern: /./,
    // Coating-stage checks ("VISUAL COATING") happen after repair too, despite no FINAL prefix.
    excludePattern: /final|pre[\s-]?coat|coating|post[\s-]?weld|in[\s-]?process|^copy of/i,
    folder: /7d|(^|\/)[^/]*ndt/i,
    requiredExtensions: [".pdf", ".xlsx", ".xlsm"],
  },
  {
    kind: "filenamePattern",
    pattern: /crack[\s_-]?maps?/i,
    excludePattern: /final/i,
    requiredExtensions: [".pdf"],
  },
];

export const FINAL_NDT_RULES: SourceMatchRule[] = [
  {
    kind: "filenamePattern",
    pattern: /final/i,
    excludePattern: /^copy of/i,
    folder: /7d|(^|\/)[^/]*ndt/i,
    requiredExtensions: [".pdf", ".xlsx", ".xlsm"],
  },
];

export const HEAT_TREAT_RULES: SourceMatchRule[] = [
  {
    kind: "filenamePattern",
    pattern: /./,
    // 7C only -- 3B In-process photo folders are named things like "OUT TO HEAT TREAT" too.
    folder: /(^|\/)7c\b|^7 reports\/[^/]*heat\s*treat/i,
    requiredExtensions: [".pdf"],
  },
];

/** VeriTech Labs "Report 2026-138 with covers.pdf", or the other lab's "26844-02 APG F7EA S1N AR
 * JN 20312.pdf" -- neither says "metallurgical" in its file name. */
export const MET_REPORT_RULES: SourceMatchRule[] = [
  {
    kind: "filenamePattern",
    pattern: /report\s*\d{4}-\d{2,4}|\bAR\s+JN\b|met(allurgical)?.*(report|sample|analysis)/i,
    preferFolder: /7a|inspection report/i,
    requiredExtensions: [".pdf"],
  },
];

/** Incoming flow test on flow-tested parts (F7FA S1N): "F7FA S1N Incoming Air Flow ID.pdf" / "OD"
 * in 7A. Alfredo's I&A gives it its own "Incoming Air Flow" divider after the photographs (Job
 * 20564), rather than mixing it into the dimensional sheets. */
export const INCOMING_AIRFLOW_RULES: SourceMatchRule[] = [
  {
    kind: "filenamePattern",
    pattern: /air\s*flow|flow\s*(test|incoming)/i,
    excludePattern: /final/i,
    folder: /7a|inspection report/i,
    requiredExtensions: [".pdf", ".xlsx"],
  },
];

/** Customer-supplied pages that go in front of the cover -- Calpine's "Repair Detail Summary"
 * (asset #, unit, hours/starts) on Job 20564's I&A and Repair reports. */
export const CUSTOMER_PAGES_RULES: SourceMatchRule[] = [
  {
    kind: "filenamePattern",
    pattern: /repair\s*detail\s*summary|(^|[^a-z])rds([^a-z]|$)/i,
    folder: /^7 reports/i,
    requiredExtensions: [".pdf", ".xlsx"],
  },
];

export const FINAL_AIRFLOW_RULES: SourceMatchRule[] = [
  {
    kind: "filenamePattern",
    pattern: /air\s*flow|flow\s*test|final\s*flow/i,
    folder: /7b|final report/i,
    requiredExtensions: [".pdf", ".xlsx"],
  },
];

/** APG's own certification sheets for the customer -- "Flow Test Cert for TMG.pdf", "Heat Treat
 * Cert for TMG.pdf" -- which Elmer Gomez prints as a "Certifications" block (501F vane jobs 20381,
 * 19168). In the report folder of the report being built (7A for the I&A, 7B for the Repair). */
export const certificationRules = (folder: RegExp): SourceMatchRule[] => [
  {
    kind: "filenamePattern",
    pattern: /cert(ification)?\s+for\b|flow\s*test\s*cert|heat\s*treat\s*cert/i,
    excludePattern: /coat/i,
    folder,
    requiredExtensions: [".pdf", ".xlsx"],
  },
];
export const IA_CERTIFICATION_RULES = certificationRules(/7a|inspection report/i);
export const FINAL_CERTIFICATION_RULES = certificationRules(/7b|final report/i);

/** The heat treat vendor's certification ("Certification-159589-1.pdf" in 7C) -- Elmer's W501F R3V
 * reports give it its own "Heat Treat Certification" divider (Job 20387). */
export const HEAT_TREAT_CERT_RULES: SourceMatchRule[] = [
  {
    kind: "filenamePattern",
    pattern: /certification|_cert\.pdf$|\bcert\b/i,
    folder: /(^|\/)7c\b|^7 reports\/[^/]*heat\s*treat/i,
    requiredExtensions: [".pdf"],
  },
];

export const COATING_CERT_RULES: SourceMatchRule[] = [
  {
    kind: "filenamePattern",
    pattern: /./,
    folder: /^9\s*coating/i,
    requiredExtensions: [".pdf", ".xlsx"],
  },
  {
    kind: "filenamePattern",
    pattern: /coat(ing)?\s*cert|cert\s*data\s*sheet/i,
    requiredExtensions: [".pdf", ".xlsx"],
  },
];

export const PHOTO_RULES: SourceMatchRule[] = [{ kind: "folderPattern", pattern: /pictures/i, fileExtensions: [".jpg", ".jpeg", ".png"] }];
