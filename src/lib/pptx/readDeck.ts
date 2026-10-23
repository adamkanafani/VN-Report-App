import JSZip from "jszip";

// Minimal reader for the text structure of a .pptx -- enough to (a) lift the Engineering Summary /
// Repair Recommendations wording out of a past report deck (see priorReport.ts) and (b) find the
// divider slides in a tech rep's edited deck so exhibits can be inserted after them (see
// finalFromDeck.ts). Regex over the slide XML rather than a full XML parser: the parts needed are
// few and their shape is fixed by the OOXML spec (<p:sp> shapes, <a:p> paragraphs, <a:r> runs).

export interface DeckParagraph {
  text: string;
  bold: boolean;
  underline: boolean;
}

export interface DeckShape {
  /** Top-left position in inches (0 when the shape inherits its position from the layout). */
  x: number;
  y: number;
  paragraphs: DeckParagraph[];
}

export interface DeckSlide {
  /** 1-based position in the presentation. */
  number: number;
  /** Hidden slides are skipped by PowerPoint's PDF export, so they never become a page. */
  hidden: boolean;
  shapes: DeckShape[];
  /** All the slide's text, whitespace-collapsed -- for matching divider titles. */
  text: string;
}

const EMU_PER_INCH = 914400;

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

function parseParagraph(xml: string): DeckParagraph {
  let text = "";
  let boldChars = 0;
  let underlineChars = 0;
  let counted = 0;
  // Runs, fields and line breaks in document order.
  for (const m of xml.matchAll(/<a:(r|fld)\b[^>]*>([\s\S]*?)<\/a:\1>|<a:br\b[^>]*\/?>/g)) {
    if (!m[1]) {
      text += " ";
      continue;
    }
    const body = m[2];
    const t = [...body.matchAll(/<a:t>([\s\S]*?)<\/a:t>|<a:t\/>/g)].map((x) => decodeXml(x[1] ?? "")).join("");
    const rPr = body.match(/<a:rPr\b[^>]*>/)?.[0] ?? "";
    const visible = t.trim().length;
    if (visible > 0) {
      counted += visible;
      if (/\bb="1"/.test(rPr)) boldChars += visible;
      if (/\bu="(sng|dbl|heavy|words)/.test(rPr)) underlineChars += visible;
    }
    text += t;
  }
  return { text, bold: counted > 0 && boldChars * 2 >= counted, underline: counted > 0 && underlineChars * 2 >= counted };
}

function parseShape(xml: string): DeckShape {
  const off = xml.match(/<a:off\s+x="(-?\d+)"\s+y="(-?\d+)"/);
  const paragraphs = [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>|<a:p\/>/g)].map((m) => (m[1] === undefined ? { text: "", bold: false, underline: false } : parseParagraph(m[1])));
  return { x: off ? Number(off[1]) / EMU_PER_INCH : 0, y: off ? Number(off[2]) / EMU_PER_INCH : 0, paragraphs };
}

/** Slides in presentation order with their text shapes. */
export async function readDeck(data: Buffer | Uint8Array): Promise<DeckSlide[]> {
  const zip = await JSZip.loadAsync(data);
  const presentation = (await zip.file("ppt/presentation.xml")?.async("string")) ?? "";
  const rels = (await zip.file("ppt/_rels/presentation.xml.rels")?.async("string")) ?? "";
  const targetById = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = m[0].match(/\bId="([^"]+)"/)?.[1];
    const target = m[0].match(/\bTarget="([^"]+)"/)?.[1];
    if (id && target) targetById.set(id, target.replace(/^\/?ppt\//, ""));
  }
  const slideIds = [...presentation.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)].map((m) => m[1]);

  const slides: DeckSlide[] = [];
  for (const [i, rId] of slideIds.entries()) {
    const target = targetById.get(rId);
    const xml = target ? await zip.file(`ppt/${target}`)?.async("string") : undefined;
    if (!xml) continue;
    const hidden = /<p:sld\b[^>]*\bshow="0"/.test(xml);
    const shapes = [...xml.matchAll(/<p:sp>([\s\S]*?)<\/p:sp>/g)].map((m) => parseShape(m[1])).filter((s) => s.paragraphs.some((p) => p.text.trim()));
    const text = shapes
      .flatMap((s) => s.paragraphs.map((p) => p.text))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    slides.push({ number: i + 1, hidden, shapes, text });
  }
  return slides;
}

/** A slide's title: the text of its topmost shape, when that shape sits in the header band (his
 * content slides put the 20pt title at y≈0.13–0.14 in, above the letterhead rules). */
export function slideTitle(slide: DeckSlide): string {
  const top = [...slide.shapes].sort((a, b) => a.y - b.y)[0];
  if (!top || top.y > 0.75) return "";
  return top.paragraphs
    .map((p) => p.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
