import puppeteer from "puppeteer-core";
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

export async function htmlToPdf(html: string): Promise<Buffer> {
  // A fresh profile folder per render: with puppeteer's default, a headless Chrome left over from
  // an earlier render (still shutting down, or orphaned by a crash) holds the profile lock and the
  // next launch fails with "The browser is already running for ...puppeteer_dev_chrome_profile-*".
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "vnreport-chrome-"));
  const browser = await puppeteer.launch({
    executablePath: findBrowserExecutable(),
    headless: true,
    userDataDir,
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    const pdfBuffer = await page.pdf({
      format: "letter",
      printBackground: true,
      margin: { top: "0.5in", bottom: "0.5in", left: "0.5in", right: "0.5in" },
    });
    return Buffer.from(pdfBuffer);
  } finally {
    await browser.close();
    await fs.rm(userDataDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}
