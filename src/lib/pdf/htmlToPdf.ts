import puppeteer from "puppeteer-core";
import { existsSync } from "fs";

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
  const browser = await puppeteer.launch({
    executablePath: findBrowserExecutable(),
    headless: true,
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
  }
}
