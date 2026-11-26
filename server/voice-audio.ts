/**
 * Voice audio via OpenRouter (BYOK key):
 *  - ASR: POST {base}/audio/transcriptions (base64 WAV in JSON). OpenRouter
 *    has no MiniMax ASR model, so the default is OpenAI whisper-large-v3-turbo.
 *  - TTS: POST {base}/audio/speech, model minimax/speech-2.8-turbo. MiniMax on
 *    OpenRouter returns mp3 or raw 24 kHz mono s16le PCM (no WAV container) —
 *    measured against the direct API at the same voice/speed.
 *
 * Endpoint: https://openrouter.ai/api/v1.
 */
import { createLogger } from "../src/lib/logger";

const log = createLogger("voice-audio");

export interface VoiceAudioConfig {
  apiKey: string;
  baseUrl: string;
  ttsModel: string;
  asrModel: string;
  voiceZh: string;
  voiceEn: string;
  speechRate?: number;
}

export function resolveVoiceAudioConfig(
  env: NodeJS.ProcessEnv = process.env,
): VoiceAudioConfig {
  const parsedRate = Number(env.VOICE_TTS_SPEECH_RATE);
  const speechRate =
    Number.isFinite(parsedRate) && parsedRate > 0
      ? Math.min(2, Math.max(0.5, parsedRate))
      : 1.0;
  return {
    apiKey: env.OPENROUTER_API_KEY || "",
    baseUrl: (env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, ""),
    ttsModel: env.VOICE_TTS_MODEL || "minimax/speech-2.8-turbo",
    asrModel: env.VOICE_ASR_MODEL || "openai/whisper-large-v3-turbo",
    voiceZh: env.VOICE_TTS_VOICE_ZH || "male-qn-qingse",
    voiceEn: env.VOICE_TTS_VOICE_EN || "English_Trustworth_Man",
    speechRate,
  };
}

// ── WAV helper (the ASR endpoint wants a container, not raw PCM) ──────

export function wrapPcmAsWav(
  pcm: Buffer,
  sampleRate = 16_000,
  channels = 1,
  bitsPerSample = 16,
): Buffer {
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const dataBytes = pcm.byteLength - (pcm.byteLength % (bitsPerSample / 8));
  const header = Buffer.alloc(44);

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);

  return Buffer.concat([header, pcm.subarray(0, dataBytes)]);
}

// ── ASR ──────────────────────────────────────────────────────────────

/**
 * One-shot ASR over 16 kHz mono s16le PCM. Returns the recognized text
 * ("" when the provider returns nothing usable).
 */
export async function transcribePcm(
  pcm: Buffer,
  cfg: VoiceAudioConfig,
  language?: string,
  signal?: AbortSignal,
): Promise<string> {
  const wav = wrapPcmAsWav(pcm, 16_000);
  // whisper hints accept ISO-639-1; force nothing when the value is not a code.
  const lang = language?.toLowerCase().match(/^[a-z]{2}$/)?.[0];

  const res = await fetch(`${cfg.baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: cfg.asrModel,
      input_audio: { data: wav.toString("base64"), format: "wav" },
      ...(lang ? { language: lang } : {}),
    }),
    signal,
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`OpenRouter ASR HTTP ${res.status}: ${detail}`);
  }
  const json = (await res.json()) as { text?: string };
  return (json.text || "").trim();
}

// ── TTS ──────────────────────────────────────────────────────────────

export interface TtsRequestOptions {
  language?: string;
  signal?: AbortSignal;
}

/**
 * Sync TTS → raw 24 kHz mono s16le PCM. Throws on provider errors; callers
 * decide fallback behavior.
 */
export async function synthesizePcm(
  text: string,
  cfg: VoiceAudioConfig,
  opts: TtsRequestOptions = {},
): Promise<Buffer> {
  const isZh = opts.language?.toLowerCase().startsWith("zh");
  // ponytail: zh/en voice split only — id reuses the en voice; add a
  // VOICE_TTS_VOICE_ID mapping if live Indonesian quality demands it.
  const voiceId = isZh ? cfg.voiceZh : cfg.voiceEn;

  const res = await fetch(`${cfg.baseUrl}/audio/speech`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: cfg.ttsModel,
      input: text,
      voice: voiceId,
      response_format: "pcm",
      ...(cfg.speechRate && cfg.speechRate !== 1 ? { speed: cfg.speechRate } : {}),
    }),
    signal: opts.signal,
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`OpenRouter TTS HTTP ${res.status}: ${detail}`);
  }
  const pcm = Buffer.from(await res.arrayBuffer());
  if (pcm.byteLength === 0) throw new Error("OpenRouter TTS: empty audio response");
  log.debug(`TTS ${text.length} chars -> ${pcm.byteLength}B pcm (${voiceId})`);
  return pcm;
}