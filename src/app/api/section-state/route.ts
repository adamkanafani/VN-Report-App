import { NextRequest, NextResponse } from "next/server";
import { updateSectionState } from "@/lib/state/jobState";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { jobRoot, sectionId, patch } = body as { jobRoot: string; sectionId: string; patch: Record<string, unknown> };
  if (!jobRoot || !sectionId) return NextResponse.json({ error: "jobRoot and sectionId are required" }, { status: 400 });

  const state = await updateSectionState(jobRoot, sectionId, patch);
  return NextResponse.json({ state: state.sections[sectionId] });
}
