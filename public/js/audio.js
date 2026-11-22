"use strict";
// Fluent — sound: the tutor's voice (played sentence by sentence as it arrives, with
// loudness and mouth shapes for the avatar) and the learner's microphone.

// =====================================================================
// Audio output
// =====================================================================
// The tutor's voice arrives quiet: -24 LUFS, 10 dB under a video (measured 2026-11-05: "I can't hear him, even at full volume").
// This brings it up without clipping, and clears it for small laptop speakers. The mouth reads the voice before this (analyser).
const VOICE_VOLUME = { normal: 1.6, loud: 3.2, max: 5.5 }; // measured through this chain: -17, -14.4 and -13 LUFS, no clipping
function voiceChain(ctx, out, boost) {
  const low = ctx.createBiquadFilter();
  low.type = "highpass"; low.frequency.value = 90; // small speakers cannot play this: it only eats their power
  const clear = ctx.createBiquadFilter();
  clear.type = "peaking"; clear.frequency.value = 3000; clear.Q.value = 0.8; clear.gain.value = 3; // where consonants are
  const level = ctx.createGain();
  level.gain.value = boost;
  const even = ctx.createDynamicsCompressor(); // the quiet words come closer to the loud ones
  even.threshold.value = -20; even.knee.value = 10; even.ratio.value = 2.5; even.attack.value = 0.006; even.release.value = 0.18;
  const limit = ctx.createDynamicsCompressor(); // never above full scale, whatever the volume chosen
  limit.threshold.value = -3; limit.knee.value = 0; limit.ratio.value = 20; limit.attack.value = 0.001; limit.release.value = 0.08;
  const trim = ctx.createGain();
  trim.gain.value = 0.92; // the compressors add their own gain
  low.connect(clear); clear.connect(level); level.connect(even); even.connect(limit); limit.connect(trim); trim.connect(out);
  return { input: low, level };
}
const AudioOut = {
  ctx: null, analyser: null, time: null, freq: null, gain: null, chain: null,
  ensure() {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    this.ctx = new AC({ latencyHint: "interactive" });
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.35;
    this.gain = this.ctx.createGain();
    this.analyser.connect(this.gain);
    this.chain = voiceChain(this.ctx, this.ctx.destination, VOICE_VOLUME.loud);
    this.gain.connect(this.chain.input);
    this.time = new Uint8Array(this.analyser.fftSize);
    this.freq = new Uint8Array(this.analyser.frequencyBinCount);
    return this.ctx;
  },
  async unlock() {
    const ctx = this.ensure();
    if (ctx && ctx.state !== "running") { try { await ctx.resume(); } catch { /* needs a tap */ } }
    // iOS: play one silent buffer inside the tap so later audio is allowed.
    if (ctx && !this.primed) {
      this.primed = true;
      try { const b = ctx.createBuffer(1, 1, 22050); const s = ctx.createBufferSource(); s.buffer = b; s.connect(ctx.destination); s.start(0); } catch { /* fine */ }
    }
  },
  running() { return Boolean(this.ctx && this.ctx.state === "running"); },
  setVolume(name) {
    if (this.chain) this.chain.level.gain.setTargetAtTime(VOICE_VOLUME[name] || VOICE_VOLUME.loud, this.ctx.currentTime, 0.04);
  },
  // The learner starts to talk over the tutor: their voice goes down at once (on: true), then back up.
  // now: back to full at once (a new answer must never start quiet).
  duck(on, now = false) {
    const g = this.gain?.gain;
    if (!g) return;
    const t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    if (now) { g.setValueAtTime(1, t); return; }
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(on ? 0.5 : 1, t + (on ? 0.08 : 0.3));
  },
};
["pointerdown", "keydown", "touchend"].forEach((ev) => document.addEventListener(ev, () => AudioOut.unlock(), { passive: true }));

// Which voice a tutor uses: the learner's choice, else the best Mac voice for that tutor.
const Speech = {
  voices: [], defaults: {}, browserVoices: [], current: null, ready: false,
  async init() {
    try {
      const r = await api("/api/voices");
      this.voices = r.voices || [];
      this.defaults = r.defaults || {};
    } catch { this.voices = []; }
    this.loadBrowser();
    this.ready = true;
  },
  loadBrowser() {
    if ("speechSynthesis" in window) this.browserVoices = speechSynthesis.getVoices().filter((v) => /^en[-_](GB|US)$/i.test(v.lang));
  },
  voiceFor(tutor) {
    let v = (S.profile.voices || {})[tutor] || "";
    if (v.startsWith("mac:")) v = v.slice(4);
    if (v.startsWith("browser:")) return v;
    return v || this.defaults[tutor] || "";
  },
  // "auto": slower for beginners, natural speed from B2.
  rate() {
    const r = S.profile.rate;
    if (r !== "auto" && Number(r)) return Number(r);
    return { A1: 0.78, A2: 0.84, B1: 0.92 }[S.profile.level] || 1;
  },
  // One-off line (a word, a drill phrase, a quick reaction).
  say(text, { tutor, rate, onstart, onend, emotion } = {}) {
    text = String(text || "").trim();
    if (!text) { onend?.(false); return null; }
    tutor = tutor || S.profile.tutor;
    const u = new Utterance({ tutor, onstart, onend });
    const voice = this.voiceFor(tutor);
    const r = rate ?? this.rate();
    if (voice && !voice.startsWith("browser:")) {
      u.add({ text, start: 0, audio: fetchTTS(text, voice, r, tutor) });
    } else {
      u.add({ text, start: 0, browser: true, rate: r });
    }
    u.finish();
    return u;
  },
  stop() { this.current?.stop(); },
  speaking() { return Boolean(this.current && this.current.playing); },
};
if ("speechSynthesis" in window) speechSynthesis.onvoiceschanged = () => Speech.loadBrowser();

const ttsCache = new Map();
// mood: a tone for ElevenLabs ("laugh", "surprised"…), for the quick reactions.
function fetchTTS(text, voice, rate, tutor, mood = "") {
  const key = `${voice}|${rate}|${mood}|${text}`;
  if (ttsCache.has(key)) return ttsCache.get(key);
  const p = fetch("/api/tts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, voice, rate, tutor, mood }) }).then(readAudio);
  p.catch(() => ttsCache.delete(key));
  ttsCache.set(key, p);
  if (ttsCache.size > 80) ttsCache.delete(ttsCache.keys().next().value);
  return p;
}
function fetchAudioKey(key) {
  return fetch(`/api/audio/${key}`).then(readAudio);
}
// A reply sentence's voice as ElevenLabs makes it (2026-10-29): 24 kHz pieces that play from the first one
// (about 0.2 s) instead of the whole sentence (0.75 to 1.1 s). live.fallback: no stream, ask the file as before.
function openLive(key) {
  const live = { pieces: [], chars: [], words: [], end: 0, done: false, fallback: false, wake: null, abort: new AbortController() };
  const take = (d) => {
    if (d.t) { d.t.forEach((ms, j) => { live.chars[d.c + j] = ms; }); }
    else if (d.a) {
      const bin = atob(d.a);
      const pcm = new Int16Array(bin.length >> 1);
      for (let i = 0; i < pcm.length; i++) { const v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8); pcm[i] = v > 32767 ? v - 65536 : v; }
      live.pieces.push(pcm);
    } else if (d.words) { live.words = d.words; live.end = d.end || 0; }
    else if (d.fallback && !live.pieces.length) live.fallback = true;
  };
  (async () => {
    try {
      const res = await fetch(`/api/audio/${key}/live`, { signal: live.abort.signal });
      if (!res.ok || !res.body) throw new Error("no stream");
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line) take(JSON.parse(line)); }
        live.wake?.();
      }
    } catch { if (!live.pieces.length) live.fallback = true; }
    live.done = true;
    live.wake?.();
  })();
  return live;
}
async function readAudio(res) {
  if (!res.ok) throw new Error("audio " + res.status);
  let words = [];
  try { words = JSON.parse(decodeURIComponent(res.headers.get("x-words") || "%5B%5D")); } catch { /* no timings */ }
  let chars = [];
  try { chars = JSON.parse(decodeURIComponent(res.headers.get("x-chars") || "%5B%5D")); } catch { /* no timings */ }
  const buf = await res.arrayBuffer();
  const ctx = AudioOut.ensure();
  if (!ctx) throw new Error("no audio");
  const audio = await ctx.decodeAudioData(buf);
  return { audio, words, chars };
}

// One tutor reply. Sentences arrive one by one (streaming); each plays as soon as it is ready.
class Utterance {
  constructor({ tutor, onstart, onend, onsentence, hold = false } = {}) {
    this.tutor = tutor;
    this.onstart = onstart;
    this.onend = onend;
    this.onsentence = onsentence;
    this.hold = hold;
    this.sents = [];
    this.done = false;
    this.stopped = false;
    this.playing = false;
    this.started = false;
    this.idx = -1;
    this.cur = null; // { sent, startAt, dur, words, browser, t0, charIdx }
    this.text = "";
    this.waiter = null;
    if (Speech.current && Speech.current !== this) Speech.current.stop();
    Speech.current = this;
    if (UI.call) UI.call.duckAt = 0;
    AudioOut.duck(false, true); // a new answer never starts quiet
    this.loop();
  }
  add(s) {
    if (this.stopped) return;
    const sent = { ...s };
    if (!sent.audio && sent.key) sent.live = openLive(sent.key);
    if (sent.audio) sent.audio.catch(() => {});
    if (sent.start == null) sent.start = this.text.length + (this.text ? 1 : 0);
    this.text = this.text ? this.text + " " + sent.text : sent.text;
    this.sents.push(sent);
    this.wake();
  }
  finish() { this.done = true; this.wake(); }
  commit() { this.hold = false; this.wake(); }
  wake() { const w = this.waiter; this.waiter = null; w?.(); }
  wait() { return new Promise((r) => { this.waiter = r; }); }
  async loop() {
    let i = 0;
    while (!this.stopped) {
      if (this.hold || i >= this.sents.length) {
        if (!this.hold && this.done && i >= this.sents.length) break;
        await this.wait();
        continue;
      }
      const sent = this.sents[i];
      let ok = false;
      if (sent.live) {
        ok = await this.playLive(sent, i);
        if (this.stopped) return;
        if (!ok && sent.live.fallback) sent.audio = fetchAudioKey(sent.key); // no stream for this one: the file
        if (!ok && sent.audio) sent.audio.catch(() => {});
      }
      if (!ok && !sent.browser && sent.audio) {
        try {
          const { audio, words, chars } = await sent.audio;
          if (this.stopped) return;
          await this.playBuffer(sent, audio, words, i, chars);
          ok = true;
        } catch { /* fall back to the browser voice for this sentence */ }
      }
      if (!ok && !this.stopped) await this.playBrowser(sent, i);
      i++;
    }
    this.end(this.stopped);
  }
  begin(i) {
    this.idx = i;
    this.playing = true;
    if (!this.started) { this.started = true; this.onstart?.(); }
    this.onsentence?.(i, this.sents[i]);
  }
  playBuffer(sent, audio, words, i, chars = []) {
    const ctx = AudioOut.ensure();
    return new Promise(async (resolve) => {
      if (ctx.state !== "running") { try { await ctx.resume(); } catch { /* ignore */ } }
      if (this.stopped) return resolve();
      const src = ctx.createBufferSource();
      src.buffer = audio;
      src.connect(AudioOut.analyser);
      this.src = src;
      this.resolveNow = resolve;
      src.onended = () => { this.src = null; resolve(); };
      const startAt = ctx.currentTime + 0.02;
      src.start(startAt);
      this.cur = { sent, startAt, dur: audio.duration, words: Array.isArray(words) ? words : [], chars, browser: false };
      this.begin(i);
    });
  }
  // Plays the pieces back to back as they arrive. -> true once played, false if there was no stream.
  playLive(sent, i) {
    const live = sent.live, ctx = AudioOut.ensure();
    return new Promise(async (resolve) => {
      if (ctx.state !== "running") { try { await ctx.resume(); } catch { /* ignore */ } }
      let k = 0, next = 0, cur = null, endTimer = null;
      this.liveSrcs = [];
      const finish = (ok) => { live.wake = null; clearTimeout(endTimer); this.resolveNow = null; resolve(ok); };
      this.resolveNow = () => finish(true);
      const pump = () => {
        if (this.stopped) return finish(true);
        if (!cur && live.fallback) return finish(false);
        while (k < live.pieces.length) {
          const pcm = live.pieces[k++];
          const b = ctx.createBuffer(1, pcm.length, 24000);
          const ch = b.getChannelData(0);
          for (let j = 0; j < pcm.length; j++) ch[j] = pcm[j] / 32768;
          const src = ctx.createBufferSource();
          src.buffer = b;
          src.connect(AudioOut.analyser);
          if (next < ctx.currentTime + 0.01) { // first piece, or a late one (a small hole in the voice)
            if (cur) SoundLog.count("late");
            next = ctx.currentTime + (cur ? 0.06 : 0.09); // a little ahead: the 3D keeps the page busy, and pieces come in bursts
          }
          src.start(next);
          this.liveSrcs.push(src);
          if (!cur) { cur = { sent, startAt: next, dur: 0, words: [], chars: live.chars, browser: false }; this.cur = cur; this.begin(i); }
          next += b.duration;
          cur.dur = next - cur.startAt;
        }
        if (cur) cur.words = live.words;
        if (live.done) {
          if (!cur) return finish(false);
          // The end of speech (the silence after it is not played): the next sentence follows naturally.
          const endAt = live.end ? Math.min(next, cur.startAt + live.end) : next;
          cur.dur = endAt - cur.startAt;
          for (const s of this.liveSrcs) { try { s.stop(endAt); } catch { /* done */ } }
          clearTimeout(endTimer);
          endTimer = setTimeout(() => finish(true), Math.max(0, (endAt - ctx.currentTime) * 1000));
        }
      };
      live.wake = pump;
      pump();
    });
  }
  playBrowser(sent, i) {
    return new Promise((resolve) => {
      if (!("speechSynthesis" in window)) return resolve();
      speechSynthesis.cancel();
      if (!Speech.browserVoices.length) Speech.loadBrowser();
      const u = new SpeechSynthesisUtterance(sent.text);
      const pref = Speech.voiceFor(this.tutor);
      let v = pref.startsWith("browser:") ? Speech.browserVoices.find((x) => x.voiceURI === pref.slice(8)) : null;
      if (!v) v = pickBrowserVoice(this.tutor);
      if (v) { u.voice = v; u.lang = v.lang.replace("_", "-"); } else u.lang = this.tutor === "jake" ? "en-US" : "en-GB";
      u.rate = sent.rate || Speech.rate();
      const cur = { sent, browser: true, t0: performance.now(), est: Math.max(700, (sent.text.length * 62) / u.rate), charIdx: 0 };
      u.onstart = () => { cur.t0 = performance.now(); this.cur = cur; this.begin(i); };
      u.onboundary = (e) => { if (e.name === "word" || e.charIndex != null) cur.charIdx = e.charIndex; };
      u.onend = u.onerror = () => resolve();
      this.resolveNow = resolve;
      speechSynthesis.speak(u);
    });
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    try { if (this.src) { this.src.onended = null; this.src.stop(); } } catch { /* already stopped */ }
    for (const s of this.liveSrcs || []) { try { s.stop(); } catch { /* done */ } }
    for (const sent of this.sents) sent.live?.abort.abort();
    if (this.cur?.browser && "speechSynthesis" in window) speechSynthesis.cancel();
    this.resolveNow?.();
    this.wake();
    this.end(true);
  }
  end(stopped) {
    if (this.ended) return;
    this.ended = true;
    this.playing = false;
    this.cur = null;
    if (Speech.current === this) Speech.current = null;
    const cb = this.onend;
    this.onend = null;
    cb?.(stopped);
  }
  // Seconds into the current sentence.
  elapsed() {
    const c = this.cur;
    if (!c) return 0;
    if (c.browser) return (performance.now() - c.t0) / 1000;
    return Math.max(0, AudioOut.ctx.currentTime - c.startAt);
  }
  // Character position in the whole reply text (for karaoke subtitles).
  charPos() {
    const c = this.cur;
    if (!c) return null;
    const t = this.elapsed();
    const len = c.sent.text.length;
    let pos;
    if (c.browser) {
      pos = Math.max(c.charIdx, Math.min(len, (t * 1000 / c.est) * len * 0.9));
    } else if (c.words.length) {
      const w = c.words;
      let k = 0;
      while (k + 1 < w.length && w[k + 1].t <= t) k++;
      if (t < w[0].t) pos = 0;
      else {
        const nextT = k + 1 < w.length ? w[k + 1].t : c.dur;
        const f = clamp((t - w[k].t) / Math.max(0.05, nextT - w[k].t), 0, 1);
        pos = w[k].start + Math.min(w[k].len, f * w[k].len * 1.6) + (f > 0.98 ? 0.5 : 0);
      }
    } else {
      pos = Math.min(1, t / Math.max(0.2, c.dur - 0.15)) * len;
    }
    return c.sent.start + pos;
  }
  // The letter being spoken now (for the mouth shape).
  viseme() {
    const c = this.cur;
    if (!c) return null;
    const text = c.sent.text;
    const p = Math.floor(this.charPos() - c.sent.start);
    for (let k = Math.max(0, p); k < Math.min(text.length, p + 3); k++) {
      const ch = text[k].toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
      if (/[a-zñ]/.test(ch)) return ch;
    }
    return null;
  }
  question() {
    const c = this.cur;
    return Boolean(c && /\?\s*$/.test(c.sent.text));
  }
  // For the 3D mouth: the sentence and the letter being said, from the voice's own timing when it is there.
  // The sound reaches the ears later than we play it (a lot with Bluetooth), and lips move just before the sound.
  mouth() {
    const c = this.cur;
    if (!c) return null;
    const text = c.sent.text;
    const late = c.browser ? 0 : AudioOut.ctx?.outputLatency || 0;
    const ms = (this.elapsed() - late + 0.04) * 1000;
    const t = c.chars;
    let i;
    if (t?.length && ms <= t[t.length - 1] + 350) {
      let lo = 0, hi = t.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (t[mid] <= ms) lo = mid; else hi = mid - 1; }
      i = lo;
    } else {
      i = Math.floor(this.charPos() - c.sent.start);
    }
    return { text, i, progress: i / Math.max(1, text.length), ms, chars: t };
  }
}

// Voice loudness (0..1) and three frequency bands for the avatar's mouth.
const VoiceMeter = {
  level() {
    const u = Speech.current;
    if (!u || !u.playing || !u.cur) return 0;
    if (u.cur.browser) return 0; // no real sound data: the avatar animates from the letters instead
    const a = AudioOut.analyser;
    a.getByteTimeDomainData(AudioOut.time);
    let sum = 0;
    const d = AudioOut.time;
    for (let i = 0; i < d.length; i++) { const x = (d[i] - 128) / 128; sum += x * x; }
    return Math.min(1, Math.sqrt(sum / d.length) * 4.2);
  },
  bands() {
    const u = Speech.current;
    if (!u || !u.playing || !u.cur || u.cur.browser) return null;
    const a = AudioOut.analyser;
    a.getByteFrequencyData(AudioOut.freq);
    const hz = AudioOut.ctx.sampleRate / a.fftSize;
    const band = (lo, hi) => {
      const i0 = Math.max(1, Math.floor(lo / hz)), i1 = Math.min(AudioOut.freq.length - 1, Math.ceil(hi / hz));
      let s = 0;
      for (let i = i0; i <= i1; i++) s += AudioOut.freq[i];
      return s / ((i1 - i0 + 1) * 255);
    };
    return { low: band(100, 500), mid: band(500, 2000), high: band(2000, 6000) };
  },
};

function pickBrowserVoice(tutor) {
  const vs = Speech.browserVoices;
  if (!vs.length) return null;
  const accent = tutor === "jake" ? "en-us" : "en-gb";
  const norm = (l) => l.replace("_", "-").toLowerCase();
  const rank = (v) => {
    let r = 0;
    if (norm(v.lang) === accent) r += 10;
    if (/premium/i.test(v.name)) r += 6;
    else if (/enhanced/i.test(v.name)) r += 5;
    else if (/google/i.test(v.name)) r += 4;
    if (tutor === "jake" && /evan|nathan|tom|aaron|daniel|\bmale\b/i.test(v.name)) r += 3;
    if (tutor !== "jake" && /serena|kate|stephanie|samantha|female/i.test(v.name)) r += 3;
    if (/grandma|grandpa|rocko|sandy|shelley|bad news|bells|boing|bubbles|cellos|jester|organ|superstar|trinoids|whisper|wobble|zarvox|albert|fred|junior|ralph|kathy|bahh|good news/i.test(v.name)) r -= 20;
    return r;
  };
  return [...vs].sort((a, b) => rank(b) - rank(a))[0];
}

// =====================================================================
// Microphone: speech recognition (Chrome, Safari) + a loudness meter
// =====================================================================
const Mic = {
  SR: window.SpeechRecognition || window.webkitSpeechRecognition,
  get ok() { return Boolean(this.SR); },
  active: null,
  // Listens until stop()/abort(). onUpdate(text) fires on every change.
  // prefix = words already said (the learner goes on with the same sentence).
  listen(lang, { onUpdate, onStart, prefix = "" } = {}) {
    if (!this.SR) return { promise: Promise.reject({ code: "unsupported" }), stop() {}, cut() {}, abort() {} };
    this.active?.abort();
    let finals = String(prefix).trim(), interim = "", err = null, stopped = false, restarts = 0, fails = 0, rec = null, resolveP, rejectP;
    const ctl = {
      text: finals,
      lastChange: performance.now(),
      started: false,
      promise: new Promise((res, rej) => { resolveP = res; rejectP = rej; }),
      stop() { stopped = true; try { rec?.stop(); } catch { finish(); } },
      // Send what we have now, without waiting for the browser to close the recognition (faster than stop).
      cut() { stopped = true; finish(); try { rec?.abort(); } catch { /* gone */ } },
      abort() { stopped = true; err = null; finals = ""; interim = ""; try { rec?.abort(); } catch { /* gone */ } finish(); },
    };
    const join = () => (finals + " " + interim).replace(/\s+/g, " ").trim();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      rec && (rec.onresult = null);
      if (Mic.active === ctl) Mic.active = null;
      if (err && !join()) rejectP({ code: err });
      else resolveP({ text: join() });
    };
    const start = () => {
      rec = new this.SR();
      rec.lang = lang;
      rec.interimResults = true;
      rec.continuous = true;
      rec.maxAlternatives = 1;
      let base = finals;
      rec.onstart = () => { if (!ctl.started) { ctl.started = true; onStart?.(); } };
      rec.onresult = (e) => {
        let f = "", it = "";
        for (let i = 0; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) f += " " + r[0].transcript;
          else it += " " + r[0].transcript;
        }
        finals = (base + " " + f).trim();
        interim = it.trim();
        const t = join();
        if (t !== ctl.text) { ctl.text = t; ctl.lastChange = performance.now(); onUpdate?.(t); }
      };
      rec.onerror = (e) => { if (e.error !== "no-speech" && e.error !== "aborted") err = e.error; };
      rec.onend = () => {
        // Chrome and Safari stop by themselves after a few seconds of silence: start again,
        // as long as needed, until we say stop (the learner may think for a long time).
        if (!stopped && !err) {
          restarts++;
          finals = join();
          interim = "";
          setTimeout(() => { if (stopped) finish(); else start(); }, 120);
          return;
        }
        finish();
      };
      try { rec.start(); fails = 0; } catch {
        // The previous session is not fully closed yet: try again a few times.
        if (!stopped && ++fails <= 5) { setTimeout(() => { if (stopped) finish(); else start(); }, 300 * fails); return; }
        err = "start_failed";
        finish();
      }
    };
    start();
    this.active = ctl;
    return ctl;
  },
  stopAll() { this.active?.abort(); },
};

function micError(e) {
  const map = {
    "not-allowed": IS_IOS ? L("Allow the microphone: aA › Website Settings › Microphone.", "Autorise le micro : aA › Réglages du site web › Micro.") : L("Allow the microphone: click the icon at the left of the address bar.", "Autorise le micro : clique sur l'icône à gauche de la barre d'adresse."),
    "service-not-allowed": IS_IOS ? L("Turn on Dictation: Settings › General › Keyboard › Enable Dictation.", "Active la dictée : Réglages › Général › Clavier › Activer la dictée.") : L("Allow the microphone: click the icon at the left of the address bar.", "Autorise le micro : clique sur l'icône à gauche de la barre d'adresse."),
    "audio-capture": L("No microphone found. Check your sound settings.", "Aucun micro trouvé. Vérifie tes réglages de son."),
    network: L("Speech recognition needs the internet. Check your connection.", "La reconnaissance vocale demande internet. Vérifie ta connexion."),
    "language-not-supported": L("This browser cannot recognise English. Use Google Chrome.", "Ce navigateur ne reconnaît pas l'anglais. Utilise Google Chrome."),
    unsupported: L("Voice input needs Google Chrome (or Safari on iPhone). You can type for now.", "La voix demande Google Chrome (ou Safari sur iPhone). Tu peux écrire en attendant."),
  };
  toast(map[e?.code] || L("The microphone stopped. Tap it and try again.", "Le micro s'est arrêté. Touche-le et réessaie."), 4200);
}

// =====================================================================
// Better ears: the learner's voice is recorded while the browser listens, and Whisper (on Groq,
// through the Mac) writes it down. The browser's dictation knows one language and native accents
// only; Whisper understands a French accent, and French mixed in. The browser still shows the words
// live and finds the end of the turn. Needs a Groq key (Settings) and the mic stream of MicMeter.
// =====================================================================
const Ears = {
  // UI.stt comes from the Mac at page load; a key added since is found by the first try.
  off: 0, // Date.now() until which we do not try (no key)
  get ok() { return Boolean(MicMeter.stream && window.MediaRecorder && Date.now() > this.off); },
  mime() {
    for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) if (MediaRecorder.isTypeSupported?.(m)) return m;
    return "";
  },
  // Starts recording. -> { blob(): Promise<Blob> (everything so far), stop() }, or null.
  record() {
    if (!this.ok) return null;
    let mr;
    try { mr = new MediaRecorder(MicMeter.stream, this.mime() ? { mimeType: this.mime() } : undefined); } catch { return null; }
    const chunks = [];
    mr.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
    try { mr.start(1000); } catch { return null; }
    const all = () => new Blob(chunks, { type: mr.mimeType || "audio/webm" });
    return {
      blob() {
        if (mr.state !== "recording") return Promise.resolve(all());
        return new Promise((resolve) => {
          const on = () => { mr.removeEventListener("dataavailable", on); resolve(all()); };
          mr.addEventListener("dataavailable", on);
          try { mr.requestData(); } catch { mr.removeEventListener("dataavailable", on); resolve(all()); }
        });
      },
      stop() { try { if (mr.state !== "inactive") mr.stop(); } catch { /* gone */ } },
    };
  },
  // -> Whisper's text, or "" (no key, too slow, Groq busy: the caller keeps the browser's text).
  async hear(rec, context = "") {
    if (!rec) return "";
    try {
      const blob = await rec.blob();
      if (blob.size < 1000) return "";
      const res = await fetch("/api/stt", {
        method: "POST", body: blob, signal: AbortSignal.timeout(5000),
        headers: { "content-type": blob.type || "audio/webm", "x-context": encodeURIComponent(String(context).slice(-300)) },
      });
      if (res.status === 400) { this.off = Date.now() + 60_000; return ""; }
      if (!res.ok) return "";
      UI.stt = true;
      return String((await res.json()).text || "").trim();
    } catch { return ""; }
  },
};

// Numbers only (no voice, no words), so that a bad call can be understood afterwards: data/sound-log.jsonl on the Mac.
const SoundLog = {
  d: null, t0: 0,
  begin() { this.d = { at: new Date().toISOString(), late: 0, ducks: 0, turns: 0, dictation: 0, shortRec: 0, echoTail: 0, askMs: 0 }; this.t0 = Date.now(); },
  count(k) { if (this.d) this.d[k] = (this.d[k] || 0) + 1; },
  put(k, v) { if (this.d) this.d[k] = v; },
  finish() {
    const d = this.d;
    if (!d) return;
    this.d = null;
    if (!UI.local) return;
    const tr = MicMeter.stream?.getAudioTracks?.()[0], set = tr?.getSettings?.() || {}, ctx = AudioOut.ctx;
    const db = (x) => (x > 0 ? Math.round(20 * Math.log10(x)) : -120);
    Object.assign(d, {
      seconds: Math.round((Date.now() - this.t0) / 1000), mic: tr?.label || "none", ec: set.echoCancellation, ns: set.noiseSuppression, agc: set.autoGainControl, micRate: set.sampleRate,
      voiceDb: db(MicMeter.voiceN ? MicMeter.voiceSum / MicMeter.voiceN : 0), floorDb: db(MicMeter.floor), scale: +MicMeter.scale.toFixed(1), speakers: ctx?.sampleRate, outMs: Math.round((ctx?.outputLatency || 0) * 1000), volume: S.profile.voiceVol || "loud",
    });
    fetch("/api/sound-log", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(d), keepalive: true }).catch(() => {});
  },
};

// A mic that would make things worse. Bluetooth headphones drop to phone quality (and to a low volume) as soon as their mic opens;
// an iPhone may be in another room; a virtual device (Teams, Zoom) gives silence. "Automatic" leaves those out, and any wired mic stays.
const MIC_AVOID = /bluetooth|airpods|beats|buds|iphone|ipad|teams|zoom|blackhole|loopback|soundflower|virtual|krisp/i;
const MIC_BUILT_IN = /built-?in|macbook|internal|intégré/i;

// The learner's microphone: one stream for the live ears, the recording and the loudness (mic ring, the tutor's nods).
const MicMeter = {
  stream: null, analyser: null, data: null, level: 0, starting: null, denied: "",
  floor: 0.002, peak: 0.05, scale: 1, top: 0, voiceSum: 0, voiceN: 0,
  constraints(id) {
    return { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, ...(id ? { deviceId: { exact: id } } : {}) } };
  },
  async open() {
    const want = S.profile.micId || "";
    const md = navigator.mediaDevices;
    let stream;
    try { stream = await md.getUserMedia(this.constraints(want)); } catch (e) {
      if (!want || e?.name === "NotAllowedError") throw e;
      stream = await md.getUserMedia(this.constraints("")); // that mic is gone
    }
    if (want || !MIC_AVOID.test(stream.getAudioTracks()[0]?.label || "")) return stream;
    const mics = (await md.enumerateDevices()).filter((d) => d.kind === "audioinput" && d.deviceId !== "default" && d.deviceId !== "communications");
    const better = mics.find((d) => MIC_BUILT_IN.test(d.label)) || mics.find((d) => !MIC_AVOID.test(d.label));
    if (!better) return stream;
    stream.getTracks().forEach((t) => t.stop());
    return md.getUserMedia(this.constraints(better.deviceId));
  },
  // -> a promise, done when the mic is ready or refused. Asking twice gives the same promise.
  start() {
    if (this.stream || IS_IOS || !navigator.mediaDevices?.getUserMedia) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = (async () => {
      try {
        const ctx = AudioOut.ensure();
        const stream = await this.open();
        const src = ctx.createMediaStreamSource(stream);
        this.analyser = ctx.createAnalyser();
        this.analyser.fftSize = 512;
        src.connect(this.analyser);
        this.data = new Float32Array(this.analyser.fftSize); // whole numbers cannot see a quiet voice (under -42 dB)
        this.stream = stream;
        this.denied = "";
      } catch (e) { this.denied = e?.name || "failed"; }
      this.starting = null;
    })();
    return this.starting;
  },
  read() {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.data);
    let sum = 0;
    for (let i = 0; i < this.data.length; i++) sum += this.data[i] * this.data[i];
    const rms = Math.sqrt(sum / this.data.length);
    // The room's noise and the voice's level, followed slowly: someone far from a quiet mic still counts as a voice.
    this.floor = rms < this.floor ? this.floor * 0.9 + rms * 0.1 : this.floor * 0.9995 + rms * 0.0005;
    this.top = Math.max(this.top, rms);
    if (rms > this.floor * 3 && rms > 0.0012) {
      this.peak = Math.max(rms, this.peak * 0.997); // a few seconds of voice are enough to learn its level
      this.voiceSum += rms;
      this.voiceN++;
    } else this.peak = Math.max(0.0012, this.peak * 0.9999);
    this.scale = Math.max(1, Math.min(14, 0.05 / this.peak));
    const v = Math.min(1, rms * 6 * this.scale);
    this.level += (v - this.level) * 0.3;
    return this.level;
  },
  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.analyser = null;
    this.level = 0;
    this.floor = 0.002; this.peak = 0.05; this.scale = 1; this.top = 0; this.voiceSum = 0; this.voiceN = 0;
  },
};

// =====================================================================
// Live ears (2026-10-29): ElevenLabs Scribe v2 Realtime writes the learner's words while they speak
// (about 0.2 s behind the voice). The reply starts from the right words as soon as the learner pauses:
// no recording to upload at the end, and no restart because the browser's dictation heard other words.
// One connection per call (a single-use pass from the Mac). Sound goes out only while a listener is open
// (16 kHz PCM, 100 ms pieces); each listener ends with a commit, and Scribe's final words for it come back.
// Same controller as Mic.listen. No ElevenLabs key, no mic stream, or the link fails: Mic + Ears take over.
// =====================================================================
const LIVE_WORKLET = `class Pcm16 extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / 16000; this.t = 0; this.out = new Int16Array(1600); this.n = 0;
    // A real low-pass filter before going down to 16 kHz: a plain average lets the highs of s, f and th fold back as noise.
    const N = 33, fc = 7400 / sampleRate, h = new Float32Array(N);
    let sum = 0;
    for (let i = 0; i < N; i++) {
      const x = i - (N - 1) / 2;
      const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
      h[i] = sinc * (0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (N - 1)));
      sum += h[i];
    }
    for (let i = 0; i < N; i++) h[i] /= sum;
    this.h = h; this.buf = new Float32Array(N); this.at = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    const h = this.h, buf = this.buf, N = h.length;
    for (let i = 0; i < ch.length; i++) {
      buf[this.at] = ch[i];
      this.at = (this.at + 1) % N;
      this.t += 1;
      if (this.t < this.step) continue;
      this.t -= this.step;
      let y = 0;
      for (let k = 0; k < N; k++) y += h[k] * buf[(this.at + k) % N];
      const s = Math.max(-1, Math.min(1, y));
      this.out[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.n === this.out.length) { this.port.postMessage(this.out.buffer, [this.out.buffer]); this.out = new Int16Array(1600); this.n = 0; }
    }
    return true;
  }
}
registerProcessor("pcm16", Pcm16);`;

// One Scribe connection. Each listener gets a new one, opened ahead of time: in the same connection, Scribe
// sometimes went deaf on the learner's next answer (no live words, then an empty final text: 5 calls out of 6
// on 2026-10-29), never on the first answer of a connection.
class ScribeSession {
  constructor() {
    this.ws = null;
    this.owners = []; // who gets the answer of each commit, in order (null: nobody)
    this.dirty = false; // sound sent since the last commit
    this.voiced = 0; // pieces with a voice in them since the last commit
    this.backlog = [];
    this.lastDone = "";
    this.listener = null;
    this.closed = false;
    this.failed = false;
    this.ready = this.connect();
  }
  async connect() {
    try {
      await LiveEars.ensureGraph();
      const { url } = await api("/api/stt/live", {});
      if (this.closed) return;
      const ws = new WebSocket(url);
      await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = () => reject(new Error("no link"));
        setTimeout(() => reject(new Error("too slow")), 6000);
      });
      ws.onmessage = (e) => { try { this.message(JSON.parse(e.data)); } catch { /* not JSON */ } };
      ws.onclose = () => this.lost();
      ws.onerror = () => {};
      this.ws = ws;
      if (this.closed) { ws.close(); return; }
      for (const m of this.backlog.splice(0)) ws.send(m);
    } catch (e) {
      console.warn("[live ears] could not open:", e?.message || e);
      LiveEars.off = Date.now() + 60_000; // the old ears for a minute
      this.failed = true;
      this.lost();
    }
  }
  send(msg) {
    if (this.ws?.readyState === 1) this.ws.send(msg);
    else if (!this.closed && this.backlog.length < 60) this.backlog.push(msg); // up to 6 s while it opens
  }
  // Closes the current stretch of sound. owner.final(text) gets Scribe's words for it (null owner: nobody waits).
  commit(owner) {
    if (!this.dirty) { owner?.final(null); return; }
    this.dirty = false;
    if (owner) owner.voiced = this.voiced;
    this.voiced = 0;
    LiveEars.silence ||= b64(new Int16Array(1600).buffer);
    // Scribe closes the session if a commit comes with less than 0.3 s of sound: fill up with silence.
    for (let i = this.since || 0; i < 3; i++) this.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: LiveEars.silence, commit: false, sample_rate: 16000 }));
    this.since = 0;
    this.owners.push(owner);
    this.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: LiveEars.silence, commit: true, sample_rate: 16000 }));
  }
  message(d) {
    const type = d.message_type, l = this.listener;
    if (type === "partial_transcript") {
      if (!this.owners.length && l) l.partial(this.fresh(String(d.text || "")));
    } else if (type === "committed_transcript") {
      if (d.text) this.lastDone = normText(d.text);
      if (this.owners.length) this.owners.shift()?.final(String(d.text || ""));
      else l?.committed(String(d.text || "")); // Scribe closed a long stretch by itself
      if (this.retiring && !this.owners.length) this.close();
    } else if (type !== "session_started" && d.error) {
      console.warn("[live ears]", type, d.error);
      if (/quota|auth|terms/.test(type)) LiveEars.off = Date.now() + 10 * 60_000;
      this.close();
    }
  }
  // After a commit, Scribe sometimes sends the stretch it just closed once more, as live words
  // (seen 2026-10-29: the learner's sentence came out twice). Those words are not new: drop them.
  fresh(t) {
    const done = this.lastDone;
    if (!done) return t;
    const words = t.trim().split(/\s+/), n = done.split(" ").length;
    // Only right after a commit, and only a repeat of 2 words or more ("Vale" may well be said again).
    if (n < 2 || words.length < n || normText(words.slice(0, n).join(" ")) !== done) { this.lastDone = ""; return t; }
    return words.slice(n).join(" ");
  }
  // The listener is done: wait for the last answers, then close.
  retire() {
    this.listener = null;
    this.retiring = true;
    if (!this.owners.length) this.close();
    else setTimeout(() => this.close(), 2500);
  }
  lost() {
    if (this.closed && !this.ws) return;
    // Words waiting for a commit will not come back: the listeners keep what they have.
    for (const o of this.owners.splice(0)) o?.final(null);
    this.backlog = [];
    const l = this.listener;
    this.close();
    if (l && LiveEars.active === l) l.cut(); // a listener cut off from Scribe ends with its words so far
  }
  close() {
    this.closed = true;
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(); } catch { /* gone */ }
    if (LiveEars.next === this) LiveEars.next = null;
  }
}

const LiveEars = {
  want: false, off: 0, next: null,
  node: null, src: null, sink: null, graph: null, moduleCtx: null,
  active: null, silence: null, noise: 0.01, voiceAt: 0, flushed: true,
  // Closing a stretch in the middle of speech loses words. Measured on 14 real French accents reading a known text (2026-11-05):
  // 17% of words wrong with a commit at each 450 ms pause, 8% at 1200 ms, 7% like this, 5.7% with one commit at the end.
  // So only a short first answer closes early ("Yes, sure": Scribe holds it back for almost 2 s); after that, only a long silence.
  flushShortMs: 600, flushLongMs: 3000,
  get ok() { return Boolean(UI.eleven && MicMeter.stream && window.AudioWorkletNode && window.WebSocket && Date.now() > this.off); },

  // The mic's sound -> 16 kHz PCM pieces (once per call).
  async ensureGraph() {
    if (this.graph) return this.graph;
    this.graph = (async () => {
      const ctx = AudioOut.ensure();
      if (this.moduleCtx !== ctx) { // a worklet can be added only once to the same sound context
        await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([LIVE_WORKLET], { type: "application/javascript" })));
        this.moduleCtx = ctx;
      }
      this.src = ctx.createMediaStreamSource(MicMeter.stream);
      this.node = new AudioWorkletNode(ctx, "pcm16");
      this.sink = ctx.createGain();
      this.sink.gain.value = 0; // the worklet must be pulled by the graph; nothing reaches the speakers
      this.src.connect(this.node);
      this.node.connect(this.sink);
      this.sink.connect(ctx.destination);
      this.node.port.onmessage = (e) => this.piece(e.data);
    })().catch((e) => { this.graph = null; throw e; });
    return this.graph;
  },

  // At the start of a call: the first connection opens while the tutor says hello.
  open() {
    this.want = true;
    if (!this.next || this.next.closed) this.next = new ScribeSession();
    return this.next.ready;
  },
  close() {
    this.want = false;
    this.active?.abort();
    this.next?.close();
    this.next = null;
    try { this.src?.disconnect(); this.node?.disconnect(); this.sink?.disconnect(); } catch { /* gone */ }
    this.src = this.node = this.sink = this.graph = null;
  },
  // A fresh connection for a new listener, and the next one opening already.
  take() {
    let s = this.next;
    if (!s || s.closed || s.listener) s = new ScribeSession();
    this.next = this.want ? new ScribeSession() : null;
    return s;
  },

  piece(buf) {
    const l = this.active, s = l?.session;
    if (!s || s.closed) return;
    s.dirty = true;
    s.since = (s.since || 0) + 1;
    s.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: b64(buf), commit: false, sample_rate: 16000 }));
    const pcm = new Int16Array(buf);
    let sum = 0;
    for (let i = 0; i < pcm.length; i += 4) sum += (pcm[i] / 32768) ** 2;
    const rms = Math.sqrt(sum / (pcm.length / 4));
    const now = performance.now();
    if (rms > Math.max(0.004, this.noise * 3)) { this.voiceAt = now; this.flushed = false; s.voiced++; } // 0.004: a quiet mic
    else this.noise = this.noise * 0.95 + rms * 0.05;
    const wait = !s.closedOnce && s.voiced <= 15 ? this.flushShortMs : this.flushLongMs;
    if (!this.flushed && now - this.voiceAt > wait) { this.flushed = true; s.closedOnce = true; this.flush(); }
  },
  // Closes the stretch heard so far; its final words go to the listener (even if it has ended meanwhile).
  flush() {
    const l = this.active;
    if (!l) return;
    const owner = { final: (t) => { if (t != null) l.committed(t, owner.voiced); } };
    l.session.commit(owner);
  },

  listen(lang, { onUpdate, onStart, prefix = "" } = {}) {
    this.active?.abort();
    const base = String(prefix).trim();
    let parts = [], part = "", done = false, resolveP, finalP, timer = null, glitch = false, rescue = null;
    // A plain recording too: if Scribe loses a stretch it clearly heard, the normal Scribe writes the turn from it.
    const backup = Ears.record();
    const session = this.take();
    const join = () => [base, ...parts, part].join(" ").replace(/\s+/g, " ").trim();
    const update = () => {
      const t = join();
      if (t !== ctl.text) { ctl.text = t; ctl.lastChange = performance.now(); onUpdate?.(t); }
    };
    // Scribe sent back nothing for a stretch with a voice in it: the recording gives the whole turn (about 1 s).
    const save = () => {
      glitch = true;
      if (rescue || !backup) return;
      rescue = Ears.hear(backup).then((w) => {
        rescue = null;
        if (!w || done) return;
        parts = [w];
        part = "";
        session.lastDone = normText(w);
        update();
      });
    };
    const ctl = {
      live: true,
      backup,
      session,
      text: base,
      lastChange: performance.now(),
      started: true,
      promise: new Promise((res) => { resolveP = res; }),
      partial(t) { if (!done) { part = clean(withoutRepeat(parts.join(" "), t)); update(); } },
      committed(t, voiced = 0) {
        const repeat = clean(t) && !clean(withoutRepeat(parts.join(" "), t));
        if (repeat) { part = ""; update(); return; } // words we already have: nothing was lost
        t = clean(withoutRepeat(parts.join(" "), t));
        if (done) { if (t) parts.push(t); return; } // late words still go into the final text
        if (!t) {
          // An empty answer for a stretch with half a second of voice or more, while the tutor is quiet
          // (so it is the learner, not the tutor's echo): Scribe lost it (seen 2026-10-29).
          if (part) { parts.push(part); session.lastDone = normText(part); part = ""; }
          if (voiced >= 5 && !Speech.speaking()) save();
          return;
        }
        parts.push(t);
        part = "";
        update();
      },
      // Forget what was heard so far (the tutor's own voice, while they were talking): a fresh start.
      // Safer than cutting words off the text, since Scribe may still rewrite the words of an open stretch.
      reset() {
        if (done || (!parts.length && !part)) return; // nothing heard: nothing to forget
        parts = [];
        part = "";
        session.commit(null);
        update();
      },
      // Scribe (or the rescue) still owes words for this listener.
      owes() { return !done && (session.owners.length > 0 || Boolean(rescue)); },
      // Send the words we have now (the commit's final words arrive a moment later in ctl.finalText).
      cut() { end(true); },
      stop() { end(true); },
      abort() { end(false); },
    };
    ctl.finalText = new Promise((res) => { finalP = res; });
    session.listener = ctl;
    const end = (keep) => {
      if (done) return;
      done = true;
      if (LiveEars.active === ctl) LiveEars.active = null;
      const words = keep ? join() : "";
      const owed = part; // live words not closed yet: the commit below must bring them back
      let settled = false;
      const settle = (t) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        session.retire();
        const fin = keep && t != null ? [base, ...parts, clean(withoutRepeat(parts.join(" "), t))].join(" ").replace(/\s+/g, " ").trim() : null;
        if (keep && backup && (glitch || (owed && t === ""))) {
          // Scribe lost words: the recording, written by the normal Scribe (about 1 s), gives the full turn.
          finalP(Ears.hear(backup).then((w) => (w ? [base, w].join(" ").trim() : fin)).finally(() => backup.stop()));
        } else {
          backup?.stop();
          finalP(fin);
        }
      };
      timer = setTimeout(() => settle(null), 1500);
      // Scribe's final words for this listener (a little more exact than the live ones), or null.
      session.commit({ final: settle });
      resolveP({ text: words });
    };
    this.active = ctl;
    onStart?.();
    return ctl;
  },
  stopAll() { this.active?.abort(); },
};

// Scribe sometimes sends words it has already closed once more (seen 2026-10-29 and 2026-11-05: a whole turn came out
// twice). done: what is closed so far. -> t without the repeat. A repeat of one or two words may be real ("no, no").
function withoutRepeat(done, t) {
  const old = normText(done).split(" ").filter(Boolean);
  const words = String(t || "").trim().split(/\s+/).filter(Boolean);
  const toks = [], owner = [];
  words.forEach((w, i) => normText(w).split(" ").filter(Boolean).forEach((k) => { toks.push(k); owner.push(i); }));
  if (old.length < 3 || toks.length < 3) return String(t || "");
  // It is coming back from the start of the turn, word by word.
  if (toks.length <= old.length && old.slice(0, toks.length).join(" ") === toks.join(" ")) return "";
  // It starts with the last words already closed.
  for (let n = Math.min(old.length, toks.length); n >= 3; n--) {
    if (old.slice(-n).join(" ") === toks.slice(0, n).join(" ")) return words.slice(owner[n - 1] + 1).join(" ");
  }
  return String(t || "");
}

// Scribe sometimes wraps what it heard in quotes ("¡Sí, gracias!".) or spaces a question mark: the learner's words only.
function clean(t) {
  return String(t || "").trim().replace(/^["“”«»]+\s*/, "").replace(/\s*["“”«»]+([.!?…]*)$/, "$1").replace(/([!?…])\.$/, "$1")
    .replace(/\s+([?!.,;:])/g, "$1").trim(); // "Jake ?" -> "Jake?"
}

function b64(buf) {
  const u = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}
