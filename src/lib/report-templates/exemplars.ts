// Finished reports the tech reps themselves picked as good, typical examples to start new reports
// from -- preferred over "the most recent report of the same product" whenever one exists for the
// product being built (see draft/priorReport.ts's findPriorReport). An example without the needed
// deck (an I&A-only job when building a Repair Report, say) is simply skipped for that report type.
//
// Alfredo Resendiz, 10/28/2026 (GE nozzles + inner support ring):
//   20062 inner support ring (Repair Report only)
//   19797 F7EA 1st stage nozzle
//   -     F7EA 2nd stage nozzle -- he sent 19757, which is a field service job with no reports;
//         waiting on the right number (19673 / 19929 are the likely candidates)
//   19837 F7EA 3rd stage nozzle (I&A only)
//   20564 F7FA 1st stage nozzle
//   19163 F7FA 2nd stage nozzle (I&A only)
//   18669 F7FA 3rd stage nozzle
// Vanes / vane carriers (Elmer Gomez, Adan Aguirre): none yet.
export const PREFERRED_EXAMPLE_JOBS: string[] = ["20062", "19797", "19837", "20564", "19163", "18669"];
