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

  for (const [i, { sessionId, name }] of sessions.entries()) {
    // Throttle UI ticks — each onProgress triggers a React re-render of the
    // 300+ row report; emitting every 5 items keeps the DOM quiet while the
    // loop is still making forward progress in the background.
    if (i % 5 === 0) {
      opts.onProgress?.({ done, failed, total: sessions.length, current: name });
    }
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
  }
  // Always emit the final tick so the UI shows the real total on completion.
  opts.onProgress?.({
    done,
    failed,
    total: sessions.length,
    current: null,
  });

  return { done, failed };
}
