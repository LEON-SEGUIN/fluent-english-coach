// Fluent text-to-speech. Default: Microsoft's neural voices (online, free: the "Read aloud" voices
// of the Edge browser), much more natural than the Mac voices. The Mac voices stay as the fallback:
// a fast native engine (tts/camino-tts.swift, AVSpeechSynthesizer kept loaded in a helper process),
// then the `say` command. See tts/README.md.
import { spawn, execFile, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "tts", "camino-tts.swift");
const BIN = path.join(HERE, "tts", "bin", "camino-tts");
const SWIFTC = fs.existsSync("/usr/bin/swiftc") ? "/usr/bin/swiftc" : "swiftc";
const NATIVE_OFF = process.env.FLUENT_TTS_DISABLE_NATIVE === "1";
const DEBUG = process.env.FLUENT_TTS_DEBUG === "1";
const DIR = path.join(os.tmpdir(), "fluent-tts"); // not camino-tts: both apps can run at the same time
const MAX_FILES = 400;
const TIMEOUT_MS = 10_000;
const VOICES_TTL_MS = 5 * 60_000;
const NOVELTY = /grandma|grandpa|rocko|sandy|shelley|bad news|bells|boing|bubbles|cellos|jester|organ|superstar|trinoids|whisper|wobble|zarvox|albert|fred|junior|ralph|kathy|bahh|good news/i;
const QUALITY = { eleven: 5, natural: 4, premium: 3, enhanced: 2, default: 1 };
// AVSpeech reports "unspecified" for the Eloquence voices; fill in the known ones.
const GENDER = {
  eddy: "male", reed: "male", rocko: "male", grandpa: "male", daniel: "male", evan: "male", nathan: "male", tom: "male", aaron: "male", oliver: "male", arthur: "male",
  flo: "female", sandy: "female", shelley: "female", grandma: "female", samantha: "female", serena: "female", kate: "female",
  stephanie: "female", martha: "female", ava: "female", allison: "female", susan: "female", zoe: "female", karen: "female", moira: "female",
};

// Speed calibration, measured on macOS 26 (3 sentences, speech length relative to `say -r 185`).
// [AVSpeechUtterance.rate, speed]. Compact/enhanced/premium voices move in coarse steps;
// Eloquence voices (Eddy, Flo, Reed...) are nearly continuous. Both hit 1.00 at rate 0.51.
const CURVE_VOICE = [[0.22, 0.69], [0.28, 0.74], [0.34, 0.80], [0.42, 0.88], [0.48, 0.96], [0.51, 1.0],
  [0.52, 1.04], [0.53, 1.14], [0.54, 1.19], [0.55, 1.25], [0.56, 1.30], [0.57, 1.37]];
const CURVE_ELOQUENCE = [[0.20, 0.53], [0.22, 0.55], [0.24, 0.57], [0.26, 0.59], [0.28, 0.62], [0.30, 0.64],
  [0.32, 0.67], [0.34, 0.70], [0.36, 0.73], [0.38, 0.76], [0.40, 0.79], [0.42, 0.82], [0.44, 0.85],
  [0.46, 0.89], [0.48, 0.92], [0.50, 0.96], [0.51, 1.0], [0.52, 1.04], [0.53, 1.08], [0.54, 1.17],
  [0.55, 1.21], [0.56, 1.26], [0.57, 1.31], [0.58, 1.43]];
// App rate -> wanted speed = rate^0.8: 1.0 natural (= say -r 185), 0.9 -> 0.92x, 0.68 -> 0.73x
// (clearly slow, 37% longer), 0.5 -> 0.57x, 1.3 -> 1.23x. Then the closest measured AV rate.
function avRate(voiceId, rate) {
  const want = Math.pow(rate, 0.8);
  const curve = voiceId.startsWith("com.apple.voice.") ? CURVE_VOICE : CURVE_ELOQUENCE;
  let best = curve[0];
  for (const p of curve) if (Math.abs(p[1] - want) < Math.abs(best[1] - want)) best = p;
  return best[0];
}
const clampRate = (r) => Math.round(Math.max(0.5, Math.min(1.3, Number(r) || 0.9)) * 100) / 100;

// Emoji are blanked (same UTF-16 length, so word indexes still match the text).
const EMOJI = /\p{Extended_Pictographic}|\p{Emoji_Modifier}||[-]/gu;
const speakable = (text) => text.replace(EMOJI, (m) => " ".repeat(m.length));

const log = (...a) => console.warn("[tts]", ...a);
const debug = (...a) => { if (DEBUG) console.warn("[tts]", ...a); };

// The cache folder is emptied once, when the module loads.
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

// ---------- Native helper process ----------
const native = {
  state: NATIVE_OFF ? "off" : "idle", // idle | compiling | starting | ready | failed | off
  proc: null,
  launching: null,       // promise while compiling/starting
  pending: new Map(),    // id -> { resolve, reject, timer, out }
  abandoned: new Map(),  // id -> out path of requests that timed out
  voiceWaiters: [],
  nextId: 1,
  lastLineAt: 0,
  crashes: [],
  wantWarm: false,
  warm: "no",          // no | warming | done (default voices loaded)
};

function needsCompile() {
  try { return fs.statSync(BIN).mtimeMs < fs.statSync(SRC).mtimeMs; } catch { return true; }
}

// Without Xcode Command Line Tools, /usr/bin/swiftc only opens an "install" window: skip it, `say` works.
function hasCompiler() {
  try { execFileSync("/usr/bin/xcode-select", ["-p"], { stdio: "ignore" }); return true; } catch { return false; }
}

function compile() {
  if (!hasCompiler()) {
    log("no Swift compiler (Xcode Command Line Tools), staying on `say`");
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    fs.mkdirSync(path.dirname(BIN), { recursive: true });
    const tmp = `${BIN}.tmp-${process.pid}`;
    const t0 = Date.now();
    log("compiling the native voice engine (once, ~10 s); using `say` meanwhile");
    execFile(SWIFTC, ["-O", SRC, "-o", tmp], { timeout: 300_000, maxBuffer: 4_000_000 }, (err, _out, stderr) => {
      if (err) {
        log("compile failed, staying on `say`:", String(stderr || err.message).split("\n").slice(0, 5).join(" | "));
        fs.rmSync(tmp, { force: true });
        return resolve(false);
      }
      try { fs.renameSync(tmp, BIN); } catch (e) { log("could not install binary:", e.message); return resolve(false); }
      log(`native voice engine compiled in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      resolve(true);
    });
  });
}

// Compiles if needed and starts the helper. Resolves true when it answers.
function launch() {
  if (native.state === "ready") return Promise.resolve(true);
  if (native.state === "off" || native.state === "failed") return Promise.resolve(false);
  if (native.launching) return native.launching;
  native.launching = (async () => {
    if (needsCompile()) {
      native.state = "compiling";
      if (!(await compile())) { native.state = "failed"; return false; }
    }
    native.state = "starting";
    return startHelper();
  })().catch((err) => {
    log("native engine unavailable, staying on `say`:", err.message);
    native.state = "failed";
    return false;
  }).finally(() => { native.launching = null; });
  return native.launching;
}

function startHelper() {
  let proc;
  try {
    proc = spawn(BIN, [], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, CAMINO_TTS_DEBUG: DEBUG ? "1" : "0" } });
  } catch (err) {
    log("could not start the native engine:", err.message);
    native.state = "failed";
    return Promise.resolve(false);
  }
  native.proc = proc;
  proc.unref();
  for (const s of [proc.stdin, proc.stdout, proc.stderr]) s.unref?.();
  proc.stdin.on("error", () => {});
  proc.stderr.on("data", (d) => { if (DEBUG) process.stderr.write(d); });
  readline.createInterface({ input: proc.stdout }).on("line", onLine);
  proc.on("error", (err) => { log("native engine error:", err.message); onExit(proc, null, err.code || "error"); });
  proc.on("exit", (code, signal) => onExit(proc, code, signal));
  return askVoices(15_000).then(
    (list) => {
      if (native.proc !== proc) return false;
      voiceCache = { at: Date.now(), list };
      native.state = "ready";
      debug(`native engine ready (pid ${proc.pid})`);
      if (native.wantWarm) warmVoices();
      return true;
    },
    (err) => { debug("native engine did not answer:", err.message); proc.kill("SIGKILL"); return false; },
  );
}

function onLine(line) {
  native.lastLineAt = Date.now();
  let msg;
  try { msg = JSON.parse(line); } catch { return debug("bad line from helper:", line.slice(0, 200)); }
  if (msg.op === "voices") return native.voiceWaiters.shift()?.resolve(msg.voices || []);
  if (msg.op === "done") {
    const id = String(msg.id);
    const p = native.pending.get(id);
    if (p) { native.pending.delete(id); clearTimeout(p.timer); return p.resolve(msg); }
    const out = native.abandoned.get(id);
    if (out) { native.abandoned.delete(id); fsp.rm(out, { force: true }).catch(() => {}); }
    return;
  }
  debug("helper says:", line.slice(0, 200));
}

function onExit(proc, code, signal) {
  if (native.proc !== proc) return;
  native.proc = null;
  native.warm = "no";
  const err = new Error(`native engine exited (${signal || code})`);
  for (const [, p] of native.pending) { clearTimeout(p.timer); p.reject(err); }
  native.pending.clear();
  for (const w of native.voiceWaiters.splice(0)) w.reject(err);
  if (native.state === "off" || native.state === "failed") return;
  const now = Date.now();
  native.crashes = native.crashes.filter((t) => now - t < 60_000);
  if (native.crashes.length >= 3) {
    native.state = "failed";
    return log(`${err.message}; too many restarts, staying on \`say\``);
  }
  native.crashes.push(now);
  log(`${err.message}; restarting`);
  native.state = "idle";
  launch();
}

function send(obj) {
  if (!native.proc) throw new Error("native engine not running");
  native.proc.stdin.write(JSON.stringify(obj) + "\n");
}

function askVoices(timeoutMs) {
  return new Promise((resolve, reject) => {
    const w = { resolve, reject };
    const timer = setTimeout(() => {
      const i = native.voiceWaiters.indexOf(w);
      if (i >= 0) native.voiceWaiters.splice(i, 1);
      reject(new Error("voices timeout"));
    }, timeoutMs);
    w.resolve = (v) => { clearTimeout(timer); resolve(v); };
    w.reject = (e) => { clearTimeout(timer); reject(e); };
    native.voiceWaiters.push(w);
    try { send({ op: "voices" }); } catch (e) { native.voiceWaiters.pop(); w.reject(e); }
  });
}

function nativeSynth(text, voice, rate, out) {
  return new Promise((resolve, reject) => {
    const id = String(native.nextId++);
    const sentAt = Date.now();
    const timer = setTimeout(() => {
      native.pending.delete(id);
      native.abandoned.set(id, out);
      reject(new Error("native timeout"));
      // Not a word from the helper since this request was sent: it is stuck, restart it.
      if (native.lastLineAt < sentAt && native.proc) native.proc.kill("SIGKILL");
    }, TIMEOUT_MS);
    native.pending.set(id, { resolve, reject, timer, out });
    try { send({ op: "synth", id, text, voice, rate, out }); } catch (e) { native.pending.delete(id); clearTimeout(timer); reject(e); }
  });
}

// True when the native engine can take a request now (waits a little if it is starting).
async function nativeUsable() {
  if (native.state === "ready") return true;
  if (native.state === "off" || native.state === "failed") return false;
  const p = launch();
  if (native.state === "compiling") return false;
  let t;
  const ok = await Promise.race([p, new Promise((r) => { t = setTimeout(() => r(false), 3000); })]);
  clearTimeout(t);
  return ok === true && native.state === "ready";
}

process.on("exit", () => { try { native.proc?.kill(); } catch { /* gone */ } });

// ---------- Natural voices (Microsoft Edge "Read aloud", online) ----------
// Same protocol as the edge-tts Python package. One sentence per request; an open connection
// answers in ~300 ms (a new one adds 200-400 ms), so idle connections are kept for the next sentence.
const EDGE_OFF = process.env.FLUENT_TTS_DISABLE_EDGE === "1";
const EDGE_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const EDGE_CHROME = "143.0.3650.75";
const EDGE_URL = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const EDGE_MAJOR = EDGE_CHROME.split(".")[0];
const EDGE_HEADERS = {
  "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${EDGE_MAJOR}.0.0.0 Safari/537.36 Edg/${EDGE_MAJOR}.0.0.0`,
  Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
  Pragma: "no-cache",
  "Cache-Control": "no-cache",
};
const EDGE_VOICES = [
  { short: "en-GB-SoniaNeural", name: "Sonia", lang: "en-GB", gender: "female" },
  { short: "en-GB-LibbyNeural", name: "Libby", lang: "en-GB", gender: "female" },
  { short: "en-GB-RyanNeural", name: "Ryan", lang: "en-GB", gender: "male" },
  { short: "en-US-AndrewNeural", name: "Andrew", lang: "en-US", gender: "male" },
  { short: "en-US-BrianNeural", name: "Brian", lang: "en-US", gender: "male" },
  { short: "en-US-AvaNeural", name: "Ava", lang: "en-US", gender: "female" },
  { short: "en-US-EmmaNeural", name: "Emma", lang: "en-US", gender: "female" },
].map((v) => ({ id: "edge:" + v.short, name: `${v.name} (natural)`, lang: v.lang, quality: "natural", gender: v.gender, short: v.short }));
// Since October 2026 the service is uneven: the same sentence takes 0.6 s or 5 s, and some connections are refused.
// So each sentence gets a fresh connection (as in edge-tts), and is asked again on another one when no audio came
// after EDGE_HEDGE_MS; the first answer wins. The Mac voice only speaks when every try failed.
const EDGE_HEDGE_MS = 1300;  // no audio yet: ask again on another connection
const EDGE_TRIES = 4;        // at most this many tries per sentence
const EDGE_FIRST_MS = 7000;  // one try gives up without audio by then
const EDGE_TOTAL_MS = 12_000;
const EDGE_SPARE = 2;        // connections opened in advance (each one is used for a single sentence)
const EDGE_SPARE_MS = 45_000; // an unused spare older than this is closed (the service drops idle connections)
const MP3_BYTES_PER_S = 6000; // audio-24khz-48kbitrate-mono-mp3 is constant bitrate
const MP3_FRAME = 144;        // bytes per frame at that rate (576 samples, 24 ms): cut only between frames
const EDGE_TAIL_S = 0.2;      // silence kept after the last word (the service adds about 1 s)
const isEdge = (id) => String(id).startsWith("edge:");
const edge = { pool: [], failUntil: 0, fails: 0 };
const edgeUp = () => !EDGE_OFF && Date.now() >= edge.failUntil;

const edgeId = () => crypto.randomUUID().replaceAll("-", "");
const edgeDate = () => new Date().toUTCString().replace("GMT", "GMT+0000 (Coordinated Universal Time)");
// Sec-MS-GEC v2 (since October 2026): "<CS64 hex>-<SHA-256 hex>" of the rounded Windows file time + the client token.
// A port of edge-tts (src/edge_tts/drm.py): a SHA-256 started from a modified state, then a "CS64" checksum.
// Every value stays a 32-bit unsigned number (>>> 0, Math.imul), like the masks in the Python code.
const GEC_INITIAL = [0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A, 0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19];
const GEC_STATE = [0xFD9FBEA2, 0x91243CE7, 0xBE499094, 0xCD2E1E0A, 0x6C006F49, 0x04BD35AB, 0xFEB0A7E4, 0x03EFFBD2];
const GEC_SCHEDULE = [0xEB24BF9E, 0x1558691F, 0xA0C09EE2, 0x0CFA32BA, 0xA622EE8C, 0xD1DD9491, 0xC0DD25A0, 0xF9E70AB6, 0xF0C31573, 0x7058CE4E, 0x7188E606, 0x00E5AB33, 0xD258B060, 0x72766564];
const GEC_K = [
  0x428A2F98, 0x71374491, 0xB5C0FBCF, 0xE9B5DBA5, 0x3956C25B, 0x59F111F1, 0x923F82A4, 0xAB1C5ED5, 0xD807AA98, 0x12835B01, 0x243185BE, 0x550C7DC3, 0x72BE5D74, 0x80DEB1FE, 0x9BDC06A7, 0xC19BF174,
  0xE49B69C1, 0xEFBE4786, 0x0FC19DC6, 0x240CA1CC, 0x2DE92C6F, 0x4A7484AA, 0x5CB0A9DC, 0x76F988DA, 0x983E5152, 0xA831C66D, 0xB00327C8, 0xBF597FC7, 0xC6E00BF3, 0xD5A79147, 0x06CA6351, 0x14292967,
  0x27B70A85, 0x2E1B2138, 0x4D2C6DFC, 0x53380D13, 0x650A7354, 0x766A0ABB, 0x81C2C92E, 0x92722C85, 0xA2BFE8A1, 0xA81A664B, 0xC24B8B70, 0xC76C51A3, 0xD192E819, 0xD6990624, 0xF40E3585, 0x106AA070,
  0x19A4C116, 0x1E376C08, 0x2748774C, 0x34B0BCB5, 0x391C0CB3, 0x4ED8AA4A, 0x5B9CCA4F, 0x682E6FF3, 0x748F82EE, 0x78A5636F, 0x84C87814, 0x8CC70208, 0x90BEFFFA, 0xA4506CEB, 0xBEF9A3F7, 0xC67178F2,
];
const GEC_ADJ = 0xC9DC06A7;
const GEC_K_BLOCK = GEC_K.map((k, i) => (i === 14 ? GEC_ADJ : k));
const GEC_CS64 = [
  [0xE82E91B1, 0xB32700D0], [0x44DE24C6, 0x88DFF51D], [0x3BEB65BC, 0x29514038], [0xC89C5933, 0xB328CBDF], [0x8D1EC211, 0xD405B4D5], [0x314EF5D5, 0x26E55F3C], [0xE92491B1, 0x607801C6],
  [0xF0A5B9D5, 0x82B2C1FB], [0x06064CF3, 0xFA51A3DA], [0xDA79FA60, 0x207CC464], [0xBED20560, 0x3C3C74F3], [0x89F9C9F8, 0xD2D14B61], [0x35FA38C6, 0xBB04A2C1], [0xCB49E3C6, 0xC5626167],
];
const u32 = (x) => x >>> 0;
const rotr = (x, n) => u32((x >>> n) | (x << (32 - n)));
const rol16 = (x) => u32((x << 16) | (x >>> 16));
const mul = (a, b) => u32(Math.imul(a, b));
const sig0 = (x) => u32(rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3));
const sig1 = (x) => u32(rotr(x, 17) ^ rotr(x, 19) ^ (x >>> 10));

function gecExpand(w, from) {
  for (let i = from; i < 64; i++) w[i] = u32(sig1(w[i - 2]) + w[i - 7] + sig0(w[i - 15]) + w[i - 16]);
}
function gecRounds(state, w, first, k) {
  let [a, b, c, d, e, f, g, h] = state;
  for (let i = first; i < 64; i++) {
    const t1 = h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + u32(g ^ (e & (f ^ g))) + k[i] + w[i];
    const t2 = u32(rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + u32((a & b) | (c & (a | b)));
    h = g; g = f; f = e; e = u32(d + t1); d = c; c = b; b = a; a = u32(t1 + t2);
  }
  return [a, b, c, d, e, f, g, h];
}
function gecDigest(data) {
  // The first 7 bytes give a starting state (most of the first block is fixed).
  const w = new Array(14).fill(0);
  w[14] = (data[0] << 16) | (data[1] << 8) | data[2];
  w[15] = data.readUInt32BE(3);
  for (let i = 16; i < 30; i++) {
    let v = GEC_SCHEDULE[i - 16] + (i === 16 ? u32(sig1(w[i - 2]) ^ 0x000B92C0) : sig1(w[i - 2]));
    if (i >= 21) v += w[i - 7];
    if (i === 29) v += u32(sig0(w[i - 15]) ^ 0x059C0B80);
    w[i] = u32(v);
  }
  w[30] = u32(sig1(w[28]) + w[23] + sig0(w[15]) + w[14] + GEC_ADJ - GEC_K[14]);
  gecExpand(w, 31);
  let state = gecRounds(GEC_STATE, w, 14, GEC_K_BLOCK).map((x, i) => u32(GEC_INITIAL[i] + x));
  // Then the rest of the data, padded like SHA-256 (as if 57 bytes came before).
  const length = 57 + data.length;
  const pad = ((55 - length) % 64 + 64) % 64;
  const tail = Buffer.concat([data.subarray(7), Buffer.from([0x80]), Buffer.alloc(pad), Buffer.alloc(8)]);
  tail.writeBigUInt64BE(BigInt(length * 8), tail.length - 8);
  for (let off = 0; off < tail.length; off += 64) {
    const words = Array.from({ length: 16 }, (_, i) => tail.readUInt32BE(off + i * 4));
    gecExpand(words, 16);
    state = gecRounds(state, words, 0, GEC_K).map((x, i) => u32(state[i] + x));
  }
  const out = Buffer.alloc(32);
  state.forEach((x, i) => out.writeUInt32BE(x, i * 4));
  return out;
}
function gecCs64(data, digest) {
  const keyA = u32(digest.readUInt32LE(0) | 1);
  const keyB = u32(digest.readUInt32LE(4) | 1);
  const factors = [mul(keyA, 0x82893933), mul(keyB, 0x82893933)];
  const terms = GEC_CS64.map(([c], i) => mul(c, factors[i % 2]));
  const offsets = GEC_CS64.map(([, o]) => o);
  let bytes = Buffer.concat([Buffer.from([0]), data]);
  bytes = Buffer.concat([bytes, Buffer.alloc((4 - (bytes.length % 4)) % 4)]);
  const words = Array.from({ length: bytes.length / 4 }, (_, i) => bytes.readUInt32LE(i * 4));
  if (words.length % 2) words.push(0);
  words.forEach((word, i) => {
    let term = mul(word, i % 2 ? keyB : keyA);
    let offset = mul(rol16(word), i % 2 ? 0xC31713DB : 0xEF0569FB);
    if (i === 0) { term = u32(term + mul(0xF2F90B1A, factors[0])); offset = u32(offset + 0x0B1A0000); }
    terms.push(term);
    offsets.push(offset);
  });
  let swapAcc = 0, swapLast = 0, state = 0, acc = 0;
  for (let i = 0; i < terms.length; i += 2) {
    const x = terms[i], y = terms[i + 1];
    let q = mul(rol16(u32(offsets[i] + x)), 0x76F50F34);
    swapAcc = u32(swapAcc + u32(mul(rol16(q), 0xC3EFEA97) + q));
    q = mul(rol16(u32(offsets[i + 1] + y)), 0x1881CE3C);
    swapLast = u32(mul(rol16(q), 0x35BD1EC9) + q);
    swapAcc = u32(swapAcc + swapLast);
    state = u32(mul(state, keyA) + x);
    state = mul(rol16(state), 0xCF98B111);
    state = mul(rol16(state), 0x87085B9F);
    state = mul(rol16(state), 0x12CEB96D);
    state = mul(rol16(state), 0x257E1D83);
    acc = u32(acc + state);
    let t = u32(mul(state, keyB) + y);
    t = mul(rol16(t), 0xA27416F5);
    t = mul(rol16(t), 0xD38396FF);
    state = mul(rol16(mul(rol16(t), 0x7C932B89)), 0xBFA49F69);
    acc = u32(acc + state);
  }
  const out = Buffer.alloc(8);
  out.writeUInt32LE(u32(swapLast ^ state), 0);
  out.writeUInt32LE(u32(swapAcc ^ acc), 4);
  return out;
}
let gecCache = { ticks: null, value: "" };
function edgeGec(nowMs = Date.now()) {
  let s = nowMs / 1000 + 11644473600;
  s -= s % 300;
  const ticks = (s * 1e7).toFixed(0);
  if (gecCache.ticks === ticks) return gecCache.value;
  const data = Buffer.from(`${ticks}${EDGE_TOKEN}`, "ascii");
  const digest = gecDigest(data);
  const value = `${gecCs64(data, digest).toString("hex").toUpperCase()}-${digest.toString("hex").toUpperCase()}`;
  gecCache = { ticks, value };
  return value;
}
const xml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

function edgeConnect() {
  const url = `${EDGE_URL}?TrustedClientToken=${EDGE_TOKEN}&ConnectionId=${edgeId()}&Sec-MS-GEC=${edgeGec()}&Sec-MS-GEC-Version=2-${EDGE_CHROME}`;
  const cookie = `muid=${crypto.randomBytes(16).toString("hex").toUpperCase()};`;
  const conn = { ws: null, busy: false, dead: false, open: false, usedAt: Date.now(), job: null, ready: null };
  conn.ready = new Promise((resolve, reject) => {
    let ws;
    try { ws = new WebSocket(url, { headers: { ...EDGE_HEADERS, Cookie: cookie } }); } catch (e) { return reject(e); }
    conn.ws = ws;
    ws.binaryType = "arraybuffer";
    const timer = setTimeout(() => { reject(new Error("connect timeout")); try { ws.close(); } catch { /* gone */ } }, EDGE_FIRST_MS);
    ws.onopen = () => {
      clearTimeout(timer);
      ws.send(`X-Timestamp:${edgeDate()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n`
        + '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},'
        + '"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n');
      resolve(conn);
    };
    ws.onerror = (e) => { clearTimeout(timer); reject(new Error("connection error " + (e?.message || ""))); };
    ws.onclose = (e) => {
      clearTimeout(timer);
      conn.dead = true;
      edge.pool = edge.pool.filter((c) => c !== conn);
      conn.job?.fail(new Error(`connection closed (${e?.code || "?"})`));
      reject(new Error("closed"));
    };
    ws.onmessage = (m) => conn.job?.onMessage(m);
  });
  conn.ready.catch(() => { conn.dead = true; edge.pool = edge.pool.filter((c) => c !== conn); });
  edge.pool.push(conn);
  return conn;
}

function edgeClose(conn) {
  conn.dead = true;
  edge.pool = edge.pool.filter((c) => c !== conn);
  try { conn.ws?.close(); } catch { /* gone */ }
}

// A spare connection opened in advance (handshake already done), else a new one. Each connection says one sentence.
async function edgeTake() {
  for (const c of edge.pool) if (!c.busy && !c.dead && Date.now() - c.usedAt > EDGE_SPARE_MS) edgeClose(c);
  let conn = edge.pool.find((c) => !c.busy && !c.dead && c.open);
  if (!conn) conn = edgeConnect();
  conn.busy = true;
  edgeWarm();
  await conn.ready;
  return conn;
}

// Keeps EDGE_SPARE connections open, so a sentence does not pay for the handshake (~0.5 s).
function edgeWarm() {
  if (!edgeUp()) return;
  const spare = edge.pool.filter((c) => !c.busy && !c.dead).length;
  for (let i = spare; i < EDGE_SPARE; i++) {
    const c = edgeConnect();
    c.ready.then(() => { c.open = true; }, (e) => debug("natural voice warm-up failed:", e.message));
  }
}

// One try on one connection. -> { promise: { mp3, words }, cancel(), audio: boolean (some audio arrived) }
function edgeTry(text, short, rate) {
  const job = { conn: null, cancelled: false, audio: false };
  job.cancel = () => { job.cancelled = true; if (job.conn) edgeClose(job.conn); };
  job.promise = (async () => {
    const conn = await edgeTake();
    job.conn = conn;
    if (job.cancelled) { edgeClose(conn); throw new Error("cancelled"); }
    const pct = Math.round((Math.pow(rate, 0.8) - 1) * 100);
    const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${short.slice(0, 5)}'>`
      + `<voice name='${short}'><prosody pitch='+0Hz' rate='${pct >= 0 ? "+" : ""}${pct}%' volume='+0%'>${xml(speakable(text))}</prosody></voice></speak>`;
    const chunks = [], words = [];
    let cursor = 0, speechEnd = 0;
    try {
      await new Promise((resolve, reject) => {
        const first = setTimeout(() => { if (!job.audio) fail(new Error("no audio in time")); }, EDGE_FIRST_MS);
        const total = setTimeout(() => fail(new Error("too slow")), EDGE_TOTAL_MS);
        const done = () => { clearTimeout(first); clearTimeout(total); conn.job = null; };
        const fail = (err) => { done(); reject(err); };
        conn.job = {
          fail,
          onMessage(m) {
            if (typeof m.data === "string") {
              const cut = m.data.indexOf("\r\n\r\n");
              const head = m.data.slice(0, cut);
              if (head.includes("Path:audio.metadata")) {
                let meta = [];
                try { meta = JSON.parse(m.data.slice(cut + 4)).Metadata || []; } catch { /* skip */ }
                for (const x of meta) {
                  if (x.Type !== "WordBoundary") continue;
                  speechEnd = Math.max(speechEnd, (x.Data.Offset + (x.Data.Duration || 0)) / 1e7);
                  const w = String(x.Data?.text?.Text || "");
                  const at = w ? text.indexOf(w, cursor) : -1;
                  if (at < 0) continue;
                  words.push({ start: at, len: w.length, t: Math.round((x.Data.Offset / 1e7) * 1000) / 1000 });
                  cursor = at + w.length;
                }
              } else if (head.includes("Path:turn.end")) {
                done();
                resolve();
              }
              return;
            }
            const b = Buffer.from(m.data);
            if (b.length < 2) return;
            const data = b.subarray(2 + b.readUInt16BE(0));
            if (data.length) { job.audio = true; chunks.push(data); }
          },
        };
        conn.ws.send(`X-RequestId:${edgeId()}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${edgeDate()}Z\r\nPath:ssml\r\n\r\n${ssml}`);
      });
    } finally {
      edgeClose(conn); // one sentence per connection
    }
    let mp3 = Buffer.concat(chunks);
    if (!mp3.length) throw new Error("empty audio");
    // Sentences play one after the other: drop the long silence at the end, keep a short breath.
    if (speechEnd > 0) {
      const keep = Math.ceil(((speechEnd + EDGE_TAIL_S) * MP3_BYTES_PER_S) / MP3_FRAME) * MP3_FRAME;
      if (keep < mp3.length) mp3 = mp3.subarray(0, keep);
    }
    return { mp3, words };
  })();
  return job;
}

// -> { mp3: Buffer, words: [{ start, len, t }] }. Tries again in parallel while no audio arrives; the first answer wins.
function edgeSynth(text, short, rate) {
  return new Promise((resolve, reject) => {
    const jobs = [];
    let settled = false, failed = 0, timer = null, lastErr = null;
    const finish = (fn) => { settled = true; clearTimeout(timer); fn(); };
    const start = () => {
      if (settled || jobs.length >= EDGE_TRIES) return;
      const job = edgeTry(text, short, rate);
      jobs.push(job);
      job.promise.then(
        (out) => { if (!settled) finish(() => { for (const j of jobs) if (j !== job) j.cancel(); resolve(out); }); },
        (err) => {
          if (settled) return;
          lastErr = err;
          if (++failed >= EDGE_TRIES) finish(() => reject(lastErr));
          else if (!jobs.some((j) => j.audio)) start(); // failed fast: try again now
        });
      clearTimeout(timer);
      timer = setTimeout(function hedge() {
        if (settled) return;
        if (!jobs.some((j) => j.audio)) start();
        else timer = setTimeout(hedge, EDGE_HEDGE_MS);
      }, EDGE_HEDGE_MS);
    };
    start();
  });
}

// ---------- ElevenLabs (the most human voices; pay as you go, about $0.04 per 1,000 characters) ----------
// Used when ELEVENLABS_API_KEY is set (Settings › API key). Each sentence is one request with exact word timings;
// the sentence before it is sent too, so the tone and the loudness carry on from one sentence to the next.
// If ElevenLabs says no, the free Microsoft voice of the same accent and gender says that sentence.
const ELEVEN_API = "https://api.elevenlabs.io/v1";
const ELEVEN_MODEL = "eleven_v4_turbo";      // ~0.1 s, second best voice model in blind tests (Oct 2026)
const ELEVEN_FORMAT = "mp3_24000_48";        // same bitrate as the Microsoft voices: the trimming below works for both
const ELEVEN_TIMEOUT_MS = 8000;
const ELEVEN_PARALLEL = 3;                   // requests at once (an account allows only a few); the others wait their turn
const ELEVEN_SETTINGS = { stability: 0.45, similarity_boost: 0.8, style: 0, use_speaker_boost: true }; // a little lower = more emotion
// The face's emotion becomes an audio tag at the start of the reply (Eleven v4 Turbo performs it: a real laugh, a warm tone).
// Only ElevenLabs gets it: the subtitles and the free stand-in voice never see the tag.
const ELEVEN_MOOD = { laugh: "[laughs]", happy: "[cheerfully]", surprised: "[surprised]", empathetic: "[warmly]", encouraging: "[warmly]", curious: "[curious]", thinking: "[thoughtfully]" };
// ElevenLabs' ready-made voices, best first. Emma: British woman; Jake: American man.
const ELEVEN_PICKS = {
  emma: [["Alice", "Xb7hH8MSUJpSbSDYk0k2"], ["Lily", "pFZP5JQG7iQjIQuC4Bku"]],
  jake: [["Chris", "iP95p4xoKVk53GoZ742B"], ["Eric", "cjVigY5qzO86Huf0OWal"], ["Brian", "nPczCjzI2devNBz1zQrb"]],
};
const ELEVEN_PICK_VOICE = { emma: { lang: "en-GB", gender: "female" }, jake: { lang: "en-US", gender: "male" } };
const ELEVEN_DEFAULT_TUTOR = "emma";
const ELEVEN_LANG = "en";
const ELEVEN_WARM_TEXT = "Hi.";
const ELEVEN_ACCENT = { british: "en-GB", american: "en-US", australian: "en-AU", irish: "en-IE", scottish: "en-GB" };
const eleven = { failUntil: 0, fails: 0, busy: 0, queue: [], voices: { at: 0, list: null } };
const elevenKey = () => String(process.env.ELEVENLABS_API_KEY || "").trim();
const elevenUp = () => Boolean(elevenKey()) && Date.now() >= eleven.failUntil;
const isEleven = (id) => String(id).startsWith("eleven:");
export const elevenReady = () => Boolean(elevenKey());

// The tutors' picks first, then the account's own voices (read once every 10 minutes).
const elevenPicks = () => Object.entries(ELEVEN_PICKS).flatMap(([tutor, picks]) => picks.map(([name, id]) => ({ id: "eleven:" + id, name, quality: "eleven", ...ELEVEN_PICK_VOICE[tutor] })));
async function elevenVoices() {
  if (!elevenKey()) return [];
  if (eleven.voices.list && Date.now() - eleven.voices.at < 600_000) return eleven.voices.list;
  let list = null;
  try {
    const res = await fetch(`${ELEVEN_API}/voices`, { headers: { "xi-api-key": elevenKey() }, signal: AbortSignal.timeout(6000) });
    if (res.ok) {
      list = ((await res.json()).voices || []).map((v) => ({
        id: "eleven:" + v.voice_id,
        name: v.name,
        lang: ELEVEN_ACCENT[String(v.labels?.accent || "").toLowerCase()] || "en",
        quality: "eleven",
        gender: v.labels?.gender === "male" || v.labels?.gender === "female" ? v.labels.gender : "unspecified",
      })).sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
    }
  } catch { /* offline: keep the ready-made voices below */ }
  const picks = elevenPicks();
  if (!list) return picks; // offline: the picks only, asked again next time
  const all = [...picks, ...list.filter((v) => !picks.some((p) => p.id === v.id))];
  eleven.voices = { at: Date.now(), list: all };
  return all;
}

async function elevenDefault(tutor) {
  return "eleven:" + ELEVEN_PICKS[ELEVEN_PICKS[tutor] ? tutor : ELEVEN_DEFAULT_TUTOR][0][1];
}

// A voice's first sentence can take 10 s (ElevenLabs loads it); the next ones about 0.5 s.
// So the tutor's voice says one short word in the background when the app opens and when a call starts.
const elevenWarmAt = new Map();
export function warmVoice(id) {
  if (!isEleven(id) || !elevenUp() || Date.now() - (elevenWarmAt.get(id) || 0) < 20 * 60_000) return;
  elevenWarmAt.set(id, Date.now());
  elevenSynth(ELEVEN_WARM_TEXT, id.slice(7), 1).then(
    () => debug("ElevenLabs voice warmed up:", id),
    (err) => { elevenWarmAt.delete(id); debug("ElevenLabs warm-up failed:", err.message); });
}

// A few requests at a time: the first sentence of a reply goes first, the others wait.
async function elevenSlot(fn) {
  if (eleven.busy >= ELEVEN_PARALLEL) await new Promise((resolve) => eleven.queue.push(resolve));
  eleven.busy++;
  try { return await fn(); } finally { eleven.busy--; eleven.queue.shift()?.(); }
}

// -> { mp3: Buffer, words: [{ start, len, t }] }
async function elevenSynth(text, voiceId, rate, prev = "", mood = "") {
  const say = speakable(text);
  const tag = ELEVEN_MOOD[mood] || "";
  const body = JSON.stringify({
    text: tag ? `${tag} ${say}` : say,
    model_id: ELEVEN_MODEL,
    language_code: ELEVEN_LANG,
    voice_settings: { ...ELEVEN_SETTINGS, speed: Math.max(0.7, Math.min(1.2, rate)) },
    ...(prev ? { previous_text: speakable(prev).slice(-600) } : {}),
  });
  const ask = () => fetch(`${ELEVEN_API}/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps?output_format=${ELEVEN_FORMAT}`, {
    method: "POST", headers: { "xi-api-key": elevenKey(), "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(ELEVEN_TIMEOUT_MS),
  });
  let res;
  // "Too many requests at once" (429): wait a moment and ask again, rather than change voice.
  for (let i = 0; i < 3; i++) {
    res = await elevenSlot(ask);
    if (res.status !== 429) break;
    await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  if (!res.ok) {
    let detail = "";
    try { detail = JSON.stringify((await res.json()).detail || "").slice(0, 200); } catch { /* no body */ }
    const err = new Error(`ElevenLabs answered ${res.status} ${detail}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  let mp3 = Buffer.from(String(data.audio_base64 || ""), "base64");
  if (!mp3.length) throw new Error("empty audio");
  // Word timings from the character timings, and the end of speech (to drop the silence after it).
  const a = data.alignment;
  const words = [];
  let chars = [];
  let speechEnd = 0;
  const at = a && Array.isArray(a.characters) ? a.characters.join("").lastIndexOf(say) : -1; // after the tag, if any
  if (at >= 0) {
    chars = Array.from(say, (_, i) => Math.round((a.character_start_times_seconds[at + i] || 0) * 1000)); // for the avatar's mouth
    for (const m of say.matchAll(/\S+/g)) {
      words.push({ start: m.index, len: m[0].length, t: Math.round((a.character_start_times_seconds[at + m.index] || 0) * 1000) / 1000 });
      speechEnd = Math.max(speechEnd, a.character_end_times_seconds[at + m.index + m[0].length - 1] || 0);
    }
  }
  if (speechEnd > 0) {
    const keep = Math.ceil(((speechEnd + EDGE_TAIL_S) * MP3_BYTES_PER_S) / MP3_FRAME) * MP3_FRAME;
    if (keep < mp3.length) mp3 = mp3.subarray(0, keep);
  }
  return { mp3, words, chars };
}

// Checks a key before it is saved. -> "ok" | "bad_key" | "no_tts" | "offline"
export async function checkElevenKey(key) {
  const head = { "xi-api-key": key };
  try {
    const res = await fetch(`${ELEVEN_API}/voices`, { headers: head, signal: AbortSignal.timeout(8000) });
    if (res.ok) return "ok";
    const detail = await res.json().catch(() => ({}));
    if (detail?.detail?.status === "invalid_api_key") return "bad_key";
    // A key without the right to list voices: try one tiny sentence instead.
    const tts = await fetch(`${ELEVEN_API}/text-to-speech/${ELEVEN_PICKS[ELEVEN_DEFAULT_TUTOR][0][1]}?output_format=${ELEVEN_FORMAT}`, {
      method: "POST", headers: { ...head, "Content-Type": "application/json" }, body: JSON.stringify({ text: "Hi.", model_id: ELEVEN_MODEL }), signal: AbortSignal.timeout(8000),
    });
    return tts.ok ? "ok" : tts.status === 401 ? "no_tts" : "bad_key";
  } catch {
    return "offline";
  }
}
// After a new key: read its voices again.
export function elevenReset() { eleven.voices = { at: 0, list: null }; eleven.failUntil = 0; eleven.fails = 0; }

// ---------- Voices ----------
let voiceCache = { at: 0, list: null };
let voiceLoading = null;

async function rawVoices() {
  if (voiceCache.list && Date.now() - voiceCache.at < VOICES_TTL_MS) return voiceCache.list;
  if (voiceLoading) return voiceLoading;
  voiceLoading = (async () => {
    let list = null;
    if (await nativeUsable()) {
      const fresh = voiceCache.list && Date.now() - voiceCache.at < VOICES_TTL_MS; // set by startHelper
      list = fresh ? voiceCache.list : await askVoices(5000).catch(() => null);
    }
    if (!list) list = await jxaVoices().catch(() => null);
    if (!list) list = await sayVoices().catch(() => null);
    if (list?.length) voiceCache = { at: Date.now(), list };
    return list || voiceCache.list || [];
  })().finally(() => { voiceLoading = null; });
  return voiceLoading;
}

// Same list as the helper, without compiling anything (AVFoundation through JavaScript for Automation).
function jxaVoices() {
  const script = `ObjC.import("AVFoundation"); var v = $.AVSpeechSynthesisVoice.speechVoices, r = [];
for (var i = 0; i < v.count; i++) { var x = v.objectAtIndex(i);
  r.push({ id: x.identifier.js, name: x.name.js, lang: x.language.js,
    quality: ["", "default", "enhanced", "premium"][x.quality] || "default",
    gender: ["unspecified", "male", "female"][x.gender] || "unspecified" }); }
JSON.stringify(r);`;
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-l", "JavaScript", "-e", script], { timeout: 10_000, maxBuffer: 4_000_000 }, (err, out) => {
      if (err) return reject(err);
      try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
    });
  });
}

function sayVoices() {
  return new Promise((resolve, reject) => {
    execFile("say", ["-v", "?"], { timeout: 10_000, maxBuffer: 4_000_000 }, (err, out) => {
      if (err) return reject(err);
      resolve(out.split("\n").map((line) => {
        const m = line.match(/^(.+?)\s+([a-z]{2,3}_[A-Z0-9]{2,4})\s+#/);
        if (!m) return null;
        const name = m[1].trim();
        return { id: name, name, lang: m[2].replace("_", "-"), quality: /premium/i.test(name) ? "premium" : /enhanced/i.test(name) ? "enhanced" : "default", gender: "unspecified" };
      }).filter(Boolean));
    });
  });
}

const fold = (s) => String(s).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
const baseName = (name) => fold(name).replace(/\s*\(.*$/, "");
const isEloquence = (v) => /eloquence/i.test(v.id) || /^(eddy|flo|reed)$/.test(baseName(v.name));

const naturalVoices = () => (EDGE_OFF ? [] : EDGE_VOICES.map(({ short, ...v }) => ({ ...v })));

export async function voices() {
  return [...(await elevenVoices()), ...naturalVoices(), ...(await macVoices())];
}

async function macVoices() {
  const list = (await rawVoices())
    .filter((v) => typeof v?.id === "string" && /^en-(GB|US)$/.test(String(v.lang)) && !NOVELTY.test(v.name))
    .map((v) => ({
      id: v.id, name: v.name, lang: v.lang, quality: QUALITY[v.quality] ? v.quality : "default",
      gender: v.gender === "male" || v.gender === "female" ? v.gender : GENDER[baseName(v.name)] || "unspecified",
    }));
  return list.sort((a, b) => QUALITY[b.quality] - QUALITY[a.quality]
    || isEloquence(a) - isEloquence(b) || a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
}

export async function defaultVoice(tutor) {
  if (elevenKey()) { const id = await elevenDefault(tutor); if (id) return id; }
  if (!EDGE_OFF) return tutor === "jake" ? "edge:en-US-AndrewNeural" : "edge:en-GB-SoniaNeural";
  return macDefault(tutor);
}

// The best Mac voice for a tutor (also says the sentence when the natural voice cannot).
async function macDefault(tutor) {
  const list = await macVoices();
  if (!list.length) return null;
  const pick = (...tiers) => {
    for (const ok of tiers) {
      const v = list.find(ok); // list is sorted best quality first
      if (v) return v.id;
    }
    return null;
  };
  if (tutor === "jake") {
    const named = (v, names) => names.includes(baseName(v.name));
    const best = ["evan", "nathan", "tom", "aaron"];
    return pick(
      (v) => named(v, best) && v.quality !== "default" && v.lang === "en-US",
      (v) => named(v, best) && v.lang === "en-US",
      (v) => v.gender === "male" && v.quality !== "default" && v.lang === "en-US",
      (v) => named(v, ["eddy"]) && v.lang === "en-US",
      (v) => named(v, ["reed"]) && v.lang === "en-US",
      (v) => v.gender === "male" && v.lang === "en-US",
      (v) => v.gender === "male",
      (v) => v.lang === "en-US",
      () => true,
    );
  }
  const named = (n) => (v) => v.lang === "en-GB" && baseName(v.name) === n;
  const q = (quality, test) => (v) => v.quality === quality && test(v);
  const female = (v) => v.lang === "en-GB" && v.gender === "female" && !isEloquence(v);
  const tiers = [];
  for (const quality of ["premium", "enhanced", "default"]) tiers.push(q(quality, named("serena")), q(quality, named("kate")), q(quality, named("stephanie")), q(quality, female));
  return pick(...tiers,
    (v) => v.lang === "en-GB" && v.gender === "female",
    (v) => v.gender === "female" && !isEloquence(v),
    (v) => v.gender === "female",
    (v) => v.lang === "en-GB",
    () => true,
  );
}

// Accepts an id from voices(), or an old-style name: "Serena", "Serena (Premium)", "Eddy (English (US))".
async function resolveVoice(input) {
  const s = String(input ?? "").trim();
  const list = s ? await voices() : [];
  let v = list.find((x) => x.id === s) || list.find((x) => fold(x.name) === fold(s));
  if (!v) {
    const m = s.match(/^(.+?)\s*\((.+)\)$/);
    if (m) {
      const name = fold(m[1]);
      const inner = m[2].trim();
      const region = inner.match(/^.+?\((.+)\)$/)?.[1];
      const quality = /^(enhanced|premium)$/i.test(inner) ? inner.toLowerCase() : null;
      const regionOf = (lang) => { try { return new Intl.DisplayNames(["en"], { type: "region" }).of(lang.split("-")[1]); } catch { return ""; } };
      v = list.find((x) => baseName(x.name) === name
        && (!quality || x.quality === quality)
        && (!region || fold(regionOf(x.lang)) === fold(region)));
    }
  }
  // An ElevenLabs voice missing from the list (list not readable now): still try it.
  if (!v && isEleven(s) && elevenKey()) v = { id: s, name: "ElevenLabs", lang: "en", quality: "eleven", gender: "unspecified" };
  if (!v) {
    const err = new Error("Unknown voice.");
    err.code = "bad_voice";
    err.status = 400;
    throw err;
  }
  return v;
}

// ---------- Synthesis ----------
const results = new Map(); // key -> { file, duration, words, engine } (oldest first)
const inflight = new Map();
let seq = 0;

function wavDuration(file) {
  const b = fs.readFileSync(file);
  let off = 12, rate = 0, blockAlign = 2;
  while (off + 8 <= b.length) {
    const id = b.toString("ascii", off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === "fmt ") { rate = b.readUInt32LE(off + 12); blockAlign = b.readUInt16LE(off + 20) || 2; }
    if (id === "data") return rate ? Math.min(size, b.length - off - 8) / blockAlign / rate : 0;
    off += 8 + size + (size & 1);
  }
  return 0;
}

function sayMake(text, voice, rate, file) {
  const wpm = Math.round(Math.max(92, Math.min(240, rate * 185)));
  const tmp = `${file}.${process.pid}.${seq++}.say.wav`;
  return new Promise((resolve, reject) => {
    const p = spawn("say", ["-v", voice.id, "-r", String(wpm), "-o", tmp, "--data-format=LEI16@24000"]);
    const timer = setTimeout(() => p.kill("SIGKILL"), 30_000);
    p.on("error", (e) => { clearTimeout(timer); reject(e); });
    p.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`say exited ${code}`)); });
    p.stdin.on("error", () => {});
    p.stdin.end(speakable(text));
  }).then(async () => {
    await fsp.rename(tmp, file);
    return { file, duration: Math.round(wavDuration(file) * 1000) / 1000, words: [], engine: "say" };
  }, async (err) => { await fsp.rm(tmp, { force: true }); throw err; });
}

// The free Microsoft voice closest to an ElevenLabs voice (same accent and gender).
function elevenStandIn(voice) {
  if (EDGE_OFF) return null;
  const gb = voice.lang === "en-GB";
  if (voice.gender === "female") return gb ? "edge:en-GB-SoniaNeural" : "edge:en-US-AvaNeural";
  return gb ? "edge:en-GB-RyanNeural" : "edge:en-US-AndrewNeural";
}

async function make(key, text, voice, rate, prev, mood) {
  await fsp.mkdir(DIR, { recursive: true });
  let standIn = false;
  if (isEleven(voice.id)) {
    if (elevenUp()) {
      try {
        const t0 = Date.now();
        const { mp3, words, chars } = await elevenSynth(text, voice.id.slice(7), rate, prev, mood);
        const file = path.join(DIR, key + ".mp3");
        await fsp.writeFile(file, mp3);
        eleven.fails = 0;
        debug(`ElevenLabs voice: ${Date.now() - t0} ms for ${text.length} chars`);
        return keep(key, { file, duration: Math.round((mp3.length / MP3_BYTES_PER_S) * 1000) / 1000, words, chars, engine: "eleven" });
      } catch (err) {
        // A refused key or no more credit: stop asking for a minute. Three failures in a row: the same.
        if ([401, 402, 403].includes(err.status) || ++eleven.fails >= 3) { eleven.failUntil = Date.now() + 60_000; eleven.fails = 0; }
        log("ElevenLabs voice failed, the free voice says this sentence:", err.message);
      }
    }
    const id = elevenStandIn(voice);
    voice = await resolveVoice(id || (await macDefault(voice.gender === "male" ? "jake" : "emma")));
    standIn = true;
  }
  if (!isEdge(voice.id)) return keep(key, { ...(await macMake(key, text, voice, rate)), ...(standIn ? { engine: "fallback" } : {}) });
  const short = EDGE_VOICES.find((v) => v.id === voice.id)?.short;
  if (short && edgeUp()) {
    try {
      const t0 = Date.now();
      const { mp3, words } = await edgeSynth(text, short, rate);
      const file = path.join(DIR, key + ".mp3");
      await fsp.writeFile(file, mp3);
      edge.fails = 0;
      debug(`natural voice: ${Date.now() - t0} ms for ${text.length} chars`);
      return keep(key, { file, duration: Math.round((mp3.length / MP3_BYTES_PER_S) * 1000) / 1000, words, engine: standIn ? "fallback" : "edge" });
    } catch (err) {
      // Every try failed, twice in a row: the service is down or blocked. Use the Mac voices for a minute, then try again.
      if (++edge.fails >= 2) { edge.failUntil = Date.now() + 60_000; edge.fails = 0; }
      log("natural voice failed, using a Mac voice:", err.message);
    }
  }
  // A Mac voice says this sentence; the natural voice is tried again for it later (engine "fallback").
  const mac = await resolveVoice(await macDefault(voice.gender === "male" ? "jake" : "emma"));
  return keep(key, { ...(await macMake(key, text, mac, rate)), engine: "fallback" });
}

async function macMake(key, text, voice, rate) {
  const file = path.join(DIR, key + ".wav");
  let res = null;
  if (await nativeUsable()) {
    const tmp = `${file}.${process.pid}.${seq++}.tmp.wav`;
    try {
      const msg = await nativeSynth(text, voice.id, avRate(voice.id, rate), tmp);
      if (!msg.ok) throw new Error(msg.error || "native engine failed");
      await fsp.rename(tmp, file);
      const sr = msg.sampleRate;
      res = {
        file, duration: Math.round((msg.samples / sr) * 1000) / 1000, engine: "native",
        words: (msg.words || []).map((w) => ({ start: w.start, len: w.len, t: Math.round((w.sample / sr) * 1000) / 1000 })),
      };
    } catch (err) {
      log("native synth failed, using `say`:", err.message);
      fsp.rm(tmp, { force: true }).catch(() => {});
    }
  }
  // `say` files get their own name: a later native redo must not overwrite a file being served.
  return res || sayMake(text, voice, rate, path.join(DIR, key + ".say.wav"));
}

// Remembers a result (the cache keeps MAX_FILES files, oldest out first).
function keep(key, res) {
  const old = results.get(key);
  if (old && old.file !== res.file) setTimeout(() => fsp.rm(old.file, { force: true }).catch(() => {}), 600_000).unref();
  results.delete(key);
  results.set(key, res);
  for (const [k, old] of results) {
    if (results.size <= MAX_FILES) break;
    results.delete(k);
    fsp.rm(old.file, { force: true }).catch(() => {});
  }
  return res;
}

const copy = (r) => ({ file: r.file, duration: r.duration, words: r.words.map((w) => ({ ...w })), chars: r.chars || [] });

// prev: the sentence said just before (ElevenLabs keeps the same tone and loudness with it).
// mood: the face's emotion, for the first sentence of a reply (ElevenLabs only).
export async function synthesize({ text, voice, rate, prev = "", mood = "" } = {}) {
  text = typeof text === "string" ? text : String(text ?? "");
  if (!text.trim()) {
    const err = new Error("No text.");
    err.code = "bad_text";
    err.status = 400;
    throw err;
  }
  launch(); // starts (or compiles) the native engine in the background on first use
  const v = await resolveVoice(voice);
  const r = clampRate(rate);
  const before = isEleven(v.id) ? String(prev || "").trim() : "";
  const feel = isEleven(v.id) && ELEVEN_MOOD[mood] ? mood : "";
  const key = crypto.createHash("sha1").update(`${v.id}|${r}|${before}|${feel}|${text}`).digest("hex");
  const hit = results.get(key);
  // A `say` result (no word timings) is redone once the native engine is up,
  // a Mac voice standing in for a natural one once the natural voices answer again.
  const redo = hit?.engine === "fallback" ? edgeUp() || (isEleven(v.id) && elevenUp()) : hit?.engine === "say" && native.state === "ready";
  if (hit && !redo && fs.existsSync(hit.file)) {
    results.delete(key);
    results.set(key, hit);
    return copy(hit);
  }
  if (!inflight.has(key)) inflight.set(key, make(key, text, v, r, before, feel).finally(() => inflight.delete(key)));
  return copy(await inflight.get(key));
}

// =====================================================================
// Streamed voice (2026-10-29): a reply sentence starts playing from ElevenLabs' first sound (about 0.2 s)
// instead of waiting for the whole sentence (0.75 to 1.1 s). `live` gets raw 24 kHz PCM pieces as they come
// (live.pieces, live.notify()), then the word timings and the end of speech. The finished sentence is kept
// as a WAV file, so a replay is the normal cached file. Not ElevenLabs, ElevenLabs down, or already made:
// live.fallback = true and the normal path answers (a cached sentence is instant anyway).
// =====================================================================
const PCM_RATE = 24000;
export function newLive() {
  const subs = new Set();
  return { pieces: [], chars: [], words: null, end: 0, done: false, error: false, fallback: false, subs, notify() { for (const f of subs) f(); } };
}
export async function synthesizeLive(live, { text, voice, rate, prev = "", mood = "" } = {}) {
  const fallback = () => { live.fallback = true; live.done = true; live.notify(); return synthesize({ text, voice, rate, prev, mood }); };
  text = String(text ?? "");
  if (!text.trim()) return fallback();
  let v;
  try { v = await resolveVoice(voice); } catch { return fallback(); }
  if (!isEleven(v.id) || !elevenUp()) return fallback();
  const r = clampRate(rate);
  const before = String(prev || "").trim();
  const feel = ELEVEN_MOOD[mood] ? mood : "";
  const key = crypto.createHash("sha1").update(`${v.id}|${r}|${before}|${feel}|${text}`).digest("hex");
  const hit = results.get(key);
  if ((hit && hit.engine === "eleven" && fs.existsSync(hit.file)) || inflight.has(key)) return fallback();
  const job = (async () => {
    try {
      const t0 = Date.now();
      const { pcm, words, speechEnd } = await elevenStream(text, v.id.slice(7), r, before, feel, live);
      await fsp.mkdir(DIR, { recursive: true });
      // Keep the speech and a short silence after it (ElevenLabs adds more), like the whole-sentence path.
      const keepBytes = speechEnd > 0 ? Math.min(pcm.length, Math.ceil((speechEnd + EDGE_TAIL_S) * PCM_RATE) * 2) : pcm.length;
      const file = path.join(DIR, key + ".wav");
      await fsp.writeFile(file, wav(pcm.subarray(0, keepBytes), PCM_RATE));
      eleven.fails = 0;
      debug(`ElevenLabs live voice: first sound after ${live.firstMs} ms, all ${Date.now() - t0} ms for ${text.length} chars`);
      live.words = words;
      live.end = keepBytes / 2 / PCM_RATE;
      live.done = true;
      live.notify();
      return keep(key, { file, duration: live.end, words, chars: live.chars, engine: "eleven" });
    } catch (err) {
      if ([401, 402, 403].includes(err.status) || ++eleven.fails >= 3) { eleven.failUntil = Date.now() + 60_000; eleven.fails = 0; }
      log("ElevenLabs live voice failed:", err.message);
      // Nothing played yet: the page takes the normal path (the free voice stands in if ElevenLabs is down).
      if (!live.pieces.length) { inflight.delete(key); return copy(await fallback()); }
      live.error = true;
      live.done = true;
      live.notify();
      throw err;
    }
  })();
  inflight.set(key, job.finally(() => inflight.delete(key)));
  return copy(await job);
}

async function elevenStream(text, voiceId, rate, prev, mood, live) {
  const say = speakable(text);
  const tag = ELEVEN_MOOD[mood] || "";
  const body = JSON.stringify({
    text: tag ? `${tag} ${say}` : say,
    model_id: ELEVEN_MODEL,
    language_code: ELEVEN_LANG,
    voice_settings: { ...ELEVEN_SETTINGS, speed: Math.max(0.7, Math.min(1.2, rate)) },
    ...(prev ? { previous_text: speakable(prev).slice(-600) } : {}),
  });
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ELEVEN_TIMEOUT_MS);
  const ask = () => fetch(`${ELEVEN_API}/text-to-speech/${encodeURIComponent(voiceId)}/stream/with-timestamps?output_format=pcm_${PCM_RATE}`, {
    method: "POST", headers: { "xi-api-key": elevenKey(), "Content-Type": "application/json" }, body, signal: ctrl.signal,
  });
  try {
    let res;
    for (let i = 0; i < 3; i++) {
      res = await elevenSlot(ask);
      if (res.status !== 429) break;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
    if (!res.ok) {
      let detail = "";
      try { detail = JSON.stringify((await res.json()).detail || "").slice(0, 200); } catch { /* no body */ }
      const err = new Error(`ElevenLabs answered ${res.status} ${detail}`);
      err.status = res.status;
      throw err;
    }
    const chars = [], starts = [], ends = [], all = [];
    let odd = null, buf = "";
    const line = (l) => {
      if (!l.trim()) return;
      const d = JSON.parse(l);
      const a = d.alignment;
      if (a && Array.isArray(a.characters)) {
        chars.push(...a.characters); starts.push(...a.character_start_times_seconds); ends.push(...a.character_end_times_seconds);
        // The time of each letter, as soon as it arrives (after the tag, if any): the avatar's mouth follows the real voice.
        if (!tag || chars.length > tag.length) {
          const from = tag && chars.slice(0, tag.length).join("") === tag ? tag.length + 1 : 0;
          for (let k = from + live.chars.length; k < starts.length; k++) live.chars.push(Math.round(starts[k] * 1000));
        }
      }
      let pcm = Buffer.from(String(d.audio_base64 || ""), "base64");
      if (odd) { pcm = Buffer.concat([odd, pcm]); odd = null; }
      if (pcm.length % 2) { odd = pcm.subarray(pcm.length - 1); pcm = pcm.subarray(0, pcm.length - 1); }
      if (pcm.length) {
        if (!live.pieces.length) live.firstMs = Date.now() - t0;
        all.push(pcm);
        live.pieces.push(pcm);
        live.notify();
      }
    };
    const dec = new TextDecoder();
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1); }
    }
    line(buf);
    const pcm = Buffer.concat(all);
    if (!pcm.length) throw new Error("empty audio");
    // Word timings from the character timings (after the tag, if any), like elevenSynth.
    const words = [];
    let speechEnd = 0;
    const at = chars.join("").lastIndexOf(say);
    if (at >= 0) {
      for (const m of say.matchAll(/\S+/g)) {
        words.push({ start: m.index, len: m[0].length, t: Math.round((starts[at + m.index] || 0) * 1000) / 1000 });
        speechEnd = Math.max(speechEnd, ends[at + m.index + m[0].length - 1] || 0);
      }
    }
    return { pcm, words, speechEnd };
  } finally {
    clearTimeout(timer);
  }
}

// 16-bit mono PCM -> a WAV file.
function wav(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

async function warmVoices() {
  if (native.warm !== "no" || native.state !== "ready") return;
  native.warm = "warming";
  try {
    const ids = [...new Set([await macDefault("emma"), await macDefault("jake")])].filter(Boolean);
    await fsp.mkdir(DIR, { recursive: true });
    for (const id of ids) {
      const out = path.join(DIR, `warm-${process.pid}-${seq++}.wav`);
      const msg = await nativeSynth("Hello.", id, 0.51, out).catch((e) => ({ ok: false, error: e.message }));
      fsp.rm(out, { force: true }).catch(() => {});
      if (!msg.ok) debug("warm-up failed for", id, msg.error);
    }
    debug("voices warmed up:", ids.join(", "));
  } catch (err) {
    debug("warm-up failed:", err.message);
  }
  if (native.warm === "warming") native.warm = "done";
}

export function warm() {
  if (elevenKey()) elevenVoices().catch(() => {});
  else edgeWarm();
  if (NATIVE_OFF) return;
  native.wantWarm = true;
  if (native.state === "ready") warmVoices();
  else launch().catch(() => {});
}

export function status() {
  if (elevenUp()) return { engine: "eleven", ready: true };
  if (edgeUp()) return { engine: "natural", ready: true };
  const engine = native.state === "ready" ? "native" : "say";
  // ready = nothing is still compiling/starting/warming up.
  const ready = engine === "native" ? native.warm === "done" || !native.wantWarm : native.state === "off" || native.state === "failed";
  return { engine, ready };
}
