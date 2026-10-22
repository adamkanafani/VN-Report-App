# Tech Rep Report Builder

Prototype: pick I&A Report or Final Report, point this app at an APG job folder, review what it can and can't auto-draft, edit/regenerate sections, and export the finished PDF.

## Setup

```bash
npm install
npm run dev
```

Open http://localhost:3000. `ANTHROPIC_API_KEY` is optional, not required to run the app:

- Folder scanning, every dimensional table, attaching third-party PDFs, and PDF export never touch the API.
- The initial draft of the four narrative sections (I&A Summary, FPI & Visual Inspection Summary, Dimensional Inspection Summary, Recommended Repairs) is fully deterministic — built straight from the job's own data, no LLM call.
- Photo Set's AI pass (surfacing photos that show an actual finding first) and the content-based fallback file matcher (for oddly-named source files) are both best-effort refinements on top of a working default — without a key they just skip the refinement rather than failing anything.
- The only thing that actually needs the key is clicking "Regenerate" / giving a custom instruction to revise one of the four narrative sections after the fact — that specific action calls the Anthropic API and will show an error on that section if no key is set.

To enable that regenerate/revise action: `cp .env.local.example .env.local`, then fill in `ANTHROPIC_API_KEY`.

PDF export (`Generate Report`) needs a local Chrome or Edge install (checks the usual Program Files locations) — no download required.

## What's real vs. stubbed

- **I&A Report**: fully implemented, reverse-engineered against a real completed job (APG Job 20443).
- **Final Report**: fully implemented, reverse-engineered against a real completed job (APG Job 18664) plus field notes on which exhibits are conditional (X-ray, airflow) vs. near-universal (coating cert, shot peen, moment weigh). No narrative summary sections (the real report doesn't restate incoming findings); most of its dimensional re-check sections reuse the I&A Report's own parsers verbatim against the final-stage files.
- **Crack Map**: only attached as-is when a source file is found by filename pattern (`crack*map`). The app never tries to interpret hand-marked findings from it — the source tracker itself rates that as low-confidence automation, and this prototype treats it as always-manual.
- **Photo Set**: Claude vision suggests candidates, but the section is always flagged "review recommended" — click photos in the grid to override the selection before generating.
- **Router-derived sections** (FPI & Visual Inspection Summary, Recommended Repairs): pulled from the job's "Router" `.xlsm` workbooks. Which operations are actually in scope for a given job is determined by reading the router's own prose ("not selected" / "not required" / a label starting with "No ...") rather than its Quantity/cost columns, which are driven by live cross-sheet formulas this app doesn't evaluate.

## Where job-review state lives

Per-job edits, regenerated drafts, and photo selections are saved to `%LOCALAPPDATA%\TechRepReportApp\jobs\<hash>.json` — keyed by the job folder's path, not stored inside the job folder itself, so nothing is written back into the customer's OneDrive folder until you explicitly export the PDF.
