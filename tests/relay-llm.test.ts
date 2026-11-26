import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import * as relayLlm from "../server/relay-llm";

function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => void,
): void {
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    prev[key] = process.env[key];
    const v = vars[key];
    if (v === undefined) delete process.env[key];
    else process.env[key] = v;
  }
  relayLlm.resetRelayLlmCacheForTests();
  try {
    fn();
  } finally {
    for (const key of Object.keys(vars)) {
      const v = prev[key];
      if (v === undefined) delete process.env[key];
      else process.env[key] = v;
    }
    relayLlm.resetRelayLlmCacheForTests();
  }
}

afterEach(() => {
  relayLlm.resetRelayLlmCacheForTests();
});

test("default primary is minimax/minimax-m3.1-flash via OpenRouter with tencent/hy4-flash fallback", () => {
  withEnv(
    {
      RELAY_LLM_MODEL: undefined,
      RELAY_LLM_API_KEY: undefined,
      RELAY_LLM_BASE_URL: undefined,
      KIMI_API_KEY: undefined,
      GEMINI_API_KEY: "g-test",
      MINIMAX_API_KEY: "m-test",
      MINIMAX_BASE_URL: "https://api.minimax.io/v1",
      OPENROUTER_API_KEY: "or-test",
    },
    () => {
      assert.equal(relayLlm.getRelayLlmModel(), "minimax/minimax-m3.1-flash");
      assert.equal(relayLlm.getRelayLlmFallbackModel(), "tencent/hy4-flash");
    },
  );
});

test("RELAY_LLM_MODEL override works and falls back to tencent/hy4-flash", () => {
  withEnv(
    {
      RELAY_LLM_MODEL: "abab6.5s-chat",
      RELAY_LLM_API_KEY: "m-test",
      RELAY_LLM_BASE_URL: "https://api.minimax.io/v1",
      RELAY_LLM_PROVIDER: "openai",
      MINIMAX_API_KEY: "m-test",
      OPENROUTER_API_KEY: "or-test",
    },
    () => {
      assert.equal(relayLlm.getRelayLlmModel(), "abab6.5s-chat");
      assert.equal(relayLlm.getRelayLlmFallbackModel(), "tencent/hy4-flash");
    },
  );
});

async function withChatStub(
  vars: Record<string, string | undefined>,
  reply: (body: Record<string, unknown>) => { content: string; finish?: string },
  fn: (bodies: Record<string, unknown>[]) => Promise<void>,
): Promise<void> {
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    prev[key] = process.env[key];
    const v = vars[key];
    if (v === undefined) delete process.env[key];
    else process.env[key] = v;
  }
  relayLlm.resetRelayLlmCacheForTests();

  const original = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    bodies.push(body);
    const { content, finish } = reply(body);
    return new Response(
      JSON.stringify({
        choices: [{ message: { content }, finish_reason: finish ?? "stop" }],
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  try {
    await fn(bodies);
  } finally {
    globalThis.fetch = original;
    for (const key of Object.keys(vars)) {
      const v = prev[key];
      if (v === undefined) delete process.env[key];
      else process.env[key] = v;
    }
    relayLlm.resetRelayLlmCacheForTests();
  }
}

const CLEAN_RELAY_ENV = {
  RELAY_LLM_MODEL: undefined,
  RELAY_LLM_API_KEY: undefined,
  RELAY_LLM_BASE_URL: undefined,
  RELAY_LLM_PROVIDER: undefined,
  RELAY_LLM_FALLBACK_MODEL: undefined,
  RELAY_LLM_FALLBACK_BASE_URL: undefined,
  OPENROUTER_API_KEY: "or-test",
};

test("an empty primary completion falls through to the fallback model", async () => {
  await withChatStub(
    CLEAN_RELAY_ENV,
    (body) =>
      body.model === "tencent/hy4-flash"
        ? { content: "fallback answer" }
        : { content: "", finish: "length" },
    async (bodies) => {
      const text = await relayLlm.callRelayLLM("halo", 100);
      assert.equal(text, "fallback answer");
      assert.deepEqual(
        bodies.map((b) => b.model),
        ["minimax/minimax-m3.1-flash", "tencent/hy4-flash"],
      );
    },
  );
});

test("reasoning control is sent to OpenRouter only", async () => {
  await withChatStub(CLEAN_RELAY_ENV, () => ({ content: "ok" }), async (bodies) => {
    await relayLlm.callRelayLLM("halo", 100);
    assert.deepEqual(bodies[0]!.reasoning, { effort: "low" });
  });
  await withChatStub(
    {
      ...CLEAN_RELAY_ENV,
      RELAY_LLM_MODEL: "abab6.5s-chat",
      RELAY_LLM_API_KEY: "mm-test",
      RELAY_LLM_BASE_URL: "https://api.minimax.io/v1",
      OPENROUTER_API_KEY: undefined,
    },
    () => ({ content: "ok" }),
    async (bodies) => {
      await relayLlm.callRelayLLM("halo", 100);
      assert.equal(bodies.length, 1);
      assert.equal(Object.hasOwn(bodies[0] ?? {}, "reasoning"), false);
    },
  );
});

test("no fallback without OPENROUTER_API_KEY", () => {
  withEnv(
    {
      GEMINI_API_KEY: "g-test",
      MINIMAX_API_KEY: "m-test",
      OPENROUTER_API_KEY: undefined,
    },
    () => {
      assert.equal(relayLlm.getRelayLlmFallbackModel(), null);
    },
  );
});
