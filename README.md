# Vanes & Nozzles Report Builder

The Vanes & Nozzles (V&N) version of APG's report builder. It uses the same shell, look and workflow as the Tech Rep (buckets) Report Builder, built around how the V&N team finishes reports: **in PowerPoint**.

The two report types are:
- **I&A Report** → the **"Incoming Report"** (inspect & advise)
- **Final Report** → the **"Repair Report"** (the completion deliverable)

## Workflow

1. **Pick the report type and the job folder.** The app scans the folder, finds every exhibit and drafts the narrative sections.
2. **Review in the app.** Tick, untick and reorder exhibits, check the drafts, fill in the cover.
3. **1. Download PowerPoint.** This gives an editable deck in Alfredo Resendiz's own format:
   - cover and component-details slides
   - Incoming Engineering Summary
   - Repair Recommendations / Repair Summary
   - a divider slide per exhibit block
   - photo slides, 6 per slide
4. **Edit the deck in PowerPoint** as usual: fix anything the floor got wrong, add customer-specific lines, move photos. Save it.
5. **2. Build PDF from edited PowerPoint….** Pick the saved deck:
   - PowerPoint exports it.
   - The app inserts every block's real completed forms (DS sheets, NDT reports, heat treat charts, coating cert, …) right after that block's divider slide.
   - Customer front pages (e.g. Calpine's Repair Detail Summary) go ahead of the cover.
   - Divider slides are found by their text, so **keep each divider's title as generated**. Everything else in the deck can be edited, reordered or deleted.

**Quick PDF** skips the PowerPoint step and builds the PDF straight from the app.

## Setup

```bash
npm install
npm run dev -- -p 3001
```

Open http://localhost:3001. Port 3001 lets it run next to the Tech Rep app, which uses 3000. For day-to-day use, see `SETUP.md`: double-click `Setup - Run This First.bat` once, then `Start Report Builder.bat`.

Requirements:
- **Chrome or Edge**, for PDF rendering.
- **Desktop PowerPoint**, for "Build PDF from edited PowerPoint".
- **Desktop Excel**, only for exhibits that exist only as `.xlsx` (common for final DS sheets). They're printed through Excel; without it they're listed as skipped.
- `ANTHROPIC_API_KEY` is optional:
  - It's only used for "Revise with instruction" and for photo duplicate/blur screening.
  - Without it, scanning, every draft and both exports work normally.

## How the drafts are made

**Starting from the last report of the same product.** Alfredo's reports reuse most of their wording per product:
- Across 9 F7EA 1st stage nozzle I&A reports, 21 Repair Recommendations lines appear in every one, and 85–95% of each list is shared.
- The Engineering Summary has the same subheadings every time, with many findings repeated word for word.

So for a new job the app finds the **most recent finished report deck of the same model and stage/row** in the same Working Jobs tree, and starts from its wording (`src/lib/draft/priorReport.ts`).

**Then this job's values are filled in** (`src/lib/ingest/measurements.ts`), all confirmed against Job 20564:
- **Received date:** from the 3A Incoming\Shipping folder name, e.g. "… 03-18-26" → 3/18/2026.
- **Total area deviation and throat range:** from the area-check workbook (DS-0045 / 0337 / 0346 / 0388 / 0945) in 7A.
- **Flow ranges (OD T/E, ID L/E):** from the incoming airflow workbook's "Range:" cells.

**Every other job-specific value** from the old report (counts like "Twenty one (21)", inch readings) is kept but wrapped in **[brackets]**, so it gets checked.

**The Repair Summary is this job's own Repair Recommendations in the past tense**, line for line, exactly how Alfredo writes it. On his 20564 report, 17 of 17 lines match.

**Fallback:** with no earlier report of the same product, the drafts come from the job's I&A and repair routers instead. Each narrative section shows where its draft came from, with **Start over from last report** and **Start over from router** buttons.

## Report structure

Section lists live in `src/lib/report-templates/` and the file-matching rules in `vn-rules.ts`. They follow Alfredo's 20564 decks.

**Incoming Report:**
1. Customer pages (before the cover)
2. Cover + component details
3. Incoming Engineering Summary
4. Repair Recommendations
5. Then, each behind a divider:
   - Serial Number List
   - Incoming Dimensional Sheets
   - Incoming NDT Reports
   - Incoming Photographs
   - Incoming Air Flow
   - Heat Treat Charts
   - Metallurgical Sample Analysis

**Repair Report:**
1. Customer pages
2. Cover + component details
3. Incoming Engineering Summary
4. Serial Number List
5. Repair Summary
6. Then, each behind a divider:
   - Final Dimensional Sheets
   - Final NDT Report
   - Final Photographs
   - Air Flow Test
   - Heat Treat Charts
   - Coating Certification

The incoming exhibit blocks are also available in the Repair Report. Some of his reports repeat them (Job 20505), others don't (Job 20564), so they start out left out and can be added back from the sidebar.

**Adding your own section.** "+ Add section" at the bottom of the sidebar adds a block with any title (e.g. "Eddy Current Map"):
- Attach its file(s) in the section's panel. PDFs go in as-is; Excel files are printed through Excel.
- It prints like every built-in block: its own divider page/slide, then the files.
- It can be renamed, reordered, left out or deleted like any other section.
- It's saved per job and per report type.

Details:
- **Serial Number List:** the real completed DS-0404 form, previewed in the review screen and embedded as-is behind its divider, the same as the other data sheets. The standard incoming PDF is picked by default; other copies (the working .xlsx, a field-service print) are listed one click away. A list that only exists as an Excel file is printed through Excel.
- **Cover fields:** his labels, including **Asset#** (read from the "EQ 10925569" in Calpine folder names) and a separate **Customer** on the details page (20564's cover says Zion Gas, the details page says Calpine). Blank standard fields stay in the PowerPoint so they can be filled in there.
- **Photo slides:** titled by folder the way he titles them: Shipping Photos, NDT Photos (Segments / Ret. Ring / Cores & Covers / …), Final Photos. Shipping photos are capped at one slide (6) by default.
- **Field-service copies:** "… FS.pdf" files beside the standard file are collapsed into it.
- **Heat treat charts:** print in the order the cycles ran (by file date).

## Where job-review state lives

Per-job edits, drafts and selections are saved to `%LOCALAPPDATA%\VNReportApp\jobs\<hash>.json`, keyed by the job folder's path:
- The Incoming and Repair reports share one job's state, so the summary, cover and exhibit picks carry over. Each report keeps its own page order.
- Nothing is written into the job folder except files attached manually (`_Manual Attachments\`).
- Excel-printed exhibits and deck exports are made under `%TEMP%`.
