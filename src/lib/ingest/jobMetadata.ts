import path from "path";
import { loadWorkbook, cellText } from "./excel";
import type { JobFile } from "./fileWalk";

export interface JobMetadata {
  jobNumber: string;
  customer: string;
  customerPO: string;
  part: string;
  quantity: string;
  date: string;
  techRep: string;
  turbineOEM: string;
  turbineModel: string;
  component: string;
  castPartNumber: string;
  machPartNumber: string;
  material: string;
  coating: string;
  priorRepair: string;
  hours: string;
  starts: string;
  boxes: string;
  /** Where each field came from, for transparency in the review UI. */
  source: "JOB TAG.xlsx" | "folder name";
}

// Field order and labels match the real "Incoming Report" cover pages (Cover + Incoming Report
// data page) from a completed job, so the review UI and the generated PDF read the same as the
// deliverable it's modeled on.
export const COVER_FIELD_ORDER: Array<{ key: keyof JobMetadata; label: string }> = [
  { key: "customer", label: "Customer" },
  { key: "customerPO", label: "Customer PO" },
  { key: "part", label: "Part Type" },
  { key: "jobNumber", label: "APG Job #" },
  { key: "date", label: "Date" },
  { key: "techRep", label: "Tech Rep" },
  { key: "turbineOEM", label: "Turbine OEM" },
  { key: "turbineModel", label: "Turbine Model" },
  { key: "component", label: "Component" },
  { key: "castPartNumber", label: "Cast Part Number" },
  { key: "machPartNumber", label: "Mach Part Number" },
  { key: "quantity", label: "Quantity" },
  { key: "material", label: "Material" },
  { key: "coating", label: "Coating" },
  { key: "priorRepair", label: "Prior Repair" },
  { key: "hours", label: "Hours" },
  { key: "starts", label: "Starts" },
  { key: "boxes", label: "Boxes" },
];

const BLANK_ENRICHMENT = {
  customerPO: "TBD",
  techRep: "",
  turbineOEM: "",
  turbineModel: "",
  component: "",
  castPartNumber: "",
  machPartNumber: "",
  material: "",
  coating: "",
  priorRepair: "",
  hours: "",
  starts: "",
  boxes: "",
};

/** Best-effort job number/customer/part/quantity parse from the job folder's own name, e.g.
 * "20443 EMISSIONS F7EA 1ST STAGE BUCKETS (QTY 92)". Used as a fallback when no JOB TAG.xlsx
 * is present, and to sanity-check the JOB TAG's job number matches the folder we're actually
 * scanning. */
export function parseJobMetadataFromFolderName(jobRoot: string): JobMetadata {
  const folderName = path.basename(jobRoot);
  const match = folderName.match(/^(\d+)\s+(.+?)\s*\(QTY\s*(\d+)\)\s*$/i);
  if (!match) {
    return { jobNumber: "", customer: "", part: folderName, quantity: "", date: "", ...BLANK_ENRICHMENT, source: "folder name" };
  }
  const [, jobNumber, description, quantity] = match;
  const words = description.trim().split(/\s+/);
  const customer = words[0] ?? "";
  const part = words.slice(1).join(" ");
  return { jobNumber, customer, part, quantity, date: "", ...BLANK_ENRICHMENT, source: "folder name" };
}

/** JOB TAG.xlsx layout (confirmed against Job 20443): sheet "Job Tag", labels in column C
 * (JOB:/CUST:/PART:/QTY./DATE:), value in column D (merged across D:H). */
export async function parseJobTag(absolutePath: string): Promise<JobMetadata | null> {
  const workbook = await loadWorkbook(absolutePath);
  const sheet = workbook.worksheets.find((s) => /job tag/i.test(s.name));
  if (!sheet) return null;

  const fields: Record<string, string> = {};
  for (let r = 1; r <= sheet.rowCount; r++) {
    const label = cellText(sheet.getRow(r).getCell(3)).trim().toLowerCase();
    if (!label) continue;
    const value = cellText(sheet.getRow(r).getCell(4)).trim();
    fields[label] = value;
  }

  const jobNumber = fields["job:"] ?? "";
  if (!jobNumber) return null;

  return {
    jobNumber,
    customer: fields["cust:"] ?? "",
    part: fields["part:"] ?? "",
    quantity: fields["qty."] ?? "",
    date: fields["date:"] ?? "",
    ...BLANK_ENRICHMENT,
    source: "JOB TAG.xlsx",
  };
}

/** DS-0554 "Serial Number List" header (confirmed against Job 20443): sheet contains "serial
 * number sheet"; row 5 col C = Unit/Frame (turbine model), row 4 col J = Cast P/N, row 5 col J
 * = Mach P/N. */
async function enrichFromSerialNumberList(absolutePath: string): Promise<Partial<JobMetadata> | null> {
  const workbook = await loadWorkbook(absolutePath);
  const sheet = workbook.worksheets.find((s) => /serial number sheet/i.test(s.name));
  if (!sheet) return null;
  const turbineModel = cellText(sheet.getRow(5).getCell(3));
  const castPartNumber = cellText(sheet.getRow(4).getCell(10));
  const machPartNumber = cellText(sheet.getRow(5).getCell(10));
  if (!turbineModel && !castPartNumber && !machPartNumber) return null;
  return { turbineModel, castPartNumber, machPartNumber };
}

/** Repair Router "Master" sheet Component Information block (confirmed against Job 20443): a
 * header row labelled "Component Information", followed by a row with "Alloy:" in column B and
 * the alloy name in column C. */
async function enrichFromRepairRouter(absolutePath: string): Promise<Partial<JobMetadata> | null> {
  const workbook = await loadWorkbook(absolutePath);
  const sheet = workbook.worksheets.find((s) => /^master$/i.test(s.name.trim()));
  if (!sheet) return null;
  for (let r = 1; r <= sheet.rowCount; r++) {
    if (/^alloy:$/i.test(cellText(sheet.getRow(r).getCell(2)).trim())) {
      const material = cellText(sheet.getRow(r).getCell(3)).trim();
      if (material) return { material };
    }
  }
  return null;
}

function inferTurbineOEM(turbineModel: string): string {
  // GE frame designations are numeric or F-prefixed-numeric (e.g. "F7EA", "7EA", "9FA").
  return /^F?\d/i.test(turbineModel.trim()) ? "GE" : "";
}

export async function resolveJobMetadata(jobRoot: string, files: JobFile[]): Promise<JobMetadata> {
  const jobTagFile = files.find((f) => /^job tag\.xlsx$/i.test(f.baseName));
  let metadata: JobMetadata;
  if (jobTagFile) {
    try {
      metadata = (await parseJobTag(jobTagFile.absolutePath)) ?? parseJobMetadataFromFolderName(jobRoot);
    } catch {
      metadata = parseJobMetadataFromFolderName(jobRoot);
    }
  } else {
    metadata = parseJobMetadataFromFolderName(jobRoot);
  }

  const serialListFile = files.find(
    (f) => /ds-?0554.*incoming/i.test(f.baseName) && f.ext === ".xlsx"
  ) ?? files.find((f) => /ds-?0554/i.test(f.baseName) && !/in.?process|final/i.test(f.baseName) && f.ext === ".xlsx");
  if (serialListFile) {
    try {
      const enrichment = await enrichFromSerialNumberList(serialListFile.absolutePath);
      if (enrichment) Object.assign(metadata, enrichment);
    } catch {
      // leave the placeholder values in place
    }
  }

  const repairRouterFile = files.find((f) => /repair[_ -]?router/i.test(f.baseName) && !/^copy of/i.test(f.baseName));
  if (repairRouterFile) {
    try {
      const enrichment = await enrichFromRepairRouter(repairRouterFile.absolutePath);
      if (enrichment) Object.assign(metadata, enrichment);
    } catch {
      // leave the placeholder values in place
    }
  }

  if (!metadata.turbineOEM) metadata.turbineOEM = inferTurbineOEM(metadata.turbineModel);
  if (!metadata.component) metadata.component = metadata.part;

  return metadata;
}
