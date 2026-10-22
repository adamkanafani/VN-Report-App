import type { SourceMatchRule } from "../report-templates/types";
import type { JobFile } from "./fileWalk";

export interface RuleMatch {
  rule: SourceMatchRule;
  /** Candidates matching this rule, best candidate first. */
  candidates: JobFile[];
}

function matchFilenameRule(
  rule: Extract<SourceMatchRule, { kind: "filenamePattern" }>,
  files: JobFile[]
): JobFile[] {
  let candidates = files.filter((f) => rule.pattern.test(f.baseName));
  if (rule.excludePattern) {
    candidates = candidates.filter((f) => !rule.excludePattern!.test(f.baseName));
  }
  if (rule.requiredExtensions) {
    const exts = rule.requiredExtensions.map((e) => e.toLowerCase());
    candidates = candidates.filter((f) => exts.includes(f.ext));
  }
  if (rule.preferFolder) {
    const preferred = candidates.filter((f) => rule.preferFolder!.test(f.folderPath));
    if (preferred.length > 0) candidates = preferred.concat(candidates.filter((f) => !preferred.includes(f)));
  }
  // Tie-break: shortest relative path first (closer to a canonical location, less likely a
  // duplicate/copy buried in a subfolder).
  return [...candidates].sort((a, b) => a.relativePath.length - b.relativePath.length);
}

function matchFolderRule(
  rule: Extract<SourceMatchRule, { kind: "folderPattern" }>,
  files: JobFile[]
): JobFile[] {
  let candidates = files.filter((f) => rule.pattern.test(f.folderPath));
  if (rule.fileExtensions) {
    const exts = rule.fileExtensions.map((e) => e.toLowerCase());
    candidates = candidates.filter((f) => exts.includes(f.ext));
  }
  return candidates;
}

/** Try a section's sourceRules in order; returns the first rule that has at least one
 * candidate. Callers may still reject a candidate after inspecting its content (e.g. a blank
 * template) and re-call with the remaining rules. */
export function findCandidates(rules: SourceMatchRule[], files: JobFile[]): RuleMatch[] {
  const matches: RuleMatch[] = [];
  for (const rule of rules) {
    if (rule.kind === "jobMetadata") continue;
    const candidates = rule.kind === "filenamePattern" ? matchFilenameRule(rule, files) : matchFolderRule(rule, files);
    if (candidates.length > 0) matches.push({ rule, candidates });
  }
  return matches;
}
