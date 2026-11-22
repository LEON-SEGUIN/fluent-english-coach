"use strict";
// Fluent — shadowing: a daily accent workout of 10 to 30 minutes, one sound of the day (SHADOW_PROGRAM), in blocks.
// A native voice (the tutor's) says a sentence; the learner speaks along with it (shadowing, with headphones)
// or right after it. Each try gets three scores: the words (written down by Scribe on the Mac), the melody
// (both pitch curves, compared after aligning them in time) and the rhythm (how long the speech lasts).
// Sentences come from /api/shadow/set: new ones, or the ones of a lesson (homework).

const SHADOW_GOALS = [10, 15, 20, 30];
const SHADOW_SET = 8; // sentences per round; the next round repeats them, the weakest first
const SHADOW_ROUNDS = 2; // rounds per block; then a block of new sentences (a 30-minute workout never loops on 8 sentences)
// The daily program (2026-11-10: a daily accent workout of up to 30 minutes with Jake's voice).
// One main sound or habit per day, in this order, then again from the start. A day counts once 5 minutes are done.
const SHADOW_PROGRAM = [
  { en: "The th sound (think, this, three)", fr: "Le son th (think, this, three)" },
  { en: "The American r (right, work, really)", fr: "Le r américain (right, work, really)" },
  { en: "The flap t (water, better, get it)", fr: "Le t américain adouci (water, better, get it)" },
  { en: "The h (house, have, how)", fr: "Le h (house, have, how)" },
  { en: "Short i and long ee (live, leave, it, eat)", fr: "i court et ee long (live, leave, it, eat)" },
  { en: "Weak words and the schwa (to, for, can, of)", fr: "Les mots faibles et le schwa (to, for, can, of)" },
  { en: "Word stress (deVELop, PHOtograph, eCOnomy)", fr: "L'accent des mots (deVELop, PHOtograph, eCOnomy)" },
  { en: "Linking words (gonna, wanna, kinda, get it)", fr: "Enchaîner les mots (gonna, wanna, kinda, get it)" },
  { en: "-ed endings (worked, wanted, played)", fr: "Les terminaisons -ed (worked, wanted, played)" },
  { en: "The open a (that, have, plan, actually)", fr: "Le a ouvert (that, have, plan, actually)" },
  { en: "Sentence melody: statements and questions", fr: "La mélodie : affirmations et questions" },
  { en: "The dark l (feel, will, people, actually)", fr: "Le l sombre (feel, will, people, actually)" },
];
// The blocks of one workout, in this order: the sound of the day, everyday talk, business talk, then a mix.
const SHADOW_BLOCKS = [["sound", "Sound of the day", "Son du jour"], ["everyday", "Everyday talk", "Vie de tous les jours"], ["business", "Business talk", "Anglais pro"], ["mix", "Mix", "Mélange"]];
const SHADOW_SILENT = 0.006; // mic level (RMS) under which a whole try is silence (-44 dB; speech is about 0.05 to 0.3)
const SHADOW_UNCLEAR = -0.35; // Scribe log-probability under which a word was not clear (Scribe is usually sure: ~0)
// Small words are not worth a "sound to work on" entry (they are missed for many reasons).
const SHADOW_SMALL = new Set("a an the to of in on at for and or but so is are was were be been it its i you he she we they me my your our their this that these those with as by from up out do does did can could will would should have has had not no yes just very really what which who how".split(" "));

// =====================================================================
// Sound analysis: pure functions (no DOM), also run under node in the tests.
// =====================================================================

// AudioBuffer-like ({ numberOfChannels, getChannelData }) -> one channel.
function shadowMono(buffer) {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);
  const a = buffer.getChannelData(0), b = buffer.getChannelData(1), out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i] + b[i]) / 2;
  return out;
}

// Pitch every 10 ms (YIN), from 70 to 400 Hz. -> { f0 (0 = no voice), rms, hop (s), loud }
function shadowPitch(samples, rate) {
  const k = Math.max(1, Math.round(rate / 16000)); // 16 kHz is enough for a voice, and 3 times faster than 48 kHz
  const sr = rate / k;
  const x = new Float32Array(Math.floor(samples.length / k));
  for (let i = 0; i < x.length; i++) { let s = 0; for (let j = 0; j < k; j++) s += samples[i * k + j]; x[i] = s / k; }
  const hop = Math.round(sr * 0.01), win = Math.round(sr * 0.03);
  const minLag = Math.floor(sr / 400), maxLag = Math.ceil(sr / 70);
  const n = Math.max(0, Math.floor((x.length - win - maxLag) / hop));
  const f0 = new Float32Array(n), rms = new Float32Array(n), d = new Float32Array(maxLag + 2);
  for (let f = 0; f < n; f++) {
    const s0 = f * hop;
    let e = 0;
    for (let j = 0; j < win; j++) e += x[s0 + j] * x[s0 + j];
    rms[f] = Math.sqrt(e / win);
  }
  const loud = [...rms].sort((a, b) => a - b)[Math.floor(n * 0.95)] || 0;
  for (let f = 0; f < n; f++) {
    if (rms[f] < loud * 0.08) continue; // silence or breath
    const s0 = f * hop;
    // YIN: difference function, cumulative mean normalised, first dip under the threshold (else the deepest one, if clear enough).
    let run = 0, tau = -1, best = -1;
    d[0] = 1;
    for (let t = 1; t <= maxLag + 1; t++) {
      let sum = 0;
      for (let j = 0; j < win; j++) { const v = x[s0 + j] - x[s0 + j + t]; sum += v * v; }
      run += sum;
      d[t] = run ? (sum * t) / run : 1;
    }
    for (let t = minLag; t <= maxLag; t++) {
      if (best < 0 || d[t] < d[best]) best = t;
      if (d[t] < 0.2) { while (t + 1 <= maxLag && d[t + 1] < d[t]) t++; tau = t; break; }
    }
    if (tau < 0 && best > 0 && d[best] < 0.35) tau = best;
    if (tau < 0) continue;
    const a = d[tau - 1], b = d[tau], c = d[tau + 1];
    const shift = a + c - 2 * b ? (a - c) / (2 * (a + c - 2 * b)) : 0;
    f0[f] = sr / (tau + Math.max(-1, Math.min(1, shift)));
  }
  return { f0, rms, hop: hop / sr, loud };
}

// Pitch in semitones around the speaker's own median (a deep voice and a high voice become comparable).
// Octave slips of the tracker are folded back, short gaps filled. -> { st (NaN = no voice), start, end } (frames of speech)
function shadowContour(p) {
  const n = p.f0.length;
  const voiced = [...p.f0].filter((v) => v > 0).sort((a, b) => a - b);
  const st = new Float32Array(n).fill(NaN);
  let start = 0, end = n - 1;
  while (start < n && p.rms[start] < p.loud * 0.15) start++;
  while (end > start && p.rms[end] < p.loud * 0.15) end--;
  if (voiced.length < 5) return { st, start, end: end + 1, voiced: 0 };
  const med = voiced[Math.floor(voiced.length / 2)];
  for (let i = 0; i < n; i++) {
    if (!(p.f0[i] > 0)) continue;
    let v = 12 * Math.log2(p.f0[i] / med);
    if (v > 7) v -= 12; else if (v < -9) v += 12; // a doubled or halved period, not a real jump
    if (Math.abs(v) <= 9) st[i] = v;
  }
  const sm = new Float32Array(st);
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(st[i])) continue;
    const w = [];
    for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) if (!Number.isNaN(st[j])) w.push(st[j]);
    w.sort((a, b) => a - b);
    sm[i] = w[Math.floor(w.length / 2)];
  }
  // Fill gaps up to 80 ms (a consonant inside a word), not real pauses.
  for (let i = 0; i < n;) {
    if (!Number.isNaN(sm[i])) { i++; continue; }
    let j = i;
    while (j < n && Number.isNaN(sm[j])) j++;
    if (i > 0 && j < n && j - i <= 8) for (let k = i; k < j; k++) sm[k] = sm[i - 1] + ((sm[j] - sm[i - 1]) * (k - i + 1)) / (j - i + 1);
    i = j;
  }
  return { st: sm, start, end: end + 1, voiced: voiced.length };
}

// The speech part, frame by frame: loudness (z-scored log energy: it marks the syllables) and pitch.
function shadowFrames(p, c) {
  const e = [], st = [];
  for (let i = c.start; i < c.end; i++) { e.push(Math.log(p.rms[i] + 1e-4)); st.push(c.st[i]); }
  const mean = e.reduce((a, b) => a + b, 0) / Math.max(1, e.length);
  const sd = Math.sqrt(e.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, e.length)) || 1;
  return { e: e.map((v) => (v - mean) / sd), st };
}

// Dynamic time warping inside a band (no wild stretching), on syllables first, pitch second.
// -> pairs [i, j] from start to end.
function shadowDTW(a, b) {
  const n = a.e.length, m = b.e.length;
  const band = Math.max(15, Math.ceil(0.15 * Math.max(n, m)));
  const INF = 1e12;
  const D = Array.from({ length: n + 1 }, () => new Float64Array(m + 1).fill(INF));
  D[0][0] = 0;
  for (let i = 1; i <= n; i++) {
    const center = Math.round((i * m) / n);
    for (let j = Math.max(1, center - band); j <= Math.min(m, center + band); j++) {
      const pa = a.st[i - 1], pb = b.st[j - 1];
      const va = !Number.isNaN(pa), vb = !Number.isNaN(pb);
      const cost = Math.abs(a.e[i - 1] - b.e[j - 1]) + (va && vb ? 0.12 * Math.abs(pa - pb) : va !== vb ? 0.4 : 0);
      D[i][j] = cost + Math.min(D[i - 1][j - 1], D[i - 1][j] + 0.05, D[i][j - 1] + 0.05);
    }
  }
  const path = [];
  let i = n, j = m;
  if (D[n][m] >= INF) return path;
  while (i > 0 && j > 0) {
    path.push([i - 1, j - 1]);
    const diag = D[i - 1][j - 1], up = D[i - 1][j], left = D[i][j - 1];
    if (diag <= up && diag <= left) { i--; j--; } else if (up < left) i--; else j--;
  }
  return path.reverse();
}

// Compares the learner with the native recording.
// -> { intonation 0-100 | null, rhythm 0-100 | null, ratio (learner length / native length), curve: { native: [], you: [] } }
function shadowCompare(refSamples, refRate, youSamples, youRate) {
  const rp = shadowPitch(refSamples, refRate), yp = shadowPitch(youSamples, youRate);
  const rc = shadowContour(rp), yc = shadowContour(yp);
  const refDur = (rc.end - rc.start) * rp.hop, youDur = (yc.end - yc.start) * yp.hop;
  const ratio = refDur > 0.3 && youDur > 0.3 ? youDur / refDur : null;
  // Rhythm: 10% off is fine, 50% off is far.
  const rhythm = ratio ? Math.round(clampN(100 - Math.abs(Math.log(ratio)) * 160, 0, 100)) : null;
  const a = shadowFrames(rp, rc), b = shadowFrames(yp, yc);
  const none = { intonation: null, rhythm, ratio, curve: { native: shadowThin(shadowSmooth([...a.st])), you: [] } };
  if (rc.voiced < 10 || yc.voiced < 10 || !ratio) return none;
  const path = shadowDTW(a, b);
  const pairs = path.filter(([i, j]) => !Number.isNaN(a.st[i]) && !Number.isNaN(b.st[j]));
  if (pairs.length < 15) return none;
  let ma = 0, mb = 0;
  for (const [i, j] of pairs) { ma += a.st[i]; mb += b.st[j]; }
  ma /= pairs.length; mb /= pairs.length;
  let cov = 0, va = 0, vb = 0, mad = 0;
  for (const [i, j] of pairs) {
    const x = a.st[i] - ma, y = b.st[j] - mb;
    cov += x * y; va += x * x; vb += y * y; mad += Math.abs(x - y);
  }
  mad /= pairs.length;
  const r = va && vb ? cov / Math.sqrt(va * vb) : 0;
  // Same shape (correlation of the aligned pitch lines) and same size of the ups and downs (mean gap in semitones).
  const shape = clampN(((r - 0.2) / 0.65) * 100, 0, 100);
  const size = clampN(100 - (mad - 1.5) * 25, 0, 100);
  // A flat voice cannot score well, even when it stays "close" to a calm native line.
  const sdA = Math.sqrt(va / pairs.length), sdB = Math.sqrt(vb / pairs.length);
  const flat = sdB < sdA * 0.45 ? 0.6 : 1;
  const intonation = Math.round((0.65 * shape + 0.35 * size) * flat);
  // The learner's line drawn on the native time line.
  const you = new Array(a.st.length).fill(null), cnt = new Array(a.st.length).fill(0);
  for (const [i, j] of path) if (!Number.isNaN(b.st[j])) { you[i] = (you[i] || 0) + b.st[j] - mb + ma; cnt[i]++; }
  for (let i = 0; i < you.length; i++) if (cnt[i]) you[i] /= cnt[i];
  return { intonation, rhythm, ratio, curve: { native: shadowThin(shadowSmooth([...a.st])), you: shadowThin(shadowSmooth(you)) }, r, mad };
}
// For the drawing only: a wider median (one-frame spikes of the tracker disappear).
function shadowSmooth(vals) {
  const ok = (v) => v != null && !Number.isNaN(v);
  return vals.map((v, i) => {
    if (!ok(v)) return null;
    const w = [];
    for (let j = Math.max(0, i - 4); j <= Math.min(vals.length - 1, i + 4); j++) if (ok(vals[j])) w.push(vals[j]);
    w.sort((a, b) => a - b);
    return w[Math.floor(w.length / 2)];
  });
}
// At most 160 points to draw (NaN and null kept as gaps).
function shadowThin(vals, max = 160) {
  if (vals.length <= max) return [...vals].map((v) => (v == null || Number.isNaN(v) ? null : v));
  const out = [];
  for (let k = 0; k < max; k++) {
    const a = Math.floor((k * vals.length) / max), b = Math.floor(((k + 1) * vals.length) / max);
    let s = 0, c = 0;
    for (let i = a; i < b; i++) if (vals[i] != null && !Number.isNaN(vals[i])) { s += vals[i]; c++; }
    out.push(c ? s / c : null);
  }
  return out;
}
function clampN(v, a, b) { return Math.max(a, Math.min(b, v)); }

// "10%" -> "ten percent", "40" -> "forty": the transcript writes numbers, the sentence spells them.
function shadowSpell(text) {
  const ones = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
  const tens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
  const say = (n) => {
    if (n < 20) return ones[n];
    if (n < 100) return tens[Math.floor(n / 10)] + (n % 10 ? " " + ones[n % 10] : "");
    if (n < 1000) return ones[Math.floor(n / 100)] + " hundred" + (n % 100 ? " " + say(n % 100) : "");
    return String(n);
  };
  return String(text).replace(/%/g, " percent").replace(/\b\d{1,3}\b/g, (m) => say(Number(m)));
}

// =====================================================================
// Microphone and playback for the workout
// =====================================================================
const ShadowMic = {
  stream: null, analyser: null, data: null,
  // Opens the mic once per workout (inside a tap, so phones allow it).
  async open() {
    if (this.stream) return;
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw { code: "unsupported" };
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      throw { code: e?.name === "NotAllowedError" ? "not-allowed" : "audio-capture" };
    }
    const ctx = AudioOut.ensure();
    const src = ctx.createMediaStreamSource(this.stream);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    src.connect(this.analyser);
    this.data = new Float32Array(this.analyser.fftSize);
  },
  level() {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.data);
    let s = 0;
    for (const v of this.data) s += v * v;
    return Math.sqrt(s / this.data.length);
  },
  // -> { stop(), done: Promise<Blob> }
  record() {
    const mime = Ears.mime();
    const mr = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    mr.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
    const done = new Promise((resolve) => { mr.onstop = () => resolve(new Blob(chunks, { type: mr.mimeType || "audio/webm" })); });
    mr.start(250);
    return { done, stop() { try { if (mr.state !== "inactive") mr.stop(); } catch { /* gone */ } } };
  },
  close() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.analyser = null;
  },
};

const ShadowPlayer = {
  src: null,
  stop() { try { if (this.src) { this.src.onended = null; this.src.stop(); } } catch { /* stopped */ } this.src = null; },
  // Plays a decoded buffer; resolves at its end (or when stopped).
  play(buffer) {
    Speech.stop();
    this.stop();
    const ctx = AudioOut.ensure();
    return new Promise(async (resolve) => {
      if (ctx.state !== "running") { try { await ctx.resume(); } catch { /* needs a tap */ } }
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(AudioOut.analyser);
      src.onended = () => { if (this.src === src) this.src = null; resolve(); };
      this.src = src;
      src.start();
    });
  },
};

// =====================================================================
// The workout
// =====================================================================
const shadowGoal = () => (SHADOW_GOALS.includes(Number(S.profile.shadowMinutes)) ? Number(S.profile.shadowMinutes) : 10);
const shadowDays = () => (S.progress.shadow && typeof S.progress.shadow === "object" ? S.progress.shadow : {});
const shadowToday = () => Number(shadowDays()[today()]) || 0;
// Days in a row with at least 5 minutes of shadowing (today may still be to do).
function shadowStreak() {
  const days = shadowDays();
  let d = today(), n = 0;
  if ((days[d] || 0) < 5) d = addDays(d, -1);
  while ((days[d] || 0) >= 5) { n++; d = addDays(d, -1); }
  return n;
}
// Day of the program: the days already worked (5 minutes or more) before today, so today keeps one sound all day.
function shadowDay() {
  const days = shadowDays(), t = today();
  return Object.keys(days).filter((d) => d < t && (Number(days[d]) || 0) >= 5).length;
}
const shadowFocus = () => SHADOW_PROGRAM[shadowDay() % SHADOW_PROGRAM.length];
const shadowBlock = (n) => SHADOW_BLOCKS[n % SHADOW_BLOCKS.length];
const shadowTutor = () => tutorNow().id;
const shadowVoice = () => Speech.voiceFor(shadowTutor());
const shadowRate = (slow) => (slow ? Math.min(0.8, Speech.rate() * 0.8) : Speech.rate());

// opts: { minutes: one of SHADOW_GOALS, sentences: [strings from a lesson], title, onDone(summary) }
async function startShadow(opts = {}) {
  Speech.stop();
  Mic.stopAll();
  const minutes = SHADOW_GOALS.includes(Number(opts.minutes)) ? Number(opts.minutes) : shadowGoal();
  const sh = {
    phase: "loading", minutes, t0: Date.now(), activeMs: 0, lastTick: Date.now(), error: null,
    source: Array.isArray(opts.sentences) ? opts.sentences.filter(Boolean) : null, title: opts.title || "", onDone: opts.onDone,
    block: 0, day: shadowDay(), focus: shadowFocus(), nextSet: null,
    sentences: [], order: [], pos: 0, round: 1, mode: S.profile.shadowMode === "after" ? "after" : "shadow",
    step: "listen", // listen | recording | checking | feedback
    results: {}, tries: 0, xp: 0, weak: {}, ref: new Map(), last: null, showTr: false,
    saved: { ms: 0, tries: 0, xp: 0, weak: {} }, // what is already written (a "5 more minutes" part is saved on its own)
  };
  UI.shadow = sh;
  render();
  window.scrollTo(0, 0);
  // The mic permission is asked while the sentences load (both take a moment).
  ShadowMic.open().catch((e) => micError(e));
  await shadowLoad(sh);
  if (UI.shadow === sh && sh.phase === "work") shadowListen();
  sh.timer = setInterval(() => shadowTick(sh), 1000);
}

// What to ask the Mac for: the lesson's sentences, or new ones for block n (its kind, the sound of the day,
// and the sentences already done today so none comes back).
function shadowSetBody(sh, n) {
  if (sh.source?.length) return { source: { sentences: sh.source } };
  return { count: SHADOW_SET, block: shadowBlock(n)[0], focus: sh.focus.en, avoid: sh.sentences.map((s) => s.text).slice(-40) };
}

// Loads the sentences of the current block (or takes the ones fetched in advance) and adds them to the workout.
async function shadowLoad(sh) {
  try {
    const r = await (sh.nextSet || api("/api/shadow/set", shadowSetBody(sh, sh.block)));
    sh.nextSet = null;
    if (UI.shadow !== sh || sh.phase !== "loading") return;
    const fresh = (r.sentences || []).filter((s) => s && s.text);
    if (!fresh.length) throw { message: L("No sentences came back. Try again.", "Aucune phrase reçue. Réessaie.") };
    const start = sh.sentences.length;
    sh.sentences.push(...fresh);
    sh.order = fresh.map((_, i) => start + i);
    sh.pos = 0;
    sh.round = 1;
    sh.phase = "work";
    sh.lastTick = Date.now();
  } catch (e) {
    sh.nextSet = null;
    if (UI.shadow !== sh || sh.phase !== "loading") return;
    sh.phase = "error";
    sh.error = e;
  }
  render();
}

// The last round of a block is starting: the next block is written meanwhile, so there is no wait.
function shadowPreload(sh) {
  if (sh.source?.length || sh.nextSet) return;
  sh.nextSet = api("/api/shadow/set", shadowSetBody(sh, sh.block + 1));
  sh.nextSet.catch(() => {});
}

function shadowNewBlock(sh) {
  sh.block++;
  sh.phase = "loading";
  ShadowPlayer.stop();
  render();
  window.scrollTo(0, 0);
  shadowLoad(sh).then(() => { if (UI.shadow === sh && sh.phase === "work") shadowListen(); });
}

// Counts active time only (a hidden page or a long pause does not count), and updates the clock.
function shadowTick(sh) {
  if (UI.shadow !== sh) { clearInterval(sh.timer); return; }
  const now = Date.now();
  if (sh.phase === "work" && !document.hidden) sh.activeMs += Math.min(5000, now - sh.lastTick);
  sh.lastTick = now;
  const el = $("#sh-clock");
  if (el) el.textContent = shadowClock(sh);
  const bar = $("#sh-time");
  if (bar) bar.style.width = `${Math.min(100, (sh.activeMs / (sh.minutes * 60000)) * 100)}%`;
}
function shadowClock(sh) {
  const s = Math.floor(sh.activeMs / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} / ${sh.minutes}:00`;
}

const shadowCur = () => { const sh = UI.shadow; return sh && sh.sentences[sh.order[sh.pos]]; };

// The native recording of a sentence (decoded, kept for the comparison and the replays).
function shadowRef(idx, slow = false) {
  const sh = UI.shadow;
  const key = `${idx}|${slow ? "slow" : "normal"}`;
  if (!sh.ref.has(key)) {
    const p = fetchTTS(sh.sentences[idx].text, shadowVoice(), shadowRate(slow), shadowTutor());
    p.catch(() => sh.ref.delete(key));
    sh.ref.set(key, p);
  }
  return sh.ref.get(key);
}

async function shadowListen(slow = false) {
  const sh = UI.shadow, idx = sh?.order[sh.pos];
  if (!sh || idx == null || sh.step === "recording") return;
  try {
    const { audio } = await shadowRef(idx, slow);
    if (UI.shadow === sh) await ShadowPlayer.play(audio);
  } catch {
    Speech.say(sh.sentences[idx].text, { tutor: shadowTutor(), rate: shadowRate(slow) });
  }
  // The next sentence is fetched now, so it is ready when the learner moves on.
  const next = sh.order[sh.pos + 1];
  if (next != null) shadowRef(next).catch(() => {});
}

// Shadow mode: the native voice and the mic start together. Repeat mode: the mic opens when the voice ends.
async function shadowGo() {
  const sh = UI.shadow, idx = sh?.order[sh.pos];
  if (!sh || idx == null) return;
  if (sh.step === "recording") { sh.stopNow?.(); return; }
  if (sh.step === "checking") return;
  if (!ShadowMic.stream) { try { await ShadowMic.open(); } catch (e) { micError(e); return; } }
  let ref;
  try { ref = await shadowRef(idx); } catch { toast(L("The voice did not load. Check your internet.", "La voix n'a pas chargé. Vérifie ton internet.")); return; }
  if (UI.shadow !== sh) return;
  sh.step = "recording";
  sh.last = null;
  render();
  let stopped = false;
  const stopWait = new Promise((resolve) => { sh.stopNow = () => { stopped = true; resolve(); }; });
  let rec, meter;
  if (sh.mode === "shadow") {
    rec = ShadowMic.record();
    meter = shadowMeter();
    await new Promise((r) => setTimeout(r, 120)); // the recorder needs a moment to start
    await Promise.race([ShadowPlayer.play(ref.audio), stopWait]);
    if (!stopped) await Promise.race([new Promise((r) => setTimeout(r, 700)), stopWait]);
  } else {
    await Promise.race([ShadowPlayer.play(ref.audio), stopWait]);
    if (!stopped) {
      rec = ShadowMic.record();
      meter = shadowMeter();
      sh.yourTurn = true;
      render();
      // Stops 1.2 s after the voice goes quiet, or at most twice the native length.
      const max = ref.audio.duration * 2 + 2;
      const t0 = performance.now();
      let heard = 0, quiet = 0;
      await new Promise((resolve) => {
        const iv = setInterval(() => {
          const lvl = ShadowMic.level();
          const now = performance.now();
          if (lvl > 0.02) { heard = heard || now; quiet = now; }
          if (stopped || (heard && now - quiet > 1200) || now - t0 > max * 1000) { clearInterval(iv); resolve(); }
        }, 80);
      });
    }
  }
  ShadowPlayer.stop();
  sh.yourTurn = false;
  sh.stopNow = null;
  if (!rec) { sh.step = "listen"; render(); return; }
  rec.stop();
  const peak = meter.stop();
  const blob = await rec.done;
  if (UI.shadow !== sh) return;
  // Nothing reached the mic: say so at once (Scribe can take 10 seconds or more on an empty recording).
  if (peak < SHADOW_SILENT) {
    sh.step = "listen";
    render();
    toast(sh.mode === "shadow" ? L("I did not hear you. Speak along with the voice, a bit louder.", "Je ne t'ai pas entendu. Parle en même temps que la voix, un peu plus fort.") : L("I did not hear you. Try again.", "Je ne t'ai pas entendu. Réessaie."), 3500);
    return;
  }
  sh.step = "checking";
  render();
  await shadowCheck(sh, idx, blob, ref.audio);
}

// The loudest moment of a try (mic level every 60 ms).
function shadowMeter() {
  let peak = 0;
  const iv = setInterval(() => { peak = Math.max(peak, ShadowMic.level()); }, 60);
  return { stop() { clearInterval(iv); return peak; } };
}

async function shadowCheck(sh, idx, blob, refAudio) {
  const s = sh.sentences[idx];
  // The melody is measured here while Scribe writes the words down on the Mac.
  const sound = blob.arrayBuffer().then((buf) => AudioOut.ensure().decodeAudioData(buf)).then((you) => {
    let cmp = null;
    try { cmp = shadowCompare(shadowMono(refAudio), refAudio.sampleRate, shadowMono(you), you.sampleRate); } catch { /* words only */ }
    return { you, cmp };
  }, () => ({ you: null, cmp: null }));
  let heard = { text: "", words: [] };
  try {
    const res = await fetch("/api/shadow/score", { method: "POST", body: blob, headers: { "content-type": blob.type || "audio/webm" } });
    if (res.ok) heard = await res.json(); else throw await res.json().catch(() => ({}));
  } catch (e) {
    if (UI.shadow !== sh) return;
    sh.step = "listen";
    render();
    toast(errText(e?.error || e), 4000);
    return;
  }
  if (UI.shadow !== sh) return;
  if (!heard.text) {
    sh.step = "listen";
    render();
    toast(sh.mode === "shadow" ? L("I did not hear you. Speak along with the voice, a bit louder.", "Je ne t'ai pas entendu. Parle en même temps que la voix, un peu plus fort.") : L("I did not hear you. Try again.", "Je ne t'ai pas entendu. Réessaie."), 3500);
    return;
  }
  const words = scoreSpeech(shadowSpell(s.text), shadowSpell(heard.text));
  // Words Scribe was unsure of: shown as unclear even when they matched.
  const unsure = new Set((heard.words || []).filter((w) => w.logprob != null && w.logprob < SHADOW_UNCLEAR).map((w) => normToken(w.text)));
  for (const mk of words.marks) if (mk.s === "hit" && unsure.has(normToken(mk.w))) mk.s = "near";
  const { you, cmp: measured } = await sound;
  if (UI.shadow !== sh) return;
  const cmp = measured || { intonation: null, rhythm: null, ratio: null, curve: null };
  // Overall: the words count most; melody and rhythm when they could be measured.
  const parts = [[words.score, 0.5], [cmp.intonation, 0.3], [cmp.rhythm, 0.2]].filter(([v]) => v != null);
  const total = Math.round(parts.reduce((a, [v, w]) => a + v * w, 0) / parts.reduce((a, [, w]) => a + w, 0));
  const result = { score: total, words: words.score, marks: words.marks, said: heard.text, intonation: cmp.intonation, rhythm: cmp.rhythm, ratio: cmp.ratio, curve: cmp.curve, you };
  const prev = sh.results[idx];
  sh.results[idx] = { best: Math.max(prev?.best || 0, total), tries: (prev?.tries || 0) + 1, last: result };
  sh.last = result;
  sh.tries++;
  if (!prev) { const xp = total >= 80 ? 3 : 2; addXP(xp); sh.xp += xp; }
  // Words that did not come out right, when the learner did say this sentence (not a wrong or empty try).
  if (words.score >= 40) {
    for (const mk of words.marks) {
      const w = mk.w.toLowerCase().replace(/[^\p{L}'’-]/gu, "");
      if (mk.s !== "hit" && w.length > 2 && !SHADOW_SMALL.has(normToken(w))) sh.weak[w] = (sh.weak[w] || 0) + 1;
    }
  }
  sh.step = "feedback";
  render();
  if (total >= 85) Speech.say(pick(["Nice!", "Spot on!", "That sounded great!"]), { tutor: shadowTutor() });
}

function shadowNext() {
  const sh = UI.shadow;
  if (!sh) return;
  ShadowPlayer.stop();
  sh.last = null;
  sh.step = "listen";
  if (sh.pos + 1 < sh.order.length) sh.pos++;
  else {
    if (sh.activeMs >= sh.minutes * 60000) { shadowFinish(); return; }
    // A block done: new sentences (the next kind of talk). A lesson's sentences keep going round.
    if (!sh.source?.length && sh.round >= SHADOW_ROUNDS) { shadowNewBlock(sh); return; }
    // Time left: one more round with the same sentences, the weakest first (repetition is what shadowing is about).
    sh.round++;
    sh.order = [...sh.order].sort((a, b) => (sh.results[a]?.best ?? 0) - (sh.results[b]?.best ?? 0));
    sh.pos = 0;
    if (sh.round >= SHADOW_ROUNDS) shadowPreload(sh);
  }
  if (sh.activeMs >= sh.minutes * 60000 && sh.tries) { shadowFinish(); return; }
  render();
  shadowListen();
}

function shadowFinish() {
  const sh = UI.shadow;
  if (!sh) return;
  ShadowPlayer.stop();
  sh.phase = "done";
  sh.step = "listen";
  const bests = Object.values(sh.results).map((r) => r.best);
  sh.avg = Math.round(bests.reduce((a, b) => a + b, 0) / Math.max(1, bests.length));
  sh.minutesDone = Math.round((sh.activeMs / 60000) * 10) / 10;
  if (sh.tries > sh.saved.tries) {
    // Only what was not saved yet (the part after "5 more minutes" is saved on its own).
    const minutes = Math.max(0.5, Math.round(((sh.activeMs - sh.saved.ms) / 60000) * 10) / 10);
    S.progress.shadow = { ...shadowDays(), [today()]: Math.round(((shadowDays()[today()] || 0) + minutes) * 10) / 10 };
    // Words often unclear: the tutor can work on them in class.
    const weak = new Map((Array.isArray(S.progress.shadowWeak) ? S.progress.shadowWeak : []).map((w) => [w.word, w.count || 0]));
    for (const [w, c] of Object.entries(sh.weak)) if (w && c > (sh.saved.weak[w] || 0)) weak.set(w, (weak.get(w) || 0) + c - (sh.saved.weak[w] || 0));
    S.progress.shadowWeak = [...weak].map(([word, count]) => ({ word, count })).sort((a, b) => b.count - a.count).slice(0, 40);
    save("progress");
    addMinutes(minutes);
    logEntry({ id: uid(), kind: "shadow", ts: Date.now(), date: today(), title: sh.title || L("Shadowing", "Shadowing"), score: sh.avg, xp: sh.xp - sh.saved.xp, turns: sh.tries - sh.saved.tries, minutes });
    sh.saved = { ms: sh.activeMs, tries: sh.tries, xp: sh.xp, weak: { ...sh.weak } };
    try { sh.onDone?.({ avg: sh.avg, minutes: sh.minutesDone, tries: sh.tries, results: sh.results }); } catch { /* the caller's problem */ }
  }
  render();
}

function stopShadow() {
  const sh = UI.shadow;
  if (!sh) return;
  if (sh.step === "recording") sh.stopNow?.();
  // Leaving with tries not saved yet (also while the next block loads): save them and show the summary.
  if (sh.phase !== "done" && sh.tries > sh.saved.tries) { shadowFinish(); return; }
  closeShadow();
}
function closeShadow() {
  const sh = UI.shadow;
  ShadowPlayer.stop();
  ShadowMic.close();
  if (sh) clearInterval(sh.timer);
  UI.shadow = null;
  render();
  window.scrollTo(0, 0);
}

// Space key (main.js): starts or stops the current try.
function shadowMic() { if (UI.shadow?.phase === "work") shadowGo(); }

// =====================================================================
// Screens
// =====================================================================

// The sentence as written ("I", "PDFs"), with the stressed syllables in bold, taken from the stress
// pattern word by word ("we NEED to deVELop it"). A word spelled differently there stays plain.
function shadowStress(stress, text) {
  const pattern = String(stress || "").trim().split(/\s+/);
  const words = String(text || "").trim().split(/(\s+)/);
  const letters = (w) => w.toLowerCase().replace(/[^a-z]/g, "");
  if (!/[A-Z]{2}/.test(stress || "") || pattern.length !== words.filter((w) => w.trim()).length) return h("span", null, text);
  let k = 0;
  return h("span", null, words.map((w) => {
    if (!w.trim()) return w;
    const p = pattern[k++].replace(/[^A-Za-z]/g, "");
    if (letters(w) !== p.toLowerCase() || !/[A-Z]/.test(p) || p === "I") return w;
    // Bold the letters that are capitals in the pattern, keeping the word's own spelling and punctuation.
    const out = [];
    let j = 0, run = "", bold = false;
    for (const ch of w) {
      const isLetter = /[A-Za-z]/.test(ch);
      const b = isLetter && /[A-Z]/.test(p[j] || "");
      if (isLetter) j++;
      if (b !== bold && run) { out.push(bold ? h("b", { class: "sh-st" }, run) : run); run = ""; }
      bold = b;
      run += ch;
    }
    if (run) out.push(bold ? h("b", { class: "sh-st" }, run) : run);
    return out;
  }));
}

// Native line and the learner's line, in semitones, on the native time line.
function shadowCurve(curve) {
  if (!curve || !curve.native?.length) return null;
  const W = 320, H = 110, pad = 8;
  const lim = 9;
  const y = (v) => pad + ((lim - clampN(v, -lim, lim)) / (2 * lim)) * (H - 2 * pad);
  const x = (i, n) => pad + (i / Math.max(1, n - 1)) * (W - 2 * pad);
  const line = (vals) => {
    let d = "", pen = false;
    vals.forEach((v, i) => {
      if (v == null || Number.isNaN(v)) { pen = false; return; }
      d += `${pen ? "L" : "M"}${x(i, vals.length).toFixed(1)} ${y(v).toFixed(1)} `;
      pen = true;
    });
    return d;
  };
  const svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${L("Melody: native voice and you", "Mélodie : voix native et toi")}">
    <line x1="${pad}" x2="${W - pad}" y1="${y(0)}" y2="${y(0)}" class="sh-mid"/>
    <path d="${line(curve.native)}" class="sh-native"/>
    ${curve.you?.length ? `<path d="${line(curve.you)}" class="sh-you"/>` : ""}</svg>`;
  return h("div", { class: "sh-curve" },
    h("div", { class: "sh-plot", html: svg }),
    h("div", { class: "sh-legend" }, h("span", { class: "n" }, L("Native", "Natif")), h("span", { class: "y" }, L("You", "Toi"))));
}

function shadowScorePill(label, v) {
  return h("div", { class: "sh-sub" }, h("b", { class: v == null ? "" : scoreClass(v) }, v == null ? "–" : String(v)), h("span", null, label));
}

function viewShadow() {
  const sh = UI.shadow;
  const t = tutorNow();
  const back = h("button", { class: "btn sm ghost", onclick: stopShadow }, icon("back", 16), sh.phase !== "done" && sh.tries > sh.saved.tries ? L("Finish", "Terminer") : L("Back", "Retour"));
  const blk = shadowBlock(sh.block);
  if (sh.phase === "loading") {
    const later = sh.block > 0;
    return h("div", { class: "stack" },
      h("div", { class: "spread" }, back, later ? h("span", { class: "muted small num" }, shadowClock(sh)) : null),
      h("section", { class: "card focus-card" }, portrait(t.id, "lg"),
        sh.source?.length ? null : h("div", { class: "eyebrow" }, later ? L(`Next: ${blk[1]}`, `Ensuite : ${blk[2].toLowerCase()}`) : L(`Day ${sh.day + 1} · ${sh.focus.en}`, `Jour ${sh.day + 1} · ${sh.focus.fr}`)),
        h("p", null, sh.source?.length ? L(`${t.name} is preparing your lesson sentences…`, `${t.name} prépare les phrases de ton cours…`)
          : later ? L(`${t.name} is writing new sentences…`, `${t.name} écrit de nouvelles phrases…`) : L(`${t.name} is choosing today's sentences…`, `${t.name} choisit les phrases du jour…`)),
        later ? null : h("p", { class: "small muted" }, L("Put your headphones on: you will speak at the same time as the voice.", "Mets tes écouteurs : tu vas parler en même temps que la voix."))));
  }
  if (sh.phase === "error") {
    return h("div", { class: "stack" }, back, errorBox(sh.error, () => { sh.phase = "loading"; render(); shadowLoad(sh).then(() => { if (UI.shadow === sh && sh.phase === "work") shadowListen(); }); }));
  }
  if (sh.phase === "done") {
    const list = sh.sentences.map((s, i) => ({ s, r: sh.results[i] })).filter((x) => x.r);
    const weak = Object.entries(sh.weak).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([w]) => w);
    const avg = sh.avg ?? 0;
    return h("div", { class: "stack" },
      h("div", null, h("div", { class: "eyebrow" }, L("Shadowing done", "Shadowing terminé")), h("h1", null, avg >= 80 ? L("Great accent work!", "Super travail d'accent !") : L("Good workout!", "Bonne séance !"))),
      h("section", { class: "card score-hero" }, ring(avg / 100, 90, 9, String(avg), avg >= 80 ? "var(--ok)" : avg >= 60 ? "var(--azafran)" : "var(--warn)"),
        h("div", { class: "stack tight" },
          h("div", { class: "row" }, h("span", { class: "badge ok" }, `+${sh.xp} XP`), h("span", { class: "badge" }, `${Math.round(sh.minutesDone || 0)} min`), h("span", { class: "badge" }, L(`${sh.tries} tries`, `${sh.tries} essais`))),
          h("p", null, shadowStreak()
            ? L(`${shadowStreak()}-day shadowing streak. Same time tomorrow?`, `Série de shadowing : ${pl(shadowStreak(), "jour", "jours")}. Même heure demain ?`)
            : L("5 minutes a day starts a streak. Same time tomorrow?", "5 minutes par jour lancent ta série. Même heure demain ?")))),
      weak.length ? h("section", { class: "card stack tight" }, h("h3", null, L("Sounds to keep working on", "Sons à retravailler")),
        h("div", { class: "row" }, weak.map((w) => h("button", { class: "chip", onclick: () => Speech.say(w, { tutor: shadowTutor(), rate: 0.8 }) }, icon("speaker", 13), w))),
        h("p", { class: "small muted" }, L(`${t.name} will use them in your next lessons.`, `${t.name} les reprendra dans tes prochains cours.`))) : null,
      h("section", { class: "card word-list" }, list.map(({ s, r }) => h("div", { class: "word-row" },
        h("div", { class: "wt" }, h("b", null, s.text), h("span", null, s.tr)),
        h("span", { class: `badge ${scoreClass(r.best)}` }, String(r.best)),
        h("button", { class: "icon-btn plain", "aria-label": L("Listen", "Écouter"), onclick: () => Speech.say(s.text, { tutor: shadowTutor() }) }, icon("speaker", 18))))),
      h("div", { class: "row" },
        h("button", { class: "btn", onclick: () => { sh.phase = "work"; sh.minutes = Math.ceil(sh.activeMs / 60000) + 5; sh.lastTick = Date.now(); shadowNext(); } }, L("5 more minutes", "5 minutes de plus")),
        h("button", { class: "btn ghost", onclick: closeShadow }, L("Done", "Terminé"))));
  }

  const idx = sh.order[sh.pos];
  const s = sh.sentences[idx];
  const r = sh.step === "feedback" ? sh.last : null;
  const best = sh.results[idx]?.best;
  const busy = sh.step === "recording" || sh.step === "checking";
  const modeChip = (m, en, fr) => h("button", { class: `chip sm${sh.mode === m ? " on" : ""}`, disabled: busy, onclick: () => { sh.mode = m; S.profile.shadowMode = m; save("profile"); render(); } }, L(en, fr));
  const status = sh.step === "recording"
    ? (sh.mode === "shadow" ? L("Speak WITH the voice now…", "Parle EN MÊME TEMPS que la voix…") : sh.yourTurn ? L("Your turn: say it like the voice…", "À toi : dis-la comme la voix…") : L("Listen first…", "Écoute d'abord…"))
    : sh.step === "checking" ? L("Comparing your voice…", "Je compare ta voix…")
      : sh.mode === "shadow" ? L("Tap the mic: the voice plays and you speak along with it", "Touche le micro : la voix démarre et tu parles avec elle")
        : L("Tap the mic: listen, then repeat right after", "Touche le micro : écoute, puis répète juste après");

  const card = h("section", { class: "card sh-card-main" },
    h("div", { class: "spread" },
      h("div", { class: "eyebrow" }, sh.source?.length ? "" : L(`${blk[1]} · `, `${blk[2]} · `), L(`Round ${sh.round} · ${sh.pos + 1} / ${sh.order.length}`, `Tour ${sh.round} · ${sh.pos + 1} / ${sh.order.length}`)),
      best != null ? h("span", { class: `badge ${scoreClass(best)}` }, L(`Best ${best}`, `Meilleur ${best}`)) : null),
    r ? h("div", { class: "sh-marks" }, marksEl(r.marks)) : h("div", { class: "sh-sentence" }, shadowStress(s.stress, s.text)),
    sh.showTr || r ? h("div", { class: "muted small" }, s.tr) : h("button", { class: "linkish small", onclick: () => { sh.showTr = true; render(); } }, L("Show the translation", "Voir la traduction")),
    h("div", { class: "row sh-listen" },
      h("button", { class: "chip", disabled: busy, onclick: () => shadowListen() }, icon("speaker", 14), L("Listen", "Écouter")),
      h("button", { class: "chip", disabled: busy, onclick: () => shadowListen(true) }, icon("turtle", 14), L("Slow", "Lentement")),
      h("span", { class: "grow" }),
      modeChip("shadow", "Shadow", "Shadow"), modeChip("after", "Repeat after", "Répéter après")),
    s.focus ? h("p", { class: "sh-focus" }, icon("target", 15), h("span", null, s.focus)) : null,
    s.tricky?.length ? h("div", { class: "sh-tricky" }, s.tricky.map((k) => h("button", { class: "sh-trick", onclick: () => Speech.say(k.word, { tutor: shadowTutor(), rate: 0.75 }) },
      h("b", null, k.word), h("span", { class: "ipa" }, k.ipa), h("span", { class: "small muted" }, k.tip)))) : null);

  const feedback = r ? h("section", { class: "card sh-feedback" },
    h("div", { class: "sh-scores" },
      ring(r.score / 100, 72, 8, String(r.score), r.score >= 80 ? "var(--ok)" : r.score >= 60 ? "var(--azafran)" : "var(--warn)"),
      shadowScorePill(L("Words", "Mots"), r.words),
      shadowScorePill(L("Melody", "Mélodie"), r.intonation),
      shadowScorePill(L("Rhythm", "Rythme"), r.rhythm)),
    h("p", { class: "said" }, L(`I heard: “${r.said}”`, `J'ai entendu : « ${r.said} »`)),
    shadowCurve(r.curve),
    r.ratio ? h("p", { class: "small muted" }, Math.abs(r.ratio - 1) < 0.12 ? L("Your speed matches the native voice.", "Ta vitesse colle à la voix native.")
      : r.ratio > 1 ? L(`You took ${Math.round((r.ratio - 1) * 100)}% longer: link the words more, do not stop between them.`, `Tu as mis ${Math.round((r.ratio - 1) * 100)} % de temps en plus : enchaîne les mots, sans t'arrêter entre eux.`)
        : L(`You were ${Math.round((1 - r.ratio) * 100)}% faster: keep the stressed words long and clear.`, `Tu étais ${Math.round((1 - r.ratio) * 100)} % plus rapide : garde les mots accentués longs et nets.`)) : null,
    h("div", { class: "row" },
      h("button", { class: "chip", onclick: async () => { try { ShadowPlayer.play((await shadowRef(idx)).audio); } catch { /* offline */ } } }, icon("speaker", 14), L("Native", "Natif")),
      r.you ? h("button", { class: "chip", onclick: () => ShadowPlayer.play(r.you) }, icon("play", 14), L("You", "Toi")) : null)) : null;

  const recording = sh.step === "recording";
  return h("div", { class: "stack sh" },
    h("div", { class: "spread" }, back, h("span", { class: "muted small num", id: "sh-clock" }, shadowClock(sh))),
    h("div", { class: "progress-line" }, h("i", { id: "sh-time", style: `width:${Math.min(100, (sh.activeMs / (sh.minutes * 60000)) * 100)}%` })),
    card, feedback,
    h("div", { class: "dock" },
      h("div", { class: "dock-row" },
        h("div", { class: "left" }, r ? h("button", { class: "btn sm ghost", onclick: () => { sh.step = "listen"; sh.last = null; render(); shadowGo(); } }, icon("repeat", 16), L("Again", "Encore")) : null),
        h("button", { class: `mic${recording ? " listening" : ""}`, disabled: sh.step === "checking", "aria-label": recording ? L("Stop", "Arrêter") : L("Start", "Commencer"), onclick: shadowGo }, icon(recording ? "send" : "mic", 30)),
        h("div", { class: "right" }, h("button", { class: `btn sm${r ? "" : " ghost"}`, disabled: busy, onclick: shadowNext }, r ? L("Next", "Suivant") : L("Skip", "Passer")))),
      h("div", { class: "hint-line" }, status + (IS_PHONE() || busy ? "" : L(" · or press Space", " · ou appuie sur Espace")))));
}

// A small card for Home and Practice: today's shadowing, the streak, and the start buttons.
function shadowCard() {
  const goal = shadowGoal(), done = shadowToday(), streak = shadowStreak();
  const finished = done >= goal;
  return h("section", { class: "card sh-home" },
    ring(done / goal, 56, 6, String(Math.floor(done)), finished ? "var(--ok)" : "var(--azul)"),
    h("div", { class: "grow stack tight" },
      h("div", { class: "eyebrow" }, L("Daily accent workout", "Entraînement d'accent du jour")),
      h("h3", null, L(`Shadowing · ${goal} min`, `Shadowing · ${goal} min`)),
      h("p", { class: "sh-day" }, L(`Day ${shadowDay() + 1} · ${shadowFocus().en}`, `Jour ${shadowDay() + 1} · ${shadowFocus().fr}`)),
      h("p", { class: "small muted" }, finished
        ? L("Done for today. Come back tomorrow to keep the streak.", "C'est fait pour aujourd'hui. Reviens demain pour garder ta série.")
        : goal >= 20 ? L(`The sound of the day, then everyday talk, then business talk, with ${tutorNow().name}'s voice. Headphones on.`, `Le son du jour, puis la vie de tous les jours, puis l'anglais pro, avec la voix de ${tutorNow().name}. Avec écouteurs.`)
          : L("Speak along with a native voice and copy its melody. Headphones on.", "Parle en même temps qu'une voix native et copie sa mélodie. Avec écouteurs.")),
      h("div", { class: "row" },
        streak ? h("span", { class: "badge mid" }, icon("flame", 12), L(`${streak}-day streak`, `${pl(streak, "jour", "jours")} de suite`)) : null,
        SHADOW_GOALS.map((m) => h("button", { class: `chip sm${goal === m ? " on" : ""}`, onclick: () => { S.profile.shadowMinutes = m; save("profile"); render(); } }, `${m} min`)))),
    h("button", { class: `btn${finished ? " ghost" : ""}`, onclick: () => startShadow({ minutes: goal }) }, icon("mic", 18), finished ? L("Again", "Encore") : L("Start", "Commencer")));
}
