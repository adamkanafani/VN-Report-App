import { promises as fs } from "fs";
import path from "path";
import { parseJobMetadataFromFolderName, type JobMetadata } from "../ingest/jobMetadata";
import { readDeck, slideTitle, type DeckSlide } from "../pptx/readDeck";
import { toLongPath } from "../util/longPath";
import { PREFERRED_EXAMPLE_JOBS } from "../report-templates/exemplars";

// "Start from the last report for the same product." Across Alfredo Resendiz's ~90 GE nozzle
// reports, 85–95% of each Repair Recommendations list is the same lines job to job for a given
// product (e.g. 21 lines appear in all 9 F7EA S1N I&A reports surveyed), the Engineering Summary
// always has the same subheadings with many finding lines repeated word for word, and the opening
// sentence only changes the received date. So the best first draft for a new job is the most
// recent finished report of the same model + stage/row, with the job-specific values swapped out --
// not wording generated from the router.

export interface ProductKey {
  family: string;
  stage: number | null;
  /** "support-ring" (inner support rings -- Alfredo's) and "vane-carrier" (GT11 vane carriers --
   * Adan's and Elmer's) are their own products: drafted only from earlier reports of the same kind,
   * never from nozzle or vane reports. */
  kind: "nozzle" | "vane" | "support-ring" | "vane-carrier";
}

/** "F7EA" / "7EA" → "F7EA", "6B" → "F6B", "W501D5A" / "501D5" / "D5A" → "501D5", "W501F" → "501F",
 * "MHI 501F" → "MHI501F" (Mitsubishi's 501F vanes are a different part from Siemens'). */
function normalizeFamily(model: string): string {
  const m = model.toUpperCase().replace(/\s+/g, "");
  const ge = m.match(/^F?([3-9][A-Z]{1,3})/);
  if (ge) return `F${ge[1]}`;
  if (/^D5A?$/.test(m)) return "501D5";
  const w = m.match(/^(MHI)?W?(501[A-Z]+\d?)/);
  if (w) return `${w[1] ?? ""}${w[2].replace(/A$/, "")}`;
  return m;
}

export function productKeyFor(metadata: Pick<JobMetadata, "turbineModel" | "part" | "component">): ProductKey | null {
  const text = `${metadata.part} ${metadata.component}`;
  if (!metadata.turbineModel || /pilot|fuel|parts?\s*sale/i.test(text)) return null;
  // Order matters: "1ST STAGE NOZZLE INNER SUPPORT RING" is a support ring, not a nozzle; "VANE
  // CARRIER" (also misspelled "VAVE CARRIER", Job 18177) is a carrier, not vanes. Other carriers
  // (combustor tile carriers, carrier heat shields, stator carrier rings) aren't V&N report parts.
  const kind: ProductKey["kind"] | null = /support\s*ring/i.test(text)
    ? "support-ring"
    : /va[nv]e\s*carrier/i.test(text)
      ? "vane-carrier"
      : /carrier/i.test(text)
        ? null
        : /vane/i.test(text)
          ? "vane"
          : /nozzle/i.test(text)
            ? "nozzle"
            : null;
  if (!kind) return null;
  // A support ring is always the 1st-stage ring -- its stage words don't distinguish anything. A
  // carrier's row ("ROW 1 VANE CARRIER SEGMENTS") does; a whole carrier has none.
  if (kind === "support-ring") return { family: normalizeFamily(metadata.turbineModel), stage: null, kind };
  const m = text.match(/\b(1st|first|row\s*1)\b|\b(2nd|second|row\s*2)\b|\b(3rd|third|row\s*3)\b|\b(4th|fourth|row\s*4)\b|\b(5th|row\s*5)\b/i);
  const stage = m ? [1, 2, 3, 4, 5].find((_, i) => m[i + 1]) ?? null : null;
  return { family: normalizeFamily(metadata.turbineModel), stage, kind };
}

/** Same product, ignoring the MHI marker -- which isn't always in the folder name (Job 19168's
 * folder says "501F ROW 1 VANES"; only its deck, "19168 SP-GTA MHI R1V IA Report", says MHI), so
 * MHI-ness is settled per deck in findPriorReport instead. */
const baseFamily = (family: string) => family.replace(/^MHI/, "");
function sameProduct(a: ProductKey, b: ProductKey): boolean {
  return baseFamily(a.family) === baseFamily(b.family) && a.stage === b.stage && a.kind === b.kind;
}

// Listing every job folder under "Working Jobs" walks a couple hundred bucket folders on a network
// drive -- cached for the life of the server process (a new job showing up mid-session only
// matters as a *source* once it has a finished report, which takes weeks).
const listingCache = new Map<string, Promise<Array<{ folder: string; name: string }>>>();

function listJobFolders(workingJobs: string) {
  let p = listingCache.get(workingJobs);
  if (!p) {
    p = (async () => {
      const out: Array<{ folder: string; name: string }> = [];
      const buckets = await fs.readdir(toLongPath(workingJobs), { withFileTypes: true }).catch(() => []);
      await Promise.all(
        buckets
          .filter((b) => /^\d{4,6}$/.test(b.name))
          .map(async (b) => {
            const bucket = path.join(workingJobs, b.name);
            const jobs = await fs.readdir(toLongPath(bucket), { withFileTypes: true }).catch(() => []);
            for (const j of jobs) if (/^\d{4,6}\s/.test(j.name)) out.push({ folder: path.join(bucket, j.name), name: j.name });
          })
      );
      return out;
    })();
    listingCache.set(workingJobs, p);
  }
  return p;
}

export interface PriorReport {
  jobNumber: string;
  jobFolderName: string;
  file: string;
}

const REPORT_DIRS = { ia: path.join("7 Reports", "7A Inspection Report"), repair: path.join("7 Reports", "7B Final Report") };
const REPORT_NAME = { ia: /(ia|incoming)\s*report/i, repair: /repair\s*report/i };

/** The most recent other job of the same product (by job number) that has a finished report deck
 * of the requested kind -- the standard deck, not the "-FS" field-service short version or a
 * "Copy of". Only looks inside the same "Working Jobs" tree the current job lives in. */
function deckRank(name: string): number {
  if (/\brev(ised)?\b/i.test(name)) return 0;
  return /report\.pptx$/i.test(name) ? 1 : 2;
}

export async function findPriorReport(jobRoot: string, metadata: JobMetadata, kind: "ia" | "repair"): Promise<PriorReport | null> {
  const key = productKeyFor(metadata);
  if (!key) return null;
  const workingJobs = path.dirname(path.dirname(jobRoot));
  if (!/working jobs/i.test(path.basename(workingJobs))) return null;

  const current = Number(metadata.jobNumber) || Number.MAX_SAFE_INTEGER;
  const candidates = (await listJobFolders(workingJobs))
    .map((j) => ({ ...j, meta: parseJobMetadataFromFolderName(j.folder) }))
    .filter((j) => j.meta.jobNumber && j.meta.jobNumber !== metadata.jobNumber)
    .filter((j) => {
      const k = productKeyFor(j.meta);
      if (k === null) return false;
      // A picked support-ring example serves every model (Alfredo: 20062, an F7B ring) -- support
      // ring reports have the same structure across F7B / F7EA / F7FA (checked 17366, 20062,
      // 20097, 20855); only the most-recent fallback stays within the same model.
      if (key.kind === "support-ring" && k.kind === "support-ring" && PREFERRED_EXAMPLE_JOBS.includes(j.meta.jobNumber)) return true;
      return sameProduct(k, key);
    })
    // The tech reps' own picked examples first (see exemplars.ts), then earlier jobs (most recent
    // of those first), then later ones -- a later job number can still be the newest *finished*
    // report when this job is an old one being revisited.
    .sort((a, b) => {
      const ap = PREFERRED_EXAMPLE_JOBS.includes(a.meta.jobNumber), bp = PREFERRED_EXAMPLE_JOBS.includes(b.meta.jobNumber);
      if (ap !== bp) return ap ? -1 : 1;
      const an = Number(a.meta.jobNumber), bn = Number(b.meta.jobNumber);
      const aBefore = an < current, bBefore = bn < current;
      if (aBefore !== bBefore) return aBefore ? -1 : 1;
      return aBefore ? bn - an : an - bn;
    });

  for (const c of candidates.slice(0, 25)) {
    const dir = path.join(c.folder, REPORT_DIRS[kind]);
    const names = await fs.readdir(toLongPath(dir)).catch(() => [] as string[]);
    // The finished deck: not an Office lock file, a "Copy of"/"- Copy", or the "-FS" field-service
    // short version. A "REV"/"REVISED" deck is the corrected one, so it wins; then a plain
    // "... Report.pptx" over a variant like "... Report  hardware pictures.pptx" (Job 19163).
    const deck = names
      .filter((n) => /\.pptx$/i.test(n) && REPORT_NAME[kind].test(n) && !/^~\$|^copy of|[\s_-]fs\.pptx$|- copy/i.test(n))
      .sort((a, b) => deckRank(a) - deckRank(b) || a.length - b.length)[0];
    // MHI vs Siemens 501F: the candidate is MHI when its folder or its deck says so.
    if (deck && key.family.startsWith("MHI") !== (/\bmhi\b/i.test(c.name) || /\bmhi\b/i.test(deck))) continue;
    if (deck) return { jobNumber: c.meta.jobNumber, jobFolderName: c.name, file: path.join(dir, deck) };
  }
  return null;
}

/** What a past report deck contributes to a new job's drafts. */
export interface PriorDraft {
  source: PriorReport;
  engineeringSummary?: string;
  repairRecommendations?: string;
  repairSummary?: string;
  /** Cover / component-details label → value, e.g. "Tech Rep" → "Alfredo Resendiz T.". */
  coverFields: Record<string, string>;
  /** Cover labels in order, including ones written with the value inline ("EQ# 11392387" → "EQ#"). */
  coverLabels: string[];
  /** Divider slide titles in deck order ("Serial Number List", "Flow Test", ...). */
  dividers: string[];
}

const clean = (s: string) => s.replace(/\t+/g, " ").replace(/\s+/g, " ").trim();

function isHeading(p: { text: string; bold: boolean; underline: boolean }): boolean {
  const t = clean(p.text);
  if (!t.endsWith(":") || t.length > 70) return p.bold && p.underline && t.length <= 70;
  return p.bold || p.underline || /inspection|ring|hardware|replacement|repair|assembly|packing|dimension/i.test(t);
}

/** The slides titled `title` (a summary can run over two), turned into this app's narrative markup:
 * headings → "Heading:", body paragraphs → "- bullet", lead-in sentences ("An F7FA 1st stage
 * nozzle was received...", "APG recommends the following repairs:") → plain paragraphs. */
function sectionMarkup(slides: DeckSlide[], title: RegExp): string | undefined {
  const matching = slides.filter((s) => !s.hidden && title.test(slideTitle(s)));
  if (matching.length === 0) return undefined;
  const lines: string[] = [];
  for (const slide of matching) {
    const titleText = slideTitle(slide);
    const shapes = [...slide.shapes].sort((a, b) => a.y - b.y || a.x - b.x);
    for (const shape of shapes) {
      const shapeText = clean(shape.paragraphs.map((p) => p.text).join(" "));
      if (shapeText === titleText) continue;
      for (const p of shape.paragraphs) {
        const t = clean(p.text);
        if (!t) continue;
        if (/(was|were) received|^apg (recommends|performed)|^note:/i.test(t)) {
          if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
          lines.push(t);
          continue;
        }
        if (isHeading(p)) {
          if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
          lines.push(t.endsWith(":") ? t : `${t}:`);
          continue;
        }
        lines.push(`- ${t}`);
      }
    }
  }
  while (lines[lines.length - 1] === "") lines.pop();
  return lines.length > 0 ? lines.join("\n") : undefined;
}

/** Label/value pairs off the two cover slides ("Tech Rep: \t\tAlfredo Resendiz T."). */
function coverFields(slides: DeckSlide[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const slide of slides.slice(0, 3)) {
    for (const shape of slide.shapes) {
      for (const p of shape.paragraphs) {
        const m = p.text.match(/^\s*([A-Za-z][A-Za-z #'/]*?)\s*:?\s*\t+\s*(.+?)\s*$/) ?? p.text.match(/^\s*([A-Za-z][A-Za-z #'/]*?):\s+(.+?)\s*$/);
        if (m && m[2].trim()) fields[clean(m[1]).replace(/:$/, "")] ??= clean(m[2]);
      }
    }
  }
  return fields;
}

/** Labels down the two cover slides, in order -- "Customer:<tab>…", or an inline "EQ# 11392387" /
 * "WO# 4500…" with no colon. */
function coverLabels(slides: DeckSlide[]): string[] {
  const labels: string[] = [];
  for (const slide of slides.slice(0, 2)) {
    for (const shape of slide.shapes) {
      for (const p of shape.paragraphs) {
        const t = p.text.trim();
        const m = t.match(/^([A-Za-z][A-Za-z #'/.]*?)\s*(:|	)/) ?? t.match(/^([A-Z]{2,4}#)\s*\S/);
        if (m) labels.push(clean(m[1]).replace(/:$/, ""));
      }
    }
  }
  return labels;
}

/** Divider slides: no pictures, a single short line of text, not a cover / summary / list slide. */
function dividerTitles(slides: DeckSlide[]): string[] {
  return slides
    .filter((s) => !s.hidden && s.pictures === 0 && s.shapes.length === 1 && s.text.length > 0 && s.text.length <= 60)
    .map((s) => s.text)
    .filter((t) => !/(incoming|repair)\s*report$|engineering summary|recommendation|repair summary/i.test(t));
}

export async function readPriorDraft(prior: PriorReport): Promise<PriorDraft> {
  const slides = await readDeck(await fs.readFile(toLongPath(prior.file)));
  return {
    source: prior,
    engineeringSummary: sectionMarkup(slides, /engineering\s*summary/i),
    repairRecommendations: sectionMarkup(slides, /repair\s*recommendation/i),
    repairSummary: sectionMarkup(slides, /repair\s*summary/i),
    coverFields: coverFields(slides),
    coverLabels: coverLabels(slides),
    dividers: dividerTitles(slides),
  };
}
