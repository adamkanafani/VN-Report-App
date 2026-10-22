import { getAnthropicClient, NARRATIVE_MODEL } from "../anthropic/client";
import type { JobMetadata } from "../ingest/jobMetadata";
import type { ParsedRouter, RouterFormRef } from "../ingest/parsers/router";

const SYSTEM_PROMPT = `You are revising a section of an Allied Power Group (APG) Vanes & Nozzles service report -- an "Incoming Report" (Inspect & Advise) or "Repair Report" for gas turbine stationary nozzles / vanes. The audience is the customer receiving their parts back and the internal reviewer who will edit this draft before it ships.

Style: concise, factual, engineering register. Short declarative sentences driven by counts and measurements (e.g. "Nineteen (19) joint gaps are out of tolerance."). No marketing language, no filler, no meta-commentary about being an AI. Never invent findings, counts, measurements or defect locations that are not in the text you were given -- keep any bracketed "[...]" placeholders the reviewer hasn't filled in yet exactly as they are.

Format: plain text, one item per line:
- A short line ending in ":" (e.g. "Penetrant / Visual Inspection:") is an underlined subheading.
- A line starting with "- " is a bullet under the subheading or paragraph above it.
- A blank line separates groups.
- A line starting with "NOTE:" is rendered bold.
- Anything else is a plain paragraph.
Return only the revised section text.`;

interface DraftContext {
  metadata: JobMetadata;
}

const ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function numberWords(n: number): string {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : "");
  return String(n);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function listJoin(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/** What kind of V&N part this job is, from its part description / model -- drives the nouns in the
 * drafts and which part-specific subsections (retaining ring, packings) get scaffolded. */
export function classifyPart(metadata: JobMetadata): { isVane: boolean; stage: number | null; isGe: boolean } {
  const text = `${metadata.part} ${metadata.component} ${metadata.turbineModel}`;
  const isVane = /vane/i.test(text);
  const m = text.match(/\b(1st|first|row\s*1|s1n|n1)\b|\b(2nd|second|row\s*2|s2n|n2)\b|\b(3rd|third|row\s*3|s3n|n3)\b|\b(4th|fourth|row\s*4)\b/i);
  const stage = m ? [1, 2, 3, 4].find((_, i) => m[i + 1]) ?? null : null;
  return { isVane, stage, isGe: metadata.turbineOEM === "GE" };
}

/** "a F7EA 1st stage nozzle" / "sixteen (16) F7EA 2nd stage nozzle segments" / "fourteen (14)
 * W501D5 row 3 vanes" -- quantity spelled out APG-style when it parses as a plain count. */
function receivedPhrase(metadata: JobMetadata): { subject: string; plural: boolean; noun: string } {
  const { isVane } = classifyPart(metadata);
  const qty = Number(metadata.quantity);
  const knownQty = metadata.quantity !== "" && Number.isFinite(qty) && qty > 0;
  const component = (metadata.component || metadata.part).toLowerCase();
  const model = metadata.turbineModel && !component.toUpperCase().includes(metadata.turbineModel) ? `${metadata.turbineModel} ` : "";
  if (isVane) {
    const subject = knownQty ? `${numberWords(qty)} (${qty}) ${model}${component}` : `a set of ${model}${component}`;
    return { subject, plural: !knownQty || qty !== 1, noun: "vanes" };
  }
  const singular = component.replace(/nozzles?\b/, "nozzle");
  if (!knownQty || qty === 1) return { subject: `a ${model}${singular}`, plural: false, noun: "nozzle" };
  return { subject: `${numberWords(qty)} (${qty}) ${model}${singular} segments`, plural: true, noun: "segments" };
}

/** Which inspections the I&A router actually has in scope, phrased for the opening paragraph. */
function inspectionsPerformed(router: ParsedRouter | undefined, dimForms: RouterFormRef[]): string[] {
  if (!router) return ["visual, penetrant and dimensional inspection"];
  const active = router.operations.filter((o) => o.active);
  const has = (p: RegExp) => active.some((o) => p.test(`${o.label} ${o.note}`));
  const optionSelected = (p: RegExp) => router.pricing.selectedOptions.some((o) => p.test(o));
  const out: string[] = [];
  if (dimForms.length > 0 || has(/dimension/i)) out.push("dimensional inspection");
  if (has(/\bndt\b|vpi|fpi|red\s*dye|penetrant/i)) out.push("penetrant/visual inspection");
  if (has(/\but\b|wall\s*thickness/i) || optionSelected(/wall\s*thickness|\but\b/i)) out.push("UT wall thickness inspection");
  if (has(/air\s*flow/i)) out.push("airflow testing");
  if (has(/met(allurgical)?\.?\s*(sample|analysis)/i)) out.push("metallurgical sampling");
  if (has(/pre-?\s*weld\s*heat\s*treat/i)) out.push("a pre-weld heat treatment");
  return out.length > 0 ? out : ["visual, penetrant and dimensional inspection"];
}

const AREA_FORMS = new Set(["DS-0045", "DS-0337", "DS-0346", "DS-0388", "DS-0945"]);
const NOT_DIMENSIONAL_FORM = /serial|crack\s*map|sign\s*off|ndt|inspection\s*sheet|checklist|consumable/i;

/**
 * Builds the Incoming Engineering Summary -- no LLM call. APG's real reports (Jobs 20312, 19512)
 * open with one paragraph ("A F7EA S1 nozzle was received ... for an incoming inspection. The
 * nozzle was subject to ... The results of the inspection are as follows:") and then named
 * subsections. The opening paragraph and the list of dimensional forms are fully determined by the
 * job metadata and the I&A router; the findings themselves live on the hand-marked NDT reports /
 * crack maps and the completed DS sheets, so each finding bullet is a bracketed prompt for the tech
 * rep to replace rather than anything invented here.
 */
export function buildEngineeringSummaryDraft(params: {
  metadata: JobMetadata;
  router?: ParsedRouter;
  /** DS sheet file names found in 7A, used only when there's no router to list the forms. */
  dimFileNames: string[];
  crackMapAvailable: boolean;
  metSampleAvailable: boolean;
}): string {
  const { metadata, router, dimFileNames, crackMapAvailable, metSampleAvailable } = params;
  const { isVane, stage, isGe } = classifyPart(metadata);
  const { subject, plural, noun } = receivedPhrase(metadata);

  const dimForms = (router?.formRefs ?? []).filter((f) => f.active && !NOT_DIMENSIONAL_FORM.test(f.title) && f.form !== "DS-0404");
  const lines: string[] = [];

  const from = metadata.customer ? ` from ${metadata.customer}` : "";
  lines.push(
    `${capitalize(subject)} ${plural ? "were" : "was"} received${from} for an incoming inspection under APG Job #${metadata.jobNumber}. The ${noun} ${plural ? "were" : "was"} subject to ${listJoin(inspectionsPerformed(router, dimForms))}. The results of the inspection are as follows:`
  );
  lines.push("");

  lines.push("Penetrant / Visual Inspection:");
  lines.push(`- [Findings — see the attached Incoming NDT Reports${crackMapAvailable ? " and crack map" : ""}.]`);
  lines.push("");

  if (!isVane && isGe && stage === 1) {
    lines.push("Retaining Ring Inspection:");
    lines.push("- [Findings, or \"No significant defects noted.\"]");
    lines.push("");
  }
  if (!isVane && isGe && (stage === 2 || stage === 3)) {
    lines.push("Packing Inspection:");
    lines.push("- [Findings, or \"No significant defects noted.\"]");
    lines.push("");
  }

  lines.push("Hardware:");
  lines.push(`- [Condition of ${isVane ? "cores & covers / seals" : "cores & covers, flat seals"} and other hardware.]`);
  lines.push("");

  lines.push("Dimensional Inspection:");
  if (!isVane && dimForms.some((f) => AREA_FORMS.has(f.form) || /area/i.test(f.title))) {
    lines.push("- Total nozzle area deviation is [+x.xx%], with individual throat deviations ranging from [-x.xx%] to [+x.xx%] (design requirement [-0.5% to +2.5%]).");
  }
  const otherDims = dimForms.filter((f) => !(AREA_FORMS.has(f.form) || /area/i.test(f.title)));
  if (otherDims.length > 0) {
    for (const f of otherDims) lines.push(`- ${f.title || f.form} (${f.form}): [result, e.g. "within tolerance" or "N of M out of tolerance"]`);
  } else if (dimForms.length === 0 && dimFileNames.length > 0) {
    for (const name of dimFileNames) lines.push(`- ${name}: [result]`);
  } else if (dimForms.length === 0) {
    lines.push("- [No dimensional data sheets were found for this job — summarize the dimensional results here.]");
  }
  lines.push("");

  if (metSampleAvailable) {
    lines.push("Metallurgical Sample:");
    lines.push("- A metallurgical sample was removed and evaluated; results are documented in the attached Metallurgical Sample Analysis. [Summarize the lab's conclusion.]");
    lines.push("");
  }

  lines.push("Parts Recommended for Replacement:");
  lines.push('- [List parts, or "None at this time."]');

  return lines.join("\n");
}

/** Router rows that are internal process/QA checkpoints rather than a repair worth telling the
 * customer about (paperwork sign-offs, consumables, hold points, "do not" cautions). */
const NON_ACTIONABLE_LABEL_PATTERNS = [
  /^consumables?$/i,
  /^component information/i,
  /^foreman(\s*\/\s*tech\s*rep)?\s*review/i,
  /^tech\s*rep\s*review/i,
  /^quality review$/i,
  /^qc review/i,
  /^qc hold point$/i,
  /^hold point/i,
  /^verify previous/i,
  /^do not /i,
];

function cleanOperationLabel(label: string): string {
  return label.replace(/\s*\(opt\)\s*$/i, "").replace(/\s+/g, " ").trim();
}

function repairSteps(router: ParsedRouter, block?: string): string[] {
  return router.operations
    .filter((o) => block === undefined || o.block === block)
    // Material lines (type "M": weld wire, braze powder, helicoils, ...) are on the router so
    // they get costed, not because they're a repair step.
    .filter((o) => o.active && o.opType !== "M" && !NON_ACTIONABLE_LABEL_PATTERNS.some((p) => p.test(o.label.trim())))
    .map((o) => cleanOperationLabel(o.label))
    .filter((label) => label.length > 0);
}

/** Subheading for one sheet of a multi-sheet ("PSM") router -- Job 20505's Repair Report groups
 * its steps as "Segment Repair:", "Packing Repair:", "Assembly Repair:". */
function blockHeading(block: string): string {
  if (/assembl|fixture|coat/i.test(block)) return "Assembly Repair:";
  if (/packing/i.test(block)) return "Packing Repair:";
  if (/ring/i.test(block)) return "Retaining Ring Repair:";
  if (/nozzle|segment/i.test(block)) return "Segment Repair:";
  if (/vane/i.test(block)) return "Vane Repair:";
  return `${block.replace(/\b([a-z])/g, (m) => m.toUpperCase())}:`;
}

/** The lead-in line, then the steps -- grouped under a subheading per router sheet when the
 * router has more than one (a block with nothing in scope is left out entirely). */
function repairList(router: ParsedRouter, leadIn: string, transform: (step: string) => string): string {
  const lines = [leadIn];
  if (router.blocks.length <= 1) {
    lines.push(...repairSteps(router).map((s) => `- ${transform(s)}`));
    return lines.join("\n");
  }
  for (const block of router.blocks) {
    const steps = repairSteps(router, block);
    if (steps.length === 0) continue;
    lines.push("", blockHeading(block), ...steps.map((s) => `- ${transform(s)}`));
  }
  return lines.join("\n");
}

/** Repair Recommendations -- "APG recommends the following repairs:" followed by the repair
 * router's own active op labels in sequence, the same mechanical transform the bucket line's
 * reports turned out to use. */
export function buildRepairRecommendationsDraft(router: ParsedRouter): string {
  return repairList(router, "APG recommends the following repairs:", (s) => s);
}

// Imperative router verbs → past tense for the Repair Summary ("Blast clean components" → "Blasted
// clean components"). Anything not listed is left as written for the tech rep to adjust.
const PAST_TENSE: Record<string, string> = {
  apply: "Applied", assemble: "Assembled", blast: "Blasted", blend: "Blended", bolt: "Bolted", box: "Boxed",
  braze: "Brazed", check: "Checked", clean: "Cleaned", coat: "Coated", disassemble: "Disassembled",
  grind: "Ground", inspect: "Inspected", install: "Installed", machine: "Machined", measure: "Measured",
  perform: "Performed", polish: "Polished", record: "Recorded", remove: "Removed", repair: "Repaired",
  replace: "Replaced", restore: "Restored", reweld: "Re-welded", "re-weld": "Re-welded", send: "Sent",
  ship: "Shipped", straighten: "Straightened", strip: "Stripped", tack: "Tacked", weld: "Welded", witness: "Witnessed",
};

function toPastTense(step: string): string {
  // Two-word verbs first ("Heat treat segments", "Heat tint segments", "Grit blast ...").
  const twoWord = step.match(/^(heat\s+treat|heat\s+tint|grit\s+blast|wire\s+check|weld\s+repair)\b(.*)$/i);
  if (twoWord) {
    const verb = twoWord[1].toLowerCase().replace(/\s+/, " ");
    const past = { "heat treat": "Heat treated", "heat tint": "Heat tinted", "grit blast": "Grit blasted", "wire check": "Wire checked", "weld repair": "Weld repaired" }[verb];
    return `${past}${twoWord[2]}`;
  }
  const [first, ...rest] = step.split(" ");
  const past = PAST_TENSE[first.toLowerCase()];
  return past ? [past, ...rest].join(" ") : step;
}

/** Repair Summary (Repair Report) -- "APG performed the following repairs:" with the same repair
 * router steps, verbs put in the past tense where they're recognizable. */
export function buildRepairSummaryDraft(router: ParsedRouter): string {
  return repairList(router, "APG performed the following repairs:", toPastTense);
}

/** "Revise with instruction" -- the one place the app calls Claude for narrative text. Works off
 * the current draft (or, when there isn't one, the deterministic draft the caller passes in), so
 * the model only ever rewords what's already there rather than writing findings from nothing. */
export async function reviseSection(params: { title: string; currentDraft: string; instruction: string; ctx: DraftContext }): Promise<string> {
  const { title, currentDraft, instruction, ctx } = params;
  const m = ctx.metadata;
  const prompt = `Section: "${title}" for APG Job #${m.jobNumber} (${m.customer}, ${m.turbineModel} ${m.part}, qty ${m.quantity || "unknown"}).

Current draft:
"""
${currentDraft || "(empty)"}
"""

Revise it per this instruction from the reviewer: "${instruction}"`;
  const client = getAnthropicClient();
  const response = await client.messages.create({
    model: NARRATIVE_MODEL,
    max_tokens: 1500,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: prompt }],
  });
  const textBlock = response.content.find((b) => b.type === "text");
  return textBlock && textBlock.type === "text" ? textBlock.text : "";
}
