/**
 * Sequentially backfills AI summaries for completed sessions that lack scores.
 * Runs strictly one request at a time (no parallelism) and continues past
 * individual failures so one bad transcript doesn't stall the whole batch.
 */
export type BackfillProgress = {
  done: number;
  failed: number;
  total: number;
  current: string | null;
};

export async function runSequentialSummaries(
  sessions: { sessionId: string; name: string }[],
  opts: {
    onProgress?: (p: BackfillProgress) => void;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<{ done: number; failed: number }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let done = 0;
  let failed = 0;

  for (const { sessionId, name } of sessions) {
    opts.onProgress?.({ done, failed, total: sessions.length, current: name });
    try {
      const res = await fetchImpl("/api/ai/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, skipExisting: true }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      done += 1;
    } catch {
      failed += 1;
    }
    opts.onProgress?.({ done, failed, total: sessions.length, current: name });
  }

  return { done, failed };
}
