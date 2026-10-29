import { promises as fs } from "fs";
import path from "path";
import sharp from "sharp";
import PptxGenJS from "pptxgenjs";
import type { JobScanResult, SectionScanResult } from "../ingest/scanJobFolder";
import type { JobState } from "../state/jobState";
import { coverPages, hasExhibits, REPAIR_LIST_SECTIONS, reportSections } from "../pdf/renderReportHtml";
import { groupPhotos, selectedPhotoPaths } from "../pdf/photoGroups";
import { photoSelection } from "../state/selection";
import { productKeyFor } from "../draft/priorReport";
import { toLongPath } from "../util/longPath";

// PowerPoint export in Alfredo Resendiz's own deck format, so he can keep finishing reports the way
// he does today -- edit in PowerPoint, fix whatever the floor got wrong, then export. Every size,
// position and font below is measured off his Job 20564 I&A / Repair Report decks:
//   - portrait 7.5 × 10 in, Arial throughout
//   - cover: the big APG logo at (1.47, 0.14) 4.27 × 2.37, title 24pt bold, then 24pt bold
//     "Label:<tab>Value" rows; component-details slide the same under a small 20pt title
//   - content slides: small logo top-left (1.09 × 0.61) over a 7pt APG-blue (#0046A2) rule and a
//     7pt gray rule just below it, 20pt bold centered title
//   - Engineering Summary: 17pt bold opening paragraph, then 16.5pt body -- bold underlined
//     subheadings, "•" bullets; runs onto a second slide when long
//   - Repair Recommendations / Summary: 16pt, bold lead-in, bullets, one slide
//   - divider slides: 40pt bold centered title at y 3.55
//   - photo slides: 24pt bold title, 2 × 3 grid of 3.27 × 2.80 in photos
// The deck holds no exhibits -- like his, the DS sheets / NDT forms / charts go in when the PDF is
// built (finalFromDeck.ts inserts them after each divider slide).

const W = 7.5;
const H = 10;
const FONT = "Arial";
const APG_BLUE = "0046A2";
const LOGO = path.join(process.cwd(), "public", "apg-logo.jpg");

const PHOTO_SLOTS: Array<[number, number]> = [
  [0.23, 0.92],
  [3.99, 0.92],
  [0.23, 3.96],
  [3.99, 3.96],
  [0.23, 6.99],
  [3.99, 6.99],
];
const PHOTO_W = 3.27;
const PHOTO_H = 2.8;

type Pptx = InstanceType<typeof PptxGenJS>;
type Slide = ReturnType<Pptx["addSlide"]>;
type TextRun = { text: string; options?: Record<string, unknown> };

async function imageData(file: string, maxPx: number): Promise<{ data: string; w: number; h: number }> {
  const buffer = await sharp(toLongPath(file)).rotate().resize({ width: maxPx, height: maxPx, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer({ resolveWithObject: true });
  return { data: `image/jpeg;base64,${buffer.data.toString("base64")}`, w: buffer.info.width, h: buffer.info.height };
}

function defineMasters(pptx: Pptx, logo: string) {
  pptx.defineLayout({ name: "APG_PORTRAIT", width: W, height: H });
  pptx.layout = "APG_PORTRAIT";
  pptx.defineSlideMaster({
    title: "APG_COVER",
    background: { color: "FFFFFF" },
    objects: [{ image: { x: 1.47, y: 0.14, w: 4.27, h: 2.37, data: logo } }],
  });
  pptx.defineSlideMaster({
    title: "APG_CONTENT",
    background: { color: "FFFFFF" },
    objects: [
      { image: { x: 0, y: 0, w: 1.09, h: 0.61, data: logo } },
      { line: { x: 0.37, y: 0.66, w: 7.1, h: 0, line: { color: APG_BLUE, width: 7 } } },
      { line: { x: 0.49, y: 0.71, w: 7.0, h: 0, line: { color: "808080", width: 7, transparency: 15 } } },
    ],
  });
}

function addTitle(slide: Slide, title: string, size = 20) {
  slide.addText(title, { x: 1.1, y: 0.1, w: W - 2.2, h: 0.48, fontFace: FONT, fontSize: size, bold: true, align: "center", valign: "middle", color: "000000" });
}

/** "Label:<tab>Value" rows on one 3-inch tab stop -- how his cover pages line values up (he does it
 * with runs of default 1" tabs; one explicit stop gives the same column and stays put when edited). */
function fieldRuns(fields: Array<{ label: string; value: string }>, size: number, spaceAfter: number): TextRun[] {
  // His labels print gray, values black.
  return fields.flatMap(({ label, value }, i) => [
    { text: `${label.replace(/:?\s*$/, ":")}\t`, options: { bold: true, fontSize: size, fontFace: FONT, color: "7F7F7F", tabStops: [{ position: 3.0 }], paraSpaceAfter: spaceAfter } },
    { text: value || " ", options: { bold: true, fontSize: size, fontFace: FONT, color: "000000", breakLine: i < fields.length - 1 } },
  ]);
}

function addCover(pptx: Pptx, reportTitle: string, page1: Array<{ label: string; value: string }>, page2: Array<{ label: string; value: string }>) {
  const cover = pptx.addSlide({ masterName: "APG_COVER" });
  cover.addText(reportTitle, { x: 0, y: 3.15, w: W, h: 0.5, fontFace: FONT, fontSize: 24, bold: true, align: "center" });
  const size1 = page1.length > 9 ? 20 : 24;
  cover.addText(fieldRuns(page1, size1, page1.length > 8 ? 6 : 12), { x: 0.04, y: 4.1, w: W - 0.08, h: 5.7, valign: "top", color: "000000" });
  if (page2.length === 0) return;
  const details = pptx.addSlide({ masterName: "APG_CONTENT" });
  addTitle(details, reportTitle);
  const size2 = page2.length > 13 ? 18 : page2.length > 11 ? 20 : 24;
  details.addText(fieldRuns(page2, size2, page2.length > 11 ? 8 : 14), { x: 0, y: 0.79, w: W, h: 8.95, valign: "top", color: "000000" });
}

/** This app's narrative markup (see renderNarrative) as PowerPoint paragraphs. */
type Para = { kind: "lead" | "heading" | "bullet"; text: string };

function toParas(content: string): Para[] {
  const out: Para[] = [];
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("- ")) out.push({ kind: "bullet", text: line.slice(2) });
    else if (line.endsWith(":") && line.length <= 60 && !/^apg (recommends|performed)/i.test(line)) out.push({ kind: "heading", text: line });
    else out.push({ kind: "lead", text: line });
  }
  return out;
}

function runsFor(paras: Para[], size: number): TextRun[] {
  return paras.map((p, i) => {
    const last = i === paras.length - 1;
    if (p.kind === "bullet") return { text: p.text, options: { fontSize: size, fontFace: FONT, bullet: { indent: 10 }, breakLine: !last } };
    if (p.kind === "heading")
      return { text: p.text, options: { fontSize: size, fontFace: FONT, bold: true, underline: { style: "sng" }, paraSpaceBefore: i === 0 ? 0 : 10, breakLine: !last } };
    return { text: p.text, options: { fontSize: size, fontFace: FONT, bold: true, breakLine: !last } };
  });
}

/** Rough wrapped-line count at a font size over a box width -- Arial runs ≈0.46 em per char in
 * his kind of text (calibrated so his 30-line Repair Recommendations fit one slide at 16pt). */
function lineCount(paras: Para[], size: number, width: number): number {
  const charsPerLine = Math.max(20, Math.floor((width - 0.45) / ((size * 0.46) / 72)));
  return paras.reduce((n, p) => n + Math.max(1, Math.ceil(p.text.length / charsPerLine)) + (p.kind === "heading" ? 0.5 : 0), 0);
}

const linesFit = (height: number, size: number) => Math.floor(height / ((size * 1.17) / 72));

/** Engineering Summary layout: opening paragraph in its own 17pt bold box, body underneath, onto as
 * many continuation slides as needed -- breaking before a heading rather than right after one. */
function addSummarySlides(pptx: Pptx, title: string, content: string) {
  const paras = toParas(content);
  const firstHeading = paras.findIndex((p) => p.kind !== "lead");
  const opening = firstHeading === -1 ? paras : paras.slice(0, firstHeading);
  let body = firstHeading === -1 ? [] : paras.slice(firstHeading);
  const SIZE = 16.5;

  let first = true;
  do {
    const slide = pptx.addSlide({ masterName: "APG_CONTENT" });
    addTitle(slide, title);
    let top = 0.81;
    if (first && opening.length > 0) {
      const h = Math.min(2.6, 0.3 + (lineCount(opening, 17, W) * 17 * 1.2) / 72);
      slide.addText(runsFor(opening, 17), { x: 0, y: top, w: W, h, valign: "top", color: "000000" });
      top += h + 0.1;
    }
    first = false;
    if (body.length === 0) break;
    const capacity = linesFit(H - 0.15 - top, SIZE);
    let used = 0;
    let take = 0;
    while (take < body.length) {
      const n = lineCount([body[take]], SIZE, W);
      if (used + n > capacity && take > 0) break;
      used += n;
      take++;
    }
    // Don't strand a heading at the bottom of a slide.
    while (take > 1 && take < body.length && body[take - 1].kind === "heading") take--;
    slide.addText(runsFor(body.slice(0, take), SIZE), { x: 0, y: top, w: W, h: H - 0.15 - top, valign: "top", color: "000000" });
    body = body.slice(take);
  } while (body.length > 0);
}

/** Repair Recommendations / Repair Summary: one slide, 16pt like his, shrinking (to 11pt) before
 * spilling onto a second slide. */
function addRepairListSlides(pptx: Pptx, title: string, content: string) {
  let paras = toParas(content);
  const top = 0.78;
  const height = H - 0.15 - top;
  let size = 16;
  while (size > 11 && lineCount(paras, size, W) > linesFit(height, size)) size -= 0.5;
  while (paras.length > 0) {
    const slide = pptx.addSlide({ masterName: "APG_CONTENT" });
    addTitle(slide, title);
    const capacity = linesFit(height, size);
    let used = 0;
    let take = 0;
    while (take < paras.length) {
      const n = lineCount([paras[take]], size, W);
      if (used + n > capacity && take > 0) break;
      used += n;
      take++;
    }
    while (take > 1 && take < paras.length && paras[take - 1].kind === "heading") take--;
    slide.addText(runsFor(paras.slice(0, take), size), { x: 0, y: top, w: W, h: height, valign: "top", color: "000000" });
    paras = paras.slice(take);
  }
}

/** "Incoming Dimensional Sheets" → two lines like his ("Incoming" / "Dimensional Sheets"). */
function addDivider(pptx: Pptx, title: string) {
  const slide = pptx.addSlide({ masterName: "APG_CONTENT" });
  const m = title.match(/^(Incoming|Final)\s+(.{12,})$/);
  const runs: TextRun[] = m
    ? [
        { text: m[1], options: { breakLine: true } },
        { text: m[2], options: {} },
      ]
    : [{ text: title }];
  slide.addText(runs, { x: 0, y: 3.55, w: W, h: 1.45, fontFace: FONT, fontSize: 40, bold: true, align: "center", valign: "middle", color: "000000" });
}

async function addPhotoSlides(pptx: Pptx, section: SectionScanResult, scan: JobScanResult, state: JobState) {
  const paths = selectedPhotoPaths(section, photoSelection(state.sections[section.id], scan.reportType));
  for (const group of groupPhotos(paths)) {
    for (let i = 0; i < group.paths.length; i += PHOTO_SLOTS.length) {
      const slide = pptx.addSlide({ masterName: "APG_CONTENT" });
      addTitle(slide, group.label, 24);
      const batch = group.paths.slice(i, i + PHOTO_SLOTS.length);
      const images = await Promise.all(batch.map((p) => imageData(path.join(scan.jobRoot, p), 1600).catch(() => null)));
      images.forEach((img, k) => {
        if (!img) return;
        const [x, y] = PHOTO_SLOTS[k];
        // Fit inside the 3.27 × 2.80 slot, centered, keeping the photo's own aspect ratio.
        const scale = Math.min(PHOTO_W / img.w, PHOTO_H / img.h);
        const w = img.w * scale;
        const h = img.h * scale;
        slide.addImage({ data: img.data, x: x + (PHOTO_W - w) / 2, y: y + (PHOTO_H - h) / 2, w, h });
      });
    }
  }
}

/** His file naming: "20564 Calpine F7FA S1N IA Report.pptx" / "... Repair Report.pptx". */
export function deckFileName(scan: JobScanResult): string {
  const m = scan.metadata;
  const key = productKeyFor(m);
  // His file-name codes: "S1N" nozzles, "R3V" vanes, "INSR" inner support rings, "Vane Carrier" /
  // "R1V Carrier Segments" carriers.
  const code =
    key?.kind === "support-ring"
      ? "INSR"
      : key?.kind === "vane-carrier"
        ? key.stage
          ? `R${key.stage}V Carrier Segments`
          : "Vane Carrier"
        : key?.stage
          ? key.kind === "vane"
            ? `R${key.stage}V`
            : `S${key.stage}N`
          : "";
  const customer = m.customer.replace(/\b([a-z])/gi, (c) => c.toUpperCase());
  const kind = /repair/i.test(scan.reportType) ? "Repair Report" : "IA Report";
  return [m.jobNumber, customer, m.turbineModel, code, kind].filter(Boolean).join(" ").replace(/[\\/:*?"<>|]+/g, "-") + ".pptx";
}

export async function buildDeck(scan: JobScanResult, state: JobState): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.author = state.sections.cover?.fields?.techRep || scan.metadata.techRep || "Allied Power Group";
  pptx.company = "Allied Power Group";
  pptx.title = `${scan.metadata.jobNumber} ${scan.reportType}`;
  const logo = `image/jpeg;base64,${(await fs.readFile(LOGO)).toString("base64")}`;
  defineMasters(pptx, logo);

  // Standard fields stay on the slides even when blank ("Coating:", "Prior Hours:") -- he fills
  // them in right in PowerPoint.
  const { page1, page2 } = coverPages(scan, state, { keepBlankStandard: true });
  addCover(pptx, scan.reportType, page1, page2);

  for (const section of reportSections(scan, state)) {
    if (section.beforeCover) continue; // customer pages go in the PDF only
    const content = state.sections[section.id]?.content ?? "";
    if (section.generation === "llm-narrative") {
      if (!content.trim()) continue;
      if (REPAIR_LIST_SECTIONS.has(section.id)) addRepairListSlides(pptx, section.title, content);
      else addSummarySlides(pptx, section.title, content);
      continue;
    }
    if (section.generation === "llm-vision-select") {
      if (selectedPhotoPaths(section, photoSelection(state.sections[section.id], scan.reportType)).length === 0) continue;
      if (section.divider) addDivider(pptx, section.title);
      await addPhotoSlides(pptx, section, scan, state);
      continue;
    }
    if (section.divider && hasExhibits(section, state)) addDivider(pptx, section.title);
  }

  const out = await pptx.write({ outputType: "nodebuffer" });
  return Buffer.from(out as Uint8Array);
}
