import { nanoid } from "@/lib/id";
import {
  buildReportRows,
  fetchReportEntries,
  type InterviewReport,
} from "@/lib/interview-report";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, publicProcedure, router } from "../trpc";
import { verifyInterviewAccess } from "./candidate";

export const reportRouter = router({
  /** Aggregate report + current share-link token (null when none). */
  get: protectedProcedure
    .input(z.object({ interviewId: z.string() }))
    .query(async ({ ctx, input }) => {
      const interview = await verifyInterviewAccess(
        ctx.supabase,
        input.interviewId,
        ctx.user.id,
      );

      const [{ data: interviewRow }, { data: link }] = await Promise.all([
        ctx.supabase
          .from("interviews")
          .select("title")
          .eq("id", input.interviewId)
          .single(),
        ctx.supabase
          .from("interview_report_links")
          .select("token")
          .eq("interviewId", input.interviewId)
          .maybeSingle(),
      ]);

      const entries = await fetchReportEntries(
        ctx.supabase,
        input.interviewId,
      );
      const report = buildReportRows(
        interviewRow?.title ?? "Interview",
        entries,
      );

      return {
        report,
        linkToken: (link as { token: string } | null)?.token ?? null,
        role: interview.role,
      };
    }),

  /** Create (or replace) the single share link for this interview. */
  createLink: protectedProcedure
    .input(z.object({ interviewId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await verifyInterviewAccess(ctx.supabase, input.interviewId, ctx.user.id);

      const token = nanoid(24);
      // One link per interview: replace any existing row (unique index backs this up).
      await ctx.supabase
        .from("interview_report_links")
        .delete()
        .eq("interviewId", input.interviewId);

      const { error } = await ctx.supabase
        .from("interview_report_links")
        .insert({ interviewId: input.interviewId, token });

      if (error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error.message,
        });
      }

      return { token };
    }),

  deleteLink: protectedProcedure
    .input(z.object({ interviewId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await verifyInterviewAccess(ctx.supabase, input.interviewId, ctx.user.id);

      await ctx.supabase
        .from("interview_report_links")
        .delete()
        .eq("interviewId", input.interviewId);

      return { success: true };
    }),

  /** Public: resolve a share token to the aggregate report. */
  getByToken: publicProcedure
    .input(z.object({ token: z.string() }))
    .query(async ({ ctx, input }) => {
      const { data: link } = await ctx.supabase
        .from("interview_report_links")
        .select("interviewId")
        .eq("token", input.token)
        .maybeSingle();

      if (!link) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Report link not found" });
      }

      const { data: interviewRow } = await ctx.supabase
        .from("interviews")
        .select("title")
        .eq("id", (link as { interviewId: string }).interviewId)
        .single();

      const entries = await fetchReportEntries(
        ctx.supabase,
        (link as { interviewId: string }).interviewId,
      );
      const report: InterviewReport = buildReportRows(
        interviewRow?.title ?? "Interview",
        entries,
      );

      return { report };
    }),
});
