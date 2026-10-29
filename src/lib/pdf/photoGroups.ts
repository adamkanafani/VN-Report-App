// Which photo slide a photo belongs on, from its folder -- mirrors how Alfredo titles his photo
// slides (Job 20564's I&A deck): "Shipping Photos" (3A Incoming\Shipping), "NDT Photos (Segments)"
// / "(Ret. Ring)" / "(Cores & Covers)" (3A Incoming\NDT-1\<part>), "Incoming Photos (Hardware)",
// "Final Photos" (3C Final). The rank orders groups the way his decks do. Shared by the PDF
// renderer and the PowerPoint export so both title and order photo pages identically.

/** His wording for the NDT-1 part folders the shop creates ("NOZZLE", "INCOMING RETAINER RING",
 * "CORES AND COVERS", ...). Anything else is title-cased as-is. */
function partLabel(folder: string): string {
  const f = folder.replace(/^incoming\s+/i, "").trim();
  if (/nozzle|segment/i.test(f)) return "Segments";
  if (/vane/i.test(f)) return "Vanes";
  if (/retain(er|ing)\s*ring|ret\.?\s*ring/i.test(f)) return "Ret. Ring";
  if (/cores?\s*(&|and)\s*covers?/i.test(f)) return "Cores & Covers";
  if (/flat\s*seal/i.test(f)) return "Flat Seals";
  if (/packing/i.test(f)) return "Packings";
  return f.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

export function photoGroup(folderPath: string): { label: string; rank: number } {
  const parts = folderPath.split("/");
  const after = (pattern: RegExp) => {
    const i = parts.findIndex((p) => pattern.test(p));
    return i !== -1 ? parts[i + 1] : undefined;
  };
  if (/shipping/i.test(folderPath)) return { label: /3c\s*final/i.test(folderPath) ? "Final Shipping Photos" : "Shipping Photos", rank: 0 };
  const ndtPart = after(/^ndt/i);
  if (ndtPart) return { label: `NDT Photos (${partLabel(ndtPart)})`, rank: 1 };
  if (/ndt/i.test(folderPath)) return { label: "NDT Photos", rank: 1 };
  if (/hardware/i.test(folderPath)) return { label: "Incoming Photos (Hardware)", rank: 2 };
  // Loose photos straight in "3 Pictures\3A Incoming" (no subfolder).
  if (/3a\s*incoming$/i.test(folderPath)) return { label: "Incoming Photos", rank: 2 };
  if (/3c\s*final/i.test(folderPath)) {
    const sub = after(/^3c\s*final/i);
    return { label: sub && !/^final$/i.test(sub) ? `Final Photos (${partLabel(sub)})` : "Final Photos", rank: 3 };
  }
  return { label: `Photos (${partLabel(parts[parts.length - 1] || "Other")})`, rank: 4 };
}

/** Photos per report page / PowerPoint slide: two across, three down. */
export const PHOTOS_PER_REPORT_PAGE = 6;

/** Where a group sits in the report, from its title -- for a group a tech rep moved a photo into. */
export function labelRank(label: string): number {
  if (/shipping/i.test(label)) return 0;
  if (/ndt/i.test(label)) return 1;
  if (/incoming/i.test(label)) return 2;
  if (/final/i.test(label)) return 3;
  return 4;
}

/** A photo's group: the one the tech rep moved it to (a shot the shop filed in the wrong folder),
 * else the one its folder says. */
export function photoGroupOf(relativePath: string, overrides?: Record<string, string>): { label: string; rank: number } {
  const moved = overrides?.[relativePath];
  if (moved) return { label: moved, rank: labelRank(moved) };
  const folder = relativePath.includes("/") ? relativePath.slice(0, relativePath.lastIndexOf("/")) : "";
  return photoGroup(folder);
}

/** Selected photos (relative paths, in the tech rep's order) grouped into titled runs. */
export function groupPhotos(paths: string[], overrides?: Record<string, string>): Array<{ label: string; paths: string[] }> {
  const groups = new Map<string, { rank: number; paths: string[] }>();
  for (const relativePath of paths) {
    const { label, rank } = photoGroupOf(relativePath, overrides);
    const g = groups.get(label) ?? { rank, paths: [] };
    g.paths.push(relativePath);
    groups.set(label, g);
  }
  return [...groups.entries()].sort((a, b) => a[1].rank - b[1].rank).map(([label, g]) => ({ label, paths: g.paths }));
}

/** The photos a photo section prints for one report, in order (see the photo picker on the review
 * screen). The report's own pick once the tech rep has made one; the Final's repeated incoming
 * block otherwise starts from the I&A's pick; then the automatic (AI) pick when there is one.
 * With none of those, the Final starts with just its shipping photos -- tech reps choose the rest
 * deliberately -- and the I&A with every photo, as before. Photos no longer in the folder drop out. */
export function photoPick(
  section: { id: string; matchedFiles: Array<{ relativePath: string }> },
  sectionState: { selectedPhotoPaths?: string[]; selectedPhotoPathsByReport?: Record<string, string[]>; photoGroupOverrides?: Record<string, string> } | undefined,
  reportType: string
): string[] {
  const final = /repair|final/i.test(reportType);
  const exists = new Set(section.matchedFiles.map((f) => f.relativePath));
  const keep = (paths: string[] | undefined) => paths?.filter((p) => exists.has(p));
  const own = keep(sectionState?.selectedPhotoPathsByReport?.[final ? "final" : "ia"]);
  if (own) return own;
  if (final && section.id === "photoSet") {
    const ia = keep(sectionState?.selectedPhotoPathsByReport?.ia);
    if (ia?.length) return ia;
  }
  const auto = keep(sectionState?.selectedPhotoPaths);
  if (auto?.length) return auto;
  const all = section.matchedFiles.map((f) => f.relativePath);
  return final ? all.filter((p) => photoGroupOf(p, sectionState?.photoGroupOverrides).rank === 0) : all;
}
