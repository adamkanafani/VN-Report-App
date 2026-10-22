import { NextRequest, NextResponse } from "next/server";
import { updateSectionOrder } from "@/lib/state/jobState";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { jobRoot, order } = body as { jobRoot: string; order: string[] };
  if (!jobRoot || !Array.isArray(order)) return NextResponse.json({ error: "jobRoot and order are required" }, { status: 400 });

  const state = await updateSectionOrder(jobRoot, order);
  return NextResponse.json({ sectionOrder: state.sectionOrder });
}
