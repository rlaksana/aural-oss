import assert from "node:assert/strict";
import test from "node:test";

import { runSequentialSummaries } from "../src/lib/report-backfill";

// fetchImpl signature mirrors global fetch: (input, init)
type FetchCall = (input: string, init?: RequestInit) => Promise<Response>;

test("runSequentialSummaries fires requests strictly one at a time", async () => {
  let active = 0;
  let maxActive = 0;
  const order: string[] = [];

  const fetchImpl: FetchCall = async (_input, init) => {
    const body = JSON.parse(init!.body as string) as { sessionId: string };
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push(body.sessionId);
    // Hold each request long enough that a parallel run would interleave.
    await new Promise((r) => setTimeout(r, 10));
    active -= 1;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const progressTicks: number[] = [];
  await runSequentialSummaries(
    [
      { sessionId: "s1", name: "A" },
      { sessionId: "s2", name: "B" },
      { sessionId: "s3", name: "C" },
    ],
    {
      fetchImpl: fetchImpl as typeof fetch,
      onProgress: (p) => progressTicks.push(p.done + p.failed),
    },
  );

  assert.equal(maxActive, 1, "sequential — never more than one in flight");
  assert.deepEqual(order, ["s1", "s2", "s3"]);
  assert.equal(progressTicks[progressTicks.length - 1], 3);
});

test("runSequentialSummaries keeps going past a failure", async () => {
  const order: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const body = JSON.parse(init!.body as string) as { sessionId: string };
    order.push(body.sessionId);
    if (body.sessionId === "s2") {
      return new Response("nope", { status: 500 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const result = await runSequentialSummaries(
    [
      { sessionId: "s1", name: "A" },
      { sessionId: "s2", name: "B" },
      { sessionId: "s3", name: "C" },
    ],
    { fetchImpl },
  );

  assert.deepEqual(order, ["s1", "s2", "s3"]);
  assert.equal(result.done, 2);
  assert.equal(result.failed, 1);
});

test("runSequentialSummaries does not throw when failing entirely", async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response("nope", { status: 500 });

  const result = await runSequentialSummaries(
    [
      { sessionId: "s1", name: "A" },
      { sessionId: "s2", name: "B" },
    ],
    { fetchImpl },
  );

  assert.equal(result.done, 0);
  assert.equal(result.failed, 2);
});

test("runSequentialSummaries sends skipExisting on every request", async () => {
  const seen: unknown[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    seen.push(JSON.parse(init!.body as string));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  await runSequentialSummaries(
    [{ sessionId: "s1", name: "A" }],
    { fetchImpl },
  );

  for (const body of seen) {
    assert.equal((body as { skipExisting: boolean }).skipExisting, true);
  }
});

test("runSequentialSummaries handles an empty batch", async () => {
  const result = await runSequentialSummaries([], {
    fetchImpl: async () => new Response("{}", { status: 200 }),
  });

  assert.deepEqual(result, { done: 0, failed: 0 });
});
