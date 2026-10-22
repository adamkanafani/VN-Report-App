// Shared types for report template configs (I&A / Incoming Report, Final / Repair Report).
// A report template is a data-driven list of sections; nothing about a specific
// report type should be hardcoded outside of a `*-report.ts` config module.

export type GenerationStrategy =
  | "template" // filled from job metadata fields, no LLM
  | "table-from-source" // deterministic table parsed from a source file, pass/fail computed in code
  | "llm-narrative" // deterministic draft from job data; Claude only for "revise with instruction"
  | "llm-vision-select" // photo set (optional Claude vision screening)
  | "attach-as-is" // no generation, just slot the single matched file in
  | "attach-multi"; // a run of real completed exhibits (DS prints, NDT forms, charts) the tech rep picks and orders

export type AutomationConfidence = "high" | "medium" | "low";

export type SourceMatchRule =
  | {
      kind: "filenamePattern";
      /** Matched against the file's base name (case-insensitive). Rules on a section are
       * tried in order; ingestion falls through to the next rule if a match fails validation
       * (e.g. the file parses but contains no data). */
      pattern: RegExp;
      /** Base names matching this are skipped even if `pattern` matches (e.g. "Copy of ..."). */
      excludePattern?: RegExp;
      /** Not a hard filter — used only to break ties when multiple files match `pattern`. */
      preferFolder?: RegExp;
      /** Hard filter on the file's folder path (relative to the job root) -- V&N jobs keep the
       * same DS form numbers in both "7A Inspection Report" (incoming) and "7B Final Report"
       * (final), so stage is told apart by where the file lives, not by its name. */
      folder?: RegExp;
      /** Files whose folder path matches this are skipped (e.g. 7B's "Pre-coat" / "IN PROCESS"
       * subfolders, which are in-process re-checks rather than the final-stage prints). */
      excludeFolder?: RegExp;
      requiredExtensions?: string[];
    }
  | {
      kind: "folderPattern";
      pattern: RegExp;
      fileExtensions?: string[];
    }
  | { kind: "jobMetadata" };

export interface SectionConfig {
  id: string;
  title: string;
  sourceRules: SourceMatchRule[];
  generation: GenerationStrategy;
  automationConfidence: AutomationConfidence;
  /** If true, this section is always flagged "review recommended" even when drafting succeeds. */
  alwaysReview?: boolean;
  /** For llm-narrative sections synthesized from other sections' data rather than raw files. */
  dependsOnSections?: string[];
  /** For attach-multi sections: which of the matched files start out selected (tested against the
   * base name). Everything matched is still listed and can be ticked on by hand; omit to start
   * with every match selected. */
  preselectPattern?: RegExp;
  /** For attach-multi sections: when any matched file's base name matches this, only those start
   * out selected -- e.g. 7B often holds both "DS-0079 ... Final.xlsx" and an un-suffixed working
   * copy of the same sheet (Job 20505), and only the "Final" one belongs in the Repair Report. */
  preferPattern?: RegExp;
  /** Print a divider page (letterhead + the section title, large and centered) ahead of this
   * section's exhibits -- APG's V&N reports open every block of appended forms with one, since
   * the forms themselves carry no report-level heading. */
  divider?: boolean;
}

export interface ReportTemplate {
  /** Also the cover page's title ("Incoming Report" / "Repair Report"). */
  reportType: string;
  sections: SectionConfig[];
}
