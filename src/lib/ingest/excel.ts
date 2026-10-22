import ExcelJS from "exceljs";
import { toLongPath } from "../util/longPath";

/** Load a workbook from disk. Works for .xlsx and .xlsm (macros are ignored, we only read cells).
 * Reads via the extended-length path form -- see toLongPath's own comment -- since a real job
 * folder's own path plus a source workbook's verbose real filename routinely breaches Windows'
 * classic 260-character limit, and this is the single most-shared read path in the app (every
 * table/router parser goes through it). */
export async function loadWorkbook(absolutePath: string): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(toLongPath(absolutePath));
  return workbook;
}

/** Coerce a cell value to a plain string, resolving formula results and rich text. */
export function cellText(cell: ExcelJS.Cell | undefined): string {
  if (!cell) return "";
  const v = cell.value as unknown;
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    const anyV = v as { richText?: { text: string }[]; result?: unknown; text?: string; error?: string };
    if (anyV.richText) return anyV.richText.map((r) => r.text).join("");
    if (anyV.error) return "";
    if (typeof anyV.result === "number" || typeof anyV.result === "string") return String(anyV.result);
    if (typeof anyV.text === "string") return anyV.text;
    if (v instanceof Date) return v.toISOString();
    return "";
  }
  return String(v).trim();
}

/** Coerce a cell value to a number if possible, else null. Resolves formula results. */
export function cellNumber(cell: ExcelJS.Cell | undefined): number | null {
  if (!cell) return null;
  const v = cell.value as unknown;
  if (typeof v === "number") return v;
  if (typeof v === "object" && v !== null) {
    const anyV = v as { result?: unknown };
    if (typeof anyV.result === "number") return anyV.result;
  }
  const text = cellText(cell);
  if (text === "") return null;
  const stripped = text.replace(/[^0-9.+-]/g, "");
  // A label like "Minimum Limits:" strips down to "", and Number("") is 0 -- not NaN -- so
  // without this check a purely non-numeric cell would silently read as a real zero instead of
  // "not a number" (confirmed by a real bug: wallThickness's dynamic search for minimum-limit
  // rows walked straight through a text-only header row because every one of its cells came back
  // as a valid-looking 0 rather than null).
  if (!/\d/.test(stripped)) return null;
  const n = Number(stripped);
  return Number.isFinite(n) ? n : null;
}

/**
 * True if a cell's raw XML-level value looks like a bare shared-string index that never got
 * resolved to text (the router-workbook macro/external-link caching artifact) — a plain
 * integer sitting where a multi-word phrase is expected. Heuristic: exceljs already resolves
 * shared strings correctly in the vast majority of cases; this catches the residual case where
 * a cell that should be a note (given its neighbor is a real label) evaluates as a short numeric
 * string instead of prose.
 */
export function looksLikeUnresolvedPlaceholder(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "") return false;
  return /^\d+$/.test(trimmed) && trimmed.length <= 6;
}
