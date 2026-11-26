import { isAbortError } from "@/lib/abort-error";
import { createLogger } from "@/lib/logger";
import { NextResponse } from "next/server";
import { resolveVoiceAudioConfig } from "../../../../../server/voice-audio";
import { synthesizeCoachAudio } from "./synthesize";

const log = createLogger("api/voice/tts-s2s");

/**
 * POST /api/voice/tts-s2s
 *
 * Coach TTS synthesis via OpenRouter (minimax/speech-2.8-turbo). Always returns WAV (browser-safe).
 */
export async function POST(req: Request) {
  let body: { text?: unknown; language?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const rawText = typeof body.text === "string" ? body.text.trim() : "";
  const language = typeof body.language === "string" ? body.language : undefined;

  if (!rawText) {
    return NextResponse.json({ error: "Missing text" }, { status: 400 });
  }

  const voiceConfig = resolveVoiceAudioConfig();
  if (!voiceConfig.apiKey) {
    return NextResponse.json(
      { error: "OpenRouter TTS credentials not configured" },
      { status: 503 }
    );
  }

  const abort = new AbortController();
  req.signal.addEventListener("abort", () => abort.abort(), { once: true });

  try {
    const startedAt = Date.now();
    const wav = await synthesizeCoachAudio(rawText, voiceConfig, language, abort.signal);

    if (!wav) {
      log.warn(`TTS returned no audio (${rawText.length} chars in)`);
      return NextResponse.json(
        { error: "TTS returned no audio", fallback: "browser" },
        { status: 502 },
      );
    }

    log.info(
      `TTS synthesized wav: ${wav.byteLength}B, ${Date.now() - startedAt}ms`,
    );

    return new Response(new Uint8Array(wav), {
      status: 200,
      headers: {
        "Content-Type": "audio/wav",
        "Cache-Control": "no-store",
        "X-Aural-TTS-Format": "wav",
        "X-Aural-TTS-Provider": "openrouter-minimax-tts",
      },
    });
  } catch (err) {
    if (abort.signal.aborted || isAbortError(err)) {
      return new Response(null, { status: 499 });
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error("TTS synthesis failed:", message);
    return NextResponse.json(
      { error: "TTS synthesis failed" },
      { status: 502 }
    );
  }
}
