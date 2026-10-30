import puppeteer, { type Browser } from "puppeteer-core";
import { existsSync, promises as fs } from "fs";
import os from "os";
import path from "path";

const CANDIDATE_EXECUTABLES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

function findBrowserExecutable(): string {
  const found = CANDIDATE_EXECUTABLES.find((p) => existsSync(p));
  if (!found) {
    throw new Error("No local Chrome or Edge installation found for PDF rendering. Install one of them, or point htmlToPdf.ts at a different executable path.");
  }
  return found;
}

// Chrome 156 (10/27/2026 update) takes 1-3+ minutes to start a fresh headless profile on APG
// machines -- first-run setup, component updates, background networking -- and the app used to start
// one per rendered page, so a report with a dozen HTML pages timed out ("The browser is already
// running for ...vnreport-chrome-*"). Now: one shared browser per server process, with those startup
// chores switched off (≈2 s to start), reused for every page, and closed in the background after a
// minute idle (closing can itself take 15-50 s, so nothing waits on it).
const LAUNCH_ARGS = [
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--disable-component-update",
  "--disable-sync",
  "--disable-background-networking",
  "--disable-default-apps",
];
const IDLE_CLOSE_MS = 60_000;

let browserPromise: Promise<Browser> | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let inFlight = 0;

async function launch(): Promise<Browser> {
  // Full-length temp path (not the 8.3 "AKANAF~1" form os.tmpdir() returns), one profile per server
  // process -- reused across reports, never shared with a Chrome left over from an earlier run.
  const base = await fs.realpath(os.tmpdir()).catch(() => os.tmpdir());
  const options = { executablePath: findBrowserExecutable(), headless: true, args: LAUNCH_ARGS, timeout: 120_000 };
  try {
    return await puppeteer.launch({ ...options, userDataDir: path.join(base, `vnreport-chrome-${process.pid}`) });
  } catch {
    // That profile is somehow still held -- fall back to a brand-new one.
    return puppeteer.launch({ ...options, userDataDir: await fs.mkdtemp(path.join(base, "vnreport-chrome-")) });
  }
}

function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = launch().then((browser) => {
      browser.on("disconnected", () => {
        browserPromise = null;
      });
      return browser;
    });
    browserPromise.catch(() => {
      browserPromise = null;
    });
  }
  return browserPromise;
}

function scheduleIdleClose() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (inFlight > 0 || !browserPromise) return;
    const closing = browserPromise;
    browserPromise = null;
    closing.then((b) => b.close()).catch(() => {});
  }, IDLE_CLOSE_MS);
}

export async function htmlToPdf(html: string): Promise<Buffer> {
  inFlight++;
  if (idleTimer) clearTimeout(idleTimer);
  try {
    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
      await page.setContent(html, { waitUntil: "load" });
      const pdfBuffer = await page.pdf({
        // The tech reps' own report pages are 7.5 x 10in (their PowerPoint slide size) edge to edge;
        // only the exhibit sheets copied in are Letter. Same here, so a page of ours sits beside a
        // page of theirs at the same scale (renderReportHtml.ts lays out in pt on this page).
        width: "7.5in",
        height: "10in",
        printBackground: true,
        margin: { top: "0", bottom: "0", left: "0", right: "0" },
      });
      return Buffer.from(pdfBuffer);
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    inFlight--;
    scheduleIdleClose();
  }
}
