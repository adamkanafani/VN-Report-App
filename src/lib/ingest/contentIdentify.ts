import { promises as fs } from "fs";
import { getAnthropicClient, VISION_MODEL } from "../anthropic/client";
import type { JobFile } from "./fileWalk";
import { toLongPath } from "../util/longPath";

export interface ContentMatch {
  file: JobFile;
  reason: string;
}

/** What each attach-as-is exhibit actually looks like, described for a vision call rather than a
 * filename pattern — written from the same real-job knowledge the filename patterns themselves
 * were reverse-engineered from (see ia-report.ts). Keep this in sync with which section IDs
 * scanJobFolder.ts actually calls identifyByContent for. */
const DOCUMENT_DESCRIPTIONS: Record<string, string> = {
  crackMap: `A turbine bucket/blade crack map: a printed or hand-drawn diagram of the part's outline (often several views -- tip, platform, root/dovetail, airfoil), hand-marked or hand-annotated with the locations of FPI (fluorescent penetrant inspection) indications -- circles, hatching, or handwritten notes on top of the part outline. May reference zone names like Tips, Airfoil, Platform, Angel Wings, Shank, or Root Serrations, or a form number such as "3097-INSP-GE-7-1SB". Often a scanned document with little or no machine-readable text.`,
  chemTest: `A vendor Certificate of Conformance or material chemistry/composition test report for turbine bucket material -- typically a vendor letterhead (e.g. a metals testing lab or coating vendor like "Flame Spray"), with a table of chemical element percentages (Cr, Ni, Co, C, etc.) or a pass/fail conformance statement.`,
  metallurgicalReport: `A vendor metallurgical evaluation report for a turbine component sample -- describes microstructure, hardness testing, grain structure, or similar metallurgical findings, from a materials testing lab, about a sample cut from the job's parts.`,
};

// Hard caps on both file count and total bytes sent, so a fallback content scan (which only ever
// runs once filename matching has already come up with nothing -- see scanJobFolder.ts) can't
// turn into an expensive or slow surprise on a job with an unusually large Reports/QA folder.
const MAX_CANDIDATES = 12;
const MAX_FILE_BYTES = 15 * 1024 * 1024; // Claude's own per-document limit is higher than this;
// capped well under it since these are meant to be short inspection reports, not scan dumps.

function mediaTypeFor(ext: string): "image/jpeg" | "image/png" | null {
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  return null;
}

/** Best-effort, vision-based fallback for identifying a section's real exhibit by what's actually
 * in the file, for when nothing matched by filename at all -- e.g. a Crack Map saved by a
 * scanner under a generic name like "Scan_0142.pdf", which /crack[_ -]?map/i would never catch.
 * Sends each candidate's actual content (a PDF as Claude's native "document" block, so this works
 * even on a pure scanned image with no text layer -- Claude reads it like a photo, not OCR) and
 * asks whether it matches the section's document description.
 *
 * Degrades to "no matches" without an API key, on a network/rate-limit failure, or for a section
 * with no description above -- same as photoSelect.ts's own duplicate/blur screening: this is a
 * bonus refinement on top of filename matching, never a requirement for a section to work, and
 * every match is still surfaced to the tech rep as needing confirmation (see scanJobFolder.ts),
 * never silently trusted the way a filename match is. */
export async function identifyByContent(sectionId: string, candidates: JobFile[]): Promise<ContentMatch[]> {
  const description = DOCUMENT_DESCRIPTIONS[sectionId];
  if (!description || candidates.length === 0) return [];

  let client;
  try {
    client = getAnthropicClient();
  } catch {
    return []; // no API key configured -- this fallback simply doesn't run
  }

  // One call per candidate, run concurrently rather than one-at-a-time -- this fallback only
  // ever runs once filename matching has already come up empty (see scanJobFolder.ts), so it's
  // already the rare case, but a job scan/rescan still shouldn't wait out up to MAX_CANDIDATES
  // vision calls back-to-back on top of everything else a scan already does.
  const results = await Promise.all(
    candidates.slice(0, MAX_CANDIDATES).map(async (file): Promise<ContentMatch | null> => {
      try {
        const stat = await fs.stat(toLongPath(file.absolutePath));
        if (stat.size > MAX_FILE_BYTES) return null;

        const imageMediaType = mediaTypeFor(file.ext);
        if (file.ext !== ".pdf" && !imageMediaType) return null; // not a type we can send at all

        const buffer = await fs.readFile(toLongPath(file.absolutePath));
        const data = buffer.toString("base64");
        const block =
          file.ext === ".pdf"
            ? ({ type: "document" as const, source: { type: "base64" as const, media_type: "application/pdf" as const, data } })
            : ({ type: "image" as const, source: { type: "base64" as const, media_type: imageMediaType!, data } });

        const response = await client.messages.create({
          model: VISION_MODEL,
          max_tokens: 128,
          system:
            "You are helping identify a turbine-parts inspection document by its actual content, not its filename -- a shop scanner often saves these under a generic name like Scan_0142.pdf. Reply with ONLY one word: YES if the attached file matches the given description, or NO if it doesn't (e.g. it's a blank page, a purchase order, a photo, or an unrelated document).",
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: `Does this file match this description?\n\n${description}` }, block],
            },
          ],
        });

        const textBlock = response.content.find((b) => b.type === "text");
        const answer = textBlock && textBlock.type === "text" ? textBlock.text.trim().toUpperCase() : "";
        return answer.startsWith("YES") ? { file, reason: "Identified by its content, not its filename." } : null;
      } catch {
        return null; // this one candidate failed to read/send/classify -- the rest still count
      }
    })
  );

  const matches = results.filter((m): m is ContentMatch => m !== null);
  return matches;
}
