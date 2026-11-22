// Fluent — shadowing: a daily accent workout of 10 to 30 minutes, one sound of the day (SHADOW_PROGRAM in shadow.js).
// Claude writes short native sentences with their stress pattern and the tricky sounds; the learner speaks
// along with the tutor's voice, and the recording comes back here to be written down word by word
// (ElevenLabs Scribe, with how sure it was of each word; Whisper on Groq as the backup).
// The melody and the rhythm are compared in the browser (public/js/shadow.js), which has both recordings.

// Strict schemas: every field required, no extra fields (same helpers as server.js).
const obj = (properties) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const str = { type: "string" };

const SET_SCHEMA = obj({
  sentences: {
    type: "array",
    items: obj({ text: str, tr: str, focus: str, stress: str, tricky: { type: "array", items: obj({ word: str, ipa: str, tip: str }) } }),
  },
});

const SCRIBE_API = "https://api.elevenlabs.io/v1/speech-to-text";
const GROQ_API = "https://api.groq.com/openai/v1/audio/transcriptions";
const TIMEOUT_MS = 8000;

const clean = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

export function shadowRoutes({ askJSON, modelFor, settingsOf, readDoc, memoryText, AppError, LEVEL_GUIDE }) {
  return {
    // A set of sentences to shadow. body.source.sentences: sentences from a lesson (homework) to annotate instead of new ones.
    async "POST /api/shadow/set"(body) {
      const [profile, memory, progress] = await Promise.all([readDoc("profile"), readDoc("memory"), readDoc("progress")]);
      const set = settingsOf(profile);
      const given = (Array.isArray(body?.source?.sentences) ? body.source.sentences : []).map((s) => clean(s, 220)).filter(Boolean).slice(0, 12);
      const n = given.length || Math.min(12, Math.max(3, Number(body?.count) || 8));
      const british = set.tutorId === "emma";
      const accent = british ? "modern British English (London)" : "General American English (West Coast)";
      const weak = (Array.isArray(progress?.shadowWeak) ? progress.shadowWeak : [])
        .filter((w) => w && w.word).sort((a, b) => (b.count || 0) - (a.count || 0)).slice(0, 12).map((w) => w.word);
      const L = set.lang;
      // The daily program (shadow.js): the sound of the day and the kind of talk of this block.
      const focus = clean(body?.focus, 200);
      const avoid = (Array.isArray(body?.avoid) ? body.avoid : []).map((s) => clean(s, 240)).filter(Boolean).slice(-40);
      const KINDS = {
        sound: `Every sentence is packed with today's sound: ${focus || "the sounds French speakers miss"}. Mostly everyday speech.`,
        everyday: `Everyday speech: friends, flatmates and classmates on a university exchange abroad, shops, cafés, plans, opinions, small talk, reactions, short stories, feelings. Use today's sound (${focus || "th, r, h, flap t"}) often.`,
        business: `General business talk: presenting a company, meetings, calls, updates, networking, polite disagreement, small talk with colleagues. Never about the learner's own company. Use today's sound (${focus || "th, r, h, flap t"}) often.`,
        mix: `A mix of everyday and business talk, built around today's sound (${focus || "th, r, h, flap t"}) and the words they often say unclearly (below).`,
      };
      const kind = KINDS[body?.block] || "";
      const system = `You are an accent coach for a French speaker who wants to sound natural in ${accent}. You prepare shadowing material: the learner listens to a native voice and speaks along with it, copying the melody, the rhythm, the stress and the linking. Explanations language: ${L}. Learner level: ${set.level}. ${LEVEL_GUIDE[set.level] || ""}`;
      const what = given.length
        ? `Use exactly these ${given.length} sentences, in this order, with "text" copied word for word:\n${given.map((s, i) => `${i + 1}. ${s}`).join("\n")}`
        : kind
          ? `Write ${n} different sentences (8 to 18 words each), the way a native really says them. ${kind} Never about the learner's company. Use contractions and natural rhythm. Order them from easier to harder.${avoid.length ? `\nThese were already done today: write new ones, with other topics and other words:\n${avoid.map((s) => `- ${s}`).join("\n")}` : ""}`
          : `Write ${n} different sentences (8 to 18 words each), the way a native really says them: mostly everyday speech (plans, opinions, small talk, reactions, stories with friends), and about one in four from general business talk (meetings, calls, networking). Fill them with the sounds French speakers miss (th, r, h, flap t, short i, reductions like gonna and wanna). Never about the learner's company. Use contractions and natural rhythm. Order them from easier to harder.${focus ? ` Focus asked by the learner: ${focus}.` : ""}`;
      const prompt = `${what}

What you know about the learner (use it to choose topics and sounds):
${memoryText(memory || {})}
Words they often say unclearly when shadowing: ${weak.join(", ") || "none yet"}

Fields for each sentence:
- text: the sentence, read aloud by text-to-speech: no slashes, brackets, quotes, emojis or "…".
- tr: its translation in French.
- focus: one short tip in ${L} on what to imitate in this sentence (linking like "wanna get it", weak forms like "to" said "tuh", the stressed word, the melody going down at the end, the flap t in "water").
- stress: exactly the same words as text, same spelling and same number of words, in lowercase, with the stressed syllable of each stressed word in CAPITALS (example: "we NEED to deVELop it beFORE the DEmo"). Keep acronyms spelled as in text but in lowercase ("pdfs", "api"), never spelled out.
- tricky: 0 to 2 words that French speakers usually get wrong in it (th, h, short i, schwa, -ed, word stress), each with ipa (${british ? "British" : "General American"} IPA between slashes) and tip (one short sentence in ${L}).`;
      const out = await askJSON({ model: modelFor(set, "chat"), system, messages: [{ role: "user", content: prompt }], schema: SET_SCHEMA, effort: "low", maxTokens: 8000 });
      const sentences = (Array.isArray(out.sentences) ? out.sentences : []).slice(0, n).map((s, i) => ({
        text: given[i] || clean(s?.text, 240),
        tr: clean(s?.tr, 300),
        focus: clean(s?.focus, 300),
        stress: clean(s?.stress, 300),
        tricky: (Array.isArray(s?.tricky) ? s.tricky : []).slice(0, 2).map((t) => ({ word: clean(t?.word, 40), ipa: clean(t?.ipa, 60), tip: clean(t?.tip, 200) })).filter((t) => t.word),
      })).filter((s) => s.text);
      if (!sentences.length) throw new AppError(502, "bad_json", "No sentences came back. Try again.");
      return { sentences, accent: british ? "en-GB" : "en-US" };
    },
  };
}

// The learner's recording -> { text, words: [{ text, start, end, logprob }], engine, ms }.
// logprob (Scribe only) says how sure the model was of each word: a low one usually means an unclear sound.
export async function shadowScore(req, res, { readRaw, send, AppError }) {
  const audio = await readRaw(req, 8_000_000);
  if (audio.length < 1000) return send(res, 200, { text: "", words: [], engine: "none", ms: 0 });
  const mime = String(req.headers["content-type"] || "audio/webm");
  const ext = /mp4|m4a|aac/.test(mime) ? "mp4" : /ogg/.test(mime) ? "ogg" : /wav/.test(mime) ? "wav" : "webm";
  const file = () => new Blob([audio], { type: mime });
  if (!process.env.ELEVENLABS_API_KEY && !process.env.GROQ_API_KEY) throw new AppError(400, "no_stt_key", "Add an ElevenLabs or Groq key in Settings.");
  const t0 = Date.now();
  if (process.env.ELEVENLABS_API_KEY) {
    try {
      const form = new FormData();
      form.append("file", file(), `speech.${ext}`);
      form.append("model_id", "scribe_v2");
      form.append("language_code", "en"); // shadowing is English only: no guessing the language
      form.append("timestamps_granularity", "word");
      form.append("tag_audio_events", "false");
      form.append("diarize", "false");
      const r = await fetch(SCRIBE_API, { method: "POST", headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY }, body: form, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!r.ok) throw new Error(`Scribe ${r.status}`);
      const d = await r.json();
      const words = (Array.isArray(d.words) ? d.words : []).filter((w) => w && w.type === "word" && String(w.text || "").trim())
        .map((w) => ({ text: String(w.text).trim(), start: Number(w.start) || 0, end: Number(w.end) || 0, logprob: Number.isFinite(w.logprob) ? w.logprob : null }));
      return send(res, 200, { text: clean(d.text, 2000), words, engine: "scribe", ms: Date.now() - t0 });
    } catch (err) {
      if (!process.env.GROQ_API_KEY) throw new AppError(502, "stt_error", "Scribe did not answer. Try again.");
      console.warn("  [shadow] Scribe failed, Whisper writes this one:", err.message);
    }
  }
  const form = new FormData();
  form.append("file", file(), `speech.${ext}`);
  form.append("model", "whisper-large-v3");
  form.append("language", "en");
  form.append("temperature", "0");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  let r;
  try {
    r = await fetch(GROQ_API, { method: "POST", headers: { authorization: `Bearer ${process.env.GROQ_API_KEY}` }, body: form, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new AppError(503, "stt_offline", "Speech recognition did not answer. Check your internet connection.");
  }
  if (!r.ok) throw new AppError(502, "stt_error", `Speech recognition error ${r.status}. Try again.`);
  const d = await r.json().catch(() => ({}));
  const words = (Array.isArray(d.words) ? d.words : []).map((w) => ({ text: String(w.word || "").trim(), start: Number(w.start) || 0, end: Number(w.end) || 0, logprob: null })).filter((w) => w.text);
  return send(res, 200, { text: clean(d.text, 2000), words, engine: "whisper", ms: Date.now() - t0 });
}
