import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import sharp from "sharp";
import { toLongPath } from "@/lib/util/longPath";

const THUMB_DIR = path.join(os.tmpdir(), "VNReportApp-thumbs");

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".pdf": "application/pdf",
};

export async function GET(request: NextRequest) {
  const jobRoot = request.nextUrl.searchParams.get("jobRoot");
  const relativePath = request.nextUrl.searchParams.get("path");
  if (!jobRoot || !relativePath) return NextResponse.json({ error: "jobRoot and path are required" }, { status: 400 });

  const resolved = path.resolve(jobRoot, relativePath);
  const resolvedRoot = path.resolve(jobRoot);
  if (!resolved.startsWith(resolvedRoot + path.sep) && resolved !== resolvedRoot) {
    return NextResponse.json({ error: "Path escapes the job folder" }, { status: 400 });
  }

  const ext = path.extname(resolved).toLowerCase();
  // ?w=360: a small JPEG for the review screen's photo grid instead of the 5 MB / 12-megapixel
  // camera original -- decoding a hundred originals at once ("Show all") ran the browser out of
  // memory and blacked out the screen. Cached on disk by path, file time and width; the report
  // itself still embeds the full photo.
  const width = Number(request.nextUrl.searchParams.get("w"));
  if (width > 0 && width <= 1600 && (ext === ".jpg" || ext === ".jpeg" || ext === ".png")) {
    try {
      const stat = await fs.stat(toLongPath(resolved));
      const key = crypto.createHash("sha256").update(`${resolved}|${stat.mtimeMs}|${width}`).digest("hex").slice(0, 24);
      const cached = path.join(THUMB_DIR, `${key}.jpg`);
      let thumb = await fs.readFile(cached).catch(() => null);
      if (!thumb) {
        thumb = await sharp(toLongPath(resolved)).rotate().resize({ width, height: width, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer();
        await fs.mkdir(THUMB_DIR, { recursive: true });
        await fs.writeFile(cached, thumb).catch(() => {});
      }
      return new NextResponse(new Uint8Array(thumb), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400" } });
    } catch {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }
  }

  try {
    const buffer = await fs.readFile(toLongPath(resolved));
    return new NextResponse(new Uint8Array(buffer), {
      headers: { "Content-Type": MIME[ext] ?? "application/octet-stream", "Cache-Control": "private, max-age=3600" },
    });
  } catch {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }
}
