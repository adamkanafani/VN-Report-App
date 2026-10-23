import { promises as fs } from "fs";
import path from "path";
import { parseJobMetadataFromFolderName, type JobMetadata } from "../ingest/jobMetadata";
import { readDeck, slideTitle, type DeckSlide } from "../pptx/readDeck";
import { toLongPath } from "../util/longPath";

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
  kind: "nozzle" | "vane";
}

/** "F7EA" / "7EA" → "F7EA", "6B" → "F6B", "W501D5A" / "501D5" → "501D5", "MHI 501F" → "501F". */
function normalizeFamily(model: string): string {
  const m = model.toUpperCase().replace(/\s+/g, "");
  const ge = m.match(/^F?([3-9][A-Z]{1,3})/);
  if (ge) return `F${ge[1]}`;
  const w = m.match(/^W?(501[A-Z]+\d?)/);
  if (w) return w[1].replace(/A$/, "");
  return m;
}

export function productKeyFor(metadata: Pick<JobMetadata, "turbineModel" | "part" | "component">): ProductKey | null {
  const text = `${metadata.part} ${metadata.component}`;
  if (!metadata.turbineModel || /pilot|fuel|carrier|support\s*ring|parts?\s*sale/i.test(text)) return null;
  const kind = /vane/i.test(text) ? "vane" : /nozzle/i.test(text) ? "nozzle" : null;
  if (!kind) return null;
  const m = text.match(/\b(1st|first|row\s*1)\b|\b(2nd|second|row\s*2)\b|\b(3rd|third|row\s*3)\b|\b(4th|fourth|row\s*4)\b|\b(5th|row\s*5)\b/i);
  const stage = m ? [1, 2, 3, 4, 5].find((_, i) => m[i + 1]) ?? null : null;
  return { family: normalizeFamily(metadata.turbineModel), stage, kind };
}

function sameProduct(a: ProductKey, b: ProductKey): boolean {
  return a.family === b.family && a.stage === b.stage && a.kind === b.kind;
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
      return k !== null && sameProduct(k, key);
    })
    // Earlier jobs first (most recent of those first), then later ones -- a later job number can
    // still be the newest *finished* report when this job is an old one being revisited.
    .sort((a, b) => {
      const an = Number(a.meta.jobNumber), bn = Number(b.meta.jobNumber);
      const aBefore = an < current, bBefore = bn < current;
      if (aBefore !== bBefore) return aBefore ? -1 : 1;
      return aBefore ? bn - an : an - bn;
    });

  for (const c of candidates.slice(0, 25)) {
    const dir = path.join(c.folder, REPORT_DIRS[kind]);
    const names = await fs.readdir(toLongPath(dir)).catch(() => [] as string[]);
    const deck = names.find((n) => /\.pptx$/i.test(n) && REPORT_NAME[kind].test(n) && !/^~\$|^copy of|[\s_-]fs\.pptx$|\brev\b|- copy/i.test(n));
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
        if (/(was|were) received|^apg (recommends|performed)/i.test(t)) {
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

export async function readPriorDraft(prior: PriorReport): Promise<PriorDraft> {
  const slides = await readDeck(await fs.readFile(toLongPath(prior.file)));
  return {
    source: prior,
    engineeringSummary: sectionMarkup(slides, /engineering\s*summary/i),
    repairRecommendations: sectionMarkup(slides, /repair\s*recommendation/i),
    repairSummary: sectionMarkup(slides, /repair\s*summary/i),
    coverFields: coverFields(slides),
  };
}
