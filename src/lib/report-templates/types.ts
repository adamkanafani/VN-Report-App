// Shared types for report template configs (I&A Report, Final Report, ...).
// A report template is a data-driven list of sections; nothing about a specific
// report type should be hardcoded outside of a `*-report.ts` config module.

export type GenerationStrategy =
  | "template" // filled from job metadata fields, no LLM
  | "table-from-source" // deterministic table parsed from a source file, pass/fail computed in code
  | "llm-narrative" // Claude text call over extracted structured data
  | "llm-vision-select" // Claude vision call over candidate images
  | "attach-as-is"; // no generation, just slot the matched file(s) in

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
  /** For llm-narrative sections synthesized from other sections' drafts rather than raw files
   * (e.g. the I&A Summary, or the Dimensional Inspection Summary's conclusion paragraph). */
  dependsOnSections?: string[];
}

export interface ReportTemplate {
  reportType: string;
  sections: SectionConfig[];
}
