import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { toLongPath } from "@/lib/util/longPath";

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

  try {
    const buffer = await fs.readFile(toLongPath(resolved));
    const ext = path.extname(resolved).toLowerCase();
    return new NextResponse(new Uint8Array(buffer), {
      headers: { "Content-Type": MIME[ext] ?? "application/octet-stream", "Cache-Control": "private, max-age=3600" },
    });
  } catch {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }
}
