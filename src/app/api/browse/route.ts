import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

/** Matches Windows Explorer's "natural" name sort (numeric-aware) rather than plain lexicographic
 * order -- job-number folders are zero-padded inconsistently across eras ("0100" next to "02000"),
 * and without `numeric: true` a plain localeCompare would also put "11000" before "9000" (comparing
 * the leading "1" vs "9" character by character), which doesn't match what a tech rep sees in
 * Explorer itself. */
function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/** Sentinel `dir`/`parent` value meaning "the drives list" (Windows Explorer's "This PC"), not a
 * real folder -- lets a tech rep reach a different drive (a mapped network share like a company
 * T: drive, say) from the folder picker. Node's path.dirname() has no way to go "above" a drive
 * root (path.dirname("T:\\") === "T:\\" itself), so without this, a job folder that isn't
 * somewhere under the default OneDrive starting point would be unreachable no matter how many
 * times "Up one level" is clicked. */
const DRIVES_ROOT = "__DRIVES__";

/** Enumerates mounted filesystem drives (local disks + mapped network drives), matching what
 * Windows Explorer's "This PC" shows. There's no cross-platform Node API for this, but the app
 * only ever runs on the tech reps' own Windows machines, so shelling out to PowerShell is fine. */
async function listDrives(): Promise<string[]> {
  try {
    const { stdout } = await execAsync('powershell -NoProfile -Command "(Get-PSDrive -PSProvider FileSystem).Root"');
    return stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .sort(naturalCompare);
  } catch {
    return []; // PowerShell unavailable for some reason -- picker just shows an empty drives list
  }
}

/** Runs `fn` over `items` with at most `limit` calls in flight at once, instead of firing all of
 * them at the same time via a bare Promise.all. Needed anywhere this file touches a mapped
 * network drive at any real volume -- see listSubdirNames and searchFolders's own comments for
 * what happens without it (a search that "hangs" isn't slow, it's thousands of concurrent
 * requests contending for the same network share). */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Bounds the fallback fs.stat() calls below (one per ambiguous dirent) and the recursive
// directory fan-out in searchFolders -- both touch the same mapped drive, so both need the same
// ceiling to avoid contending with each other.
const FS_CONCURRENCY = 16;

/** Subfolder names directly inside `dir`. Shared by the normal single-level listing and the
 * recursive search below, so both see the exact same view of what counts as a folder. */
async function listSubdirNames(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return []; // permission error, broken mapped drive, etc. -- just nothing to list/search here
  }
  const names = await mapWithConcurrency(entries, FS_CONCURRENCY, async (e) => {
    if (e.name.startsWith(".")) return null;
    if (e.isDirectory()) return e.name;
    // Some network/cloud-synced drives (OneDrive placeholders especially) report a real
    // subfolder's dirent as a symlink rather than a directory, so e.isDirectory() alone silently
    // drops it from the picker -- fall back to a real stat() (which follows the reparse point to
    // what it actually is) before ruling it out. On a folder with hundreds of entries that are
    // ALL reported this way (common on some mapped drives), that's hundreds of extra stat() calls
    // -- exactly what FS_CONCURRENCY above is bounding.
    if (e.isFile()) return null;
    try {
      const stat = await fs.stat(path.join(dir, e.name));
      return stat.isDirectory() ? e.name : null;
    } catch {
      return null; // broken link, permission error, etc.
    }
  });
  return names.filter((n): n is string => n !== null);
}

// A job's own folder sits at most two levels below wherever a tech rep starts browsing (e.g.
// "Working Jobs" -> "204000" -> "20443 EMISSIONS ..."), so depth 1 (root's children, plus their
// children) comfortably covers that. Deliberately NOT deeper: past the job-folder level is that
// job's own internal structure (Pictures, Reports, ...), and recursing into every job folder's
// contents while searching for more job folders would multiply the work by however many
// subfolders a completed job accumulates, for no benefit -- nothing in there is itself a job
// folder to select.
const MAX_SEARCH_DEPTH = 1;
// Hard stops so a query against a genuinely massive tree (decades of job-number buckets, each
// with hundreds of jobs) always finishes promptly instead of the UI looking hung: at most this
// many directories get *listed* in total, and at most this long in wall-clock, whichever comes
// first -- past either, the search returns whatever it already found and says so (`truncated`)
// rather than silently pretending the result set is complete.
const MAX_DIRS_SCANNED = 600;
const MAX_SEARCH_RESULTS = 150;
const SEARCH_TIME_BUDGET_MS = 8000;
// A single abnormally large directory (a job-number bucket with thousands of historical jobs,
// say) can blow through the whole time budget on its own before the checks between directories
// ever get a turn -- this caps any one listSubdirNames call during a search specifically, so a
// slow directory gets skipped (treated as empty) rather than stalling the entire search on it.
const PER_DIR_TIMEOUT_MS = 2500;

/** Races `promise` against a timeout, resolving to `fallback` if the timeout wins. Used only to
 * bound a single directory listing during search -- the normal single-level browse below waits
 * as long as it takes, since there the tech rep explicitly asked to go there and a slow response
 * is still the right (if slow) answer, not something to abandon partway through. */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      }
    );
  });
}

export interface FolderSearchResult {
  /** Path from the folder the search started at, down to the match, backslash-joined -- shown so
   * two same-named matches under different parents (or a match several levels down) are still
   * distinguishable in the results list. */
  relativePath: string;
  fullPath: string;
}

/** Recursively searches for subfolder names containing `query` (case-insensitive), starting from
 * `root`, bounded by MAX_SEARCH_DEPTH/MAX_DIRS_SCANNED/SEARCH_TIME_BUDGET_MS/MAX_SEARCH_RESULTS
 * above. Sibling directories at each level are searched via mapWithConcurrency rather than a bare
 * Promise.all, so a "massive" tree's sheer breadth (dozens of job-number buckets, each with
 * hundreds of jobs) can't fan out into thousands of simultaneous filesystem calls against the
 * same mapped drive -- which in practice looked exactly like a hung request, not a slow one. */
async function searchFolders(root: string, query: string): Promise<{ results: FolderSearchResult[]; truncated: boolean }> {
  const q = query.toLowerCase();
  const results: FolderSearchResult[] = [];
  const deadline = Date.now() + SEARCH_TIME_BUDGET_MS;
  let dirsScanned = 0;
  let truncated = false;

  function budgetExceeded(): boolean {
    return results.length >= MAX_SEARCH_RESULTS || dirsScanned >= MAX_DIRS_SCANNED || Date.now() > deadline;
  }

  async function walk(dir: string, relative: string, depth: number): Promise<void> {
    if (budgetExceeded()) {
      truncated = true;
      return;
    }
    dirsScanned++;
    const names = await withTimeout(listSubdirNames(dir), PER_DIR_TIMEOUT_MS, []);

    for (const name of names) {
      if (results.length >= MAX_SEARCH_RESULTS) {
        truncated = true;
        break;
      }
      if (name.toLowerCase().includes(q)) {
        results.push({ relativePath: relative ? `${relative}\\${name}` : name, fullPath: path.join(dir, name) });
      }
    }

    if (depth >= MAX_SEARCH_DEPTH || budgetExceeded()) {
      if (depth < MAX_SEARCH_DEPTH) truncated = true; // stopped early on budget, not just depth
      return;
    }
    await mapWithConcurrency(names, FS_CONCURRENCY, (name) => walk(path.join(dir, name), relative ? `${relative}\\${name}` : name, depth + 1));
  }

  await walk(root, "", 0);
  return { results, truncated };
}

export async function GET(request: NextRequest) {
  const dirParam = request.nextUrl.searchParams.get("dir");
  const query = request.nextUrl.searchParams.get("q")?.trim();

  if (dirParam === DRIVES_ROOT) {
    const folders = await listDrives();
    return NextResponse.json({ dir: null, parent: null, folders, isDriveList: true });
  }

  const dir = dirParam || path.join(os.homedir(), "OneDrive - Allied Power Group", "Strategy - Files");

  if (query) {
    try {
      const { results, truncated } = await searchFolders(dir, query);
      return NextResponse.json({ dir, query, results, truncated });
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "Search failed" }, { status: 400 });
    }
  }

  try {
    const folders = (await listSubdirNames(dir)).sort(naturalCompare);
    const dirnameOfDir = path.dirname(dir);
    // A drive root's own dirname is itself in Node -- send "Up one level" to the drives list
    // instead of looping back to the same folder.
    const parent = dirnameOfDir === dir ? DRIVES_ROOT : dirnameOfDir;
    return NextResponse.json({ dir, parent, folders, isDriveList: false });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not read directory" }, { status: 400 });
  }
}
