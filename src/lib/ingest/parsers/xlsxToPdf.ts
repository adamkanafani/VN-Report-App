import { promises as fs } from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { toLongPath } from "../../util/longPath";

const execFileAsync = promisify(execFile);

/** Cheap, dependency-free check for embedded images/drawings in an .xlsx (which is itself a zip
 * archive) -- good enough to decide whether it's worth paying for a full Excel-COM render,
 * without pulling in a real zip-parsing library just for this one check. Zip local file headers
 * store entry names as plain text, so a raw substring search on the file's own bytes reliably
 * finds the "xl/media/..." entries Excel uses for embedded pictures. */
export async function xlsxHasEmbeddedImages(xlsxPath: string): Promise<boolean> {
  try {
    const buffer = await fs.readFile(toLongPath(xlsxPath));
    return buffer.toString("latin1").includes("xl/media/");
  } catch {
    return false;
  }
}

// Opens the workbook read-only, selects whichever sheet matches SheetPattern (falling back to
// the first sheet), and exports just that one sheet to PDF -- preserving embedded
// pictures/drawings, which ExcelJS has no ability to render at all (it only reads cell data).
const RENDER_SHEET_PS1 = `
param(
  [Parameter(Mandatory=$true)][string]$InputPath,
  [Parameter(Mandatory=$true)][string]$SheetPattern,
  [Parameter(Mandatory=$true)][string]$OutputPath
)
$ErrorActionPreference = "Stop"
$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false
$excel.AskToUpdateLinks = $false
$wb = $null
$sheet = $null
try {
  $wb = $excel.Workbooks.Open($InputPath, 0, $true, [Type]::Missing, [Type]::Missing, [Type]::Missing, $true)
  foreach ($ws in $wb.Worksheets) {
    if ($ws.Name -match $SheetPattern) { $sheet = $ws; break }
  }
  if (-not $sheet) { $sheet = $wb.Worksheets.Item(1) }
  $sheet.Select()
  # Force a single-page-WIDE fit regardless of whatever print setup the sheet was last saved with
  # -- without this, a form sized just slightly past its printable width exports with a near-blank
  # extra page holding just the sliver of columns that spilled over. Deliberately NOT also forcing
  # FitToPagesTall to 1: that squeezes every row onto one page no matter how many there are, which
  # is fine for a short form but crushes a long table (90+ rows) down to unreadably tiny text.
  # Leaving height unconstrained lets a tall sheet flow across as many pages as it actually needs.
  $sheet.PageSetup.Zoom = $false
  $sheet.PageSetup.FitToPagesWide = 1
  $sheet.PageSetup.FitToPagesTall = $false
  $wb.ActiveSheet.ExportAsFixedFormat(0, $OutputPath)
} finally {
  if ($wb) { $wb.Close($false) }
  $excel.Quit()
  if ($sheet) { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($sheet) | Out-Null }
  if ($wb) { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($wb) | Out-Null }
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel) | Out-Null
  [System.GC]::Collect()
  [System.GC]::WaitForPendingFinalizers()
}
`;

/** Renders one worksheet of an .xlsx to a standalone PDF via Excel COM automation -- the only
 * reliable way to preserve embedded drawings/pictures baked into a form like DS-0004, since
 * ExcelJS (used everywhere else in this app) can read a sheet's cell data but has no rendering or
 * export capability whatsoever. Requires a full desktop Excel install; gracefully returns null
 * (never throws) if that's unavailable or the conversion fails for any reason, so callers can
 * fall back to this app's own re-parsed table instead. Cached next to the source file (by
 * source-file mtime) so repeat report generations don't re-launch Excel every time. */
export async function renderXlsxSheetToPdf(xlsxPath: string, sheetNamePattern: RegExp, cacheDir: string): Promise<string | null> {
  const cacheName = `${path.basename(xlsxPath, path.extname(xlsxPath))}.pdf`;
  const outputPath = path.join(cacheDir, cacheName);

  try {
    const sourceStat = await fs.stat(toLongPath(xlsxPath));
    const cacheStat = await fs.stat(toLongPath(outputPath)).catch(() => null);
    if (cacheStat && cacheStat.mtimeMs >= sourceStat.mtimeMs) return outputPath;
  } catch {
    return null; // source file vanished mid-scan, etc.
  }

  await fs.mkdir(cacheDir, { recursive: true });
  const scriptPath = path.join(cacheDir, ".render-sheet.ps1");

  try {
    await fs.writeFile(scriptPath, RENDER_SHEET_PS1, "utf8");
    await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        "-InputPath",
        xlsxPath,
        "-SheetPattern",
        sheetNamePattern.source,
        "-OutputPath",
        outputPath,
      ],
      { timeout: 60_000 }
    );
    await fs.access(outputPath);
    return outputPath;
  } catch {
    return null; // no Excel installed, it hung/errored, etc. -- caller falls back to our own table
  } finally {
    await fs.rm(scriptPath, { force: true }).catch(() => {});
  }
}
