// Fluent speech-to-text: the learner's recorded voice is written down by ElevenLabs Scribe v2 when the
// ElevenLabs key is set (about half the mistakes of Whisper in independent tests, $0.22 per hour of voice),
// else by Whisper on Groq (free account, about 0.3 to 0.6 s). Whisper is also the backup when Scribe fails.
// Both hear a French accent and English mixed with French much better than the browser's dictation,
// which listens for one language only. With no key, or when both fail, the page keeps the browser's text.
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

const API = "https://api.groq.com/openai/v1";
const SCRIBE_API = "https://api.elevenlabs.io/v1/speech-to-text";
const SCRIBE_MODEL = "scribe_v2";
const scribe = { offUntil: 0 }; // a key without "Speech to Text" access: use Whisper for a while
// Words Scribe should expect (+20 percent on its price): the learner's French questions, often in the middle of an English
// sentence (without them, "comment on dit…" can come out as "come and eat…"), and the tutor's name. The IT words of the old goals are gone.
const SCRIBE_TERMS = ["comment on dit", "comment dit-on", "ça veut dire", "c'est quoi", "je sais pas", "je comprends pas", "attends", "j'ai oublié", "en anglais", "Jake"];
const scribeUp = () => Boolean(process.env.ELEVENLABS_API_KEY) && Date.now() >= scribe.offUntil;
const MODEL = "whisper-large-v3"; // the full model: better than the turbo one with accents
const TIMEOUT_MS = 6000;
const KEY_FORMAT = /^gsk_[A-Za-z0-9]{20,}$/;
// Hint for Whisper: the class is in English, the learner is French and sometimes asks in French.
const HINT = "English class. The learner is French and sometimes asks in French: « comment on dit… ? »";
// What Whisper invents on silence or noise (from its subtitle training data).
const HALLUCINATION = /amara\.org|subt[íi]tulos (realizados|por)|sous-titr|gracias por ver|merci d'avoir regardé|suscr[íi]bete|thanks? (you )?for watching|please subscribe|like and subscribe/i;

export class SttError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

// Groq or ElevenLabs: one of them is enough.
export function hasSttKey(envFile) {
  return hasGroqKey(envFile) || Boolean(process.env.ELEVENLABS_API_KEY);
}

// No key yet: look in .env again, so a key pasted there works without a restart.
function hasGroqKey(envFile) {
  if (!process.env.GROQ_API_KEY) {
    try {
      const key = String(parseEnv(readFileSync(envFile, "utf8")).GROQ_API_KEY || "").trim();
      if (key) process.env.GROQ_API_KEY = key;
    } catch { /* no .env yet */ }
  }
  return Boolean(process.env.GROQ_API_KEY);
}

export async function saveSttKey(envFile, raw) {
  const key = String(raw || "").trim();
  if (!KEY_FORMAT.test(key)) throw new SttError(400, "bad_key", "This does not look like a Groq API key. It starts with gsk_.");
  let res;
  try {
    res = await fetch(`${API}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new SttError(503, "offline", "Cannot reach Groq. Check your internet connection.");
  }
  if (res.status === 401 || res.status === 403) throw new SttError(401, "bad_key", "Groq says this key does not work.");
  if (!res.ok) throw new SttError(502, "api_error", "Could not check the key. Try again.");
  let env = "";
  try { env = await fs.readFile(envFile, "utf8"); } catch { /* new file */ }
  env = env.split("\n").filter((l) => l.trim() && !l.startsWith("GROQ_API_KEY=")).join("\n");
  await fs.writeFile(envFile, (env ? env + "\n" : "") + `GROQ_API_KEY=${key}\n`, { mode: 0o600 });
  await fs.chmod(envFile, 0o600);
  process.env.GROQ_API_KEY = key;
}

// audio: Buffer (webm/opus from Chrome, mp4 from Safari). context: the tutor's last words, so
// Whisper expects the same vocabulary. -> { text, language, ms, engine }
export async function transcribe(audio, mime, context = "") {
  if (scribeUp()) {
    try { return await scribeTranscribe(audio, mime); } catch (e) {
      if (!process.env.GROQ_API_KEY) throw e;
      console.warn("  [stt] Scribe failed, Whisper writes this one:", e.message);
    }
  }
  return whisperTranscribe(audio, mime, context);
}

// Live ears (2026-10-29): Scribe v2 Realtime writes the learner's words while they speak (about 0.2 s behind
// the voice, $0.39 per hour of audio sent). The browser streams the mic straight to ElevenLabs with a
// single-use token (one connection, valid 15 minutes): the key itself never leaves the Mac.
const LIVE_API = "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe";
const LIVE_WS = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
export async function liveScribe() {
  if (!process.env.ELEVENLABS_API_KEY || Date.now() < scribe.offUntil) throw new SttError(400, "no_stt_key", "No ElevenLabs key with Speech to Text.");
  let res;
  try {
    res = await fetch(LIVE_API, { method: "POST", headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY }, signal: AbortSignal.timeout(5000) });
  } catch {
    throw new SttError(503, "stt_offline", "Scribe did not answer.");
  }
  if (res.status === 401 || res.status === 403) throw new SttError(401, "bad_stt_key", "ElevenLabs refused live Speech to Text for this key.");
  if (!res.ok) throw new SttError(502, "stt_error", `Scribe live error ${res.status}.`);
  const { token } = await res.json();
  // Manual commits: the page decides when a turn ends. The key terms work live too (tested: "comment on dit").
  // The class language, with French as the second one: left to guess, Scribe sometimes took a sentence for
  // French ("Oui,") and then sent back nothing for it (seen 2026-10-29).
  const q = new URLSearchParams({ model_id: "scribe_v2_realtime", audio_format: "pcm_16000", commit_strategy: "manual", language_code: "en", token });
  q.append("secondary_languages", "fr");
  for (const t of SCRIBE_TERMS) q.append("keyterms", t);
  return { url: `${LIVE_WS}?${q}` };
}

const extOf = (mime) => (/mp4|m4a|aac/.test(mime) ? "mp4" : /ogg/.test(mime) ? "ogg" : /wav/.test(mime) ? "wav" : "webm");

// ElevenLabs Scribe v2: word for word (hesitations and false starts kept: the tutor sees how the learner really spoke).
async function scribeTranscribe(audio, mime) {
  const form = new FormData();
  form.append("file", new Blob([audio], { type: mime || "audio/webm" }), `speech.${extOf(mime)}`);
  form.append("model_id", SCRIBE_MODEL);
  form.append("tag_audio_events", "false");
  form.append("diarize", "false");
  for (const t of SCRIBE_TERMS) form.append("keyterms", t);
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(SCRIBE_API, { method: "POST", headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY }, body: form, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new SttError(503, "stt_offline", "Scribe did not answer.");
  }
  if (res.status === 401 || res.status === 403) {
    scribe.offUntil = Date.now() + 10 * 60_000; // no "Speech to Text" access on this key: Whisper for 10 minutes
    throw new SttError(401, "bad_stt_key", "ElevenLabs refused Speech to Text for this key (turn on Speech to Text: Access).");
  }
  if (res.status === 429) {
    // ElevenLabs says why: too many requests at once, the system is busy, or the credit is used up.
    const d = (await res.json().catch(() => ({})))?.detail || {};
    throw new SttError(429, "stt_busy", `Scribe is busy (${[d.status, d.code, d.message].filter(Boolean).join(": ").slice(0, 200) || "no reason given"}).`);
  }
  if (!res.ok) throw new SttError(502, "stt_error", `Scribe error ${res.status}.`);
  const data = await res.json().catch(() => ({}));
  let text = String(data.text || "").replace(/\s+/g, " ").trim();
  if (HALLUCINATION.test(text)) text = "";
  return { text, language: data.language_code || "", ms: Date.now() - t0, engine: "scribe" };
}

async function whisperTranscribe(audio, mime, context) {
  if (!process.env.GROQ_API_KEY) throw new SttError(400, "no_stt_key", "No Groq key.");
  const ext = extOf(mime);
  const form = new FormData();
  form.append("file", new Blob([audio], { type: mime || "audio/webm" }), `speech.${ext}`);
  form.append("model", MODEL);
  form.append("temperature", "0");
  form.append("response_format", "verbose_json");
  // Whisper reads the end of the prompt most: the hint goes last. It allows about 224 tokens.
  const prompt = `${String(context).replace(/\s+/g, " ").trim().slice(-300)} ${HINT}`.trim();
  form.append("prompt", prompt);
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(`${API}/audio/transcriptions`, {
      method: "POST", headers: { authorization: `Bearer ${process.env.GROQ_API_KEY}` }, body: form, signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new SttError(503, "stt_offline", "Groq did not answer.");
  }
  if (res.status === 401 || res.status === 403) throw new SttError(401, "bad_stt_key", "Groq refused the key.");
  if (res.status === 429) throw new SttError(429, "stt_busy", "Groq's free limit for this minute is reached.");
  if (!res.ok) throw new SttError(502, "stt_error", `Groq error ${res.status}.`);
  const data = await res.json().catch(() => ({}));
  // Drop the parts Whisper is not sure are speech (noise, breath), and its invented subtitle credits.
  const parts = Array.isArray(data.segments) ? data.segments.filter((s) => !(s.no_speech_prob > 0.6 && s.avg_logprob < -0.7)).map((s) => s.text) : [data.text];
  let text = parts.join(" ").replace(/\s+/g, " ").trim();
  if (HALLUCINATION.test(text)) text = "";
  return { text, language: data.language || "", ms: Date.now() - t0, engine: "whisper" };
}
