import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveVoiceAudioConfig,
  synthesizePcm,
  transcribePcm,
  wrapPcmAsWav,
  type VoiceAudioConfig,
} from "../server/voice-audio";

// ── wrapPcmAsWav: canonical 44-byte PCM WAV header ──

test("wrapPcmAsWav writes the exact 44-byte PCM header", () => {
  const pcm = Buffer.from([0x01, 0x02, 0x03, 0x04]);
  const wav = wrapPcmAsWav(pcm, 16_000, 1, 16);
  assert.equal(wav.length, 48);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(4), 36 + 4); // riffSize = 36 + dataBytes
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.toString("ascii", 12, 16), "fmt ");
  assert.equal(wav.readUInt32LE(16), 16); // fmt chunk size
  assert.equal(wav.readUInt16LE(20), 1); // PCM format
  assert.equal(wav.readUInt16LE(22), 1); // mono
  assert.equal(wav.readUInt32LE(24), 16_000); // sample rate
  assert.equal(wav.readUInt32LE(28), 32_000); // byteRate = rate * blockAlign
  assert.equal(wav.readUInt16LE(32), 2); // blockAlign
  assert.equal(wav.readUInt16LE(34), 16); // bits per sample
  assert.equal(wav.toString("ascii", 36, 40), "data");
  assert.equal(wav.readUInt32LE(40), 4); // data size
  assert.deepEqual(wav.subarray(44), pcm);
});

test("wrapPcmAsWav truncates an odd trailing byte to the sample boundary", () => {
  const wav = wrapPcmAsWav(Buffer.alloc(5, 7)); // 16-bit samples need even bytes
  assert.equal(wav.length, 44 + 4);
  assert.equal(wav.readUInt32LE(40), 4);
});

// ── resolveVoiceAudioConfig: defaults + speech-rate clamp ──

/** Minimal env fixture — Next.js augments ProcessEnv with a required NODE_ENV. */
function cfgEnv(over: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", ...over } as NodeJS.ProcessEnv;
}

test("resolveVoiceAudioConfig applies OpenRouter defaults when env is empty", () => {
  assert.deepEqual(resolveVoiceAudioConfig(cfgEnv({})), {
    apiKey: "",
    baseUrl: "https://openrouter.ai/api/v1",
    ttsModel: "minimax/speech-2.8-turbo",
    asrModel: "openai/whisper-large-v3-turbo",
    voiceZh: "male-qn-qingse",
    voiceEn: "English_Trustworth_Man",
    speechRate: 1.0,
  });
});

test("resolveVoiceAudioConfig strips a trailing slash from baseUrl", () => {
  const cfg = resolveVoiceAudioConfig(cfgEnv({ OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1/" }));
  assert.equal(cfg.baseUrl, "https://openrouter.ai/api/v1");
});

test("resolveVoiceAudioConfig clamps the speech rate into [0.5, 2]", () => {
  assert.equal(resolveVoiceAudioConfig(cfgEnv({ VOICE_TTS_SPEECH_RATE: "5" })).speechRate, 2);
  assert.equal(resolveVoiceAudioConfig(cfgEnv({ VOICE_TTS_SPEECH_RATE: "0.1" })).speechRate, 0.5);
  assert.equal(
    resolveVoiceAudioConfig(cfgEnv({ VOICE_TTS_SPEECH_RATE: "0" })).speechRate,
    1.0,
    "non-positive values fall back to the default, not the clamp floor",
  );
  assert.equal(
    resolveVoiceAudioConfig(cfgEnv({ VOICE_TTS_SPEECH_RATE: "abc" })).speechRate,
    1.0,
    "non-numeric values fall back to the default",
  );
  assert.equal(resolveVoiceAudioConfig(cfgEnv({ VOICE_TTS_SPEECH_RATE: "1.25" })).speechRate, 1.25);
});

// ── request shapes against the OpenRouter audio endpoints ──

const CFG: VoiceAudioConfig = {
  apiKey: "test-key",
  baseUrl: "https://openrouter.ai/api/v1",
  ttsModel: "minimax/speech-2.8-turbo",
  asrModel: "openai/whisper-large-v3-turbo",
  voiceZh: "male-qn-qingse",
  voiceEn: "English_Trustworth_Man",
  speechRate: 1.0,
};

async function withFetch(
  handler: (url: string, init: RequestInit) => Promise<Response>,
  fn: () => Promise<void>,
) {
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string | URL, init?: RequestInit) =>
    handler(String(url), init ?? {})) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test("transcribePcm posts a base64 WAV with the ASR model and language hint", async () => {
  let seen: { url: string; body: Record<string, unknown> } | null = null;
  await withFetch(
    async (url, init) => {
      seen = { url, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({ text: "  halo dunia  " }), { status: 200 });
    },
    async () => {
      const text = await transcribePcm(Buffer.alloc(320, 1), CFG, "id");
      assert.equal(text, "halo dunia");
    },
  );
  assert.equal(seen!.url, "https://openrouter.ai/api/v1/audio/transcriptions");
  assert.equal(seen!.body.model, "openai/whisper-large-v3-turbo");
  assert.equal(seen!.body.language, "id");
  const audio = seen!.body.input_audio as { data: string; format: string };
  assert.equal(audio.format, "wav");
  // 320 PCM bytes + the 44-byte WAV header, base64-encoded.
  assert.equal(Buffer.from(audio.data, "base64").length, 320 + 44);
});

test("transcribePcm omits a non-ISO language hint", async () => {
  let body: Record<string, unknown> = {};
  await withFetch(
    async (_url, init) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ text: "" }), { status: 200 });
    },
    async () => {
      await transcribePcm(Buffer.alloc(8, 0), CFG, "indonesian");
    },
  );
  assert.equal("language" in body, false);
});

test("transcribePcm surfaces the provider error detail on non-OK", async () => {
  await withFetch(
    async () => new Response("model minimax/asr-1.0 does not exist", { status: 400 }),
    async () => {
      await assert.rejects(transcribePcm(Buffer.alloc(8, 0), CFG), /does not exist/);
    },
  );
});

test("synthesizePcm requests raw PCM and returns the audio bytes", async () => {
  let seen: { url: string; body: Record<string, unknown> } | null = null;
  const audio = Buffer.from([1, 2, 3, 4, 5, 6]);
  await withFetch(
    async (url, init) => {
      seen = { url, body: JSON.parse(String(init.body)) };
      return new Response(audio, { status: 200 });
    },
    async () => {
      const pcm = await synthesizePcm("halo", CFG);
      assert.deepEqual(pcm, audio);
    },
  );
  assert.equal(seen!.url, "https://openrouter.ai/api/v1/audio/speech");
  assert.equal(seen!.body.model, "minimax/speech-2.8-turbo");
  assert.equal(seen!.body.input, "halo");
  assert.equal(seen!.body.voice, "English_Trustworth_Man");
  assert.equal(seen!.body.response_format, "pcm");
  assert.equal("speed" in seen!.body, false, "default rate is left to the provider");
});

test("synthesizePcm picks the zh voice and forwards a non-default speed", async () => {
  let body: Record<string, unknown> = {};
  await withFetch(
    async (_url, init) => {
      body = JSON.parse(String(init.body));
      return new Response(Buffer.from([9, 9]), { status: 200 });
    },
    async () => {
      await synthesizePcm("你好", { ...CFG, speechRate: 1.25 }, { language: "zh" });
    },
  );
  assert.equal(body.voice, "male-qn-qingse");
  assert.equal(body.speed, 1.25);
});

test("synthesizePcm rejects an empty audio response", async () => {
  await withFetch(
    async () => new Response(Buffer.alloc(0), { status: 200 }),
    async () => {
      await assert.rejects(synthesizePcm("halo", CFG), /empty audio/);
    },
  );
});