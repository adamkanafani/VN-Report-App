import { NextRequest, NextResponse } from "next/server";
import { updateSectionOrder } from "@/lib/state/jobState";
import { resolveReportTemplate } from "@/lib/report-templates";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { jobRoot, order, reportType } = body as { jobRoot: string; order: string[]; reportType?: string };
  if (!jobRoot || !Array.isArray(order)) return NextResponse.json({ error: "jobRoot and order are required" }, { status: 400 });

  const template = resolveReportTemplate(reportType);
  const state = await updateSectionOrder(jobRoot, template.reportType, order);
  return NextResponse.json({ sectionOrder: state.sectionOrders?.[template.reportType] });
}
