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
  if (/3c\s*final/i.test(folderPath)) {
    const sub = after(/^3c\s*final/i);
    return { label: sub && !/^final$/i.test(sub) ? `Final Photos (${partLabel(sub)})` : "Final Photos", rank: 3 };
  }
  return { label: `Photos (${partLabel(parts[parts.length - 1] || "Other")})`, rank: 4 };
}

/** Selected photos (relative paths, in the tech rep's order) grouped into titled runs. */
export function groupPhotos(paths: string[]): Array<{ label: string; paths: string[] }> {
  const groups = new Map<string, { rank: number; paths: string[] }>();
  for (const relativePath of paths) {
    const folder = relativePath.includes("/") ? relativePath.slice(0, relativePath.lastIndexOf("/")) : "";
    const { label, rank } = photoGroup(folder);
    const g = groups.get(label) ?? { rank, paths: [] };
    g.paths.push(relativePath);
    groups.set(label, g);
  }
  return [...groups.entries()].sort((a, b) => a[1].rank - b[1].rank).map(([label, g]) => ({ label, paths: g.paths }));
}

/** The photos a photo-set section prints: the tech rep's selection, else every candidate. */
export function selectedPhotoPaths(section: { matchedFiles: Array<{ relativePath: string }> }, selected: string[] | undefined): string[] {
  return selected && selected.length > 0 ? selected : section.matchedFiles.map((f) => f.relativePath);
}
