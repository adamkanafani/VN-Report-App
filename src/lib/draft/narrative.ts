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
- Inside a line, **text** is bold, __text__ is underlined and //text// is italic -- the reviewer's own
  formatting. Keep every one of these markers around the same words unless told to change them.
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
  // Lower case except tokens with digits ("CM2", "S1N") -- "W501F CM2 row 1 compressor diaphragm".
  const component = (metadata.component || metadata.part)
    .split(/\s+/)
    .map((w) => (/\d/.test(w) && !/^\d+(st|nd|rd|th)$/i.test(w) ? w.toUpperCase() : w.toLowerCase()))
    .join(" ");
  const model = metadata.turbineModel && !component.toUpperCase().includes(metadata.turbineModel) ? `${metadata.turbineModel} ` : "";
  if (isVane) {
    const subject = knownQty ? `${numberWords(qty)} (${qty}) ${model}${component}` : `a set of ${model}${component}`;
    return { subject, plural: !knownQty || qty !== 1, noun: "vanes" };
  }
  // Anything that isn't a nozzle (a compressor diaphragm, Job 20992) is named by its own last word.
  if (!/nozzle/.test(component)) {
    const noun = component.split(" ").pop() || "part";
    return { subject: `a ${model}${component}`, plural: false, noun };
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
  measurements?: import("../ingest/measurements").JobMeasurements;
  crackMapAvailable: boolean;
  metSampleAvailable: boolean;
}): string {
  const { metadata, router, dimFileNames, crackMapAvailable, metSampleAvailable, measurements } = params;
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

  // (Not on an inner support ring job, whose part text also says "1st stage nozzle".)
  if (!isVane && isGe && stage === 1 && !/support\s*ring/i.test(metadata.part)) {
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
    const m = measurements;
    lines.push(
      `- The total nozzle area range is at ${m?.areaDeviation ?? "[+x.xx%]"} with individual throat deviations ranging from ${m?.throatMin ?? "[-x.xx%]"} to ${m?.throatMax ?? "[+x.xx%]"}`
    );
  }
  const otherDims = dimForms.filter((f) => !(AREA_FORMS.has(f.form) || /area/i.test(f.title)));
  if (otherDims.length > 0) {
    for (const f of otherDims) lines.push(`- ${f.title || f.form} (${f.form}): [result, e.g. "within tolerance" or "N of M out of tolerance"]`);
  } else if (dimForms.length === 0 && dimFileNames.length > 0) {
    for (const name of dimFileNames) lines.push(`- ${name}: [result]`);
  } else if (dimForms.length === 0) {
    lines.push("- [No dimensional data sheets were found for this job — summarize the dimensional results here.]");
  }
  for (const [side, range] of Object.entries(measurements?.flowRanges ?? {})) lines.push(`- Incoming flow range on the ${side} side is at ${range}`);
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

// Present → past tense for the Repair Summary. Alfredo's Repair Summary is his I&A Repair
// Recommendations with the verbs put in the past tense, line for line (Job 20564): "Weld/Blend
// repair all marked indications" → "Weld/Blend repaired ...", "Perform an in-process assembly and
// verify dimensions" → "Performed ... and verified ...", "Weld build ..." → "Weld built ...",
// "Touch-up as needed" → "Touched-up as needed". Anything not recognized is left as written.
const PAST_TENSE: Record<string, string> = {
  adjust: "adjusted", apply: "applied", assemble: "assembled", blast: "blasted", blend: "blended", bolt: "bolted",
  box: "boxed", braze: "brazed", build: "built", check: "checked", clean: "cleaned", clear: "cleared", coat: "coated",
  correct: "corrected", cut: "cut", deburr: "deburred", disassemble: "disassembled", drill: "drilled",
  ensure: "ensured", fit: "fit", grind: "ground", inspect: "inspected", install: "installed", jack: "jacked",
  machine: "machined", make: "made", mark: "marked", mask: "masked", measure: "measured", perform: "performed",
  polish: "polished", receive: "received", record: "recorded", remove: "removed", repair: "repaired",
  replace: "replaced", restore: "restored", review: "reviewed", reweld: "re-welded", run: "ran", send: "sent",
  ship: "shipped", straighten: "straightened", strip: "stripped", tack: "tacked", touch: "touched", verify: "verified",
  weld: "welded", witness: "witnessed", continue: "continued", "re-assemble": "re-assembled", reassemble: "reassembled",
  "touch-up": "touched-up", "re-install": "re-installed", "pre-assemble": "pre-assembled",
};
// Words that sit in front of the real verb ("Weld build", "Hand blend", "Final assemble",
// "Grit blast", "Heat treat" -- where "treat" is the verb).
// Adan's diaphragm lists (Job 20992) add "Stitch weld", "Light blast clean", "Glass bead",
// "Shim rings ... and tie down", "Set up ... and perform".
const VERB_PREFIXES = new Set(["weld", "hand", "final", "grit", "heat", "wire", "dust", "weld/blend", "re-", "post", "pre", "stitch", "light", "glass", "plug", "spot"]);
const EXTRA_PAST: Record<string, string> = {
  treat: "treated", tint: "tinted", "repair/blend": "repaired/blended", bead: "beaded", set: "set", shim: "shimmed", tie: "tied",
  plug: "plugged", fixture: "fixtured", stress: "stressed",
};

function pastOf(word: string): string | undefined {
  const lower = word.toLowerCase();
  const past = PAST_TENSE[lower] ?? EXTRA_PAST[lower];
  if (!past) return undefined;
  return word[0] === word[0].toUpperCase() ? past[0].toUpperCase() + past.slice(1) : past;
}

export function toPastTense(step: string): string {
  const words = step.split(" ");
  // The main verb: the first word, or the second when the first is a modifier ("Weld build").
  let i = 0;
  if (VERB_PREFIXES.has(words[0].toLowerCase()) && words[1] && pastOf(words[1])) i = 1;
  else if (!pastOf(words[0])) return step;
  // "Light blast clean" → "Light blast cleaned": in "blast clean" the verb is "clean".
  if (/^blast$/i.test(words[i]) && /^clean$/i.test(words[i + 1] ?? "")) i += 1;
  words[i] = pastOf(words[i])!;
  // A second verb joined by "and" ("... assembly and verify dimensions").
  for (let j = i + 1; j < words.length - 1; j++) {
    if (words[j].toLowerCase() !== "and") continue;
    // "... and hand blend ..." -- skip a modifier in front of the second verb too.
    const k = VERB_PREFIXES.has(words[j + 1].toLowerCase()) && words[j + 2] && pastOf(words[j + 2]) ? j + 2 : j + 1;
    if (pastOf(words[k])) {
      words[k] = pastOf(words[k])!;
      break;
    }
  }
  return words.join(" ");
}

/** The Repair Summary drafted from this job's own Repair Recommendations text (markup in, markup
 * out): the lead-in becomes "APG performed the following repairs:", every bullet goes to the past
 * tense, headings ("Segment Repair:") and blank lines are kept. */
export function recommendationsToSummary(recommendations: string): string {
  return recommendations
    .split("\n")
    .map((line) => {
      if (/^apg recommends the following repairs:?$/i.test(line.trim())) return "APG performed the following repairs:";
      return line.startsWith("- ") ? `- ${toPastTense(line.slice(2))}` : line;
    })
    .join("\n");
}

const SPELLED_COUNT = /\b(?:(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[\s-]?)+\(\d+\)/gi;

/** A past report's Engineering Summary, adapted to this job: the received date and every measured
 * value this app could read (area, throat range, flow ranges -- see measurements.ts) swapped in;
 * every other job-specific value (counts like "Twenty six (26)", inch readings, other
 * percentages) kept but wrapped in [brackets] so the tech rep checks each one. */
export function adaptPriorSummary(text: string, m: import("../ingest/measurements").JobMeasurements): string {
  const filled = new Set<string>();
  let out = text.replace(/(received on )(\d{1,2}\/\d{1,2}\/\d{2,4})/i, (_, lead, old) => `${lead}${m.receivedDate ?? `[${old}]`}`);
  out = out.replace(/(area (?:range )?is (?:at )?)([+-]?\d+(?:\.\d+)?%)/i, (all, lead, old) => {
    if (!m.areaDeviation) return all;
    filled.add(m.areaDeviation);
    return `${lead}${m.areaDeviation}`;
  });
  out = out.replace(/(ranging from )([+-]?\d+(?:\.\d+)?%)( to )([+-]?\d+(?:\.\d+)?%)/i, (all, a, _min, b) => {
    if (!m.throatMin || !m.throatMax) return all;
    filled.add(m.throatMin).add(m.throatMax);
    return `${a}${m.throatMin}${b}${m.throatMax}`;
  });
  out = out.replace(/(flow range on the (OD T\/E|ID L\/E) side is (?:at )?)(\d+(?:\.\d+)?%)/gi, (all, lead, side) => {
    const v = m.flowRanges[side.toUpperCase().replace("T/E", "T/E")] ?? m.flowRanges[side];
    if (!v) return all;
    filled.add(v);
    return `${lead}${v}`;
  });
  // Bracket what's left in the findings bullets (not the opening paragraph or headings).
  return out
    .split("\n")
    .map((line) => {
      if (!line.startsWith("- ")) return line;
      return line
        .replace(SPELLED_COUNT, (x) => `[${x}]`)
        .replace(/(?<![\[\d.])([+-]?\d*\.\d+\s*(?:”|"|in\b))/g, "[$1]")
        .replace(/(?<![\[\d.])([+-]?\d+(?:\.\d+)?%)/g, (x) => (filled.has(x) ? x : `[${x}]`));
    })
    .join("\n");
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
