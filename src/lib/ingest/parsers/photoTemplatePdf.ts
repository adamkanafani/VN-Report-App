import { promises as fs } from "fs";
import path from "path";
import sharp from "sharp";
import { PDFDocument, PDFDict, PDFName, PDFRawStream, PDFRef } from "pdf-lib";
import { toLongPath } from "../../util/longPath";

/** Below this in either dimension, an embedded image is template artwork (a logo, an icon, a
 * form's letterhead graphic) rather than a pasted camera photo — real inspection photos are
 * comfortably larger than this in both directions. Picked from a real template's own art (219×121,
 * repeated once per page) sitting well below any actual photo (smallest seen: 480×640). */
const MIN_PHOTO_DIMENSION = 300;

function isDctDecode(dict: PDFDict): boolean {
  const filter = dict.get(PDFName.of("Filter"));
  if (!filter) return false;
  // Filter can be a single name ("/DCTDecode") or an array (a filter chain) — either way its
  // string form contains "DCTDecode" if a JPEG stage is present.
  return /DCTDecode/.test(filter.toString());
}

/**
 * Extracts every embedded JPEG image from a PDF, in page order, writing each to `outDir` as
 * "p<page>-<n>.jpg". Some tech reps paste incoming photos directly into a Word/PDF "photo
 * template" instead of keeping them as loose files in a folder — this covers that case so Photo
 * Set can still find them. Only handles JPEG-compressed (DCTDecode) image streams, which is what
 * a pasted camera photo actually is inside a PDF, and skips anything smaller than
 * `MIN_PHOTO_DIMENSION` in either direction — the template's own repeated logo/letterhead art,
 * not a photo.
 *
 * Caches by presence: if `outDir` already has files in it, they're returned as-is rather than
 * re-extracting — a rescan shouldn't redo this work every time, and the PDF isn't expected to
 * change once it's been dropped in the job folder.
 */
export async function extractEmbeddedPhotos(pdfPath: string, outDir: string): Promise<string[]> {
  try {
    const existing = await fs.readdir(toLongPath(outDir));
    const jpegs = existing.filter((f) => /\.jpe?g$/i.test(f));
    if (jpegs.length > 0) return jpegs.sort().map((f) => path.join(outDir, f));
  } catch {
    // outDir doesn't exist yet — fall through and extract.
  }

  const bytes = await fs.readFile(toLongPath(pdfPath));
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });

  const written: string[] = [];
  const pages = doc.getPages();
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const resources = pages[pageIndex].node.Resources();
    const xObjects = resources?.lookupMaybe(PDFName.of("XObject"), PDFDict);
    if (!xObjects) continue;

    let n = 0;
    for (const [, value] of xObjects.entries()) {
      const obj = value instanceof PDFRef ? doc.context.lookup(value) : value;
      if (!(obj instanceof PDFRawStream)) continue;
      const subtype = obj.dict.get(PDFName.of("Subtype"));
      if (!subtype || subtype.toString() !== "/Image") continue;
      if (!isDctDecode(obj.dict)) continue;

      const contents = Buffer.from(obj.contents);
      const { width, height } = await sharp(contents).metadata();
      if (!width || !height || width < MIN_PHOTO_DIMENSION || height < MIN_PHOTO_DIMENSION) continue;

      n++;
      const fileName = `p${pageIndex + 1}-${String(n).padStart(2, "0")}.jpg`;
      if (written.length === 0) await fs.mkdir(toLongPath(outDir), { recursive: true });
      const outPath = path.join(outDir, fileName);
      await fs.writeFile(toLongPath(outPath), contents);
      written.push(outPath);
    }
  }

  return written;
}
