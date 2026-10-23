import path from "path";
import { loadWorkbook, cellText } from "./excel";
import type { JobFile } from "./fileWalk";
import { findCandidates } from "./matchSource";
import { parseRouter } from "./parsers/router";
import { readSerialListFrame } from "./parsers/serialNumberList";
import { IA_ROUTER_RULES, REPAIR_ROUTER_RULES, SERIAL_LIST_RULES } from "../report-templates/vn-rules";

export interface JobMetadata {
  jobNumber: string;
  customer: string;
  customerPO: string;
  /** Customer's own asset / equipment number -- Calpine jobs carry it in the folder name ("... EQ
   * 10925569") and want it on the cover ("Asset#:", Job 20564). Blank prints nothing. */
  assetNumber: string;
  unit: string;
  part: string;
  quantity: string;
  date: string;
  techRep: string;
  /** "Customer" on the component-details page -- usually the same as the cover's, but Alfredo's
   * 20564 cover names the site (Zion Gas) while page 2 names the owner (Calpine). */
  detailsCustomer: string;
  turbineOEM: string;
  turbineModel: string;
  component: string;
  partNumbers: string;
  material: string;
  coating: string;
  priorRepair: string;
  hours: string;
  starts: string;
  boxes: string;
  /** Where the fields came from, for transparency in the review UI. */
  sources: string[];
}

// Field order and labels match APG's real V&N "Incoming Report" / "Repair Report" cover (page 1:
// Customer through Tech Rep) and component-details page (page 2: Turbine Model onward) -- confirmed
// against Jobs 20312, 19512, 20505 and 20564. renderReportHtml breaks to page 2 after Tech Rep.
export const COVER_FIELD_ORDER: Array<{ key: keyof JobMetadata; label: string; uiLabel?: string }> = [
  { key: "customer", label: "Customer" },
  { key: "customerPO", label: "Customer PO" },
  { key: "assetNumber", label: "Asset#" },
  { key: "unit", label: "Unit #" },
  { key: "part", label: "Part Type" },
  { key: "jobNumber", label: "APG Job #" },
  { key: "date", label: "Date" },
  { key: "techRep", label: "Tech Rep" },
  { key: "detailsCustomer", label: "Customer", uiLabel: "Customer (page 2)" },
  { key: "turbineModel", label: "Turbine Model" },
  { key: "component", label: "Component" },
  { key: "partNumbers", label: "Part Numbers" },
  { key: "quantity", label: "Quantity" },
  { key: "material", label: "Material" },
  { key: "coating", label: "Coating" },
  { key: "priorRepair", label: "Prior Repairs" },
  { key: "hours", label: "Prior Hours" },
  { key: "starts", label: "Prior Starts" },
  { key: "boxes", label: "Boxes" },
];

const BLANK: Omit<JobMetadata, "jobNumber" | "customer" | "part" | "quantity" | "sources"> = {
  customerPO: "TBD",
  assetNumber: "",
  detailsCustomer: "",
  unit: "",
  date: "",
  techRep: "",
  turbineOEM: "",
  turbineModel: "",
  component: "",
  partNumbers: "",
  material: "",
  coating: "",
  priorRepair: "",
  hours: "",
  starts: "",
  boxes: "",
};

/** A turbine model/frame token as it appears in V&N job folder names: GE frames (F7EA, F7FA, 7FA,
 * F6B, F5LA, F7B), Siemens/Westinghouse (W501D5A, 501F, D5A, V84), Alstom (GT11D5, GT24). */
const MODEL_TOKEN = /^(F?[5-9][A-Z]{1,3}(\.\d+)?|W?501[A-Z0-9]*|D5A?|V\d{2}(\.\d)?|GT\d{2}[A-Z0-9]*)$/i;
/** Unit/plant designators that sit between the customer and the model ("ZN-GT2", "CT6", "DCT13",
 * "UNIT 73") -- pulled out into the cover's Unit field rather than left in the customer name. */
const UNIT_TOKEN = /^((ZN-)?GT\d|D?CT\d+|U\d+)$/i;

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\b(\d+)(St|Nd|Rd|Th)\b/g, (_, n, suf) => n + suf.toLowerCase());
}

const KEEP_UPPER = new Set(["GE", "APG", "TBC", "PO", "NDT", "MHI", "DLN", "LLC", "UT", "FS", "SRP", "TVA", "NRG", "AEP", "PGE", "APS", "TEP", "FMPA", "PSE", "LP", "CT", "GT"]);

/** All-caps text in report casing: words title-cased, model / unit tokens with digits kept upper
 * ("F7FA", "ZN-GT2"), ordinals lower ("1st"), and a few acronyms kept as-is. Mixed-case text is
 * assumed deliberate and returned untouched. */
function reportCase(s: string): string {
  if (!s || /[a-z]/.test(s)) return s;
  return s
    .split(/(\s+)/)
    .map((w) => {
      if (/^\s+$/.test(w)) return w;
      if (/^\d+(ST|ND|RD|TH)$/i.test(w)) return w.toLowerCase();
      if (/\d/.test(w) || KEEP_UPPER.has(w.replace(/[^A-Z]/g, ""))) return w;
      return w.charAt(0) + w.slice(1).toLowerCase();
    })
    .join("")
    .replace(/\bNozzles\b/, "Nozzle");
}

/** Best-effort parse of the job folder's own name, e.g. "20312 EMISSIONS F7EA 1ST STAGE NOZZLE
 * (QTY 1)", "21564 DUKE DARLINGTON DCT13 D5A ROW 2 VANES", "20342 NRG GREENS BAYOU UNIT 73 GT11D5
 * ROW 3 VANES". The customer is everything before the turbine model token, the part everything
 * from it on; quantity only when a "(QTY n)" suffix is present. */
export function parseJobMetadataFromFolderName(jobRoot: string): JobMetadata {
  const folderName = path.basename(jobRoot);
  const match = folderName.match(/^(\d{4,6})\s+(.+?)\s*(\(QTY\s*(\d+)\))?(\s+EQ\s*#?\s*\d+)?\s*$/i);
  if (!match) return { jobNumber: "", customer: "", part: folderName, quantity: "", ...BLANK, sources: ["folder name"] };
  const [, jobNumber, description, , quantity = ""] = match;
  const assetNumber = folderName.match(/\bEQ\s*#?\s*(\d{5,})/i)?.[1] ?? "";
  const words = description.trim().split(/\s+/);
  const modelIdx = words.findIndex((w) => MODEL_TOKEN.test(w));

  let customerWords = modelIdx > 0 ? words.slice(0, modelIdx) : words.slice(0, 1);
  const unitParts: string[] = [];
  const unitWord = customerWords.findIndex((w) => /^unit$/i.test(w));
  if (unitWord !== -1) {
    unitParts.push(...customerWords.slice(unitWord));
    customerWords = customerWords.slice(0, unitWord);
  }
  customerWords = customerWords.filter((w) => {
    if (UNIT_TOKEN.test(w)) {
      unitParts.push(w);
      return false;
    }
    return true;
  });

  const partWords = modelIdx >= 0 ? words.slice(modelIdx) : words.slice(1);
  const turbineModel = modelIdx >= 0 ? words[modelIdx].toUpperCase() : "";
  return {
    jobNumber,
    customer: titleCase(customerWords.join(" ")),
    part: partWords.join(" ").toUpperCase(),
    quantity,
    ...BLANK,
    unit: unitParts.join(" ").toUpperCase(),
    assetNumber,
    turbineModel,
    component: titleCase(partWords.slice(1).join(" ")),
    sources: ["folder name"],
  };
}

/** JOB TAG.xlsx: sheet "Job Tag", labels in column C (JOB:/CUST:/PART:/QTY./DATE:), value in D. */
async function parseJobTag(absolutePath: string): Promise<Partial<JobMetadata> | null> {
  const workbook = await loadWorkbook(absolutePath);
  const sheet = workbook.worksheets.find((s) => /job tag/i.test(s.name));
  if (!sheet) return null;
  const fields: Record<string, string> = {};
  for (let r = 1; r <= sheet.rowCount; r++) {
    const label = cellText(sheet.getRow(r).getCell(3)).trim().toLowerCase();
    if (label) fields[label] = cellText(sheet.getRow(r).getCell(4)).trim();
  }
  if (!fields["job:"]) return null;
  const result: Partial<JobMetadata> = { jobNumber: fields["job:"] };
  if (fields["cust:"]) result.customer = fields["cust:"];
  if (fields["part:"]) result.part = fields["part:"];
  if (fields["qty."]) result.quantity = fields["qty."];
  return result;
}

/** Repair router "Master" sheet Component Information block: "Alloy:" in column B, value in C. */
async function readRouterAlloy(absolutePath: string): Promise<string> {
  const workbook = await loadWorkbook(absolutePath);
  const sheet = workbook.worksheets.find((s) => /^master$/i.test(s.name.trim()));
  if (!sheet) return "";
  for (let r = 1; r <= sheet.rowCount; r++) {
    if (/^alloy:?$/i.test(cellText(sheet.getRow(r).getCell(2)).trim())) return cellText(sheet.getRow(r).getCell(3)).trim();
  }
  return "";
}

function inferTurbineOEM(turbineModel: string): string {
  const m = turbineModel.trim();
  if (/^F?[5-9][A-Z]/i.test(m)) return "GE";
  if (/^(W?501|D5|V\d{2})/i.test(m)) return "Siemens / Westinghouse";
  if (/^GT\d{2}/i.test(m)) return "Alstom";
  return "";
}

/** Each enrichment step is independently best-effort: a missing or unreadable source just leaves
 * that field to the folder-name fallback (or blank, for the tech rep to fill in on the cover). */
export async function resolveJobMetadata(jobRoot: string, files: JobFile[]): Promise<JobMetadata> {
  const metadata = parseJobMetadataFromFolderName(jobRoot);
  const note = (source: string) => {
    if (!metadata.sources.includes(source)) metadata.sources.push(source);
  };

  const jobTagFile = files.find((f) => /^job tag\.xlsx$/i.test(f.baseName));
  if (jobTagFile) {
    try {
      const tag = await parseJobTag(jobTagFile.absolutePath);
      // The folder name's customer split is a heuristic; JOB TAG's own fields win when present.
      if (tag) {
        Object.assign(metadata, tag);
        note("JOB TAG.xlsx");
      }
    } catch {
      // keep the folder-name values
    }
  }

  const iaRouter = findCandidates(IA_ROUTER_RULES, files)[0]?.candidates[0];
  if (iaRouter) {
    try {
      const router = await parseRouter(iaRouter.absolutePath);
      if (router?.pricing.techRep) {
        metadata.techRep = router.pricing.techRep;
        note("I&A router");
      }
    } catch {
      // leave Tech Rep for the cover editor
    }
  }

  const serialList = findCandidates(SERIAL_LIST_RULES, files)[0]?.candidates.find((f) => f.ext === ".xlsx");
  if (serialList && !metadata.turbineModel) {
    try {
      const frame = await readSerialListFrame(serialList.absolutePath);
      if (frame) {
        metadata.turbineModel = frame.split(/\s+/)[0].toUpperCase();
        note("DS-0404");
      }
    } catch {
      // leave blank
    }
  }

  const repairRouter = findCandidates(REPAIR_ROUTER_RULES, files)[0]?.candidates[0];
  if (repairRouter) {
    try {
      const alloy = await readRouterAlloy(repairRouter.absolutePath);
      if (alloy) {
        metadata.material = alloy;
        note("repair router");
      }
    } catch {
      // leave blank
    }
  }

  if (!metadata.turbineOEM) metadata.turbineOEM = inferTurbineOEM(metadata.turbineModel);
  // Folder names and JOB TAGs are all caps ("CALPINE", "F7FA 1ST STAGE NOZZLES"); the reports
  // print "Calpine", "F7FA 1st Stage Nozzle".
  metadata.customer = reportCase(metadata.customer);
  metadata.part = reportCase(metadata.part);
  if (!metadata.component) metadata.component = titleCase(metadata.part);
  if (!metadata.detailsCustomer) metadata.detailsCustomer = metadata.customer;
  return metadata;
}
