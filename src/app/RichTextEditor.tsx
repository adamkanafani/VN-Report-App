"use client";

import { useEffect, useRef, useState } from "react";
import { inlineHtml, isHeadingLine } from "@/lib/draft/inlineFormat";

// A Word-style box for the narrative sections: Bold / Underline / Italic (buttons or Ctrl+B / U /
// I), bullet lists and subheadings, shown as they'll print. What's saved is still the app's
// line-based markup (a "- " bullet, a "Heading:" line, plain paragraphs) with **bold** /
// __underline__ / //italic// markers inside lines (see inlineFormat.ts), so the PDF, the
// PowerPoint and Claude's revisions all keep working on the same text.

type Style = { b: boolean; u: boolean; i: boolean };
type Run = Style & { text: string };

/** Markup → the editor's HTML: <ul><li> for bullets, <p class="rt-heading"> for subheadings. */
export function markupToHtml(markup: string): string {
  const out: string[] = [];
  let list = false;
  for (const raw of markup.split("\n")) {
    const line = raw.trim();
    if (!line) {
      if (list) out.push("</ul>");
      list = false;
      continue;
    }
    if (line.startsWith("- ")) {
      if (!list) out.push("<ul>");
      list = true;
      out.push(`<li>${inlineHtml(line.slice(2)) || "<br>"}</li>`);
      continue;
    }
    if (list) out.push("</ul>");
    list = false;
    out.push(`<p${isHeadingLine(line) ? ' class="rt-heading"' : ""}>${inlineHtml(line)}</p>`);
  }
  if (list) out.push("</ul>");
  return out.join("") || "<p><br></p>";
}

function styleOf(el: HTMLElement, st: Style): Style {
  let { b, u, i } = st;
  const tag = el.tagName;
  if (tag === "B" || tag === "STRONG") b = true;
  if (tag === "U") u = true;
  if (tag === "I" || tag === "EM") i = true;
  const s = el.style;
  if (s.fontWeight) b = s.fontWeight === "bold" || s.fontWeight === "bolder" || Number(s.fontWeight) >= 600;
  const deco = `${s.textDecoration} ${s.textDecorationLine}`;
  if (deco.trim()) u = /underline/.test(deco);
  if (s.fontStyle) i = s.fontStyle === "italic";
  return { b, u, i };
}

const isList = (n: Node) => n.nodeName === "UL" || n.nodeName === "OL";

function collectRuns(node: Node, st: Style, runs: Run[]) {
  node.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) runs.push({ text: (child.textContent ?? "").replace(/ /g, " "), ...st });
    else if (child.nodeType === Node.ELEMENT_NODE && !isList(child)) {
      const el = child as HTMLElement;
      if (el.tagName === "BR") runs.push({ text: "\n", ...st });
      else collectRuns(el, styleOf(el, st), runs);
    }
  });
}

/** Runs → text with a marker wherever a style turns on or off (whitespace never toggles one). */
function runsToMarkup(runs: Run[]): string {
  let out = "";
  const cur: Style = { b: false, u: false, i: false };
  const set = (key: keyof Style, on: boolean, marker: string) => {
    if (cur[key] !== on) {
      out += marker;
      cur[key] = on;
    }
  };
  for (const r of runs) {
    if (!r.text) continue;
    if (r.text.trim()) {
      set("i", r.i, "//");
      set("u", r.u, "__");
      set("b", r.b, "**");
    }
    out += r.text;
  }
  set("i", false, "//");
  set("u", false, "__");
  set("b", false, "**");
  return out;
}

const BLOCKS = new Set(["P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE"]);

/** The editor's HTML → markup. */
export function editorToMarkup(root: HTMLElement): string {
  const lines: string[] = [];
  const push = (line: string) => {
    if (line.trim()) lines.push(line.trim());
  };
  const blockText = (el: HTMLElement) => {
    const runs: Run[] = [];
    collectRuns(el, styleOf(el, { b: false, u: false, i: false }), runs);
    return runsToMarkup(runs);
  };
  const walk = (parent: Node) => {
    parent.childNodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) return push(node.textContent ?? "");
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node as HTMLElement;
      if (isList(el)) {
        if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
        el.querySelectorAll(":scope > li").forEach((li) => {
          const text = blockText(li as HTMLElement).replace(/\s*\n\s*/g, " ").trim();
          if (text) lines.push(`- ${text}`);
          li.querySelectorAll(":scope > ul, :scope > ol").forEach((nested) => walk({ childNodes: [nested] } as unknown as Node));
        });
        lines.push("");
        return;
      }
      if (BLOCKS.has(el.tagName) && [...el.children].some((c) => BLOCKS.has(c.tagName) || isList(c))) return walk(el);
      const heading = el.classList.contains("rt-heading");
      for (const part of blockText(el).split("\n")) {
        let line = part.trim();
        if (!line) continue;
        if (heading && !line.replace(/\*\*|__|\/\//g, "").trim().endsWith(":")) line = `${line}:`;
        if (heading && lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
        push(line);
      }
    });
  };
  walk(root);
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

export function RichTextEditor({ initialValue, onChange, placeholder }: { initialValue: string; onChange: (markup: string) => void; placeholder?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<Style & { list: boolean }>({ b: false, u: false, i: false, list: false });

  useEffect(() => {
    // Set once per mount -- the parent remounts this (by key) when the text is replaced wholesale.
    if (ref.current) ref.current.innerHTML = initialValue.trim() ? markupToHtml(initialValue) : "";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const update = () => {
      if (!ref.current || !ref.current.contains(document.getSelection()?.anchorNode ?? null)) return;
      setActive({
        b: document.queryCommandState("bold"),
        u: document.queryCommandState("underline"),
        i: document.queryCommandState("italic"),
        list: document.queryCommandState("insertUnorderedList"),
      });
    };
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, []);

  const changed = () => ref.current && onChange(editorToMarkup(ref.current));
  const command = (name: string) => {
    ref.current?.focus();
    document.execCommand(name);
    changed();
  };
  // Subheading on / off for the paragraph the cursor is in (bold + underlined, ends in a colon).
  const toggleHeading = () => {
    const node = document.getSelection()?.anchorNode ?? null;
    const block = (node?.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node?.parentElement)?.closest("p, div");
    if (!block || !ref.current?.contains(block) || block === ref.current) return;
    block.classList.toggle("rt-heading");
    changed();
  };

  const button = (label: React.ReactNode, title: string, on: boolean, act: () => void) => (
    <button
      type="button"
      className={`rt-button ${on ? "on" : ""}`}
      title={title}
      // mousedown, not click: keeps the text selection in the editor.
      onMouseDown={(e) => {
        e.preventDefault();
        act();
      }}
    >
      {label}
    </button>
  );

  return (
    <div className="rt-wrap">
      <div className="rt-toolbar">
        {button(<strong>B</strong>, "Bold (Ctrl+B)", active.b, () => command("bold"))}
        {button(<u>U</u>, "Underline (Ctrl+U)", active.u, () => command("underline"))}
        {button(<em>I</em>, "Italic (Ctrl+I)", active.i, () => command("italic"))}
        <span className="rt-sep" />
        {button("• Bullets", "Bulleted list on / off", active.list, () => command("insertUnorderedList"))}
        {button("Heading", "Make this line a subheading (bold, underlined, ends with a colon)", false, toggleHeading)}
      </div>
      <div
        ref={ref}
        className="rt-editor"
        contentEditable
        suppressContentEditableWarning
        data-placeholder={placeholder}
        onFocus={() => document.execCommand("defaultParagraphSeparator", false, "p")}
        onInput={changed}
        onPaste={(e) => {
          // Pasted Word / Outlook text keeps its bold, underline, italics and bullets, nothing else
          // (fonts, colors, sizes) -- run through the same markup the report prints from.
          e.preventDefault();
          const html = e.clipboardData.getData("text/html");
          const text = e.clipboardData.getData("text/plain");
          let markup = text;
          if (html) {
            const holder = document.createElement("div");
            holder.innerHTML = html;
            holder.querySelectorAll("style, script, meta, title").forEach((n) => n.remove());
            markup = editorToMarkup(holder);
          }
          const pasted = markup.includes("\n") ? markupToHtml(markup) : markupToHtml(markup).replace(/^<p>|<\/p>$/g, "");
          document.execCommand("insertHTML", false, pasted);
          changed();
        }}
      />
    </div>
  );
}
