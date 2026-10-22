import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

// Convention shared with scanJobFolder.ts's manualAttachmentsFor(): a manually-attached file
// lives at "<jobRoot>/_Manual Attachments/<sectionId>/<filename>", a real file inside the job
// folder like any other -- so the very next scan picks it up through the normal file walk, with
// no separate storage or job-state field required. Placing it under a section-specific
// subfolder is what associates it with that section (matched by folder path, not filename).
const MANUAL_ATTACHMENTS_DIR = "_Manual Attachments";

// A safe path segment: no separators, no leading dot (rules out "..", ".", and hidden-file
// weirdness). Both the section id (caller-controlled, though only ever one of our own template's
// ids in practice) and the uploaded filename are checked against this before touching the disk.
const SAFE_SEGMENT = /^[^\\/]+$/;

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const jobRoot = form.get("jobRoot");
  const sectionId = form.get("sectionId");
  // One or more files -- a tech rep attaching, say, a multi-page cert that was scanned as
  // separate files, or just several candidates to compare at once, shouldn't need a separate
  // round trip per file.
  const files = form.getAll("file").filter((f): f is File => f instanceof File);

  if (typeof jobRoot !== "string" || !jobRoot) return NextResponse.json({ error: "jobRoot is required" }, { status: 400 });
  if (typeof sectionId !== "string" || !sectionId || !SAFE_SEGMENT.test(sectionId) || sectionId.startsWith(".")) {
    return NextResponse.json({ error: "Invalid sectionId" }, { status: 400 });
  }
  if (files.length === 0) return NextResponse.json({ error: "At least one file is required" }, { status: 400 });

  // Original filename, but stripped of anything but a plain base name -- e.g. a browser handing
  // us a full path from a drag-drop, or someone crafting a traversal attempt, both collapse to
  // just the last segment before this check runs.
  const safeNames: string[] = [];
  for (const file of files) {
    const safeName = path.basename(file.name).trim();
    if (!safeName || !SAFE_SEGMENT.test(safeName) || safeName.startsWith(".")) {
      return NextResponse.json({ error: `Invalid file name: "${file.name}"` }, { status: 400 });
    }
    safeNames.push(safeName);
  }

  const destDir = path.join(jobRoot, MANUAL_ATTACHMENTS_DIR, sectionId);
  const resolvedDir = path.resolve(destDir);
  const resolvedRoot = path.resolve(jobRoot);
  if (!resolvedDir.startsWith(resolvedRoot + path.sep)) {
    return NextResponse.json({ error: "Resolved path escapes the job folder" }, { status: 400 });
  }

  try {
    // Adds alongside whatever's already manually attached here, rather than replacing it -- a
    // tech rep uploading a file often just wants a second one on hand to compare or swap to
    // later (see scanJobFolder.ts's manualFiles handling: every file here becomes a candidate,
    // not necessarily what's selected). Re-uploading under the exact same filename still
    // overwrites just that one file, same as saving over it anywhere else.
    await fs.mkdir(destDir, { recursive: true });
    const relativePaths: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const targetPath = path.join(destDir, safeNames[i]);
      const bytes = Buffer.from(await files[i].arrayBuffer());
      await fs.writeFile(targetPath, bytes);
      // Verify the write actually landed before reporting success -- confirmed real-world case:
      // this same network-share class of flakiness (see readFileWithRetry/the POST handler's own
      // EPERM history) can apparently let a write call resolve without an error yet leave no file
      // behind, which previously meant the tech rep saw "success" and a chip that never showed up,
      // with nothing in the response to explain why. Checking the size back out catches a partial
      // write too, not just a missing file.
      const stat = await fs.stat(targetPath).catch(() => null);
      if (!stat || stat.size !== bytes.length) {
        throw new Error(`"${safeNames[i]}" didn't save correctly (the write reported success, but the file isn't on disk as expected). Try again, or check your connection to this job's folder.`);
      }
      relativePaths.push(`${MANUAL_ATTACHMENTS_DIR}/${sectionId}/${safeNames[i]}`);
    }
    return NextResponse.json({ relativePaths });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to save file(s)" }, { status: 500 });
  }
}

/** Removes one previously manually-attached file -- the "x" a tech rep hovers up on each chip
 * next to "Insert files manually" in the review screen. Deletes just that one file (fs.unlink),
 * never the section's whole _Manual Attachments/<sectionId> directory -- see the POST handler's
 * own commit history for why a recursive directory removal on this app's real network drives
 * isn't reliable (readFileWithRetry/generateReport.ts hit the same class of flakiness on reads). */
export async function DELETE(request: NextRequest) {
  const body = await request.json();
  const { jobRoot, sectionId, fileName } = body as { jobRoot?: string; sectionId?: string; fileName?: string };

  if (typeof jobRoot !== "string" || !jobRoot) return NextResponse.json({ error: "jobRoot is required" }, { status: 400 });
  if (typeof sectionId !== "string" || !sectionId || !SAFE_SEGMENT.test(sectionId) || sectionId.startsWith(".")) {
    return NextResponse.json({ error: "Invalid sectionId" }, { status: 400 });
  }
  if (typeof fileName !== "string" || !fileName || !SAFE_SEGMENT.test(fileName)) {
    return NextResponse.json({ error: "Invalid fileName" }, { status: 400 });
  }

  const target = path.join(jobRoot, MANUAL_ATTACHMENTS_DIR, sectionId, fileName);
  const resolvedTarget = path.resolve(target);
  const resolvedRoot = path.resolve(jobRoot);
  if (!resolvedTarget.startsWith(resolvedRoot + path.sep)) {
    return NextResponse.json({ error: "Resolved path escapes the job folder" }, { status: 400 });
  }

  try {
    await fs.unlink(resolvedTarget);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to remove file" }, { status: 500 });
  }
}
