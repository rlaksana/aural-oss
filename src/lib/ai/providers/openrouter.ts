import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { LLMProvider, GenerationParams, LLMResponse, LLMMessage } from "../types";

/** Strip `thinking` blocks some routed models emit inline. */
function stripThinking(text: string): string {
  return text.replace(/<think[\s\S]*?<\/think>\s*/g, "").trim();
}

/** MiniMax M3.1 reasons at "max" by default, and reasoning tokens share
 * max_tokens — at "high" a 700-token call can come back truncated or empty.
 * Default to "low" (measured ~30-80 reasoning tokens); callers may raise it. */
function reasoningParams(params: GenerationParams) {
  return { reasoning: { effort: params.reasoningEffort ?? "low" } };
}

/** OpenRouter is OpenAI-compatible; only the base URL and key differ. */
export class OpenRouterProvider implements LLMProvider {
  id = "openrouter";
  name = "OpenRouter";
  models = ["minimax/minimax-m3.1-flash", "tencent/hy4-flash"];
  defaultModel = "minimax/minimax-m3.1-flash";

  private client: OpenAI;

  constructor() {
    this.client = new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY ?? "",
      baseURL: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
      // Upstream occasionally drops sockets mid-response ("terminated");
      // retry harder than the SDK default and fail loudly past this.
      timeout: 180_000,
      maxRetries: 3,
    });
  }

  private toOpenAIMessages(messages: LLMMessage[]): ChatCompletionMessageParam[] {
    return messages.filter((m) =>
      typeof m.content === "string" ? m.content.trim().length > 0 : m.content.length > 0,
    ) as ChatCompletionMessageParam[];
  }

  async generateResponse(
    params: GenerationParams & { model?: string }
  ): Promise<LLMResponse> {
    const response = await this.client.chat.completions.create({
      model: params.model ?? this.defaultModel,
      messages: this.toOpenAIMessages(params.messages),
      temperature: params.temperature ?? 0.7,
      max_tokens: params.maxTokens ?? 2048,
      // OpenRouter's standardized reasoning control (see reasoningParams).
      ...reasoningParams(params),
    }, { signal: params.signal });

    const choice = response.choices[0];
    return {
      content: stripThinking(choice.message.content ?? ""),
      finishReason: choice.finish_reason ?? "stop",
      usage: response.usage
        ? {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
            totalTokens: response.usage.total_tokens,
          }
        : undefined,
    };
  }

  async *streamResponse(
    params: GenerationParams & { model?: string }
  ): AsyncIterable<string> {
    const stream = await this.client.chat.completions.create({
      model: params.model ?? this.defaultModel,
      messages: this.toOpenAIMessages(params.messages),
      temperature: params.temperature ?? 0.7,
      max_tokens: params.maxTokens ?? 2048,
      ...reasoningParams(params),
      stream: true,
    }, { signal: params.signal });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) yield content;
    }
  }
}
