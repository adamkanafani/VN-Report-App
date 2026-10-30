// Inline formatting inside the narrative markup (see renderNarrative): **bold**, __underline__ and
// //italic//, nestable ("**__Note:__**"). The review screen's editor shows them as real
// formatting and writes them back as these markers, and the PDF and PowerPoint both read them, so
// what the tech rep bolds or underlines in the app is what prints. Plain text with none of them
// renders exactly as before. Kept free of server-only imports -- the editor uses it too.

export interface InlineRun {
  text: string;
  bold: boolean;
  underline: boolean;
  italic: boolean;
}

const MARKERS: Array<[string, "bold" | "underline" | "italic"]> = [
  ["**", "bold"],
  ["__", "underline"],
  ["//", "italic"],
];

/** A line's text split into runs, each marker toggling its style on or off. */
export function parseInline(text: string): InlineRun[] {
  const runs: InlineRun[] = [];
  const style = { bold: false, underline: false, italic: false };
  let buf = "";
  const flush = () => {
    if (buf) runs.push({ text: buf, ...style });
    buf = "";
  };
  for (let i = 0; i < text.length; ) {
    const marker = MARKERS.find(([m]) => text.startsWith(m, i));
    // "//" right after a colon is a URL ("https://"), not italic.
    if (marker && !(marker[0] === "//" && text[i - 1] === ":")) {
      flush();
      style[marker[1]] = !style[marker[1]];
      i += 2;
    } else {
      buf += text[i++];
    }
  }
  flush();
  return runs;
}

/** The text with the markers taken out -- for length checks and "ends with a colon" tests. */
export function stripInline(text: string): string {
  return parseInline(text)
    .map((r) => r.text)
    .join("");
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The line as HTML: escaped text in <strong> / <u> / <em>. */
export function inlineHtml(text: string): string {
  return parseInline(text)
    .map((r) => {
      let html = escapeHtml(r.text);
      if (r.italic) html = `<em>${html}</em>`;
      if (r.underline) html = `<u>${html}</u>`;
      if (r.bold) html = `<strong>${html}</strong>`;
      return html;
    })
    .join("");
}

/** A short line ending in a colon is a subheading ("Dimensional:") -- see renderNarrative. */
export function isHeadingLine(line: string): boolean {
  const plain = stripInline(line).trim();
  return plain.endsWith(":") && plain.length <= 60;
}
