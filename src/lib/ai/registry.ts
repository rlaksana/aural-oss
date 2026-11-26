import { type LLMProvider } from "./types";
import { OpenAIProvider } from "./providers/openai";
import { GeminiProvider } from "./providers/gemini";
import { KimiProvider } from "./providers/kimi";
import { MinimaxProvider } from "./providers/minimax";
import { OpenRouterProvider } from "./providers/openrouter";
import { ZaiProvider } from "./providers/zai";

const providers = new Map<string, LLMProvider>();

function registerProvider(provider: LLMProvider) {
  providers.set(provider.id, provider);
}

// The LiteLLM gateway is deliberately NOT registered: it rejected every
// datacenter IP (including Vercel's), so no route may resolve to it.
// Routing rule since 2026-11-26: all text LLM routes resolve to OpenRouter
// (MiniMax M3.1 Flash primary, Tencent HY4 Flash fallback/repair).
registerProvider(new OpenAIProvider());
registerProvider(new GeminiProvider());
registerProvider(new KimiProvider());
registerProvider(new MinimaxProvider());
registerProvider(new OpenRouterProvider());
registerProvider(new ZaiProvider());

/** Resolve the right provider for a given model name or provider id. */
export function getProvider(idOrModel?: string | null): LLMProvider {
  if (idOrModel) {
    if (providers.has(idOrModel)) return providers.get(idOrModel)!;
    const allProviders = Array.from(providers.values());
    for (const p of allProviders) {
      if (p.models.some((m: string) => m.toLowerCase() === idOrModel.toLowerCase())) {
        return p;
      }
    }
  }
  // Default fallback order: openai → gemini → kimi → minimax → openrouter
  if (process.env.OPENAI_API_KEY) return providers.get("openai")!;
  if (process.env.GEMINI_API_KEY) return providers.get("gemini")!;
  if (process.env.KIMI_API_KEY) return providers.get("kimi")!;
  if (process.env.MINIMAX_API_KEY) return providers.get("minimax")!;
  if (process.env.OPENROUTER_API_KEY) return providers.get("openrouter")!;
  throw new Error("No LLM provider configured. Set OPENAI_API_KEY, GEMINI_API_KEY, KIMI_API_KEY, MINIMAX_API_KEY, or OPENROUTER_API_KEY.");
}

export function listProviders(): LLMProvider[] {
  return Array.from(providers.values());
}

/**
 * Primary text-LLM for ALL routes (generator pipelines, live-interviewer
 * chat, report): MiniMax M3.1 Flash served by OpenRouter. The live chat and
 * report override reasoning effort to "low" for latency.
 */
export const PRIMARY_TEXT_MODEL = "minimax/minimax-m3.1-flash";

export const REPORT_MODEL = PRIMARY_TEXT_MODEL;

export const GENERATOR_MODEL = PRIMARY_TEXT_MODEL;

export const PRIMARY_GENERATOR_MODEL = GENERATOR_MODEL;

/** Transport-error resilience fallback on OpenRouter (same provider, different model). */
export const FALLBACK_GENERATOR_MODEL = "tencent/hy4-flash";

/** Dedicated JSON-repair model on OpenRouter. */
export const REPAIR_MODEL = "tencent/hy4-flash";
