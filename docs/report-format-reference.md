# V&N report format — measured reference

Measured off Adan Aguirre's finished 20992 I&A (`7 Reports\7A Inspection Report\20992 ST-GT2 CM2 R1 CD EQ#10956713 IA Report.pdf`)
and checked line by line against the app's output for the same job. All values in pt on the report's own page.
The app (`src/lib/pdf/renderReportHtml.ts`, `htmlToPdf.ts`) is built to these numbers.
Re-measure against a new author's report before changing any of them.

## Pages

- **Own pages:** the tech reps' own pages are **540 × 720 pt (7.5 × 10 in)**, edge to edge, which is their PowerPoint slide size. This covers the cover, summaries, dividers and photos.
- **Exhibits:** exhibit sheets copied in (DS forms, NDT forms, customer pages) keep their own size, usually Letter.
- **Fonts and color:** Arial / Arial Bold throughout. Body text is pure black `#000000`.

## Page header (every page after the cover, dividers included)

| Item | Value |
|---|---|
| Logo | 79 × 44 pt at (0, 0) |
| Title | bold black, centered on the full width; 24 pt on photo pages (top of text at 6.8), 20 pt elsewhere (top at 11.9) |
| Bars | blue `#0046A2` 7 pt bar centered at y 47.4 from x 26.75 → 538, over a gray `#7F7F7F` 7 pt bar centered at y 51.1 from x 35 → 539 |
| Dividers | header with no title; block title 40 pt bold black, centered, top at 256; "Incoming / Final X" split over two lines (48 pt apart) |

## Cover (page 1)

| Item | Value |
|---|---|
| Logo | 308 × 170 pt, centered, top at 10 |
| Report title | "Incoming Report" / "Repair Report", 24 pt bold black, centered, top at 183.7 |
| Rows | 24 pt bold; labels gray `#7F7F7F` at x 7.2, values black at x 223.2; first row top at 249.1; line spacing 1.2 × size, with a blank line between rows (57.6 pt pitch at 24 pt) |
| Labels | exactly as the author writes them, colon or not (Adan: `Unit#` without a colon, `Prior Repair:`). Learned from the author's last report (`fieldLabelsExact`) |
| EQ# | Adan puts it under the PO number (`TM020-… / EQ#: 10956713`), not on a row of its own (`assetWithPO`) |
| Line breaks | a value breaks where the author broke it (tabs inside a value in the deck): `W501F Row 1 CM2 / Compressor Diaphragm` |

## Cover details page (page 2)

- **Layout:** page header (title = report name, 20 pt), then the rows from y 57.5. Same columns and colors as page 1.
- **Text size:** shrinks from 24 pt in 0.5 pt steps until every row fits above **y 697.5**. 20992, with 10 serial numbers, lands on 20.5 pt, the same as Adan's.

## Engineering summary / repair lists

| Item | Value |
|---|---|
| Opening paragraph | 17 pt bold, top of first line at 57.9, line pitch 20.4 (1.2 ×) |
| Subheadings | 17 pt bold, underlined; a blank line (≈20 pt) above |
| Bullets | 15.5 pt regular (16 pt in repair lists), pitch 1.2 ×; the dot at x 7.2, the text at x 29.8 (hanging) |
| Repair list | lead-in "APG recommends the following repairs:" 17 pt bold, top at 65.9; first bullet 40 pt below |
| Overflow | a section that doesn't fit continues on the next page under the same header; nothing is shrunk to fit |

## Photo pages

- **Grid:** six per page, 2 across × 3 down; each photo **246 × 206 pt**, filling its slot (cropped, not shrunk). Columns at x 18 and 277, rows at y 67, 285, 503.
- **Group titles:**
  - "Shipping Photos", "NDT Photos", "Incoming Photos", "Final Photos".
  - A part name in brackets only when the NDT folder names a part, e.g. "(Segments)", "(Cores & Covers)".
  - A folder named after the component itself, like `NDT-1\CM2`, is just "NDT Photos".

## Known differences left on purpose

- **Unit# value position:** on Adan's cover the `Unit#` value sits at x 151 instead of 223, a tab-stop quirk in his deck. The app keeps the same value column for every row.
- **Cover date:** the app uses the day the report was started in the app, editable on the cover. A rebuilt old job shows today's date, not the original report date.
