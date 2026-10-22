import { promises as fs } from "fs";
import sharp from "sharp";
import { getAnthropicClient, VISION_MODEL } from "../anthropic/client";
import type { JobFile } from "../ingest/fileWalk";
import { toLongPath } from "../util/longPath";

export interface PhotoExclusion {
  relativePath: string;
  reason: string;
}

/** "high" (an indication, marking, or highlighted/circled problem area is actually visible --
 * exactly what a reviewer opens the report to see) sorts before "normal" (a relevant but
 * unremarkable inspection shot), which sorts before "low" (documents the part arriving/being
 * unloaded, not its condition -- still real documentation, so still included, just not what
 * anyone's looking for first). Kept photos default to "normal" if the model's reply for that
 * photo didn't parse, so a parsing gap never drops a photo out of the selection over it. */
export type PhotoPriority = "high" | "normal" | "low";

export interface PhotoSelectResult {
  includedPaths: string[];
  excluded: PhotoExclusion[];
  raw: string;
}

const MAX_PHOTOS_PER_CALL = 20;
const PRIORITY_RANK: Record<PhotoPriority, number> = { high: 0, normal: 1, low: 2 };

function mediaTypeFor(ext: string): "image/jpeg" | "image/png" {
  return ext === ".png" ? "image/png" : "image/jpeg";
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Best-effort vision-based classification of one batch: which photos to drop (exact/near-
 * duplicate or too blurry to use) and, for everything kept, how strongly it belongs in an
 * inspection report (see PhotoPriority) -- an indication/marking/highlighted problem area versus
 * a routine shot versus a receiving/logistics photo that documents the crate arriving rather than
 * the part's condition. This is a refinement on top of the real default (include everything) --
 * never a requirement for it. Without an API key, or if the call fails for any other reason, this
 * returns zero exclusions and "normal" for every photo (i.e. today's plain natural-order
 * behavior), so photo preselection never depends on AI access being available. */
async function classifyBatch(batch: JobFile[]): Promise<{ exclusions: PhotoExclusion[]; priorities: Map<string, PhotoPriority>; raw: string }> {
  const defaultPriorities = new Map<string, PhotoPriority>(batch.map((f) => [f.relativePath, "normal" as const]));
  try {
    const imageBlocks = await Promise.all(
      batch.map(async (file) => {
        const buffer = await fs.readFile(toLongPath(file.absolutePath));
        return {
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: mediaTypeFor(file.ext),
            data: buffer.toString("base64"),
          },
        };
      })
    );

    const labelList = batch.map((f, i) => `Photo ${i + 1}: ${f.relativePath}`).join("\n");

    const client = getAnthropicClient();
    const response = await client.messages.create({
      model: VISION_MODEL,
      max_tokens: 1536,
      system:
        "You are helping a turbine-parts repair tech rep prepare photos for a customer inspection report. The default is to include every photo — tech reps aren't picky about volume, and having a few extra rarely hurts — but the ones that actually show a finding should surface first, and pure shipping/logistics photos should sort last, not vanish. Classify every photo with exactly one tag:\n" +
        "- HIGH: an indication, crack, marking, or highlighted/circled problem area is actually visible in the photo — this is what a reviewer opens the report to see.\n" +
        "- NORMAL: a relevant incoming/NDT inspection photo (an overall part shot, a setup shot, an unremarkable close-up) that doesn't show a specific finding.\n" +
        "- LOW: a shipping/receiving photo — the crate, the box, unloading, packing material — that documents logistics, not the part's condition.\n" +
        "- EXCLUDE: an exact or near-duplicate of another photo in this batch (keep the sharpest, tag the rest EXCLUDE), or so blurry/out of focus the subject can't be made out.\n" +
        "Never use EXCLUDE just for composition, lighting, or relevance — that's what LOW is for.",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Here are ${batch.length} candidate photos, in this order:\n${labelList}\n\nReply with exactly one line per photo, in order, as "Photo N: TAG" or "Photo N: TAG (reason)" for EXCLUDE -- TAG is one of HIGH, NORMAL, LOW, EXCLUDE.`,
            },
            ...imageBlocks,
          ],
        },
      ],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    const raw = textBlock && textBlock.type === "text" ? textBlock.text : "";

    const exclusions: PhotoExclusion[] = [];
    const priorities = new Map(defaultPriorities);
    const lineRegex = /photo\s+(\d+)\s*:\s*(HIGH|NORMAL|LOW|EXCLUDE)\b\s*(?:\((.+)\))?/gi;
    let match: RegExpExecArray | null;
    while ((match = lineRegex.exec(raw))) {
      const index = Number(match[1]) - 1;
      if (index < 0 || index >= batch.length) continue;
      const tag = match[2].toUpperCase();
      const file = batch[index];
      if (tag === "EXCLUDE") {
        exclusions.push({ relativePath: file.relativePath, reason: match[3]?.trim() || "duplicate or too blurry to use" });
      } else {
        priorities.set(file.relativePath, tag.toLowerCase() as PhotoPriority);
      }
    }

    return { exclusions, priorities, raw };
  } catch (err) {
    // No API key, rate limit, network error, whatever — the whole point of this batch is an
    // optional refinement, so a failure here just means "keep everything at normal priority,"
    // not "fail the scan."
    const message = err instanceof Error ? err.message : "vision-based screening failed";
    return { exclusions: [], priorities: defaultPriorities, raw: `(skipped content-based screening: ${message})` };
  }
}

/** Splits a filename into its leading number (if any) and the rest, so "2.jpg" sorts before
 * "10.jpg" — plain string sort would put "10.jpg" first. Falls back to plain string comparison
 * for anything that doesn't start with a number. */
function naturalCompare(a: string, b: string): number {
  const parse = (name: string) => {
    const m = name.match(/^(\d+)/);
    return m ? Number(m[1]) : null;
  };
  const na = parse(a);
  const nb = parse(b);
  if (na !== null && nb !== null && na !== nb) return na - nb;
  return a.localeCompare(b);
}

/** Below this average grayscale value (0-255, sampled on a tiny downscaled copy) a photo is
 * classified as taken under UV/blacklight (FPI indications glowing against a dark background) —
 * above it, as a normal work-light photo. Picked from the actual brightness distribution of a
 * real job's NDT photo set, which fell cleanly into two clusters (roughly 35-65 and 75-125) with
 * this value sitting in the gap between them. Not perfect — a heuristic on pixel brightness, not
 * real image understanding — but there's no vision model available without an API key, and this
 * is a much better default grouping than leaving the two intermixed. */
const UV_BRIGHTNESS_THRESHOLD = 75;

async function isUvLit(absolutePath: string): Promise<boolean> {
  try {
    const { data } = await sharp(toLongPath(absolutePath)).resize(32, 32, { fit: "fill" }).grayscale().raw().toBuffer({ resolveWithObject: true });
    const mean = data.reduce((sum, v) => sum + v, 0) / data.length;
    return mean < UV_BRIGHTNESS_THRESHOLD;
  } catch {
    return false; // if it can't be read here, photoToDataUri will surface the real error at render time
  }
}

/** Preselects photos for a photo-set section — Incoming-stage photos by default (which includes
 * any NDT subfolder nested under "3A Incoming"), since that's what an I&A report documents; the
 * Final Report's own photo set instead prefers Final-stage photos (see `preferredStage`) — same
 * mechanism, different stage. Whichever stage isn't preferred is left out of the preselection,
 * though still fully browsable and selectable by hand in the grid. Shipping/receiving photos (the
 * box/crate arriving) are excluded outright — not inspection content. Within what's left, every
 * photo is included by default — tech reps aren't picky about volume, so there's no "pick the
 * best N" judgment call, just a screen for exact/near-duplicates (kept once) and shots too blurry
 * to use. Batched to keep each vision call a reasonable size; duplicate detection only catches
 * matches within the same batch. Falls back to screening the full candidate set if no photos for
 * the preferred stage were found at all, rather than silently preselecting nothing.
 *
 * The final selection is grouped into two blocks — UV/blacklight FPI shots together, then normal
 * work-light shots together — since the two lighting conditions read as unrelated photos when
 * intermixed, and within each of those two blocks, ordered by PhotoPriority: a photo that
 * actually shows an indication/marking/highlighted problem area first, a routine inspection shot
 * next, and a shipping/receiving/logistics photo (crate, box, unloading -- documents the part
 * arriving, not its condition) last. Nothing in "low" priority is dropped, just deprioritized --
 * the same "tech reps aren't picky about volume" reasoning as the dup/blur exclusion above,
 * applied to ordering instead of inclusion. */
export async function selectBestPhotos(candidates: JobFile[], preferredStage: "incoming" | "final" = "incoming"): Promise<PhotoSelectResult> {
  const stageGroups = groupPhotosByStage(candidates);
  const preferred = stageGroups[preferredStage]?.length ? stageGroups[preferredStage] : candidates;
  const eligibleCandidates = preferred.filter((f) => !/shipping/i.test(f.folderPath));
  const batches = chunk(eligibleCandidates, MAX_PHOTOS_PER_CALL);

  const batchResults = await Promise.all(batches.map(classifyBatch));

  const excluded = batchResults.flatMap((r) => r.exclusions);
  const raw = batchResults.map((r) => r.raw).join("\n\n");
  const excludedPaths = new Set(excluded.map((e) => e.relativePath));
  const priorities = new Map<string, PhotoPriority>();
  for (const r of batchResults) for (const [path, tier] of r.priorities) priorities.set(path, tier);
  const kept = eligibleCandidates.filter((f) => !excludedPaths.has(f.relativePath));

  // Highest priority (lowest rank number) first, natural filename order as the tiebreaker within
  // a tier -- same ordering logic as before, just with the priority tier as the primary key
  // ahead of filename.
  const byPriorityThenName = (a: JobFile, b: JobFile) => {
    const rankDiff = PRIORITY_RANK[priorities.get(a.relativePath) ?? "normal"] - PRIORITY_RANK[priorities.get(b.relativePath) ?? "normal"];
    return rankDiff !== 0 ? rankDiff : naturalCompare(a.baseName, b.baseName);
  };

  const uvFlags = await Promise.all(kept.map((f) => isUvLit(f.absolutePath)));
  const uvGroup = kept.filter((_, i) => uvFlags[i]).sort(byPriorityThenName);
  const normalGroup = kept.filter((_, i) => !uvFlags[i]).sort(byPriorityThenName);
  const includedPaths = [...uvGroup, ...normalGroup].map((f) => f.relativePath);

  return { includedPaths, excluded, raw };
}

export function groupPhotosByStage(files: JobFile[]): Record<string, JobFile[]> {
  const groups: Record<string, JobFile[]> = {};
  for (const file of files) {
    const stageMatch = file.folderPath.match(/3[a-c]\s+(incoming|in-process|final)/i);
    const stage = stageMatch ? stageMatch[1].toLowerCase() : "other";
    (groups[stage] ??= []).push(file);
  }
  return groups;
}
