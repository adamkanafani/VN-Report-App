import { promises as fs } from "fs";
import path from "path";

export interface JobFile {
  absolutePath: string;
  /** Relative to the job folder root, using forward slashes. */
  relativePath: string;
  baseName: string;
  ext: string;
  /** Relative parent folder path, forward slashes, e.g. "7 Reports/7A Inspection Report". */
  folderPath: string;
}

const SKIP_FILE_NAMES = new Set(["thumbs.db", "desktop.ini"]);
const SKIP_EXTENSIONS = new Set([".lnk", ".msg", ".db", ".ini"]);

export async function walkJobFolder(jobRoot: string): Promise<JobFile[]> {
  const results: JobFile[] = [];

  async function recurse(dir: string) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // permission errors etc. — skip rather than fail the whole scan
    }
    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await recurse(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        // Some network/cloud-synced drives (OneDrive placeholders, certain mapped/network
        // shares) report every plain file's dirent as a symlink rather than a regular file,
        // so entry.isFile() alone silently drops the entire job folder's contents. Fall back
        // to a real stat() (which follows the reparse point/symlink to what it actually is)
        // before giving up on it.
        let stat;
        try {
          stat = await fs.stat(absolutePath);
        } catch {
          continue; // broken link, permission error, etc.
        }
        if (stat.isDirectory()) {
          await recurse(absolutePath);
          continue;
        }
        if (!stat.isFile()) continue;
      }
      const lowerName = entry.name.toLowerCase();
      if (SKIP_FILE_NAMES.has(lowerName)) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (SKIP_EXTENSIONS.has(ext)) continue;

      const relativePath = path.relative(jobRoot, absolutePath).split(path.sep).join("/");
      const folderPath = path.dirname(relativePath) === "." ? "" : path.dirname(relativePath).split(path.sep).join("/");
      results.push({
        absolutePath,
        relativePath,
        baseName: entry.name,
        ext,
        folderPath,
      });
    }
  }

  await recurse(jobRoot);
  return results;
}
