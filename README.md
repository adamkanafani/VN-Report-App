# Vanes & Nozzles Report Builder

The Vanes & Nozzles (V&N) version of APG's report builder. It uses the same shell, look and workflow as the Tech Rep (buckets) Report Builder.

To use it, pick a report type, point the app at a V&N job folder, review what it found and drafted, and export the finished PDF:

- **I&A Report** → the **"Incoming Report"** (inspect & advise)
- **Final Report** → the **"Repair Report"** (the completion deliverable)

## Setup

```bash
npm install
npm run dev -- -p 3001
```

Open http://localhost:3001. Port 3001 lets it run next to the Tech Rep app, which uses 3000. For day-to-day use, see `SETUP.md`: double-click `Setup - Run This First.bat` once, then `Start Report Builder.bat`.

`ANTHROPIC_API_KEY` is optional. Without it:
- Scanning, every draft, and PDF export work normally.
- Photo screening includes every photo instead of filtering out duplicates and blurry shots.
- "Revise with instruction" is unavailable.

**PDF export** needs Chrome or Edge.

**Excel-only exhibits** need desktop Excel. These are DS sheets or NDT forms that exist only as `.xlsx`, which is common for final-stage sheets. They're printed to PDF through Excel when the report is generated. Without Excel they're listed as skipped after export.

## What it's built from

The section lists, file-matching rules and draft wording come from a survey of real V&N job folders and their finished reports:
- GE 1st, 2nd and 3rd stage nozzles: Jobs 20312, 20505, 20564, 20978, 20174, 18042
- Siemens/Westinghouse and Alstom vanes: Jobs 19512, 20321, 20342

All of these use the standard job-folder template (`3 Pictures\3A Incoming\…`, `7 Reports\7A…7E`, `9 Coating`). The section lists live in `src/lib/report-templates/` and the matching rules in `vn-rules.ts`.

**Incoming Report:**
1. Cover + component details
2. Incoming Engineering Summary
3. Repair Recommendations
4. Then, each behind a divider page:
   - Serial Number List
   - Incoming Dimensional Sheets
   - Incoming NDT Reports
   - Incoming Photographs
   - Heat Treat Chart
   - Metallurgical Sample Analysis

**Repair Report:**
1. Cover
2. Incoming Engineering Summary (repeated)
3. Serial Number List
4. The incoming exhibit blocks again: dimensional sheets, NDT reports, photographs and met analysis
5. Repair Summary
6. Final Dimensional Sheets
7. Final NDT Reports
8. Final Photographs
9. Air Flow Test
10. Heat Treat Charts
11. Coating Certification

Any section can be dropped with the ✕ on its sidebar tab, or dragged to a new position.

## Where each section comes from

- **Cover:** the folder name and `JOB TAG.xlsx`. Tech Rep comes from the I&A router's Pricing sheet, Turbine Model from DS-0404, and Material from the repair router. Edit or add fields on the cover tab.
- **Incoming Engineering Summary:** a skeleton built from the I&A router.
  - The opening paragraph and the list of inspections performed are filled in.
  - There's one bullet per DS form the router calls for.
  - Part-specific subsections are added: Retaining Ring for GE S1N, Packing for GE S2N/S3N.
  - **Findings are `[bracketed]` placeholders for the tech rep to fill in.** They live on the hand-marked NDT reports, crack maps and DS sheets, and the app does not invent them.
- **Repair Recommendations / Repair Summary:** the repair router's in-scope operations, in sequence.
  - Material lines (type M), "No …" / "Not …" / "not selected" rows and internal checkpoints are dropped.
  - Multi-sheet "PSM" routers are grouped under "Segment Repair / Packing Repair / Assembly Repair".
  - The Repair Summary turns recognizable verbs into the past tense.
- **Serial Number List:** parsed from DS-0404. Ditto marks, continuation rows and the retaining-ring block are handled. The completed DS-0404 PDF is embedded when it exists.
- **Dimensional sheets, NDT reports, heat treat, airflow, coating cert:** every matching file is listed and the tech rep picks which go in.
  - Tick or untick each file, reorder with the arrows, hover to preview, ✕ to reject a wrong match for good.
  - The default order follows the order the job's routers list the DS forms.
  - Incoming and final stages are told apart by folder (7A vs 7B) and, in 7D, by the INCOMING/FINAL prefix.
- **Photos:** `3 Pictures`, preferring 3A Incoming for the I&A and 3C Final for the Repair Report. They print grouped by folder: "Shipping Photos", "NDT Photos (Cores And Covers)", "Incoming Photos (Hardware)", "Final Photos".

## Open questions for the V&N team (Alfredo / Dalton)

1. Should the Repair Report repeat the incoming exhibit blocks by default? Jobs 19512 and 20505 do; Job 20564 leaves them out.
2. Cover fields: GE S1N reports use "Prior job #'s / Current total Hrs / Current Starts / Incoming # of boxes", while vanes and newer GE use "Prior Repair / Prior Hours / Prior Starts / Boxes". The app uses the second set. Change if wanted.
3. Area check: should the app read the % deviation straight off the DS-0045 / 0346 / 0945 workbooks into the summary? At the moment it's a placeholder, because the incoming area sheets are usually only kept as PDFs.
4. Heat Treat on the I&A: only "pre-weld" charts are ticked by default. Which 7C charts belong on the I&A?
5. Are there exhibits that should be added: eddy current map (CDS-0014), flow test cert, customer "Repair Detail Summary" page (Job 20564)?

## Where job-review state lives

Per-job edits, drafts and selections are saved to `%LOCALAPPDATA%\VNReportApp\jobs\<hash>.json`, keyed by the job folder's path. The Incoming and Repair reports share one job's state, so the summary, cover and exhibit picks carry over between them. Each report keeps its own page order. Nothing is written into the job folder except files a tech rep attaches manually (`_Manual Attachments\`). Excel-printed exhibits are cached in `%TEMP%\VNReportApp-rendered`.
