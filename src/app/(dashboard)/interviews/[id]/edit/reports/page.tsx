"use client";

import { ReportsTab } from "@/components/interview/reports-tab";
import { useEditInterview } from "../edit-context";

export default function InterviewReportsPage() {
  const { interviewId } = useEditInterview();
  return <ReportsTab interviewId={interviewId} />;
}
