import { getAnthropicClient, NARRATIVE_MODEL } from "../anthropic/client";
import type { JobMetadata } from "../ingest/jobMetadata";
import type { ParsedTable } from "../ingest/parsers/types";
import type { ParsedRouter } from "../ingest/parsers/router";
import { fpiZonesFor } from "./fpiZones";

const SYSTEM_PROMPT = `You are drafting a section of an internal turbine-component inspection report ("I&A Report") for Allied Power Group, a turbine parts repair company. The audience is the customer receiving their equipment back and the internal reviewer who will edit this draft before it ships.

Style: concise, factual, engineering register. Short declarative sentences driven by counts and measurements (e.g. "Twenty-four (24) of ninety-two (92) buckets exhibit a linear indication on the platform."). No marketing language, no filler, no apologies, no meta-commentary about being an AI. Do not invent specific findings, counts, or defect locations that are not present in the data you were given — if the data doesn't support a claim, state what is and isn't known instead of guessing.

Format: match APG's usual report layout, which is short named categories with bullets underneath, not one flowing block of prose. Use this exact plain-text markup, one item per line:
- A short line ending in ":" (e.g. "Tips:", "Squealer Tip Thickness (E):") is an underlined subheading. Use one whenever the source material below groups into named categories.
- A line starting with "- " is a bullet under the subheading (or paragraph) immediately above it.
- A blank line separates one subheading+bullets (or paragraph) group from the next — don't add any other markup for spacing.
- A line starting with "NOTE:" is rendered bold and used only for the exact disclaimer text you're handed verbatim — never invent a new NOTE.
- Anything else is a plain paragraph line (one line in, one paragraph out — don't manually wrap long sentences).`;

/** Fixed lines that belong in every report of their kind regardless of job specifics — pulled
 * verbatim from a real completed report (Job #20443, the same job this template was
 * reverse-engineered from). Handed to the model as required quoted text rather than left to its
 * own phrasing, since boilerplate by definition shouldn't vary draft to draft. */
const STANDARD_PROCESS_LINES = {
  sealStripRootGalling: "Bucket aluminium seal strip and root galling was removed by mechanical methods.",
  airfoilCleaning:
    "Bucket airfoils were cleaned to remove environmental build-up by grit blast, bond coat by chemical stripping methods and heat tinted. Bucket residual coatings were removed by mechanical methods, as required.",
  dimensionalNote:
    "NOTE: APG will provide best effort to clear all indications within acceptable criteria. There is still the possibility of additional un-repairable components as repairs continue, and further investigation of the distress is determined according to APG.",
};

interface DraftContext {
  metadata: JobMetadata;
  instruction?: string;
  previousDraft?: string;
}

function withInstructionSuffix(prompt: string, ctx: DraftContext): string {
  if (!ctx.instruction) return prompt;
  if (ctx.previousDraft) {
    return `${prompt}\n\nA previous draft of this section was:\n"""\n${ctx.previousDraft}\n"""\n\nRevise it per this instruction from the reviewer: "${ctx.instruction}"`;
  }
  // No previous draft (e.g. automatic drafting couldn't produce one and the reviewer is asking
  // for a fresh attempt) — fold the instruction into the from-scratch prompt instead of silently
  // dropping it.
  return `${prompt}\n\nAdditional instruction from the reviewer: "${ctx.instruction}"`;
}

function activeOpSummary(router: ParsedRouter): string {
  const active = router.operations.filter((o) => o.active);
  return active.map((o) => `- [${o.sequence}] ${o.label}${o.note ? `: ${o.note}` : ""}`).join("\n");
}

function tableSummary(table: ParsedTable): string {
  const lines = [
    `Source: ${table.sourceFile} (sheet "${table.sheetName}")`,
    `Sample size: ${table.sampleSize}${table.populationSize ? ` of ${table.populationSize}` : ""}`,
    `Out-of-spec count: ${table.outOfSpecCount ?? "not computed"}`,
    ...table.notes.map((n) => `Note: ${n}`),
  ];
  return lines.join("\n");
}

/** The height-dim form (DS-0004) bundles several distinct dimensional categories — TE/LE angel
 * wing heights, tip heights, squealer tip thickness — into one table with a column per
 * measurement position. APG's real report breaks each of those out as its own named category
 * with its own count, not one combined table-level count. Column names always come out of the
 * parser as "<Letter> - <label> (<position>)" (e.g. "D - Tip Height (TE)"), so the per-category
 * grouping and its out-of-spec count are derived here in code — a mechanical count, not something
 * to hand an LLM and hope it adds up correctly. */
function heightCategoryBreakdown(table: ParsedTable): Array<{ letter: string; label: string; failCount: number; sampleSize: number }> {
  const groups = new Map<string, { label: string; columns: string[] }>();
  for (const column of table.columns) {
    const match = column.match(/^([A-Z])\s*-\s*(.+?)\s*\([^)]*\)$/);
    if (!match) continue; // e.g. "APG #" — not a lettered dimensional category
    const [, letter, label] = match;
    const group = groups.get(letter) ?? { label, columns: [] };
    group.columns.push(column);
    groups.set(letter, group);
  }
  return [...groups.entries()]
    .map(([letter, group]) => ({
      letter,
      label: group.label,
      sampleSize: table.rows.length,
      failCount: table.rows.filter((row) => group.columns.some((c) => (row[c] ?? "").includes("OUT OF SPEC"))).length,
    }))
    .sort((a, b) => a.letter.localeCompare(b.letter));
}

const ONES = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** Spells out 0-99 the way APG's reports do ("Twenty-four (24)"); falls back to the plain digit
 * for anything larger rather than guessing at "one hundred and..." conventions. */
function numberWords(n: number): string {
  if (n < 20) return ONES[n];
  if (n < 100) {
    const tens = Math.floor(n / 10);
    const ones = n % 10;
    return ones === 0 ? TENS[tens] : `${TENS[tens]}-${ONES[ones]}`;
  }
  return String(n);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** One category's pass/fail bullet, in APG's usual phrasing — used for the dovetail and wall-
 * thickness categories, which (unlike the height form) are already one measurement each so don't
 * need heightCategoryBreakdown's per-column grouping. */
function categoryBullet(table: ParsedTable, failDescription: string): string {
  const fails = table.outOfSpecCount ?? 0;
  const scope = table.populationSize ? `${table.sampleSize} of ${table.populationSize} buckets` : `${table.sampleSize} buckets`;
  const base =
    fails === 0
      ? `Inspected buckets (${scope}) are within APG criteria.`
      : `${capitalize(numberWords(fails))} (${fails}) of the ${table.sampleSize} inspected buckets ${failDescription}.`;
  return table.notes.length ? `${base} ${table.notes.join(" ")}` : base;
}

/** A dimensional category's source, for the narrative builders below. `table` is the parsed data
 * (for computing real pass/fail counts); `hasPdf` is true when a completed, print-ready PDF of
 * this exact form exists and will be embedded in the generated report regardless of whether the
 * data spreadsheet itself parsed (confirmed on a real job: Height Dim Form and Wall Thickness can
 * both come back "ready" off their print-ready PDF alone, with no readable spreadsheet at all --
 * treating that as "not yet available" here would flatly contradict what the report actually
 * contains). A category is available (not "missing") if EITHER is present. */
export interface DimCategoryInput {
  table?: ParsedTable;
  hasPdf?: boolean;
}

/**
 * Builds the Dimensional Inspection Summary directly from the parsed tables — no LLM call at
 * all. Unlike the other narrative sections, this one is pure counting and fixed phrasing (the
 * same "Inspected buckets are within APG criteria" / "<N> of the inspected buckets..." template
 * every time), so there's no real writing task an AI would help with, and no reason a missing API
 * key should keep this section from drafting. Runs on whatever categories are actually available
 * — including just one of them — and says plainly which ones are still missing rather than
 * pretending the section is complete. The overall repairability call is deliberately left to the
 * reviewing tech rep rather than asserted here, since that's a judgment call this function has no
 * basis to make.
 */
export function buildDimensionalSummaryDraft(inputs: {
  heightDimForm?: DimCategoryInput;
  dovetailDimension?: DimCategoryInput;
  zDropDimension?: DimCategoryInput;
  wallThickness?: DimCategoryInput;
}): string {
  const lines: string[] = [];
  const missing: string[] = [];
  const flagged: string[] = [];
  let categoryCount = 0;
  // Categories reviewed only via their print-ready PDF, with no readable spreadsheet to compute
  // pass/fail from -- kept out of categoryCount/flagged and the "within APG criteria" roll-up
  // below, same reasoning as Z-Notch Drop just below: folding a category with no computed
  // pass/fail into an aggregate "all within criteria" claim would assert something this app never
  // actually checked, just because it happened not to fail (it was never tested either way).
  const reviewedOnly: string[] = [];

  // The 2nd/3rd-stage height-form strategy (see heightDimForm.ts's parseHeightDimFormAlt)
  // deliberately never computes pass/fail, and its table's outOfSpecCount stays undefined the
  // same way every other "not computed" table in this app does -- checked here so its real
  // measurements don't get run through heightCategoryBreakdown, which would otherwise read "no
  // cell says OUT OF SPEC" as "zero failures" and silently claim a pass/fail verdict this app
  // never actually made.
  if (inputs.heightDimForm?.table && inputs.heightDimForm.table.outOfSpecCount !== undefined) {
    for (const cat of heightCategoryBreakdown(inputs.heightDimForm.table)) {
      categoryCount++;
      const label = `${cat.label} (${cat.letter})`;
      lines.push(`${label}:`);
      if (cat.failCount === 0) {
        lines.push("- Inspected buckets are within APG criteria.");
      } else {
        lines.push(`- ${capitalize(numberWords(cat.failCount))} (${cat.failCount}) of the ${cat.sampleSize} inspected buckets have at least one reading outside APG criteria.`);
        flagged.push(label);
      }
      lines.push("");
    }
  } else if (inputs.heightDimForm?.table) {
    reviewedOnly.push("Heights");
    lines.push("Heights:");
    lines.push(
      `- ${inputs.heightDimForm.table.sampleSize} bucket(s) measured — see the Height Dim Form section and review against its printed nominal values directly (this form mixes more than one tolerance convention, so pass/fail isn't computed automatically).`
    );
    lines.push("");
  } else if (inputs.heightDimForm?.hasPdf) {
    reviewedOnly.push("Heights");
    lines.push("Heights:");
    lines.push("- Reviewed via the completed form (see Height Dim Form section) — its data spreadsheet wasn't in a format this app could read automatically.");
    lines.push("");
  } else {
    missing.push("Height Dim Form (TE/LE Angel Wing Height, Tip Height, Squealer Tip Thickness)");
  }

  if (inputs.dovetailDimension?.table) {
    categoryCount++;
    lines.push("Root Serrations Dims:");
    lines.push(`- ${categoryBullet(inputs.dovetailDimension.table, "have at least one reading outside APG criteria")}`);
    if ((inputs.dovetailDimension.table.outOfSpecCount ?? 0) > 0) flagged.push("Root Serrations Dims");
    lines.push("");
  } else if (inputs.dovetailDimension?.hasPdf) {
    reviewedOnly.push("Root Serrations Dims");
    lines.push("Root Serrations Dims:");
    lines.push("- Reviewed via the completed form (see Dovetail Dimension Inspection section) — its data spreadsheet wasn't in a format this app could read automatically.");
    lines.push("");
  } else {
    missing.push("Dovetail Dimension Inspection");
  }

  if (inputs.wallThickness?.table) {
    categoryCount++;
    lines.push("UT Wall Thickness:");
    lines.push(`- ${categoryBullet(inputs.wallThickness.table, "are below the printed minimum wall-thickness limit")}`);
    if ((inputs.wallThickness.table.outOfSpecCount ?? 0) > 0) flagged.push("UT Wall Thickness");
    lines.push("");
  } else if (inputs.wallThickness?.hasPdf) {
    reviewedOnly.push("UT Wall Thickness");
    lines.push("UT Wall Thickness:");
    lines.push("- Reviewed via the completed form (see Wall Thickness section) — its data spreadsheet wasn't in a format this app could read automatically.");
    lines.push("");
  } else {
    missing.push("Wall Thickness (UT)");
  }

  // 2nd/3rd stage buckets only -- absent (not "missing") for a 1st-stage job, so this doesn't
  // add itself to `missing` the way the three sections above do when their form isn't found.
  // Deliberately kept out of `categoryCount`/`flagged` and the "within APG criteria" roll-up
  // below, too: unlike those three, this section doesn't compute pass/fail at all (see
  // zDropDimension.ts's own comment on why), so folding it into an aggregate pass/fail claim
  // would assert something this app never actually checked.
  if (inputs.zDropDimension?.table) {
    lines.push("Z-Notch Drop:");
    lines.push(
      `- ${inputs.zDropDimension.table.sampleSize} bucket(s) measured — see the Z-Drop Dimensions section and review against its printed target directly.`
    );
    lines.push("");
  } else if (inputs.zDropDimension?.hasPdf) {
    lines.push("Z-Notch Drop:");
    lines.push("- Reviewed via the completed form (see Z-Drop Dimensions section) — its data spreadsheet wasn't in a format this app could read automatically.");
    lines.push("");
  }

  if (missing.length > 0) {
    lines.push(`Not yet available for this job: ${missing.join(", ")}. Add the source file(s) and rescan to complete this section.`);
    lines.push("");
  }

  if (categoryCount > 0) {
    lines.push(
      flagged.length === 0
        ? `All ${categoryCount} dimensional categor${categoryCount === 1 ? "y" : "ies"} with a computed pass/fail ${categoryCount === 1 ? "is" : "are"} within APG criteria.`
        : `${flagged.length} of ${categoryCount} dimensional categories with a computed pass/fail show at least one reading outside APG criteria: ${flagged.join(", ")}. Overall repairability to be confirmed by the reviewing tech rep.`
    );
  }
  if (reviewedOnly.length > 0) {
    lines.push(
      `${reviewedOnly.join(", ")} ${
        reviewedOnly.length === 1 ? "was" : "were"
      } reviewed without an automatic pass/fail count (either no readable spreadsheet was found, or the form itself mixes more than one tolerance convention) — confirm directly against the completed form(s).`
    );
  }
  lines.push("");
  lines.push(STANDARD_PROCESS_LINES.dimensionalNote);

  return lines.join("\n");
}

/** Pulls work-instruction numbers ("WI-306", "WI 309", ...) out of router note text, deduped and
 * normalized to "WI-###". Mechanical extraction, not a hardcoded pair — a different job's router
 * can reference different procedure numbers (or three of them, or none) and this still works. */
function extractProcedureNumbers(text: string): string[] {
  const matches = text.match(/\bWI[- ]?\d+\b/gi) ?? [];
  const normalized = matches.map((m) => m.toUpperCase().replace(/\s+/, "-").replace(/^WI(\d)/, "WI-$1"));
  return [...new Set(normalized)];
}

/** Pulls the crack-map form number ("3097-INSP-GE-7-1SB") out of router note text, e.g. from
 * "...using Crack Maps on form 3097-INSP-GE-7-1SB". Falls back to no form number (the sentence
 * just omits it) rather than guessing — this format string appears to vary by turbine model. */
function extractFormNumber(text: string): string | null {
  const match = text.match(/\bform\s+([A-Za-z0-9-]+)\b/i);
  return match ? match[1] : null;
}

function listJoin(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/** Spells the bucket quantity out APG-style ("ninety-two (92)") when it parses as a plain count;
 * otherwise falls back to whatever string is on file rather than fabricating a number. */
function quantityPhrase(qty: string | undefined): string {
  const n = Number(qty);
  if (qty && Number.isFinite(n) && n >= 0) return `${numberWords(n)} (${n})`;
  return qty ?? "an unspecified quantity of";
}

/**
 * Builds the FPI & Visual Inspection Summary directly from the router data — no LLM call. Like
 * the Dimensional Summary, the scope bullets (bucket count from job metadata, procedure/form
 * numbers pulled straight out of the router's own note text) are fully determined by data already
 * on hand. What follows depends on whether this job's turbine model + stage/row is one of the
 * known configurations (see fpiZones.ts, built from a tech rep's own list of the real zone names
 * per model/stage): when it is, each zone gets its own subheading with a bracketed prompt ready
 * for the tech rep to fill in -- the same scaffold structure APG's real reports actually use, just
 * without fabricated finding text (that detail only exists on the hand-marked Crack Map, which no
 * amount of code or AI can read on its own). When the model/stage can't be determined, this falls
 * back to a single generic "Findings:" pointer at the Crack Map instead of guessing at zones that
 * might not even apply to this part.
 *
 * `router` is optional: some jobs genuinely have no "IA Router" file on hand (renamed, not yet
 * uploaded, one-off job structure). Rather than leaving the section fully blank in that case, this
 * still drafts the scope/zone skeleton from job metadata alone -- just without the procedure/form-
 * number clause, which only the router's note text can supply. A tech rep reviewing a real draft
 * with an honest gap is a better starting point than an empty textbox.
 */
export function buildFpiVisualDraft(router: ParsedRouter | undefined, ctx: DraftContext, crackMapAvailable: boolean): string {
  let scopeClause = "";
  let formNumber: string | null = null;
  if (router) {
    const fpiOps = router.operations.filter((o) => o.active && /NDT|FPI|penetrant/i.test(o.label));
    const combinedNotes = fpiOps.map((o) => o.note).join("\n");
    const procedureNumbers = extractProcedureNumbers(combinedNotes);
    formNumber = extractFormNumber(combinedNotes);
    scopeClause = procedureNumbers.length > 0 ? ` per APG procedure document${procedureNumbers.length > 1 ? "s" : ""} ${listJoin(procedureNumbers)}` : "";
  }

  const lines: string[] = [];
  lines.push("FPI & Visual Inspection:");
  lines.push(`- Performed on all ${quantityPhrase(ctx.metadata.quantity)} buckets${scopeClause}.`);
  lines.push("- Representative photographs were taken of typical indications.");
  if (!router) {
    lines.push("- No router file was found for this job — confirm the procedure/work-instruction number(s) used and add them here.");
  }
  lines.push("");

  const zones = fpiZonesFor(ctx.metadata.turbineModel, ctx.metadata.component, ctx.metadata.part);
  const crackMapClause = crackMapAvailable ? `the accompanying Crack Map${formNumber ? ` (Form ${formNumber})` : ""}` : "the Crack Map (no crack-map source file was found for this job)";
  if (zones) {
    for (const zone of zones) {
      lines.push(`${zone}:`);
      lines.push(`- [Findings from ${crackMapClause}, or "No significant defects noted."]`);
      lines.push("");
    }
    lines.pop(); // drop the trailing blank line left after the last zone
  } else {
    lines.push("Findings:");
    lines.push(
      crackMapAvailable
        ? `- Zone-by-zone finding detail is documented on ${crackMapClause}, attached as its own exhibit to this report.`
        : "- No crack-map source file was found for this job — zone-by-zone finding detail still needs a tech rep's written note before this section is complete."
    );
  }

  return lines.join("\n");
}

export async function draftFpiVisual(router: ParsedRouter | undefined, ctx: DraftContext, crackMapAvailable: boolean): Promise<string> {
  const fpiOps = router?.operations.filter((o) => o.active && /NDT|FPI|penetrant/i.test(o.label)) ?? [];
  const fpiOpsSummary = fpiOps.map((o) => `- [${o.sequence}] ${o.label}${o.note ? `: ${o.note}` : ""}`).join("\n");
  const zones = fpiZonesFor(ctx.metadata.turbineModel, ctx.metadata.component, ctx.metadata.part);
  const crackMapNote = crackMapAvailable ? "the accompanying Crack Map" : "the Crack Map — no crack-map source file was found for this job";
  const prompt = withInstructionSuffix(
    `Draft the "FPI & Visual Inspection Summary" section for job #${ctx.metadata.jobNumber} (${ctx.metadata.customer}, ${ctx.metadata.part}, qty ${ctx.metadata.quantity}).

${
  router
    ? `Here are the active FPI/visual-inspection router operations for this job:\n${fpiOpsSummary || "(none found)"}`
    : "No router file was found for this job, so there is no procedural router text to draw scope/procedure-number detail from — state the inspection was performed on all buckets and leave the specific procedure/work-instruction number as a bracketed placeholder for the tech rep to fill in, rather than inventing one."
}

APG's real report structures this section as one subheading per inspection zone, each with a bullet or two of that zone's findings. You do NOT have zone-level finding data here — only the procedural router text above, if any — so do not invent zone bullets with counts or defect types.

Start with one subheading "FPI & Visual Inspection:" with bullets covering what was performed (scope/procedure, drawn only from the router text above when present). ${
      zones
        ? `Then, for this specific part (${ctx.metadata.turbineModel || ctx.metadata.component || ctx.metadata.part}), add exactly one subheading per zone, in this order: ${zones.map((z) => `"${z}:"`).join(", ")}. Under each zone's subheading, add exactly one bullet reading "[Findings from ${crackMapNote}, or \\"No significant defects noted.\\"]" verbatim — a placeholder for the tech rep to replace, not a real finding.`
        : `Then add one subheading "Findings:" with one bullet stating that zone-by-zone finding detail is documented on ${crackMapNote}, attached as its own exhibit to this report.`
    }`,
    ctx
  );
  return callClaude(prompt);
}

/** Router rows that are internal process/QA checkpoints, not a physical repair action worth
 * telling the customer about — recurring administrative labels observed in APG's own router
 * template (paperwork sign-offs, raw material/consumable spec lines, "do not" shop cautions). A
 * different job's router could use different wording for the same concepts, in which case those
 * rows would still show up in the list — a much smaller risk than a broader heuristic silently
 * dropping a real repair step it didn't recognize. */
const NON_ACTIONABLE_LABEL_PATTERNS = [/^consumables?$/i, /^component information/i, /^foreman(\s*\/\s*tech\s*rep)?\s*review$/i, /^quality review$/i, /^qc hold point$/i, /^do not /i];

function cleanOperationLabel(label: string): string {
  return label.replace(/\s*\(opt\)\s*$/i, "").trim();
}

/**
 * Builds the Recommended Repairs section directly from the repair router — no LLM call. APG's
 * real report turned out to already do this mechanically: comparing a completed report against
 * its router showed the "Engineering Recommended Repairs" list is just the router's own active
 * step labels in sequence (repeats and all — the same "FPI & Report" checkpoint really does
 * appear three separate times at different points in a real repair sequence), with only the
 * "(Opt)" suffix and a handful of internal admin checkpoints dropped. So rather than having an
 * LLM rephrase into "customer-facing language," this just reproduces that same mechanical
 * transform — arguably more faithful to the real convention than the earlier AI-paraphrased
 * version was.
 */
export function buildRecommendedRepairsDraft(router: ParsedRouter): string {
  const steps = router.operations
    .filter((o) => o.active && !NON_ACTIONABLE_LABEL_PATTERNS.some((p) => p.test(o.label.trim())))
    .map((o) => cleanOperationLabel(o.label))
    .filter((label) => label.length > 0);

  return steps.map((label, i) => `${i + 1}. ${label}`).join("\n");
}

export async function draftRecommendedRepairs(router: ParsedRouter, ctx: DraftContext): Promise<string> {
  const prompt = withInstructionSuffix(
    `Draft the "Recommended Repairs" section for job #${ctx.metadata.jobNumber} (${ctx.metadata.customer}, ${ctx.metadata.part}, qty ${ctx.metadata.quantity}).

Here is the job's active repair-router operation sequence, in order:
${activeOpSummary(router) || "(none found)"}

Present this as a clear, ordered checklist of the repair process from prep through final shipment, in plain customer-facing language (not internal work-instruction jargon). Group closely related consecutive steps where it reads more naturally, but keep the sequence order.`,
    ctx
  );
  return callClaude(prompt);
}

export async function draftDimensionalSummary(
  tables: { heightDimForm?: DimCategoryInput; dovetailDimension?: DimCategoryInput; zDropDimension?: DimCategoryInput; wallThickness?: DimCategoryInput },
  ctx: DraftContext
): Promise<string> {
  const categories: string[] = [];

  // A category available only via its print-ready PDF (see DimCategoryInput) has no parsed table
  // to summarize -- say so plainly rather than omitting it outright, so the model doesn't draft
  // this as if that inspection never happened.
  const pdfOnlyNote = (label: string) => `Category "${label}": completed via the form on file, but its data spreadsheet wasn't in a format this app could read -- no count available, mention it was reviewed without asserting a pass/fail count.`;

  // See buildDimensionalSummaryDraft's own comment: the 2nd/3rd-stage height-form strategy never
  // computes pass/fail, and leaves outOfSpecCount undefined the same way every other "not
  // computed" table in this app does -- checked here so it doesn't get read as "zero failures."
  if (tables.heightDimForm?.table && tables.heightDimForm.table.outOfSpecCount !== undefined) {
    for (const cat of heightCategoryBreakdown(tables.heightDimForm.table)) {
      categories.push(`Category "${cat.label} (${cat.letter})": ${cat.failCount} of ${cat.sampleSize} inspected buckets have at least one reading outside APG criteria.`);
    }
  } else if (tables.heightDimForm?.table) {
    categories.push(`Category "Heights":\n${tableSummary(tables.heightDimForm.table)}`);
  } else if (tables.heightDimForm?.hasPdf) {
    categories.push(pdfOnlyNote("Heights"));
  }
  if (tables.dovetailDimension?.table) {
    categories.push(`Category "Root Serrations Dims":\n${tableSummary(tables.dovetailDimension.table)}`);
  } else if (tables.dovetailDimension?.hasPdf) {
    categories.push(pdfOnlyNote("Root Serrations Dims"));
  }
  if (tables.zDropDimension?.table) {
    // Out-of-spec count is deliberately not computed for this one (see zDropDimension.ts) --
    // tableSummary already renders that honestly as "not computed" rather than a fabricated 0.
    categories.push(`Category "Z-Notch Drop" (2nd/3rd stage buckets only):\n${tableSummary(tables.zDropDimension.table)}`);
  } else if (tables.zDropDimension?.hasPdf) {
    categories.push(pdfOnlyNote("Z-Notch Drop"));
  }
  if (tables.wallThickness?.table) {
    categories.push(`Category "UT Wall Thickness":\n${tableSummary(tables.wallThickness.table)}`);
  } else if (tables.wallThickness?.hasPdf) {
    categories.push(pdfOnlyNote("UT Wall Thickness"));
  }

  const prompt = withInstructionSuffix(
    `Draft the "Dimensional Inspection Summary" section for job #${ctx.metadata.jobNumber} (${ctx.metadata.customer}, ${ctx.metadata.part}, qty ${ctx.metadata.quantity}).

Dimensional categories inspected, with their exact counts already computed — use these counts as given, do not recompute or round them:
${categories.join("\n\n") || "(no dimensional data available)"}

APG's real report gives each category its own subheading (the category name exactly as given above, e.g. "Tip Height (D):") with one bullet stating its conclusion: "Inspected buckets are within APG criteria." when the fail count is 0, or "<N spelled out> (<N>) of the inspected buckets are outside APG criteria." otherwise (name the specific measurement if the category label makes it obvious, e.g. tip height being low or squealer tip thickness being below the printed minimum). If a category's data notes it only sampled part of the population, say so in that category's bullet rather than implying full coverage.

After all the category subheadings, add one closing paragraph stating the overall repairability conclusion based on the totals above (e.g. how many of the total buckets are repairable), then this exact line verbatim as its own paragraph, unmodified:
- "${STANDARD_PROCESS_LINES.dimensionalNote}"`,
    ctx
  );
  return callClaude(prompt);
}

/**
 * Builds the I&A Summary directly from job metadata and which source data is on hand — no LLM
 * call. This is the least mechanical of the four narrative sections, but the real report turned
 * out to be exactly this: the same fixed sentence skeleton every time (received → visual →
 * seal-strip/root-galling → dimensional → met-sample → airfoil-cleaning → FPI/visual), with only
 * the facts swapped in — confirmed by two supposedly-different completed jobs' report files
 * sharing near-identical wording apart from their specific facts. Optional bullets and clauses
 * (coating, prior repair, met-sample) only appear when that data is actually present, so a job
 * missing some of it still gets a correct, honest summary rather than an invented one.
 */
export function buildIaSummaryDraft(params: {
  metadata: JobMetadata;
  dimTables: { heightDimForm?: DimCategoryInput; dovetailDimension?: DimCategoryInput; zDropDimension?: DimCategoryInput; wallThickness?: DimCategoryInput };
  metSampleAvailable: boolean;
  crackMapAvailable: boolean;
}): string {
  const { metadata, dimTables, metSampleAvailable, crackMapAvailable } = params;
  const lines: string[] = [];

  // Cast/machined P/N are one closely-related pair, joined with "/"; everything else is a
  // separate descriptor, comma-joined — matches how APG's own reports read this line.
  const partNumbers = [
    metadata.castPartNumber ? `cast P/N ${metadata.castPartNumber}` : null,
    metadata.machPartNumber ? `machined P/N ${metadata.machPartNumber}` : null,
  ]
    .filter((d): d is string => !!d)
    .join(" / ");
  const descriptors = [metadata.turbineOEM, metadata.material ? `${metadata.material} material` : null, partNumbers || null].filter((d): d is string => !!d);
  const descriptorClause = descriptors.length > 0 ? ` (${descriptors.join(", ")})` : "";

  lines.push(
    `A set of ${quantityPhrase(metadata.quantity)} ${metadata.part}${descriptorClause} was received from ${metadata.customer} for an Incoming Inspect-and-Advise under APG Job #${metadata.jobNumber}.`
  );
  lines.push("");

  lines.push("Buckets were visually inspected for any distress and incoming-photographed.");
  if (metadata.material) lines.push(`- Set was found to be ${metadata.material} alloy.`);
  if (metadata.coating) lines.push(`- Set was found with ${metadata.coating} airfoil coating.`);
  if (metadata.priorRepair) lines.push(`- Set was found with previous repair marking ${metadata.priorRepair}.`);
  lines.push("");

  // A category with a parsed table gets its real sample size; one available only via its
  // print-ready PDF (see DimCategoryInput) still gets listed as inspected -- it's genuinely in
  // the report, this app just can't read a bucket count off it -- just without a count attached.
  const dimBullet = (label: string, input?: DimCategoryInput): string | null => {
    if (input?.table) return `- ${label} (${input.table.sampleSize} Buckets)`;
    if (input?.hasPdf) return `- ${label}`;
    return null;
  };
  lines.push(`${STANDARD_PROCESS_LINES.sealStripRootGalling} Buckets were then dimensional inspected.`);
  [
    dimBullet("Heights", dimTables.heightDimForm),
    dimBullet("Root Dovetail", dimTables.dovetailDimension),
    dimBullet("Z-Notch Drop", dimTables.zDropDimension),
    dimBullet("UT Wall Thickness", dimTables.wallThickness),
  ]
    .filter((b): b is string => b !== null)
    .forEach((b) => lines.push(b));
  lines.push("");

  if (metSampleAvailable) {
    lines.push("A metallurgical sample was removed from the set and evaluated; results are documented in the attached Metallurgical Report.");
    lines.push("");
  }

  lines.push(STANDARD_PROCESS_LINES.airfoilCleaning);
  lines.push("");

  lines.push(`Buckets were then FPI/Visual inspected${crackMapAvailable ? ", defects mapped per the accompanying Crack Map," : ""} and wall thickness inspected.`);

  return lines.join("\n");
}

export async function draftIaSummary(sectionDrafts: Record<string, string>, ctx: DraftContext): Promise<string> {
  const combined = Object.entries(sectionDrafts)
    .map(([id, text]) => `--- ${id} ---\n${text}`)
    .join("\n\n");
  const prompt = withInstructionSuffix(
    `Draft the "I&A Summary" section — a short narrative synthesis that opens the report — for job #${ctx.metadata.jobNumber} (${ctx.metadata.customer}, ${ctx.metadata.part}, qty ${ctx.metadata.quantity}).

The following sections have already been drafted elsewhere in the report; synthesize an overview from them rather than repeating their detail verbatim (their own subheadings/bullets are just context for you — don't copy that structure through here):
${combined}

Cover: what was received and inspected, the overall condition/findings at a high level, and whether the set is repairable. Do not introduce any facts not present in the sections above.

Unlike the other sections, APG's real I&A Summary does NOT use subheadings — it's a short sequence of plain paragraph sentences, several of which are followed immediately (no blank line, no subheading) by a couple of one-line bullets naming what that sentence covered. For example a sentence on visual inspection is followed by bullets on what the set was found to be (alloy, coating, prior repair — only ones you actually have data for); a sentence on dimensional inspection is followed by bullets just naming which checks were performed (not their results, which belong in the Dimensional Inspection Summary section already drafted above). Follow that same shape: short paragraph, then a tight run of "- " bullets right under it where the source material naturally groups into a short list, blank line before the next paragraph.

Two process lines are standard on every job and must appear verbatim, word-for-word, worked naturally into the narrative in this order: visual-inspection findings, then the seal-strip/root-galling line, then dimensional inspection, then (if a met-sample was taken) the met-sample line, then the airfoil-cleaning line, then FPI/visual inspection. Do not paraphrase or shorten them:
- "${STANDARD_PROCESS_LINES.sealStripRootGalling}"
- "${STANDARD_PROCESS_LINES.airfoilCleaning}"`,
    ctx
  );
  return callClaude(prompt);
}

async function callClaude(userPrompt: string): Promise<string> {
  const client = getAnthropicClient();
  const response = await client.messages.create({
    model: NARRATIVE_MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  });
  const textBlock = response.content.find((b) => b.type === "text");
  return textBlock && textBlock.type === "text" ? textBlock.text : "";
}
