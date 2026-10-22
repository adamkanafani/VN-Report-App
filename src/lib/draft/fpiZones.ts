/**
 * FPI & Visual Inspection Summary's zone-by-zone breakdown differs by turbine model and stage/row
 * -- a completely different part geometry means completely different named zones to report
 * findings against (an F7EA Stage 1 bucket has no "Z-Notch" at all; a W501D5 Row 3 bucket has no
 * "Cable Slot"). Per a tech rep's own list of the real zone sets used for each configuration.
 *
 * GE frames (F7EA, F7FA) group the 2nd and 3rd stages under one zone set (same geometry family);
 * Westinghouse/Siemens W501D5/D5A instead names each of its four rows separately, including two
 * (Row 1 and Row 2) that happen to share an identical zone set -- kept as two separate constants
 * below rather than collapsed into one, so a future correction to just one of them doesn't have to
 * first split them back apart.
 */

export type TurbineFamily = "F7EA" | "F7FA" | "W501D5";

const F7EA_STAGE_1 = ["Tips", "Airfoil", "Platform", "LE Angel Wing", "TE Angel Wing", "CC & CV Platform Shank", "Side Shank/Pin Slots", "Root Serrations"];

const F7EA_STAGE_23 = ["Airfoils", "Z-Notch", "Z-Notch Reliefs", "Shroud", "Shroud Rails", "Pin Slots & Side Shank", "Shank", "Platform", "Angel Wings", "Root Serrations"];

const F7FA_STAGE_1 = ["Airfoils", "LE Cooling Holes", "TE Cooling Holes", "Tips", "Platform", "Angel Wings", "Root Serrations", "Cable Slot", "Pin Slots", "Shank Face", "Side Shank"];

const F7FA_STAGE_23 = [
  "Airfoil",
  "LE/TE Z-Notch Face",
  "Z-Notch Fillet Radius",
  "Shroud",
  "Shroud Rail",
  "Root Shank Area",
  "Shank/Side Shank/Pin Slot Area",
  "Angel Wing",
  "Platform",
  "Root Serrations",
  "Cable Slot",
  "X-Ray Results",
];

const W501D5_ROW_1 = ["Airfoil", "Angel Wings", "Squealer Tips", "Dovetail/Root", "Platform", "Shank", "Side Shanks"];

// Identical to Row 1 today -- kept as its own constant, not an alias, per this file's own comment.
const W501D5_ROW_2 = ["Airfoil", "Angel Wings", "Squealer Tips", "Dovetail/Root", "Platform", "Shank", "Side Shanks"];

const W501D5_ROW_3 = ["Airfoil", "Tips", "Platform", "Lock Plate Slot", "Pin Slots", "Shank", "Side Shanks", "Root Serrations"];

const W501D5_ROW_4 = ["Airfoil", "Platform", "LE/TE Z-Face", "Z-Notch Fillet Radius", "Lock Plate Slot", "Shrouds", "Shroud Rail", "Shank", "Angel Wing", "Root Serrations"];

function detectFamily(...texts: string[]): TurbineFamily | null {
  const combined = texts.join(" ").toUpperCase();
  // F7FA checked before F7EA has no bearing here (the strings don't overlap), but W501D5 is
  // checked as its own distinct pattern regardless of order.
  if (/F7EA/.test(combined)) return "F7EA";
  if (/F7FA/.test(combined)) return "F7FA";
  if (/W501D5/.test(combined)) return "W501D5";
  return null;
}

// Matches "1st Stage", "Stage 1", "Row 2", "2nd Row", etc. -- job metadata's own component/part
// text is free-form (see jobMetadata.ts), so this looks for either a spelled-out ordinal or a
// bare "Stage N"/"Row N" rather than committing to one exact phrasing.
const ORDINAL_WORDS: Record<string, 1 | 2 | 3 | 4> = { "1ST": 1, FIRST: 1, "2ND": 2, SECOND: 2, "3RD": 3, THIRD: 3, "4TH": 4, FOURTH: 4 };

function detectStageOrRow(...texts: string[]): 1 | 2 | 3 | 4 | null {
  const combined = texts.join(" ").toUpperCase();
  for (const [word, n] of Object.entries(ORDINAL_WORDS)) {
    if (new RegExp(`\\b${word}\\b`).test(combined)) return n;
  }
  const m = combined.match(/\b(?:STAGE|ROW)\s*([1-4])\b/);
  return m ? (Number(m[1]) as 1 | 2 | 3 | 4) : null;
}

/**
 * Looks up the right zone-by-zone breakdown for this job from its own turbine model + component/
 * part text -- null when the model family or the stage/row number can't be confidently determined
 * from either (an unfamiliar model, or free-text that doesn't mention a stage/row at all), so the
 * caller can fall back to a generic structure instead of guessing at the wrong one.
 */
export function fpiZonesFor(turbineModel: string, component: string, part: string): string[] | null {
  const family = detectFamily(turbineModel, component, part);
  if (!family) return null;
  const stageOrRow = detectStageOrRow(component, part, turbineModel);
  if (!stageOrRow) return null;

  if (family === "F7EA") return stageOrRow === 1 ? F7EA_STAGE_1 : F7EA_STAGE_23;
  if (family === "F7FA") return stageOrRow === 1 ? F7FA_STAGE_1 : F7FA_STAGE_23;
  // W501D5/D5A
  switch (stageOrRow) {
    case 1:
      return W501D5_ROW_1;
    case 2:
      return W501D5_ROW_2;
    case 3:
      return W501D5_ROW_3;
    case 4:
      return W501D5_ROW_4;
  }
}
