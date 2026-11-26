import assert from "node:assert/strict";
import test from "node:test";

import * as registry from "../src/lib/ai/registry";
import {
  getGeneratorModelChain,
  resolveGeneratorModel,
  streamGeneratorWithFallback,
  generateChatWithFallback,
} from "../src/lib/ai/generator-run";

const ENV_KEYS = [
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "KIMI_API_KEY",
  "MINIMAX_API_KEY",
  "OPENROUTER_API_KEY",
  "AI_API_KEY",
  "AI_MODEL",
  "ZAI_API_KEY",
] as const;

async function withEnv(
  nextEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>,
  fn: () => void | Promise<void>,
) {
  const previous = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    previous.set(key, process.env[key]);
    const value = nextEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    await fn();
  } finally {
    for (const key of ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("getGeneratorModelChain is primary + fallback once OPENROUTER_API_KEY exists", () => {
  withEnv(
    {
      ZAI_API_KEY: "test-zai",
      AI_API_KEY: "test-ai",
      OPENAI_API_KEY: "test-openai",
      GEMINI_API_KEY: "test-gemini",
      KIMI_API_KEY: "test-kimi",
      MINIMAX_API_KEY: "test-minimax",
      OPENROUTER_API_KEY: "test-openrouter",
    },
    () => {
      assert.deepEqual(getGeneratorModelChain(), [
        "minimax/minimax-m3.1-flash",
        "tencent/hy4-flash",
      ]);
      assert.equal(resolveGeneratorModel(), "minimax/minimax-m3.1-flash");
    },
  );
});

test("getGeneratorModelChain ignores AI_MODEL override (gateway is not the generator primary)", () => {
  withEnv(
    {
      OPENROUTER_API_KEY: "test-openrouter",
      AI_API_KEY: "test-ai",
      AI_MODEL: "custom-gateway-model",
    },
    () => {
      assert.deepEqual(getGeneratorModelChain(), [
        "minimax/minimax-m3.1-flash",
        "tencent/hy4-flash",
      ]);
      assert.equal(resolveGeneratorModel(), "minimax/minimax-m3.1-flash");
    },
  );
});

test("getGeneratorModelChain requires OPENROUTER_API_KEY even when other keys exist", () => {
  withEnv(
    {
      OPENAI_API_KEY: "test-openai",
      MINIMAX_API_KEY: "test-minimax",
      AI_API_KEY: "test-ai",
      ZAI_API_KEY: "test-zai",
      OPENROUTER_API_KEY: undefined,
    },
    () => {
      assert.throws(() => getGeneratorModelChain(), /OPENROUTER_API_KEY/);
    },
  );
});

// ── Fallback stream/chat behavior. Both chain models now resolve to the SAME
// OpenRouter provider instance, so the fakes are dispatched by the `model`
// param instead of shadowing one provider per model.

type FakeProvider = {
  streamResponse?: (params: unknown) => AsyncGenerator<string>;
  generateResponse?: (params: unknown) => Promise<{ content: string; finishReason: string }>;
};

async function withFakedProviders(
  fakes: Record<string, FakeProvider>,
  fn: () => Promise<void>,
) {
  const provider = registry.getProvider("openrouter") as unknown as Record<string, unknown>;
  const patched: { method: string; saved: unknown }[] = [];
  try {
    for (const method of ["streamResponse", "generateResponse"] as const) {
      if (!Object.values(fakes).some((fake) => fake[method])) continue;
      patched.push({ method, saved: provider[method] });
      provider[method] = (params: unknown) => {
        const model = (params as { model?: string }).model;
        const fake = model ? fakes[model]?.[method] : undefined;
        if (!fake) throw new Error(`no fake registered for ${String(model)}`);
        return fake(params);
      };
    }
    await fn();
  } finally {
    for (const p of patched) provider[p.method] = p.saved;
  }
}

const TWO_MODEL_ENV = {
  OPENAI_API_KEY: undefined,
  GEMINI_API_KEY: undefined,
  KIMI_API_KEY: undefined,
  MINIMAX_API_KEY: undefined,
  AI_API_KEY: undefined,
  AI_MODEL: undefined,
  ZAI_API_KEY: "test-zai",
  OPENROUTER_API_KEY: "test-openrouter",
} as const;

async function drain(gen: AsyncGenerator<string>): Promise<string[]> {
  const chunks: string[] = [];
  for await (const c of gen) chunks.push(c);
  return chunks;
}

test("streaming: a partial yield pins the stream — original error, fallback never called", async () => {
  let fallbackCalls = 0;
  await withEnv(TWO_MODEL_ENV, () =>
    withFakedProviders(
      {
        "minimax/minimax-m3.1-flash": {
          streamResponse: async function* () {
            yield "a";
            yield "b";
            throw new Error("primary transport died mid-stream");
          },
        },
        "tencent/hy4-flash": {
          streamResponse: async function* () {
            fallbackCalls += 1;
            yield "fallback";
          },
        },
      },
      async () => {
        await assert.rejects(
          drain(streamGeneratorWithFallback({ messages: [] })),
          /primary transport died mid-stream/,
        );
        assert.equal(fallbackCalls, 0, "fallback after a partial yield would concatenate two responses into one unparseable output");
      },
    ),
  );
});

test("streaming: a pre-yield failure falls back transparently", async () => {
  let primaryCalls = 0;
  await withEnv(TWO_MODEL_ENV, () =>
    withFakedProviders(
      {
        "minimax/minimax-m3.1-flash": {
          streamResponse: async function* () {
            primaryCalls += 1;
            throw new Error("primary down");
          },
        },
        "tencent/hy4-flash": {
          streamResponse: async function* () {
            yield "f1";
            yield "f2";
          },
        },
      },
      async () => {
        const chunks = await drain(streamGeneratorWithFallback({ messages: [] }));
        assert.deepEqual(chunks, ["f1", "f2"]);
        assert.equal(primaryCalls, 1, "exactly one attempt on the primary before switching");
      },
    ),
  );
});

test("streaming: both models failing pre-yield rejects with the LAST error", async () => {
  await withEnv(TWO_MODEL_ENV, () =>
    withFakedProviders(
      {
        "minimax/minimax-m3.1-flash": {
          streamResponse: async function* () {
            throw new Error("primary down");
          },
        },
        "tencent/hy4-flash": {
          streamResponse: async function* () {
            throw new Error("fallback also down");
          },
        },
      },
      async () => {
        await assert.rejects(
          drain(streamGeneratorWithFallback({ messages: [] })),
          /fallback also down/,
        );
      },
    ),
  );
});

test("streaming: a clean full stream never touches the fallback", async () => {
  let fallbackCalls = 0;
  await withEnv(TWO_MODEL_ENV, () =>
    withFakedProviders(
      {
        "minimax/minimax-m3.1-flash": {
          streamResponse: async function* () {
            yield "x";
            yield "y";
          },
        },
        "tencent/hy4-flash": {
          streamResponse: async function* () {
            fallbackCalls += 1;
            yield "unused";
          },
        },
      },
      async () => {
        assert.deepEqual(await drain(streamGeneratorWithFallback({ messages: [] })), ["x", "y"]);
        assert.equal(fallbackCalls, 0);
      },
    ),
  );
});

test("chat: primary failure falls back; both failing throws the last error", async () => {
  await withEnv(TWO_MODEL_ENV, () =>
    withFakedProviders(
      {
        "minimax/minimax-m3.1-flash": {
          generateResponse: async () => {
            throw new Error("primary chat down");
          },
        },
        "tencent/hy4-flash": {
          generateResponse: async () => ({ content: "recovered", finishReason: "stop" }),
        },
      },
      async () => {
        const ok = await generateChatWithFallback({ messages: [] });
        assert.equal(ok.content, "recovered");
      },
    ),
  );

  await withEnv(TWO_MODEL_ENV, () =>
    withFakedProviders(
      {
        "minimax/minimax-m3.1-flash": {
          generateResponse: async () => {
            throw new Error("primary chat down");
          },
        },
        "tencent/hy4-flash": {
          generateResponse: async () => {
            throw new Error("fallback chat down");
          },
        },
      },
      async () => {
        await assert.rejects(
          generateChatWithFallback({ messages: [] }),
          /fallback chat down/,
        );
      },
    ),
  );
});

test("chat: a healthy primary never calls the fallback", async () => {
  let fallbackCalls = 0;
  await withEnv(TWO_MODEL_ENV, () =>
    withFakedProviders(
      {
        "minimax/minimax-m3.1-flash": {
          generateResponse: async () => ({ content: "primary answer", finishReason: "stop" }),
        },
        "tencent/hy4-flash": {
          generateResponse: async () => {
            fallbackCalls += 1;
            return { content: "unused", finishReason: "stop" };
          },
        },
      },
      async () => {
        const out = await generateChatWithFallback({ messages: [] });
        assert.equal(out.content, "primary answer");
        assert.equal(fallbackCalls, 0);
      },
    ),
  );
});
