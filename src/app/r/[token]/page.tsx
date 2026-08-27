import { ReportView } from "@/components/interview/report-view";
import { buildReportRows, fetchReportEntries } from "@/lib/interview-report";
import { AutoRefresh } from "./auto-refresh";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { CircleDot } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * Public aggregate report for an interview, resolved by share token.
 * Server-rendered; a client poller refreshes it so newly completed
 * candidates appear without reloading.
 */
export default async function PublicReportPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const { data: link } = await supabaseAdmin
    .from("interview_report_links")
    .select("interviewId")
    .eq("token", token)
    .maybeSingle();

  if (!link) notFound();

  const interviewId = (link as { interviewId: string }).interviewId;

  const { data: interviewRow } = await supabaseAdmin
    .from("interviews")
    .select("title")
    .eq("id", interviewId)
    .single();

  const entries = await fetchReportEntries(supabaseAdmin, interviewId);
  const report = buildReportRows(
    interviewRow?.title ?? "Interview",
    entries,
  );

  return (
    <div className="mx-auto min-h-screen w-full max-w-7xl space-y-6 px-4 py-8">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs uppercase tracking-wider text-muted-foreground">
            Interview Report
          </p>
          <h1 className="text-2xl font-bold">{report.interviewTitle}</h1>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <CircleDot className="h-3.5 w-3.5 text-green-600" />
          Live — updates automatically
        </div>
      </div>
      <AutoRefresh seconds={30} />
      <ReportView data={report} />
      <p className="text-center text-xs text-muted-foreground">
        Shared via{" "}
        <Link href="/" className="underline">
          Aural
        </Link>
      </p>
    </div>
  );
}
