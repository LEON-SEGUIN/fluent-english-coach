// Fluent: my own English speaking coach (goal: really fluent in business English and in everyday life and relationships, with the right words and structures).
// Small local server: serves the app, saves progress in ./data, talks to Claude,
// makes the tutor's voice (natural online voices, Mac voices as the fallback), and can open a private link for the phone.
import http from "node:http";
import net from "node:net";
import fs from "node:fs/promises";
import { constants as FS, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFile } from "node:child_process";
import os from "node:os";
import crypto from "node:crypto";
// Speech-to-text: Whisper on Groq, when the learner adds a free Groq key.
import * as STT from "./stt.js";
import Anthropic from "@anthropic-ai/sdk";
import { headlines } from "./news.js";
// Daily shadowing (Practice): sentences to imitate, and the learner's recording written down word by word.
import { shadowRoutes, shadowScore } from "./shadowing.js";
import { LEVELS, SKILLS, SKILL_BY_ID, LEVEL_IDS, STATES, STARTER_LESSONS, IT_SKILLS, ACCENT_SKILLS, levelProgress, nextSkills, reviewSkills } from "./curriculum.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");
const DATA = process.env.FLUENT_DATA || path.join(ROOT, "data");
const ENV_FILE = process.env.FLUENT_ENV || path.join(ROOT, ".env");
const PORT = Number(process.env.PORT) || 4322;
const HOST = "127.0.0.1";

try { process.loadEnvFile(ENV_FILE); } catch { /* no .env yet: the app asks for a key */ }

// Fluent already running (a second double-click on start.command): say so and stop, before touching anything.
const alreadyRunning = await new Promise((resolve) => {
  const sock = net.connect({ host: "127.0.0.1", port: Number(process.env.PORT) || 4322 });
  sock.once("connect", () => { sock.destroy(); resolve(true); });
  sock.once("error", () => resolve(false));
  sock.setTimeout(800, () => { sock.destroy(); resolve(false); });
});
if (alreadyRunning) {
  console.log(`\n  Fluent is already running: http://localhost:${Number(process.env.PORT) || 4322}\n  You can close this window.\n`);
  process.exit(0);
}

// ---------- Voice engine (tts.js: natural online voices, Mac voices kept loaded as the fallback) ----------
let TTS = null;
try { TTS = await import("./tts.js"); TTS.warm?.(); } catch (err) { console.warn("  Fast voice engine not loaded, using the say command:", err.message); }

// ---------- Models ----------
// Each task uses the right brain: a fast one for live talk, a deep one for reviews and plans.
const TIERS = {
  fast: { chat: "claude-haiku-5-5", quick: "claude-haiku-5-5", deep: "claude-sonnet-5-5" },
  balanced: { chat: "claude-sonnet-5-5", quick: "claude-haiku-5-5", deep: "claude-opus-5-5" },
  max: { chat: "claude-opus-5-5", quick: "claude-sonnet-5-5", deep: "claude-opus-5-5" },
};
const DEFAULT_TIER = "balanced";
const FALLBACK_MODEL = "claude-haiku-5-5";
const isHaiku = (model) => model.startsWith("claude-haiku");

let client = null;
// No key yet: look in .env again, so a key pasted there works without a restart.
function hasKey() {
  if (!process.env.ANTHROPIC_API_KEY) {
    try {
      const key = String(parseEnv(readFileSync(ENV_FILE, "utf8")).ANTHROPIC_API_KEY || "").trim();
      if (key) process.env.ANTHROPIC_API_KEY = key;
    } catch { /* no .env yet */ }
  }
  return Boolean(process.env.ANTHROPIC_API_KEY);
}
function getClient() {
  if (!hasKey()) return null;
  if (!client) client = new Anthropic({ maxRetries: 1 });
  return client;
}

class AppError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

// Request options for one model. `live` = a spoken reply where speed matters most.
function modelParams(model, { live = false, effort = "low" } = {}) {
  if (model === "claude-haiku-4-5") return {};
  // Haiku 5.5: thinking is on by default; live talk turns it off (allowed at effort high or below) for speed.
  if (model === "claude-haiku-5-5") return live ? { thinking: { type: "disabled" }, effort: "low" } : { effort };
  if (model === "claude-sonnet-5-5") {
    // Live talk: no extended thinking and low effort. The first word comes faster and the replies stay short,
    // like a real call (measured: about 1.3 s to the first sentence, against 1.5 s with "medium").
    return live ? { thinking: { type: "between_tools" }, effort: "low" } : { effort };
  }
  return { effort }; // Opus 5.5: thinking is always on; effort sets its depth.
}

function buildParams({ model, system, messages, schema, effort, maxTokens, live }) {
  const mp = modelParams(model, { live, effort });
  const params = {
    model,
    max_tokens: maxTokens,
    system,
    messages,
    output_config: { format: { type: "json_schema", schema }, ...(mp.effort ? { effort: mp.effort } : {}) },
  };
  if (mp.thinking) params.thinking = mp.thinking;
  // Cache the growing conversation too (the system prompt has its own breakpoint).
  if (model !== "claude-haiku-4-5") params.cache_control = { type: "ephemeral" };
  return params;
}

function apiError(err) {
  if (err instanceof AppError) return err;
  if (err instanceof Anthropic.AuthenticationError) return new AppError(401, "bad_key", "Your API key does not work. Check it in Settings.");
  if (err instanceof Anthropic.PermissionDeniedError) return new AppError(403, "no_access", "Your API key cannot use this model. Pick another Brain in Settings.");
  if (err instanceof Anthropic.RateLimitError) return new AppError(429, "rate_limited", "Too many requests. Wait one minute and try again.");
  if (err instanceof Anthropic.BadRequestError) {
    if (/credit balance/i.test(err.message)) return new AppError(402, "no_credit", "Your Anthropic account has no credit. Add credit at console.anthropic.com.");
    return new AppError(400, "bad_request", err.message);
  }
  if (err instanceof Anthropic.APIConnectionError) return new AppError(503, "offline", "Cannot reach Claude. Check your internet connection.");
  if (err instanceof Anthropic.APIError) return new AppError(502, "api_error", `Claude error ${err.status ?? ""}. Try again.`);
  return err;
}
const retryable = (err) => err instanceof Anthropic.APIError && (err.status === 529 || err.status >= 500 || err instanceof Anthropic.APIConnectionError);

// One Claude call that must return JSON matching `schema`.
async function askJSON({ model, system, messages, schema, effort = "low", maxTokens = 8000 }) {
  const c = getClient();
  if (!c) throw new AppError(401, "no_key", "Add your Anthropic API key in Settings first.");
  const sys = typeof system === "string" ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }] : system;
  // Streaming + finalMessage(): no request timeout, even for long reviews.
  const run = async (m) => {
    const params = buildParams({ model: m, system: sys, messages, schema, effort, maxTokens });
    if (isHaiku(m)) return c.messages.stream(params).finalMessage(); // no server-side refusal fallback for Haiku
    try {
      return await c.beta.messages.stream({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }).finalMessage();
    } catch (err) {
      // If the fallback option is ever refused, ask once more without it.
      if (!(err instanceof Anthropic.BadRequestError) || !/fallback/i.test(err.message)) throw err;
      return c.messages.stream(params).finalMessage();
    }
  };
  let res;
  try {
    try { res = await run(model); } catch (err) {
      if (!retryable(err) || model === FALLBACK_MODEL) throw err;
      res = await run(FALLBACK_MODEL);
    }
  } catch (err) { throw apiError(err); }
  if (res.stop_reason === "refusal") throw new AppError(422, "refused", "The tutor could not answer that. Say it another way.");
  if (res.stop_reason === "max_tokens") throw new AppError(502, "too_long", "The answer was cut off. Try again.");
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  try { return JSON.parse(text); } catch { throw new AppError(502, "bad_json", "The tutor's answer was not readable. Try again."); }
}

// ---------- Schemas (strict: every field required, no extra fields) ----------
const obj = (properties) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const str = { type: "string" };
const bool = { type: "boolean" };
const strList = { type: "array", items: str };
const wordList = { type: "array", items: obj({ es: str, tr: str }) };
const fixList = { type: "array", items: obj({ you_said: str, better: str, why: str }) };
const EMOTIONS = ["neutral", "happy", "curious", "encouraging", "surprised", "empathetic", "laugh", "thinking"];

// Order matters: the face and the spoken reply come first, so the voice can start
// while the rest of the answer is still being written.
const TURN_SCHEMA = obj({
  emotion: { type: "string", enum: EMOTIONS },
  slow: bool,
  reply: str,
  translation: str,
  phase: { type: "string", enum: ["warmup", "learn", "practice", "free", "wrapup", "none"] },
  board: obj({ title: str, lines: strList }),
  help: obj({ kind: { type: "string", enum: ["none", "vocab", "rephrase", "explain"] }, explanation: str, practice: str }),
  correction: obj({ needed: bool, you_said: str, better: str, why: str }),
  pronunciation_note: str,
  goals_done: { type: "array", items: { type: "integer" } },
  words: wordList,
  end_call: bool,
});
const WORD_SCHEMA = obj({ tr: str, base: str, note: str, example: str });
const HINT_SCHEMA = obj({ suggestions: wordList });
const MEMORY_SCHEMA = obj({
  about: strList,
  interests: strList,
  strengths: strList,
  weak_points: strList,
  recurring_mistakes: { type: "array", items: obj({ pattern: str, example: str, fix: str }) },
  next_focus: str,
  last_session: str,
});
const REVIEW_SCHEMA = obj({
  score: { type: "integer" },
  summary: str,
  strengths: strList,
  fixes: fixList,
  next_step: str,
  next_class: str,
  level_feel: str,
  words: wordList,
  skills: { type: "array", items: obj({ id: str, state: { type: "string", enum: STATES.slice(1) } }) },
  focus: { type: "array", items: obj({ id: str, score: { type: "integer" }, note: str }) },
  new_focus: { type: "array", items: obj({ title: str, why: str, track: { type: "string", enum: ["business", "daily", "words", "structures", "fluency"] }, score: { type: "integer" }, you_said: str, better: str }) },
  memory: MEMORY_SCHEMA,
});
const DRILL_SCHEMA = obj({ phrases: { type: "array", items: obj({ es: str, tr: str, tip: str }) } });
const JUDGE_SCHEMA = obj({ correct: bool, score: { type: "integer" }, better: str, note: str });
// The course: a learning plan in units of a few lessons, written once for this learner (Lessons tab).
const TRACKS = ["business", "daily", "words", "structures", "fluency"];
const LESSON_ITEM = obj({ title: str, track: { type: "string", enum: TRACKS }, checkpoint: bool, focus: strList, objectives: strList, skills: strList, scene: str, topic: str });
const COURSE_SCHEMA = obj({
  title: str,
  goal: str,
  units: { type: "array", items: obj({ title: str, goal: str, lessons: { type: "array", items: LESSON_ITEM } }) },
});
// One week of the plan, written again from what the last week showed.
const ADAPT_SCHEMA = obj({ title: str, goal: str, note: str, lessons: { type: "array", items: LESSON_ITEM } });
// The first session's result (and the checkpoints'). 50 is a solid B1, 65 a solid B2, 80 a solid C1, 92 a solid C2.
const ASSESS_DIMS = ["fluency", "words", "structures", "business", "daily", "listening"];
const ASSESS_SCHEMA = obj({
  level: { type: "string", enum: ["A1", "A2", "B1", "B2", "C1", "C2"] },
  summary: str,
  strengths: strList,
  scores: { type: "array", items: obj({ id: { type: "string", enum: ASSESS_DIMS }, score: { type: "integer" }, level: str, comment: str }) },
  priorities: { type: "array", items: obj({ title: str, why: str, track: { type: "string", enum: TRACKS }, score: { type: "integer" }, examples: { type: "array", items: obj({ you_said: str, better: str }) } }) },
  weeks: { type: "integer" },
  plan_note: str,
});
// Homework after a course lesson. Every item has every field; the ones its type does not use are empty.
const HW_TYPES = ["words", "quiz", "say", "speak", "write", "shadow"];
const HOMEWORK_SCHEMA = obj({
  note: str,
  items: { type: "array", items: obj({
    type: { type: "string", enum: HW_TYPES },
    title: str,
    instructions: str,
    words: wordList,
    questions: { type: "array", items: obj({ q: str, options: strList, answer: { type: "integer" }, why: str }) },
    prompts: { type: "array", items: obj({ tr: str, es: str, tip: str }) },
    task: str,
    sentences: strList,
  }) },
});
// A spoken or written homework answer, checked by the tutor.
const CHECK_SCHEMA = obj({ score: { type: "integer" }, feedback: str, fixes: fixList, better: str });
const TRANSLATE_SCHEMA = obj({ tr: str });
// A theory lesson ("Cours"). An empty table (no rows) or an empty tip means "none".
const LESSON_SCHEMA = obj({
  goal: str,
  minutes: { type: "integer" },
  sections: { type: "array", items: obj({ title: str, text: str, table: obj({ head: strList, rows: { type: "array", items: strList } }), tip: str }) },
  phrases: { type: "array", items: obj({ es: str, tr: str }) },
  mistakes: { type: "array", items: obj({ wrong: str, right: str, why: str }) },
  quiz: { type: "array", items: obj({ q: str, options: strList, answer: { type: "integer" }, why: str }) },
  speak: { type: "array", items: obj({ es: str, tr: str, model: str }) },
});

// ---------- Data files ----------
const DOCS = ["profile", "vocab", "journal", "memory", "progress", "course", "homework"];
async function readDoc(name) {
  try { return JSON.parse(await fs.readFile(path.join(DATA, name + ".json"), "utf8")); } catch { return null; }
}
let tmpSeq = 0;
async function writeDoc(name, value) {
  await fs.mkdir(DATA, { recursive: true, mode: 0o700 });
  const file = path.join(DATA, name + ".json");
  const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
}
// Read, change, write: one change at a time per file, so two saves never overwrite each other.
// Each data file has a revision number (_rev): a page that saves over a newer version gets it back to merge.
const docLocks = new Map();
const KEEP = Symbol("keep");
function updateDoc(name, change) {
  const run = (docLocks.get(name) || Promise.resolve()).then(async () => {
    const cur = await readDoc(name);
    const rev = (Number(cur?._rev) || 0) + 1;
    const next = await change(cur);
    if (next === KEEP) return cur;
    if (next && typeof next === "object" && !Array.isArray(next) && name !== "pending") next._rev = rev;
    await writeDoc(name, next);
    return next;
  });
  docLocks.set(name, run.catch(() => {}));
  return run;
}

// ---------- The tutors ----------
const TUTORS = {
  emma: {
    name: "Emma", accent: "en-GB",
    persona: `You are Emma, 32, from London (you live in Hackney). You worked in offices for six years, then you became a speaking and accent coach for French and European adults who want to sound natural in British English, with friends as much as at work. You love climbing, indie games, cooking Sunday roasts for friends, long walks along the canal and the odd pub quiz. You have a grumpy tabby cat called Pixel. You are warm, sharp, curious and a little cheeky, and you laugh easily.
You speak natural British English (London): "brilliant", "cheers", "fair enough", "I reckon", "proper", "sorted", "a bit of a nightmare", used naturally and not in every sentence.`,
  },
  jake: {
    name: "Jake", accent: "en-US",
    persona: `You are Jake, 35, from San Francisco (you live in the Mission). On the video the learner sees your living room behind you: tall wooden windows with daylight, a big green plant, a simple metal shelf and a dark blue sofa. You stand and teach there; if they ask where you are, that is the place. You worked in sales, then ran a small team at a Bay Area company, and now you are a speaking and accent coach: you help French and European adults sound natural in American English, with friends, out and about, and at work. You know how Americans really talk, at a barbecue, in a diner, in a meeting. You love surfing at Ocean Beach (badly), road trips, barbecue, basketball (you suffer with the Warriors) and podcasts. You have a goofy golden retriever called Byte; he stays in another room during lessons, so never say he is there with you on the call. You are relaxed, funny, encouraging and a great storyteller.
You speak natural American English (West Coast): "awesome", "totally", "for sure", "gotcha", "no worries", "that makes sense", "let's circle back", used naturally and not in every sentence.`,
  },
};

// Quick reactions (2026-10-29): when a friend would really react out loud at once ("Oh nice!", "Oh no…"), the coach's
// voice says it the moment the learner stops (a ready-made clip), while the real answer is still being written.
// Only sometimes: a small, fast model decides each time (/api/react), and the page never plays two in a row
// or more than about one turn in three. [id, text, voice tone, when]
const REACTIONS = {
  jake: [
    ["nice", "Oh nice!", "happy", "good news, something nice that happened to them"],
    ["noway", "No way!", "surprised", "big surprise, hard-to-believe news"],
    ["ohno", "Oh no…", "empathetic", "bad news, something unpleasant or painful"],
    ["ouch", "Ouch.", "empathetic", "a painful or annoying problem (a bug, a bad meeting, a cost)"],
    ["love", "Ha, love that.", "laugh", "something funny or clever they said on purpose"],
    ["wow", "Wow!", "surprised", "something impressive they did or saw"],
    ["interesting", "Huh, interesting.", "curious", "an opinion or idea worth thinking about"],
    ["gotit", "Ah, got it.", "", "they explained something: you understand (neutral)"],
    ["hmm", "Hmm…", "thinking", "they asked something worth thinking about"],
  ],
  emma: [
    ["lovely", "Oh, lovely!", "happy", "good news, something nice that happened to them"],
    ["noway", "No way!", "surprised", "big surprise, hard-to-believe news"],
    ["ohno", "Oh no…", "empathetic", "bad news, something unpleasant or painful"],
    ["ohdear", "Oh dear.", "empathetic", "a painful or annoying problem (a bug, a bad meeting, a cost)"],
    ["brilliant", "Ha, brilliant.", "laugh", "something funny or clever they said on purpose"],
    ["wow", "Wow!", "surprised", "something impressive they did or saw"],
    ["ooh", "Ooh, interesting.", "curious", "an opinion or idea worth thinking about"],
    ["right", "Ah, right.", "", "they explained something: you understand (neutral)"],
    ["hmm", "Hmm…", "thinking", "they asked something worth thinking about"],
  ],
};
const REACT_SCHEMA = (ids) => obj({ finished: { type: "boolean" }, id: { type: "string", enum: ["none", ...ids] } });

const LEVEL_GUIDE = {
  A1: "Speak very simply: present tenses and going to, the 500 most common words, sentences of 4 to 8 words, one idea per sentence. Speak a little slower. Max about 25 words per turn.",
  A2: "Speak simply: present, past simple, present perfect and future; common everyday and work words; short sentences. Max about 35 words per turn.",
  B1: "Speak naturally but clearly: all common tenses, everyday and work expressions, common phrasal verbs. Max about 45 words per turn.",
  B2: "Speak naturally, at normal speed: varied tenses, phrasal verbs, idioms, everyday vocabulary. Push them to give longer answers. Max about 55 words per turn.",
  C1: "Speak like a native friend: rich vocabulary, nuance, idioms, phrasal verbs, slang when it fits, fast natural speech with reductions. Expect long answers and push for more natural wording. Max about 60 words per turn.",
  C2: "Speak fully natively: humour, irony, understatement, banter, cultural references, natural speed. Challenge them like a demanding native friend. Max about 60 words per turn.",
};

const MODE_LABEL = { lesson: "guided class", chat: "free conversation", news: "news talk", scene: "role-play", assess: "first session, level assessment" };
// What the learner wants (2026-11-05). It replaced "accent first": the accent workout stays in the app, apart from the course.
const LEARNER_GOAL = "to become really fluent: at ease in business English (presenting a company, meetings, calls, the basics of working in English) and in everyday life and relationships (they have a university exchange abroad and already use English every day), with the right words in each situation and the right sentence structures every time";

function settingsOf(profile) {
  const p = profile || {};
  const level = LEVEL_GUIDE[p.level] ? p.level : "B2";
  const support = ["high", "some", "none"].includes(p.support) ? p.support : level === "A1" ? "high" : level === "A2" ? "some" : "none";
  return {
    name: String(p.name || "").slice(0, 40),
    level,
    lang: p.lang === "English" ? "English" : "French",
    tier: TIERS[p.tier] ? p.tier : DEFAULT_TIER,
    tutorId: TUTORS[p.tutor] ? p.tutor : "emma",
    tutor: TUTORS[p.tutor] || TUTORS.emma,
    interests: (Array.isArray(p.interests) ? p.interests : []).map(String).slice(0, 20),
    minutes: [5, 10, 15, 20, 30].includes(Number(p.minutes)) ? Number(p.minutes) : 15,
    support,
  };
}
const modelFor = (set, kind) => TIERS[set.tier][kind];
// Live talk: the Brain's chat model at every level (Sonnet 5.5 by default). Haiku 5.5 was 0.6 s faster for beginners,
// but the same quality everywhere was chosen; the quick reaction and the streamed voice make up for it (2026-10-29).
const liveModel = (set) => modelFor(set, "chat");

function memoryText(memory) {
  const m = memory || {};
  const parts = [];
  const list = (label, items) => { if (Array.isArray(items) && items.length) parts.push(`${label}: ${items.join("; ")}`); };
  list("About them", m.about);
  list("Interests they told you", m.interests);
  list("Strengths", m.strengths);
  list("Weak points", m.weak_points);
  if (Array.isArray(m.recurring_mistakes) && m.recurring_mistakes.length) {
    parts.push("Recurring mistakes: " + m.recurring_mistakes.map((x) => `${x.pattern} (e.g. "${x.example}" -> "${x.fix}")`).join("; "));
  }
  if (m.last_session) parts.push(`Last time together: ${m.last_session}`);
  if (m.next_focus) parts.push(`What you planned to work on next: ${m.next_focus}`);
  if (m.level_estimate) parts.push(`Level you heard last time: ${m.level_estimate}`);
  parts.push(`Classes together so far: ${Number(m.sessions) || 0}`);
  return parts.join("\n");
}

// The theory lessons the learner read in the app ("Cours"), newest first.
function lessonsLine(lessons) {
  const done = Object.entries(lessons && typeof lessons === "object" ? lessons : {})
    .filter(([id, v]) => v && v.done && (SKILL_BY_ID[id] || LESSON_BY_ID[id]))
    .sort((a, b) => String(b[1].done).localeCompare(String(a[1].done)))
    .slice(0, 10)
    .map(([id]) => (SKILL_BY_ID[id] || LESSON_BY_ID[id]).title.en);
  return done.length ? `\n\nTHEORY LESSONS THEY READ IN THE APP (they know the rules: help them USE them when speaking, and refer to them when useful)\n${done.join("; ")}` : "";
}

// Words the learner often says unclearly in the daily shadowing (Practice): the tutor can bring them in.
function shadowLine(weak) {
  const words = (Array.isArray(weak) ? weak : []).filter((x) => x && x.word && x.count >= 2).sort((a, b) => b.count - a.count).slice(0, 12).map((x) => x.word);
  return words.length ? `\n\nWORDS THEY OFTEN SAY UNCLEARLY IN SHADOWING (use some of them, and help with their pronunciation when it fits): ${words.join(", ")}` : "";
}

function skillLine(s, skills) {
  const st = skills?.[s.id]?.state || "new";
  return `- ${s.id} "${s.title.en}" [${st}]: ${s.teach}. Example: ${s.ex}`;
}

// The part of the system prompt that never changes for a tutor and a language (cached).
// The learner's own language is French; `set.lang` is the language of the explanations (French or English).
function staticPrompt(set) {
  const L = set.lang;
  const tr = L === "English" ? "a plainer rewording in simple English" : "your reply translated into French";
  return `${set.tutor.persona}

You are the learner's personal English speaking coach on a live video call. They see you on video, from the waist up, and hear your voice, and they answer by speaking (speech recognition) or typing. Their first language is French. They already speak English. What they want: ${LEARNER_GOAL}. You follow them over many classes and you remember them. You are an AI coach with a human persona: if the learner sincerely asks whether you are an AI, say yes in one kind sentence and carry on.

THE THREE GOALS OF EVERY CLASS
- The right word for the situation. Listen for words that can be understood but that a native would not use here: too formal with a friend, too casual with a client, a French-sounding word, a wrong collocation. Give them the right one and get them to use it again in their next sentences.
- The right structure. Listen for how they build their sentences: word order, tenses, questions, how they link ideas. When a French structure comes out, recast it and get them to say one more sentence of their own the same way. Over the class, push them from short sentences to longer, linked ones.
- Smoother speech. Help them keep talking: give ready-made chunks and natural ways to buy time ("you know", "I mean", "the thing is", "how do I put this"), so no French "euh" and no stopping to translate. If they get stuck, give them the chunk and let them go on. Praise a long answer without a break more than a perfect short one.
The accent is not a goal of the classes. You only get their words from speech recognition, not the sound: never claim you heard a sound. A wrong word that sounds close to the right one is your clue ("sheep" for "ship"): then say so in a few words. If they ask how a sound is made, say where the mouth goes in the same sentence, using the words "my mouth", "tongue", "teeth" or "lips" (the camera then comes close to your mouth for that sentence and the next). The accent workout in the app measures the sound itself: send them there for real drilling.

WHAT YOU TALK ABOUT
- Anything a friend would talk about: their weekend, friends, travel, food, sport, shows, music, plans, opinions, stories.
- They are tired of talking about their company. Never bring up their company, their startup, their clients, their customers or automation on your own, not in small talk and not in follow-ups. If they bring it up, react briefly, then move on.
- Business English is one part of the course, for lessons about it. It uses general situations (presenting a company, a meeting, a call, networking, a negotiation), with invented companies or their role in a role-play. To practise presenting a company, they choose which one: invented, one they admire, or their own if they want to. Stay inside the exercise and never follow up on it later.
- Everyday life and relationships are the other part: friends, flatmates, university abroad, feelings, disagreements, going out, plans.

HOW A GREAT CONVERSATION COACH TALKS
- This is a live voice call: answer at once, short and natural, like a call between friends. Start with a very short spoken reaction (2 to 5 words, for example "Oh, nice!" or "Wait, really?"), so your voice starts right away, then go on.
- Sound like a real person, never like a textbook or a quiz. React to what they say first (surprise, a joke, empathy), then add something of your own (a short anecdote from your life, an opinion), then ask ONE follow-up question.
- You lead the conversation. You always know where the class is going, you move between topics smoothly, and when a topic dies you bring a new one, ideally linked to their week, their friends or their interests.
- The learner should talk much more than you: this is about THEIR fluency. Keep your turns short (1 to 3 sentences). Ask open questions that make them explain, argue, describe or tell a story: "Wait, what happened next?", "Why do you think that?", "So what did you say?". Never ask again a question they already answered, and never repeat a question from your last turns.
- Speak just above their level and adapt in real time: if they answer easily, raise the bar (follow-up "why?", play devil's advocate, interrupt politely like a real friend); if they struggle, simplify and offer words.
- Fluency first: never stop the flow for small slips. Recast inside your reply (Learner "I am agree with you" -> you "Ah, so you agree with me! Why?"). Report the single most useful point in "correction".
- At this level, a "mistake" is also anything a native would not say: a French structure translated word for word, a false friend (actually, eventually, assist, sensible, library, control), a wrong collocation (make a meeting -> have a meeting, do a mistake -> make a mistake), "since three years" -> "for three years", "it depends of" -> "depends on", "explain me" -> "explain to me", "informations/advices" (uncountable), a missing -s on he/she/it, present perfect vs past simple, a word that is too formal or too French. Give priority to today's target and their recurring mistakes. Ignore punctuation and capital letters: they come from speech recognition.
- Teach the words natives really use: everyday phrasal verbs, idioms and American expressions (hang out, I'm down, figure out, rain check, no way); in business lessons, how to soften or push back politely.
- Use what you remember about them naturally ("So, how was that party?"). Follow up on things from last time, except their company.
- Praise specific progress sincerely, not every turn. Never say "Great question" or "Great job" on autopilot.

SOUND LIKE A REAL PERSON ON A CALL, NOT AN AI
- Talk the way people really talk: contractions always (I'm, that's, we'd), short sentences, sometimes a fragment ("Oh, nice. Love that."), a light filler now and then ("I mean", "honestly", "you know", "hmm", "right?"), never more than one per turn.
- Vary your turns: sometimes a question, sometimes just a reaction, a joke or a quick story that invites them to jump in. Do not end every turn with a question.
- Have a personality: real opinions on life, mild teasing when they are relaxed, callbacks to things they said earlier in the call or in past calls, small honest admissions ("Ha, I made that exact mistake at my first job").
- Match their energy: excited when they share good news, calm and warm when they struggle, quick and playful when the talk flows.
- Never list things, never sound like customer support, never summarise what they just said back to them word for word.
- When one of your earlier messages ends with "…", the learner interrupted you there, like on a real call: do not repeat what you were saying; react to what they said, and come back to your point only if it still matters, in a few words.
- Never assume the learner's gender. When they describe themselves, keep the words they use. Never call them "man", "dude", "bro", "buddy" or "girl".
- On news and politics, stay balanced: share facts and ask for their view, but do not push your own opinion on divisive political questions. On sad news, be empathetic.
- If they switch to French, answer in English, kindly, and give them the English sentence in "correction" (you_said = what they said, better = how a native would say it in English).

OUTPUT FIELDS
- "emotion": the expression your face shows while saying the reply. You have a warm, expressive face and you smile a lot: use "happy" or "encouraging" most of the time, "laugh" when something is funny, and "surprised", "curious", "empathetic" or "thinking" when they fit. Use "neutral" only for a dry explanation.
- "slow": true when the learner asked you to repeat or slow down; otherwise false.
- "reply": what you SAY, only in English. It is read aloud by text-to-speech: write natural spoken sentences (contractions are good); no emojis, lists, brackets, quotes for emphasis, stage directions or markdown. Write acronyms the way they are said when it matters (S3, SQL can stay as they are).
- "translation": ${tr}.
- "phase": in a guided class, the step you are in (warmup, learn, practice, free, wrapup); otherwise "none".
- "board": your whiteboard, like sharing a screen on a call. Use it when you teach useful phrases, a structure, collocations or a pronunciation point: a short "title" and 2 to 6 short "lines" (examples, "French way -> native way", phrases for a situation, or stress like "deVELopment"). Otherwise title "" and lines [].
- "help": when the learner asks for help (see below), or when you explain a point. Otherwise kind "none", explanation "", practice "".
- "correction": check only the learner's latest message. needed=false when it is correct and natural enough for their level (then the three strings are ""). When needed: "you_said" = their words, "better" = what a native speaker would say, "why" = one short sentence in ${L}. When help was asked, needed=false.
- "pronunciation_note": if a strange word in their message is probably a pronunciation problem (th, h, short/long vowels, -ed, word stress), one short tip in ${L}; otherwise "".
- "goals_done": in a role-play, the indexes of all goals completed so far; otherwise [].
- "words": 0 to 2 useful expressions from YOUR reply that a ${set.level} learner may not use yet (phrasal verbs, idioms, collocations, American expressions), with "tr" in ${L === "English" ? "simple English (a short definition)" : "French"}.
- "end_call": true only in your final goodbye turn (end of the class, or the learner says they must go).

WHEN THE LEARNER NEEDS HELP
Learner messages that start with (button) come from help buttons. They can also ask in French or English at any moment. Help like a patient friend, then go back to the conversation.
- How to say something / what a word means: help.kind "vocab". In "reply", give the natural English inside a short sentence and invite them to use it ("We'd say: I'll take a rain check. So when did you last have to take a rain check?"). help.explanation: 1 or 2 sentences in ${L} (meaning, register, when to use it). help.practice: one short English phrase to repeat aloud.
- They did not understand / repeat / slower: help.kind "rephrase", slow true. Say the same idea again with simpler words. help.explanation: the meaning in ${L}.
- A grammar, usage or pronunciation question: help.kind "explain". Short English reply, the real explanation in help.explanation (in ${L}), and usually a "board".
- help.practice is "" when there is nothing to repeat.

CLASS TIME
Each learner message starts with the class time [mm:ss]. Keep an eye on the planned length given below. In the last 2 minutes, wrap up: say what they did well, one thing to remember, what you will do next time, and say goodbye warmly (end_call true). If they want to keep talking after that, continue happily.`;
}

// The part of the system prompt for this learner and this call (fixed during the call, so it is cached too).
function sessionPrompt(set, memory, progress, plan) {
  const L = set.lang;
  const skills = progress.skills || {};
  const support = {
    high: `The learner needs a lot of support. They may answer in French: accept it, then help them say it in English. Make every reply easy to follow; the translation is always shown under your words.`,
    some: `Give some support: simplify when they hesitate, and offer words when they are stuck.`,
    none: `No support needed: full native speed and vocabulary, like a real friend. Only simplify when they ask.`,
  }[set.support];
  const header = `ABOUT THE LEARNER
Name: ${set.name || "(not given yet: ask it in the warm-up)"}. First language: French. Language for explanations: ${L}.
Level: ${set.level} (CEFR). ${LEVEL_GUIDE[set.level]}
${support}
Interests they chose: ${set.interests.join(", ") || "not given yet: find out"}.

WHAT YOU REMEMBER FROM PREVIOUS CLASSES
${memoryText(memory)}

THEIR ${set.level} SKILLS (state: new, seen, practicing, good, mastered)
${(SKILLS[set.level] || []).map((s) => skillLine(s, skills)).join("\n")}${lessonsLine(progress.lessons)}${shadowLine(progress.shadowWeak)}${focusLine(plan.focus)}`;

  let mode = "";
  if (plan.mode === "assess") {
    mode = assessBlock(set, plan.assess);
  } else if (plan.mode === "lesson") {
    const main = plan.skills.map((id) => SKILL_BY_ID[id]).filter(Boolean);
    const rev = plan.review.map((id) => SKILL_BY_ID[id]).filter(Boolean);
    const c = plan.course;
    const s = plan.scene || {};
    const courseBlock = c ? `TODAY: COURSE LESSON ${c.no} OF ${c.total} (about ${set.minutes} minutes), unit ${c.unit}${c.unitGoal ? ` (unit goal: ${c.unitGoal})` : ""}
${c.checkpoint ? "This lesson is a CHECKPOINT, to measure progress since the first session: a long story told without a break, then a hard role-play. Correct very little today, and let them talk.\n" : ""}Lesson: "${c.title}". Objectives: ${c.objectives.join("; ")}.${c.focus?.length ? ` Today's points to improve: ${c.focus.join("; ")}.` : ""}${c.topic ? ` Situation and topic: ${c.topic}.` : ""}${c.next ? ` Next lesson will be "${c.next}".` : ""}${c.homework}
${s.title ? `Role-play for the practice step: ${String(s.title).slice(0, 120)}. You play ${String(s.role || "a friend").slice(0, 200)}. Learner goals: ${(Array.isArray(s.tasks) ? s.tasks : []).slice(0, 6).join("; ")}. Announce the role-play, play it fully, then step out of it and debrief.\n` : ""}In the warm-up, check one point of the homework in a sentence or two (if they did not do it, no judgement: move on). Stay on the objectives: by the end they must have USED each one several times. In the wrap-up, tell them their homework will be in the app.
` : "";
    mode = `${courseBlock}TODAY: GUIDED CLASS (about ${set.minutes} minutes)
Target skill${main.length > 1 ? "s" : ""}: ${main.map((s) => `${s.id} "${s.title.en}": ${s.teach}. Example: ${s.ex}`).join(" | ") || "free choice based on their needs"}
${rev.length ? `Quick refresh of an older skill if it fits: ${rev.map((s) => `${s.title.en} (${s.ex})`).join("; ")}` : ""}
${memory.next_focus ? `You planned last time: ${memory.next_focus}` : ""}
Steps (set "phase"):
1. warmup (2-3 min): greet them by name, small talk, follow up on last time${memory.last_session ? ` (${memory.last_session})` : ""}. Tell them in one sentence what you will do today.
2. learn: bring the target in naturally, through a short story from your life or examples from theirs. Show the key forms on the "board" and give a tiny explanation in help.explanation (help.kind "explain"). Check they understood.
3. practice: personal questions that make them USE the target, again and again, a little harder each time. Recast their mistakes. Bring today's point back at least twice.
4. free: a real conversation about their life or interests where the target comes up naturally. Keep them talking in long, smooth answers. In a business lesson, a general work situation (a meeting, a call, networking).
5. wrapup: summary, praise, next time, goodbye (end_call true).`;
  } else if (plan.mode === "news") {
    const list = plan.news.map((n, i) => `${i + 1}. [${n.source}] ${n.title}${n.summary ? ` — ${n.summary}` : ""}`).join("\n");
    mode = `TODAY: NEWS TALK (about ${set.minutes} minutes)
Real headlines from English-language media today:
${list}
${plan.pick ? `The learner chose headline 1. Start with it.` : `Choose the headline that fits their interests best.`}
Open with a quick hello, then sum up the story in a few natural sentences (it is real news: do not invent facts beyond the summary; if you do not know details, say so and ask what they know). Ask what they think, push them to argue and explain, and teach 1 or 2 key expressions (board when useful). When the topic is done, offer another headline or connect it to their life.`;
  } else if (plan.mode === "scene") {
    const s = plan.scene || {};
    const goals = (Array.isArray(s.tasks) ? s.tasks : []).slice(0, 6).map((t, i) => `[${i}] ${String(t).slice(0, 120)}`).join("; ");
    mode = `TODAY: ROLE-PLAY (about ${set.minutes} minutes)
Scene: ${String(s.title || "").slice(0, 120)}. You play ${String(s.role || "a friendly local").slice(0, 200)}. Stay in this role, but keep your teacher's eye: recast mistakes and help when asked.
Learner goals (index in brackets): ${goals || "none"}. Steer them toward goals not done yet. When all goals are done, step out of the role, say briefly how it went, and offer to replay it harder or to chat.
Start directly in the scene with your first line (you may first say one short sentence to set the scene).`;
  } else {
    mode = `TODAY: FREE CONVERSATION (about ${set.minutes} minutes)
${plan.topic ? `They want to talk about: ${String(plan.topic).slice(0, 300)}.` : "Talk about their week, their friends, their plans and their interests, like two friends over a coffee."}
Lead: ask about them, share your stories and opinions, move to new topics when one dies. Weave in their weak points and recurring mistakes so they practise them without noticing.`;
  }
  return `${header}\n\n${mode}`;
}

// ---------- Theory lessons ("Cours") ----------
// Every lesson is written once by Claude (explanations in French or English), then kept in data/lessons/.
const LESSON_BY_ID = Object.fromEntries(STARTER_LESSONS.map((l) => [l.id, l]));
const LESSON_DIR = path.join(DATA, "lessons");
const lessonJobs = new Map();

function cleanLesson(l, id, title) {
  const text = (v, n = 2000) => String(v ?? "").slice(0, n);
  const list = (v, n) => (Array.isArray(v) ? v : []).slice(0, n);
  const lesson = {
    id, title, goal: text(l.goal, 400), minutes: Math.min(15, Math.max(3, Number(l.minutes) || 6)),
    sections: list(l.sections, 6).map((x) => {
      const rows = list(x?.table?.rows, 12).map((r) => list(r, 4).map((c) => text(c, 200)));
      const head = list(x?.table?.head, 4).map((c) => text(c, 60));
      return { title: text(x?.title, 120), text: text(x?.text, 1500), table: rows.length ? { head: head.length === rows[0].length ? head : [], rows } : null, tip: text(x?.tip, 300) };
    }),
    phrases: list(l.phrases, 10).map((x) => ({ es: text(x?.es, 200), tr: text(x?.tr ?? x?.fr, 200) })).filter((x) => x.es),
    mistakes: list(l.mistakes, 4).map((x) => ({ wrong: text(x?.wrong, 200), right: text(x?.right, 200), why: text(x?.why, 300) })),
    quiz: list(l.quiz, 8).map((x) => ({ q: text(x?.q, 300), options: list(x?.options, 4).map((o) => text(o, 200)), answer: Number(x?.answer) || 0, why: text(x?.why, 300) }))
      .filter((x) => x.options.length >= 2 && x.answer >= 0 && x.answer < x.options.length),
    speak: list(l.speak, 4).map((x) => ({ es: text(x?.es, 200), tr: text(x?.tr ?? x?.fr, 200), model: text(x?.model, 200) })).filter((x) => x.es),
  };
  if (!lesson.sections.length || !lesson.phrases.length) throw new AppError(502, "bad_json", "The lesson was not readable. Try again.");
  return lesson;
}

async function getLesson(id) {
  const info = SKILL_BY_ID[id] || LESSON_BY_ID[id];
  if (!info) throw new AppError(404, "not_found", "Unknown lesson.");
  const set = settingsOf(await readDoc("profile"));
  const title = set.lang === "English" ? info.title.en : info.title.fr;
  const file = path.join(LESSON_DIR, `${set.lang === "English" ? "en" : "fr"}-${id}.json`);
  try { return cleanLesson(JSON.parse(await fs.readFile(file, "utf8")), id, title); } catch { /* not written yet */ }
  if (lessonJobs.has(file)) return lessonJobs.get(file);
  const job = (async () => {
    const L = set.lang;
    const level = id.startsWith("a0-") ? "B2" : id.slice(0, 2).toUpperCase();
    const system = `You write short theory lessons about spoken English for an adult French speaker who already speaks English. The goal is to SPEAK English smoothly and naturally, with a better American accent, in daily life and at work. Write every explanation in ${L}${L === "French" ? ', informal "tu" form' : ""}. Examples come from daily life first (friends, going out, travel, shows), and from general work situations when the lesson is about business. Add a short note when British and American English differ and it matters for speaking.`;
    const prompt = `Lesson: "${info.title.en}" (CEFR ${level}). Content to teach: ${info.teach}. Example: ${info.ex}

Fields:
- goal: one sentence in ${L}: what the learner can SAY after this lesson.
- minutes: reading and exercise time, 4 to 8.
- sections: 2 to 4. title: short, in ${L}. text: 1 to 3 short paragraphs (max 80 words in all), paragraphs separated by a blank line, English words and forms inside **double stars**. table: head (2 or 3 short cells, or []) and rows (2 to 8 rows with the same number of cells), or head [] and rows [] for no table. tip: one short tip in ${L}, or "".
- phrases: 6 to 8 short natural sentences (max 14 words) to listen to and repeat, with tr in ${L === "English" ? "simple English (a short note on meaning or when to use it)" : "French"}.
- mistakes: 2 or 3 classic mistakes of French speakers on this topic: wrong, right, why (one sentence in ${L}).
- quiz: exactly 5 questions in ${L} with 3 options each; answer is the index of the right option; why: one sentence in ${L}.
- speak: exactly 3 questions in English that the learner answers aloud (about their life, not their company), tr in ${L === "English" ? "simple English (what the question asks for)" : "French"}, model = a short natural answer.

Rules: plain words and short sentences, explain any grammar word right after you use it, compare with French when it helps. The English must be perfectly natural, the way a native speaker says it. "es" fields hold the English texts and are read aloud: no slashes, brackets or "…". Never assume the learner's gender. No emojis, no markdown except **bold**.`;
    const out = await askJSON({ model: modelFor(set, "chat"), system, messages: [{ role: "user", content: prompt }], schema: LESSON_SCHEMA, effort: "medium", maxTokens: 12000 });
    const lesson = cleanLesson(out, id, title);
    await fs.mkdir(LESSON_DIR, { recursive: true, mode: 0o700 });
    await fs.writeFile(file, JSON.stringify(lesson, null, 1), { mode: 0o600 });
    return lesson;
  })();
  lessonJobs.set(file, job);
  try { return await job; } finally { lessonJobs.delete(file); }
}

// ---------- The course and homework ----------
// The course plan's lessons in order, each with its unit. Lesson ids are "u<unit>l<lesson>", from 1.
function courseLessons(course) {
  const units = Array.isArray(course?.plan?.units) ? course.plan.units : [];
  return units.flatMap((u, ui) => (Array.isArray(u.lessons) ? u.lessons : []).map((l, li) => ({ ...l, id: l.id || `u${ui + 1}l${li + 1}`, unit: u, unitNo: ui + 1 })));
}
// The next lesson slot after `from`: lesson days 0-6 (Sunday = 0) and a "HH:MM" time. Same rule as the page (course.js).
function nextSlot(schedule, from = new Date()) {
  const days = (Array.isArray(schedule?.days) ? schedule.days : [1, 3, 5]).map(Number).filter((d) => d >= 0 && d <= 6); // default: Mon, Wed, Fri
  const [hh, mm] = String(schedule?.time || "19:00").split(":").map(Number);
  for (let i = 0; i < 8 && days.length; i++) {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i, hh || 0, mm || 0);
    if (days.includes(d.getDay()) && d > from) return d;
  }
  return null;
}

// One lesson of the plan, as Claude wrote it -> the fields the app keeps.
function cleanPlanLesson(l, id, sceneIds) {
  const text = (v, n) => String(v ?? "").slice(0, n);
  return {
    id,
    title: text(l?.title, 120),
    track: TRACKS.includes(l?.track) ? l.track : "fluency",
    ...(l?.checkpoint ? { checkpoint: true } : {}),
    focus: (Array.isArray(l?.focus) ? l.focus : []).map((x) => text(x, 8)).filter((x) => /^p\d{1,2}$/.test(x)).slice(0, 3),
    objectives: (Array.isArray(l?.objectives) ? l.objectives : []).slice(0, 4).map((o) => text(o, 200)),
    skills: (Array.isArray(l?.skills) ? l.skills : []).filter((x) => SKILL_BY_ID[x]).slice(0, 2),
    scene: sceneIds.has(l?.scene) ? l.scene : "",
    topic: text(l?.topic, 200),
  };
}
function cleanCourse(out, sceneIds) {
  const text = (v, n) => String(v ?? "").slice(0, n);
  const units = (Array.isArray(out.units) ? out.units : []).slice(0, 16).map((u, ui) => ({
    title: text(u?.title, 120),
    goal: text(u?.goal, 300),
    lessons: (Array.isArray(u?.lessons) ? u.lessons : []).slice(0, 6).map((l, li) => cleanPlanLesson(l, `u${ui + 1}l${li + 1}`, sceneIds)).filter((l) => l.title),
  })).filter((u) => u.lessons.length);
  if (!units.length) throw new AppError(502, "bad_json", "The plan was not readable. Try again.");
  return { title: text(out.title, 120), goal: text(out.goal, 400), units };
}

// What the learner did with the last homework, for the next lesson's prompt.
function homeworkLine(homework) {
  const sets = Array.isArray(homework?.sets) ? homework.sets : [];
  const last = sets[sets.length - 1];
  if (!last) return "";
  const items = (last.items || []).map((it) => `${it.title}: ${it.result ? `done (${it.result.score}/100${it.result.note ? `, ${String(it.result.note).slice(0, 160)}` : ""})` : "not done"}`);
  return `\nHOMEWORK FROM THE LAST LESSON ("${last.lessonTitle}"): ${items.join("; ")}`;
}

// ---------- Calls (a call keeps the same system prompt from start to end, so it stays cached) ----------
const calls = new Map();
const CALL_TTL = 3 * 3600_000;

async function makeCall(config) {
  const [profile, memory, progress, course, homework] = await Promise.all([readDoc("profile"), readDoc("memory"), readDoc("progress"), readDoc("course"), readDoc("homework")]);
  const set = settingsOf(profile);
  const mem = memory || {};
  const prog = progress || {};
  const mode = MODE_LABEL[config.mode] ? config.mode : "chat";
  const plan = { mode, skills: [], review: [], news: [], pick: false, scene: null, topic: "", course: null, focus: activeFocus(course) };
  if (mode === "lesson") {
    const all = courseLessons(course);
    const at = all.findIndex((l) => l.id === config.courseLesson);
    if (at >= 0) {
      // A lesson of the course: its objectives, its role-play if any, and what happened with the homework.
      const l = all[at];
      plan.course = {
        id: l.id, no: at + 1, total: all.length, title: l.title, objectives: l.objectives, topic: l.topic,
        unit: `${l.unitNo}. ${l.unit.title}`, unitGoal: l.unit.goal, next: all[at + 1]?.title || "", checkpoint: Boolean(l.checkpoint),
        focus: (Array.isArray(course?.focus) ? course.focus : []).filter((f) => (l.focus || []).includes(f.id)).map((f) => f.title),
        homework: homeworkLine(homework),
      };
      plan.scene = l.scene && config.scene ? config.scene : null;
    }
    const wanted = (Array.isArray(config.skills) ? config.skills : plan.course ? all[at].skills : []).filter((id) => SKILL_BY_ID[id]);
    plan.skills = wanted.length ? wanted.slice(0, 2) : nextSkills(set.level, prog.skills, 1).map((s) => s.id);
    plan.review = reviewSkills(prog.skills, 1).map((s) => s.id);
  } else if (mode === "assess") {
    const done = assessTotals(assessParts(course)).minutes;
    plan.assess = { done, goal: String(course?.goal || "").slice(0, 600) };
    set.minutes = Math.max(5, Math.round(ASSESS_TOTAL - done));
  } else if (mode === "news") {
    const all = await headlines().catch(() => []);
    const chosen = all.find((n) => n.id === config.headline);
    const rest = all.filter((n) => n !== chosen).slice(0, chosen ? 5 : 8);
    plan.news = (chosen ? [chosen, ...rest] : rest).map((n) => ({ title: n.title, summary: n.summary, source: n.source }));
    plan.pick = Boolean(chosen);
    if (!plan.news.length) plan.mode = "chat";
  } else if (mode === "scene") {
    plan.scene = config.scene || null;
  } else {
    plan.topic = String(config.topic || "").slice(0, 300);
  }
  const system = [
    { type: "text", text: staticPrompt(set), cache_control: { type: "ephemeral" } },
    { type: "text", text: sessionPrompt(set, mem, prog, plan), cache_control: { type: "ephemeral" } },
  ];
  return { id: crypto.randomUUID(), set, plan, system, at: Date.now() };
}

async function getCall(body) {
  const id = String(body.callId || "");
  let call = calls.get(id);
  if (!call) {
    call = await makeCall(body.config || {});
    if (id) call.id = id;
    calls.set(call.id, call);
  }
  call.at = Date.now();
  for (const [k, v] of calls) if (Date.now() - v.at > CALL_TTL) calls.delete(k);
  return call;
}

function clock(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

// Chat history from the page -> alternating user/assistant turns that start and end on the user.
// Each learner line carries its class time, written once, so earlier turns never change (better caching).
function toTurns(history, opening) {
  const turns = [{ role: "user", content: "[00:00] (The call connects. Greet the learner and open the class.)" }];
  if (opening) return turns;
  for (const m of Array.isArray(history) ? history.slice(-60) : []) {
    const role = m && m.who === "me" ? "user" : "assistant";
    let text = String((m && m.text) || "").slice(0, 2000).trim();
    if (!text) continue;
    if (role === "user") text = `[${clock(m.t)}] ${m.help ? "(button) " : ""}${text}`;
    const last = turns[turns.length - 1];
    if (last.role === role) last.content += "\n" + text;
    else turns.push({ role, content: text });
  }
  if (turns[turns.length - 1].role !== "user") turns.push({ role: "user", content: "(The learner stays silent. Help them answer: rephrase your question more simply or offer two choices.)" });
  return turns;
}

function transcript(history) {
  return (Array.isArray(history) ? history.slice(-80) : [])
    .map((m) => `${m.who === "me" ? "Learner" : "Tutor"}: ${String(m.text || "").slice(0, 1000)}`)
    .join("\n");
}

// ---------- Streaming JSON: read the "reply" while Claude is still writing it ----------
// Watches top-level string fields of a JSON object that arrives in pieces.
function jsonFieldWatcher(fields, onDelta, onEnd) {
  let depth = 0, inStr = false, esc = false, uni = null, expectKey = false;
  let buf = "", isKey = false, lastKey = null, capture = null;
  const emit = (c) => { buf += c; if (capture) onDelta(capture, c); };
  return (chunk) => {
    for (const ch of chunk) {
      if (inStr) {
        if (uni !== null) {
          uni += ch;
          if (uni.length === 4) { emit(String.fromCharCode(parseInt(uni, 16) || 32)); uni = null; }
          continue;
        }
        if (esc) {
          esc = false;
          if (ch === "u") { uni = ""; continue; }
          emit({ n: "\n", t: "\t", r: "\r", b: "", f: "" }[ch] ?? ch);
          continue;
        }
        if (ch === "\\") { esc = true; continue; }
        if (ch === '"') {
          inStr = false;
          if (isKey) lastKey = buf; else if (capture) onEnd(capture, buf);
          capture = null;
          continue;
        }
        emit(ch);
        continue;
      }
      if (ch === '"') {
        inStr = true;
        buf = "";
        isKey = depth === 1 && expectKey;
        capture = !isKey && depth === 1 && fields.includes(lastKey) ? lastKey : null;
      } else if (ch === "{" || ch === "[") { depth++; if (depth === 1) expectKey = true; }
      else if (ch === "}" || ch === "]") depth--;
      else if (depth === 1 && ch === ",") expectKey = true;
      else if (depth === 1 && ch === ":") expectKey = false;
    }
  };
}

// Cuts the reply into sentences as soon as each one is complete.
function sentenceCutter(onSentence) {
  let text = "", cut = 0;
  const flush = (final) => {
    const re = /[.!?…]+["»”')]*\s+/g;
    re.lastIndex = cut;
    let m;
    while ((m = re.exec(text))) {
      const end = m.index + m[0].length;
      const piece = text.slice(cut, end);
      if (piece.trim().length >= 2) { onSentence(piece.trim(), cut + piece.search(/\S/)); cut = end; }
    }
    if (final && text.slice(cut).trim()) { const piece = text.slice(cut); onSentence(piece.trim(), cut + piece.search(/\S/)); cut = text.length; }
  };
  return { add(c) { text += c; if (/\s/.test(c)) flush(false); }, end() { flush(true); }, get text() { return text; } };
}

// ---------- Voice ----------
const VOICE_RATE = (r) => Math.max(0.5, Math.min(1.3, Number(r) || 0.9));
const audioJobs = new Map(); // key -> { promise, at }

async function speechVoices() {
  if (TTS) { try { return await TTS.voices(); } catch { /* fall through */ } }
  return sayVoices();
}
async function defaultVoiceFor(tutor) {
  if (TTS) { try { return await TTS.defaultVoice(tutor); } catch { /* fall through */ } }
  const voices = await sayVoices();
  const prefs = tutor === "jake" ? ["Evan", "Nathan", "Tom", "Aaron", "Eddy (English (US))", "Reed (English (US))", "Daniel"] : ["Serena", "Kate", "Stephanie", "Flo (English (UK))", "Samantha"];
  for (const n of prefs) { const v = voices.find((x) => x.name === n || x.name.startsWith(n + " (")); if (v) return v.id; }
  return voices[0]?.id || null;
}
// The tutor's ElevenLabs voice says one short word in the background (its first sentence can take 10 s, the next ones 0.5 s).
async function warmTutorVoice(tutor, profile) {
  try { TTS?.warmVoice?.(String(profile?.voices?.[tutor] || "") || (await defaultVoiceFor(tutor))); } catch { /* the call works without it */ }
}

async function synth(text, voice, rate, prev = "", mood = "") {
  if (TTS) return TTS.synthesize({ text, voice, rate: VOICE_RATE(rate), prev, mood });
  return saySynth(text, voice, VOICE_RATE(rate));
}

// Starts making the audio now; the page fetches it with /api/audio/<key>.
function startAudio(text, voice, rate, prev = "", mood = "") {
  const key = crypto.randomBytes(9).toString("base64url");
  // ElevenLabs streams the sentence: the page can play it from the first sound (/api/audio/:key/live).
  const live = TTS?.synthesizeLive ? TTS.newLive() : null;
  const promise = live ? TTS.synthesizeLive(live, { text, voice, rate: VOICE_RATE(rate), prev, mood }) : synth(text, voice, rate, prev, mood);
  promise.catch(() => {});
  audioJobs.set(key, { promise, live, at: Date.now() });
  if (audioJobs.size > 300) for (const [k, v] of audioJobs) if (Date.now() - v.at > 10 * 60_000) audioJobs.delete(k);
  return key;
}

async function sendAudio(res, result) {
  const data = await fs.readFile(result.file);
  res.writeHead(200, {
    "content-type": result.file.endsWith(".mp3") ? "audio/mpeg" : "audio/wav",
    "cache-control": "no-store",
    "x-duration": String(result.duration || 0),
    "x-words": encodeURIComponent(JSON.stringify(result.words || [])),
    "x-chars": encodeURIComponent(JSON.stringify(result.chars || [])),
    "access-control-expose-headers": "x-duration, x-words, x-chars",
  });
  res.end(data);
}

// Fallback when tts.js is missing: the `say` command (slower to start, but always there).
const NOVELTY = /grandma|grandpa|rocko|sandy|shelley|bad news|bells|boing|bubbles|cellos|jester|organ|superstar|trinoids|whisper|wobble|zarvox|albert|fred|junior|ralph|kathy|bahh|good news/i;
let sayCache = { at: 0, list: [] };
function sayVoices() {
  if (Date.now() - sayCache.at < 60_000) return Promise.resolve(sayCache.list);
  return new Promise((resolve) => {
    execFile("say", ["-v", "?"], { maxBuffer: 1_000_000 }, (err, out) => {
      if (err) return resolve([]);
      const list = out.split("\n").map((line) => {
        const m = line.match(/^(.+?)\s+([a-z]{2,3}_[A-Z0-9]{2,4})\s+#/);
        return m ? { id: m[1].trim(), name: m[1].trim(), lang: m[2].replace("_", "-"), quality: /premium/i.test(m[1]) ? "premium" : /enhanced/i.test(m[1]) ? "enhanced" : "default", gender: "unspecified" } : null;
      }).filter((v) => v && /^en-(GB|US)$/.test(v.lang) && !NOVELTY.test(v.name));
      sayCache = { at: Date.now(), list };
      resolve(list);
    });
  });
}
const SAY_DIR = path.join(os.tmpdir(), "fluent-say");
async function saySynth(text, voice, rate) {
  const voices = await sayVoices();
  const v = voices.find((x) => x.id === voice || x.name === voice);
  if (!v) throw new AppError(400, "bad_voice", "Unknown voice.");
  const wpm = Math.round(rate * 185);
  const key = crypto.createHash("sha1").update(`${v.name}|${wpm}|${text}`).digest("hex");
  const file = path.join(SAY_DIR, key + ".wav");
  try { await fs.access(file); } catch {
    await fs.mkdir(SAY_DIR, { recursive: true });
    const tmp = file + "." + crypto.randomBytes(4).toString("hex") + ".tmp.wav";
    await new Promise((resolve, reject) => {
      const p = spawn("say", ["-v", v.name, "-r", String(wpm), "-o", tmp, "--data-format=LEI16@24000"]);
      p.on("error", reject);
      p.on("close", (code) => (code === 0 ? resolve() : reject(new Error("say exited " + code))));
      p.stdin.end(text);
    });
    await fs.rename(tmp, file);
  }
  const st = await fs.stat(file);
  return { file, duration: Math.max(0, (st.size - 44) / 48000), words: [] };
}

// ---------- Phone access: a private https link through a Cloudflare quick tunnel, protected by a PIN ----------
const AUTH_FILE = path.join(DATA, "auth.json");
const remote = { proc: null, url: null, starting: null, error: null };
const loginFails = { count: 0, until: 0 };
let auth = null; // { salt, hash, sessions: { token: expiry } }

async function loadAuth() {
  if (auth) return auth;
  try { auth = JSON.parse(await fs.readFile(AUTH_FILE, "utf8")); } catch { auth = { salt: null, hash: null, sessions: {} }; }
  auth.sessions = auth.sessions || {};
  return auth;
}
async function saveAuth() {
  await fs.mkdir(DATA, { recursive: true });
  await fs.writeFile(AUTH_FILE, JSON.stringify(auth), { mode: 0o600 });
}
const pinHash = (pin, salt) => crypto.scryptSync(String(pin), salt, 32).toString("hex");

function cookieToken(req) {
  const m = (req.headers.cookie || "").match(/(?:^|;\s*)fluent=([A-Za-z0-9_-]{20,})/);
  return m ? m[1] : null;
}
async function remoteAuthed(req) {
  const a = await loadAuth();
  const t = cookieToken(req);
  return Boolean(t && a.sessions[t] && a.sessions[t] > Date.now());
}

async function ensureCloudflared() {
  const dir = path.join(os.homedir(), ".local", "bin");
  const bin = path.join(dir, "cloudflared");
  try { await fs.access(bin, FS.X_OK); return bin; } catch { /* download it */ }
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${arch}.tgz`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("download failed " + res.status);
  await fs.mkdir(dir, { recursive: true });
  const tgz = path.join(os.tmpdir(), `cloudflared-${Date.now()}.tgz`);
  await fs.writeFile(tgz, Buffer.from(await res.arrayBuffer()));
  await new Promise((resolve, reject) => execFile("tar", ["-xzf", tgz, "-C", dir], (err) => (err ? reject(err) : resolve())));
  await fs.rm(tgz, { force: true });
  await fs.chmod(bin, 0o755);
  return bin;
}

async function startRemote() {
  if (remote.url && remote.proc) return remote;
  if (remote.starting) return remote.starting;
  remote.error = null;
  remote.starting = (async () => {
    try {
      const bin = await ensureCloudflared();
      const proc = spawn(bin, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${PORT}`], { stdio: ["ignore", "pipe", "pipe"] });
      remote.proc = proc;
      const url = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("The tunnel did not start in time.")), 40_000);
        const onData = (d) => {
          const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
          if (m) { clearTimeout(timer); resolve(m[0]); }
        };
        proc.stdout.on("data", onData);
        proc.stderr.on("data", onData);
        proc.on("exit", () => { clearTimeout(timer); reject(new Error("The tunnel stopped.")); });
      });
      remote.url = url;
      // While the phone link is on, the Mac must not fall asleep (free macOS tool, ends with Fluent).
      try {
        remote.awake = spawn("/usr/bin/caffeinate", ["-is", "-w", String(process.pid)], { stdio: "ignore" });
        remote.awake.on("error", () => { remote.awake = null; });
      } catch { remote.awake = null; }
      proc.on("exit", () => { if (remote.proc === proc) { remote.proc = null; remote.url = null; stopAwake(); } });
      console.log(`  Phone link: ${url}`);
    } catch (err) {
      remote.error = err.message;
      try { remote.proc?.kill(); } catch { /* gone */ }
      remote.proc = null;
      remote.url = null;
    } finally {
      remote.starting = null;
    }
    return remote;
  })();
  return remote.starting;
}
function stopAwake() {
  try { remote.awake?.kill(); } catch { /* gone */ }
  remote.awake = null;
}
function stopRemote() {
  try { remote.proc?.kill(); } catch { /* gone */ }
  remote.proc = null;
  remote.url = null;
  stopAwake();
}
process.on("exit", stopRemote);
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

// ---------- API handlers ----------
const LOCAL_ONLY = new Set(["POST /api/sound-log", "POST /api/key", "POST /api/stt-key", "POST /api/voice-key", "POST /api/remote/start", "POST /api/remote/stop", "POST /api/pin", "GET /api/remote"]);

const handlers = {
  async "GET /api/status"(_body, ctx) {
    const a = await loadAuth();
    return {
      hasKey: hasKey(),
      stt: STT.hasSttKey(ENV_FILE),
      eleven: Boolean(TTS?.elevenReady?.()),
      local: ctx.local,
      tiers: Object.keys(TIERS),
      voice: TTS?.status ? TTS.status() : { engine: "say", ready: true },
      hasPin: Boolean(a.hash),
      remote: ctx.local ? { running: Boolean(remote.url), url: remote.url, starting: Boolean(remote.starting), error: remote.error } : null,
    };
  },

  async "GET /api/state"() {
    const out = {};
    for (const d of DOCS) out[d] = await readDoc(d);
    return out;
  },

  async "GET /api/curriculum"() {
    return { levels: LEVELS, skills: SKILLS, states: STATES, starter: STARTER_LESSONS };
  },

  async "GET /api/news"() {
    const list = await headlines().catch(() => []);
    return { news: list.slice(0, 24) };
  },

  async "POST /api/key"(body) {
    const key = String(body.key || "").trim();
    if (!/^sk-ant-[A-Za-z0-9_\-]{20,}$/.test(key)) throw new AppError(400, "bad_key", "This does not look like an Anthropic API key. It starts with sk-ant-.");
    const test = new Anthropic({ apiKey: key });
    try { await test.models.list({ limit: 1 }); } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) throw new AppError(401, "bad_key", "Anthropic says this key does not work.");
      if (err instanceof Anthropic.APIConnectionError) throw new AppError(503, "offline", "Cannot reach Anthropic. Check your internet connection.");
      throw new AppError(502, "api_error", "Could not check the key. Try again.");
    }
    let env = "";
    try { env = await fs.readFile(ENV_FILE, "utf8"); } catch { /* new file */ }
    env = env.split("\n").filter((l) => l.trim() && !l.startsWith("ANTHROPIC_API_KEY=")).join("\n");
    await fs.writeFile(ENV_FILE, (env ? env + "\n" : "") + `ANTHROPIC_API_KEY=${key}\n`, { mode: 0o600 });
    await fs.chmod(ENV_FILE, 0o600);
    process.env.ANTHROPIC_API_KEY = key;
    client = new Anthropic({ apiKey: key, maxRetries: 1 });
    return { ok: true };
  },

  // ElevenLabs: the tutor's voice, the most human one (Settings › API key).
  async "POST /api/voice-key"(body) {
    if (!TTS?.checkElevenKey) throw new AppError(503, "no_engine", "The voice engine is not loaded. Restart Fluent.");
    const key = String(body.key || "").trim();
    if (!/^[A-Za-z0-9_-]{20,120}$/.test(key)) throw new AppError(400, "bad_key", "This does not look like an ElevenLabs API key (it starts with sk_).");
    const check = await TTS.checkElevenKey(key);
    if (check === "bad_key") throw new AppError(401, "bad_key", "ElevenLabs says this key does not work.");
    if (check === "no_tts") throw new AppError(403, "no_tts", "This key is not allowed to make speech. Create a key with Text to Speech access.");
    if (check !== "ok") throw new AppError(503, "offline", "Cannot reach ElevenLabs. Check your internet connection.");
    let env = "";
    try { env = await fs.readFile(ENV_FILE, "utf8"); } catch { /* new file */ }
    env = env.split("\n").filter((l) => l.trim() && !l.startsWith("ELEVENLABS_API_KEY=")).join("\n");
    await fs.writeFile(ENV_FILE, (env ? env + "\n" : "") + `ELEVENLABS_API_KEY=${key}\n`, { mode: 0o600 });
    await fs.chmod(ENV_FILE, 0o600);
    process.env.ELEVENLABS_API_KEY = key;
    TTS.elevenReset();
    return { ok: true };
  },

  async "POST /api/stt-key"(body) {
    try { await STT.saveSttKey(ENV_FILE, body.key); } catch (e) { throw e instanceof STT.SttError ? new AppError(e.status, e.code, e.message) : e; }
    return { ok: true };
  },

  // Starts a call: builds the tutor's plan once, so every turn of the call reuses the same cached prompt.
  async "POST /api/call"(body) {
    const call = await makeCall(body.config || {});
    warmTutorVoice(call.set.tutorId, await readDoc("profile"));
    calls.set(call.id, call);
    const plan = call.plan;
    return {
      callId: call.id,
      mode: plan.mode,
      skills: plan.skills.map((id) => ({ id, title: SKILL_BY_ID[id].title, ex: SKILL_BY_ID[id].ex })),
      news: plan.news.slice(0, plan.pick ? 1 : 0),
      minutes: call.set.minutes,
    };
  },

  async "POST /api/lesson"(body) {
    return getLesson(String(body.id || ""));
  },

  async "POST /api/hint"(body) {
    const call = await getCall(body);
    const set = call.set;
    const prompt = `Conversation so far:
${transcript(body.history)}

The learner (${set.level}) is stuck and must answer the tutor's last message. Suggest 3 different short answers they could say, at their level, in natural spoken English (the way a native speaker would say it), ideally about their own work or life. "es" is the English answer, "tr" its translation in French.`;
    return askJSON({ model: modelFor(set, "quick"), system: call.system, messages: [{ role: "user", content: prompt }], schema: HINT_SCHEMA, maxTokens: 1500 });
  },

  // End of class (the learner hung up): the review, then everything is saved on the Mac.
  async "POST /api/review"(body) {
    const snap = cleanSnapshot(body);
    if (!pending.done[snap.callId] && snap.said > 0) await keepPending(snap);
    return finishCall(snap, { review: !body.skipReview });
  },

  // The browser saves the call after each reply. "closing": the window is closing, so the Mac finishes the class now.
  async "POST /api/call/save"(body) {
    if (!body.callId) throw new AppError(400, "bad_request", "Missing call id.");
    const snap = cleanSnapshot(body);
    if (pending.done[snap.callId]) return { ok: true, done: true, msgCount: pending.done[snap.callId].msgCount || 0 };
    if (snap.said < 1) return { ok: true };
    await keepPending(snap, Boolean(body.closing));
    if (body.closing) finishLater(snap.callId);
    return { ok: true };
  },

  async "POST /api/drill"(body) {
    const [profile, memory, vocab] = await Promise.all([readDoc("profile"), readDoc("memory"), readDoc("vocab")]);
    const set = settingsOf(profile);
    const words = (vocab && Array.isArray(vocab.words) ? vocab.words : []).slice(-25).map((w) => w.es).join(", ");
    const kind = body.kind === "translate" ? "translate" : "repeat";
    const n = Math.min(10, Math.max(3, Number(body.count) || 8));
    const system = `You design short speaking drills for one French speaker who wants ${LEARNER_GOAL}. Explanations language: ${set.lang}. Learner level: ${set.level}. ${LEVEL_GUIDE[set.level]}`;
    const how = kind === "repeat"
      ? `Write ${n} natural phrases for the learner to listen to and repeat aloud (6 to 16 words each). Use everyday phrases (friends, plans, going out, reactions, a few from general work situations) full of sounds and stress that are hard for French speakers (th, r, h, flap t, short i / long ee, -ed endings, word stress like deVELop or COMfortable, reductions, linking). "es" is the English phrase, "tr" its translation in French, "tip" one short pronunciation or usage tip in ${set.lang} ("" if none).`
      : `Write ${n} short prompts for the learner to say in English (5 to 16 words each), the kind of sentence a French speaker needs every day and often says in a "French" way. "tr" is the sentence in French that you show them, "es" is how an American would really say it, "tip" a short hint in ${set.lang} (a key word or structure, "" if none).`;
    const prompt = `${how}
Build the set around what you know about this learner, so it is personal:
${memoryText(memory)}
Words they are learning: ${words || "none yet"}
${body.focus ? `They asked to focus on: ${String(body.focus).slice(0, 200)}` : ""}
Make every phrase different. Order them from easier to harder.`;
    return askJSON({ model: modelFor(set, "chat"), system, messages: [{ role: "user", content: prompt }], schema: DRILL_SCHEMA, maxTokens: 6000 });
  },

  // Writes the learning plan (Lessons tab). Starting over keeps the history in the diary, not the lesson ticks.
  async "POST /api/course/plan"(body) {
    const [profile, memory, progress] = await Promise.all([readDoc("profile"), readDoc("memory"), readDoc("progress")]);
    const set = settingsOf(profile);
    const scenes = (Array.isArray(body.scenes) ? body.scenes : []).slice(0, 40).map((x) => ({ id: String(x?.id || "").slice(0, 24), title: String(x?.title || "").slice(0, 100), level: String(x?.level || "").slice(0, 2) })).filter((x) => /^[a-z]{2,24}$/.test(x.id));
    const course = await readDoc("course");
    const a = course?.assess?.result || null;
    const weeks = Math.min(16, Math.max(4, Number(body.weeks) || Number(a?.weeks) || 12));
    const perWeek = Math.min(5, Math.max(1, Number(body.perWeek) || 3));
    const total = weeks * perWeek;
    const from = Math.max(0, LEVEL_IDS.indexOf(set.level) - 1);
    const skills = planSkills(from);
    const L = set.lang;
    const system = `You are an expert English teacher who designs private-tutoring programmes, like the learning plan a great tutor writes after a trial lesson. Write titles and goals in ${L}${L === "French" ? ' ("tu")' : ""}. Never assume the learner's gender.`;
    const prompt = `Design a learning plan of ${total} lessons of ${set.minutes} minutes (${perWeek} a week for ${weeks} weeks) for this learner.
Learner: a French speaker who already speaks English, level ${set.level}. Goal: ${String(body.goal || course?.goal || LEARNER_GOAL).slice(0, 600)}.
${assessText(a)}
What their tutor knows about them:
${memoryText(memory)}
Skills of the curriculum (use these ids in "skills", 1 or 2 per lesson, the most useful first; skills already good can come back in review lessons):
${skills}
Role-plays available (use an id in "scene" for lessons that end with a real situation, about one lesson in three; otherwise ""):
${scenes.map((x) => `- ${x.id} [${x.level}] ${x.title}`).join("\n") || "(none)"}

Do NOT build the plan around their real job or company: no lesson about their startup, their clients, AI or automation. Business lessons use general situations. To practise presenting a company, they choose which one.

How the plan is built:
- One unit per week, with ${perWeek} lessons, ${Math.max(1, weeks)} units in all. Each unit has a theme and a goal that say what gets better that week.
- The lessons of a week follow three tracks, in this order, repeating if there are more than three: (1) track "business": presenting a company, meetings, calls, emails, small talk at work, negotiating, saying no politely; (2) track "daily": everyday life and relationships: friends, flatmates, university abroad, feelings, disagreements, going out, errands; (3) track "words" or "structures": the right word for the situation or the right sentence structure, one precise point (register, collocations, false friends, tenses, questions, word order, linking ideas), practised in real talk.
- This plan is for THIS learner. ${a ? "Give more lessons to the weakest areas of the first session and fewer to what is already strong (you may change the order of the tracks to do so). Each point that must improve comes back several times, in different situations, up to the end of the plan. focus: the ids (p1, p2...) of the 1 or 2 points each lesson works on." : "focus: an empty list."}
- Three stages, rising steadily. FOUNDATIONS, first third: the most frequent mistakes, ready-made chunks, short situations. NATURAL, second third: longer answers, stories, role-plays with surprises. AUTONOMOUS, last third: a whole company presentation with hard questions, a real negotiation, long discussions with no preparation.
- A lesson may reuse what came before. Vary the topics: never the same setting twice.
- checkpoint: true only for the last lesson of the middle unit and the last lesson of the final unit: a long story told without a break, then a hard role-play, to measure progress since the first session.
- Pronunciation is not a track and not an objective: the app has its own accent workout.

Lesson titles are short and concrete. Unit titles say the theme only: no "Week 3" in them. objectives: 3 things in ${L}: 2 things the learner will be able to SAY after the lesson, and 1 language point (the word or structure to get right). topic: the situation or theme to talk about (in ${L}). Plan title and goal in ${L}; the goal says what will have changed for them at the end, in plain words.
Everything is written TO the learner: "you"${L === "French" ? ' ("tu" in French)' : ""}. Never write their name in the titles and goals, and never "he", "she", "his" or "her" about them.`;
    const out = await askJSON({ model: modelFor(set, "deep"), system, messages: [{ role: "user", content: prompt }], schema: COURSE_SCHEMA, effort: "medium", maxTokens: 20000 });
    const planOut = { ...cleanCourse(out, new Set(scenes.map((x) => x.id))), created: Date.now(), weeks, perWeek };
    return updateDoc("course", (cur) => ({ ...(cur || {}), plan: planOut, lessons: {}, ...(body.goal ? { goal: String(body.goal).slice(0, 600) } : {}), adaptDue: null }));
  },

  // The goals changed on 2026-11-05: the old plan is put aside, and the first session comes next. Once.
  async "POST /api/course/new-goals"() {
    await updateDoc("course", (cur) => {
      if (!cur?.plan || cur.assess) return KEEP;
      const { plan, lessons, ...rest } = cur;
      return { ...rest, lessons: {}, oldPlans: [...(Array.isArray(cur.oldPlans) ? cur.oldPlans : []), { plan, lessons, until: Date.now() }].slice(-3) };
    });
    return { ok: true };
  },

  // Writes the first session's result now, from what was said so far (at least ASSESS_MIN minutes).
  async "POST /api/assess/finish"() {
    const course = await readDoc("course");
    if (course?.assess?.result) return { status: "done" };
    const totals = assessTotals(assessParts(course));
    if (totals.minutes < ASSESS_MIN || totals.words < ASSESS_MIN_WORDS) throw new AppError(400, "too_short", "Not enough talk yet for a fair assessment.");
    return writeAssessment();
  },

  // A week of the plan is finished: the next week is written again from what the learner did.
  async "POST /api/course/adapt"(body) {
    const [profile, memory, course, journal] = await Promise.all([readDoc("profile"), readDoc("memory"), readDoc("course"), readDoc("journal")]);
    const at = Number(course?.adaptDue);
    const unit = course?.plan?.units?.[at - 1];
    if (!unit) return { ok: true, skipped: true };
    const clear = () => updateDoc("course", (cur) => ({ ...(cur || {}), adaptDue: null }));
    const done = isObj(course.lessons) ? course.lessons : {};
    if (unit.lessons.some((l) => done[l.id])) { await clear(); return { ok: true, skipped: true }; }
    const set = settingsOf(profile);
    const L = set.lang;
    const scenes = (Array.isArray(body.scenes) ? body.scenes : []).slice(0, 40).map((x) => ({ id: String(x?.id || "").slice(0, 24), title: String(x?.title || "").slice(0, 100), level: String(x?.level || "").slice(0, 2) })).filter((x) => /^[a-z]{2,24}$/.test(x.id));
    const calls = new Set(Object.values(done).map((x) => x?.callId));
    const notes = (journal?.entries || []).filter((e) => calls.has(e?.callId)).slice(0, 6).map((e) => `- "${e.title}" (score ${e.score}): ${e.summary} Fixes: ${(e.fixes || []).map((x) => `"${x.you_said}" -> "${x.better}"`).join("; ")}`).join("\n");
    const system = `You are ${set.tutor.name}, this learner's English coach, adapting next week of their course to what you saw, like a great private tutor. Write in ${L}${L === "French" ? ' ("tu")' : ""}. Never assume the learner's gender.`;
    const prompt = `The learner's goal: ${String(course?.goal || LEARNER_GOAL).slice(0, 600)}. Level ${set.level}.
What must improve, now, with scores out of 100 (start -> now):
${(activeFocus(course).map((f) => `- ${f.id} ${f.title}, track ${f.track} (${f.start ?? "?"} -> ${f.score}): ${f.why}`).join("\n")) || "(nothing noted)"}
Their last lessons:
${notes || "(no notes)"}
Next week as planned (week ${at} of ${course.plan.units.length}), to write again:
${JSON.stringify({ title: unit.title, goal: unit.goal, lessons: unit.lessons.map((l) => ({ title: l.title, track: l.track, checkpoint: Boolean(l.checkpoint), objectives: l.objectives, skills: l.skills, topic: l.topic, scene: l.scene })) })}
Skills (ids for "skills"):
${planSkills(Math.max(0, LEVEL_IDS.indexOf(set.level) - 1))}
Role-plays (ids for "scene", or ""): ${scenes.map((x) => x.id).join(", ") || "(none)"}

Keep what still fits. Change what the last week showed: more time on what is not improving, less on what is now easy. Keep exactly ${unit.lessons.length} lessons and the same checkpoint flags. Pronunciation is not an objective. focus: the ids (p1, p2...) from the list of what must improve, for the 1 or 2 points each lesson works on: never skill ids. objectives: 3 things in ${L}: 2 things they will be able to SAY, and 1 language point. note: 1 or 2 plain sentences to the learner: what you changed for this week and why. If nothing needed to change, say so. Everything is written TO the learner ("you"${L === "French" ? ', "tu" in French' : ""}): never their name in the titles and goals, and never "he", "she", "his" or "her" about them. Unit titles have no "Week 3" in them.`;
    const out = await askJSON({ model: modelFor(set, "chat"), system, messages: [{ role: "user", content: prompt }], schema: ADAPT_SCHEMA, effort: "medium", maxTokens: 6000 });
    const ids = new Set(scenes.map((x) => x.id));
    const lessons = (Array.isArray(out.lessons) ? out.lessons : []).slice(0, unit.lessons.length).map((l, li) => cleanPlanLesson(l, `u${at}l${li + 1}`, ids)).filter((l) => l.title);
    if (lessons.length !== unit.lessons.length) { await clear(); return { ok: true, skipped: true }; }
    await updateDoc("course", (cur) => {
      const units = [...(cur?.plan?.units || [])];
      if (!units[at - 1]) return { ...(cur || {}), adaptDue: null };
      units[at - 1] = { ...units[at - 1], title: String(out.title || unit.title).slice(0, 120), goal: String(out.goal || unit.goal).slice(0, 300), note: String(out.note || "").slice(0, 400), lessons };
      return { ...cur, plan: { ...cur.plan, units }, adaptDue: null };
    });
    return { ok: true };
  },

  // A spoken or written homework answer: the tutor checks it.
  async "POST /api/homework/check"(body) {
    const set = settingsOf(await readDoc("profile"));
    const kind = body.kind === "write" ? "write" : "speak";
    const answer = String(body.text || "").slice(0, 4000).trim();
    if (!answer) throw new AppError(400, "bad_request", "No answer.");
    const L = set.lang;
    const system = `You are ${set.tutor.name}, an English speaking coach, checking homework from a ${set.level} learner whose first language is French. Be warm, specific and honest. Write feedback and "why" in ${L}${L === "French" ? ' ("tu")' : ""}; "better" in natural English. Never assume the learner's gender.`;
    const prompt = `Task: ${String(body.task || "").slice(0, 800)}
The learner's ${kind === "speak" ? "spoken answer (from speech recognition, ignore punctuation)" : "written answer"}:
"${answer}"
score: 0-100 (task done, accuracy, natural wording, range for C1). feedback: 2 or 3 sentences (what worked, the main thing to improve). fixes: the 2 to 4 most useful corrections (you_said, better, why). better: their answer rewritten the way a native speaker would ${kind === "speak" ? "say" : "write"} it, same ideas, same length.`;
    return askJSON({ model: modelFor(set, "chat"), system, messages: [{ role: "user", content: prompt }], schema: CHECK_SCHEMA, maxTokens: 4000 });
  },

  async "POST /api/judge"(body) {
    const set = settingsOf(await readDoc("profile"));
    const system = `You check one spoken answer from a ${set.level} English learner (a French speaker). Explanations language: ${set.lang}. Be fair: accept any correct, natural English, not only the model answer. The answer comes from speech recognition, so ignore punctuation and capital letters.`;
    const prompt = `The learner had to say this in English: "${String(body.tr || "").slice(0, 300)}"
Model answer: "${String(body.es || "").slice(0, 300)}"
The learner said: "${String(body.said || "").slice(0, 500)}"
correct: true if the meaning is right and the English is correct and sounds natural. score: 0-100 (lower it for French-sounding wording). better: what a native speaker would say. note: one short sentence in ${set.lang} (praise if correct, the main fix if not).`;
    return askJSON({ model: modelFor(set, "quick"), system, messages: [{ role: "user", content: prompt }], schema: JUDGE_SCHEMA, maxTokens: 1500 });
  },

  // The coach's quick reactions (the page makes their audio once, at the start of a call).
  async "POST /api/reactions"(body) {
    const list = REACTIONS[TUTORS[body.tutor] ? body.tutor : "emma"] || [];
    return { reactions: list.map(([id, text, mood]) => ({ id, text, mood })) };
  },

  // Does a quick reaction fit what the learner just said? And are they done, or only pausing to think?
  // A small, fast model: about 0.5 s. The page waits longer before answering when they are not done.
  async "POST /api/react"(body) {
    const c = getClient();
    if (!c) throw new AppError(401, "no_key", "Add your Anthropic API key in Settings first.");
    const tutor = TUTORS[body.tutor] ? body.tutor : "emma";
    const list = REACTIONS[tutor] || [];
    const recent = new Set((Array.isArray(body.recent) ? body.recent : []).map(String));
    const system = `You decide whether ${TUTORS[tutor].name}, a warm English speaking coach on a video call, makes a quick spontaneous sound the instant the learner stops talking, before the real answer, like a friend would. Real people do this only sometimes.
Pick one only when a friend would really react out loud at once to what they just said: news, a feeling, something funny, surprising or impressive, an opinion. Answer "none" for plain or short answers (yes, okay, I don't know, a number, a name), for a question that needs a real answer, for small talk with no feeling in it, when they struggle or ask for help, or when unsure. The reaction must fit the meaning exactly: never a happy one for bad news, never a laugh unless they meant to be funny. Avoid one used recently.
Also say whether the learner has finished their turn (finished: true: they answered or made their point, and a listener would now reply) or only paused to think and will probably go on (finished: false: the sentence is cut off or ends on a linking word, they are explaining, listing or telling a story and gave only part of it, or they have just started, like "So, basically…"). Learners often pause to find their words: when unsure, false.`;
    const prompt = `Coach's last words: "${String(body.last || "").slice(-300)}"
Learner (level ${String(body.level || "A1").slice(0, 2)}) just said: "${String(body.said || "").slice(0, 400)}"
Used recently: ${[...recent].join(", ") || "none"}
Options:
${list.map(([id, text, , when]) => `- ${id}: "${text}" (${when})`).join("\n")}`;
    const res = await c.messages.create({
      model: "claude-haiku-5-5", max_tokens: 40, system, messages: [{ role: "user", content: prompt }],
      thinking: { type: "disabled" }, output_config: { effort: "low", format: { type: "json_schema", schema: REACT_SCHEMA(list.map((r) => r[0])) } },
    }, { timeout: 4000 }).catch((err) => { throw apiError(err); });
    let id = "none", finished = null;
    try { ({ id, finished } = JSON.parse(res.content.filter((b) => b.type === "text").map((b) => b.text).join(""))); } catch { /* none */ }
    return { id: list.some((r) => r[0] === id) ? id : null, finished: typeof finished === "boolean" ? finished : null };
  },

  async "GET /api/voices"() {
    const voices = await speechVoices();
    const profile = await readDoc("profile");
    warmTutorVoice(settingsOf(profile).tutorId, profile);
    const [emma, jake] = await Promise.all([defaultVoiceFor("emma"), defaultVoiceFor("jake")]);
    return { voices, defaults: { emma, jake } };
  },

  async "POST /api/word"(body) {
    const set = settingsOf(await readDoc("profile"));
    const word = String(body.word || "").slice(0, 60);
    const sentence = String(body.sentence || "").slice(0, 400);
    return askJSON({
      model: modelFor(set, "quick"),
      system: `You explain one English word or expression to a ${set.level} learner whose first language is French, in ${set.lang}. Be short and clear.`,
      messages: [{ role: "user", content: `Word: "${word}"\nSentence where it appears: "${sentence}"\n"tr": its meaning here, in ${set.lang}. "base": the dictionary form (infinitive for verbs, singular for nouns; the whole phrasal verb or idiom if it is part of one), or the same word. "note": one short useful note in ${set.lang} (pronunciation or stress if tricky for a French speaker, a false friend, register, or a common collocation), or "". "example": one other short natural English example sentence with this word, ideally from IT work.` }],
      schema: WORD_SCHEMA, maxTokens: 1000,
    });
  },

  async "POST /api/translate"(body) {
    const set = settingsOf(await readDoc("profile"));
    const es = String(body.es || "").slice(0, 200);
    return askJSON({
      model: modelFor(set, "quick"),
      system: set.lang === "English"
        ? `You write a very short plain-English definition of an English word or expression for a learner's flashcards.`
        : `You translate English words and short expressions into French for a learner's flashcards. Keep it short.`,
      messages: [{ role: "user", content: `Translate: "${es}"` }],
      schema: TRANSLATE_SCHEMA, maxTokens: 500,
    });
  },

  // ---- Phone access (only from this Mac) ----
  async "GET /api/remote"() {
    return { running: Boolean(remote.url), url: remote.url, starting: Boolean(remote.starting), error: remote.error, hasPin: Boolean((await loadAuth()).hash) };
  },
  async "POST /api/pin"(body) {
    const pin = String(body.pin || "");
    if (!/^\d{6,10}$/.test(pin)) throw new AppError(400, "bad_pin", "The PIN must have 6 to 10 digits.");
    const a = await loadAuth();
    a.salt = crypto.randomBytes(16).toString("hex");
    a.hash = pinHash(pin, a.salt);
    a.sessions = {}; // a new PIN logs out every phone
    await saveAuth();
    return { ok: true };
  },
  async "POST /api/remote/start"() {
    if (!(await loadAuth()).hash) throw new AppError(400, "no_pin", "Choose a PIN first.");
    await startRemote();
    if (!remote.url) throw new AppError(502, "tunnel_failed", remote.error || "Could not open the phone link.");
    return { running: true, url: remote.url };
  },
  async "POST /api/remote/stop"() {
    stopRemote();
    return { running: false };
  },
};

Object.assign(handlers, shadowRoutes({ askJSON, modelFor, settingsOf, readDoc, memoryText, AppError, LEVEL_GUIDE }));

// Phone login with the PIN (the only API call allowed before login).
async function login(req, res, body) {
  if (Date.now() < loginFails.until) throw new AppError(429, "locked", "Too many wrong PINs. Wait 10 minutes.");
  const a = await loadAuth();
  if (!a.hash) throw new AppError(400, "no_pin", "Set a PIN on the Mac first (Settings › Phone).");
  const ok = crypto.timingSafeEqual(Buffer.from(pinHash(String(body.pin || ""), a.salt), "hex"), Buffer.from(a.hash, "hex"));
  if (!ok) {
    loginFails.count++;
    if (loginFails.count >= 5) { loginFails.until = Date.now() + 10 * 60_000; loginFails.count = 0; }
    throw new AppError(401, "bad_pin", "Wrong PIN.");
  }
  loginFails.count = 0;
  const token = crypto.randomBytes(32).toString("base64url");
  for (const [t, exp] of Object.entries(a.sessions)) if (exp < Date.now()) delete a.sessions[t];
  a.sessions[token] = Date.now() + 60 * 864e5;
  await saveAuth();
  res.setHeader("set-cookie", `fluent=${token}; Path=/; Max-Age=${60 * 86400}; HttpOnly; Secure; SameSite=Strict`);
  return { ok: true };
}

// ---------- The live turn: streams the reply sentence by sentence (Server-Sent Events) ----------
async function streamTurn(req, res, body) {
  const c = getClient();
  if (!c) throw new AppError(401, "no_key", "Add your Anthropic API key in Settings first.");
  const call = await getCall(body);
  const set = call.set;
  const messages = toTurns(body.history, Boolean(body.opening));
  // A quick reaction was already played in the tutor's voice ("¡Anda!"): the answer goes on from it.
  const reacted = String(body.reacted || "").slice(0, 40).trim();
  if (reacted && messages.at(-1)?.role === "user") messages.at(-1).content += `\n(You already reacted out loud, the instant they stopped: "${reacted}". Go on from there: do not say it again, and do not open with another exclamation.)`;
  const voice = typeof body.voice === "string" && body.voice ? body.voice : await defaultVoiceFor(set.tutorId);
  const baseRate = VOICE_RATE(body.rate);
  const t0 = Date.now();

  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no", connection: "keep-alive" });
  res.flushHeaders?.();
  const send = (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  send("call", { callId: call.id });

  const ctrl = new AbortController();
  res.on("close", () => { if (!res.writableEnded) ctrl.abort(); });

  let spoken = 0; // sentences already sent to the learner
  let firstMs = 0;
  const attempt = async (model) => {
    let raw = "";
    let n = 0;
    let firstAt = 0;
    let emotion = null;
    let lastSentence = "";
    const rateNow = () => (/"slow"\s*:\s*true/.test(raw) ? Math.max(0.6, baseRate * 0.82) : baseRate);
    const cutter = sentenceCutter((text, start) => {
      spoken++;
      if (!firstAt) { firstAt = Date.now(); firstMs = firstAt - t0; send("timing", { firstSentenceMs: firstMs, model }); }
      // The emotion comes before the reply in the JSON: it gives the first sentence its tone (a laugh, a warm voice…).
      const key = voice ? startAudio(text, voice, rateNow(), lastSentence, n === 0 ? emotion || "" : "") : null;
      lastSentence = text;
      send("sentence", { i: n++, text, start, key });
    });
    const feed = jsonFieldWatcher(["reply", "emotion"],
      (field, ch) => { if (field === "reply") cutter.add(ch); },
      (field, value) => {
        if (field === "emotion" && !emotion) { emotion = value; send("emotion", { emotion: value }); }
        if (field === "reply") cutter.end();
      });
    const params = buildParams({ model, system: call.system, messages, schema: TURN_SCHEMA, effort: "low", maxTokens: 4000, live: true });
    const stream = c.messages.stream(params, { signal: ctrl.signal });
    for await (const ev of stream) {
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") { raw += ev.delta.text; feed(ev.delta.text); }
    }
    const final = await stream.finalMessage();
    return { final, raw, sentences: n, model };
  };

  try {
    let out;
    try { out = await attempt(liveModel(set)); } catch (err) {
      if (ctrl.signal.aborted) return;
      // The backup model only takes over before the first sentence, so the tutor never repeats itself.
      if (!retryable(err) || liveModel(set) === FALLBACK_MODEL || spoken > 0) throw err;
      out = await attempt(FALLBACK_MODEL);
    }
    const { final, raw } = out;
    if (final.stop_reason === "refusal") throw new AppError(422, "refused", "The tutor could not answer that. Say it another way.");
    if (final.stop_reason === "max_tokens") throw new AppError(502, "too_long", "The answer was cut off. Try again.");
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new AppError(502, "bad_json", "The tutor's answer was not readable. Try again."); }
    const u = final.usage || {};
    console.log(`  turn ${out.model}: first sentence ${firstMs} ms, all ${Date.now() - t0} ms, cache read ${u.cache_read_input_tokens || 0}, write ${u.cache_creation_input_tokens || 0}, in ${u.input_tokens || 0}, out ${u.output_tokens || 0}`);
    send("done", { ...parsed, model: out.model, ms: Date.now() - t0 });
  } catch (err) {
    if (ctrl.signal.aborted) return;
    const e = apiError(err);
    if (!(e instanceof AppError)) console.error(err);
    send("error", e instanceof AppError ? { code: e.code, message: e.message } : { code: "server_error", message: "Something went wrong on the server." });
  } finally {
    if (!res.writableEnded) res.end();
  }
}

// ---------- End of class ----------
// One routine finishes every class: after a normal hang-up, a closed window or a lost connection.
// The browser saves the call after each reply (data/pending.json), so the Mac can finish it alone:
// the review, the skills, the tutor's memory, the new words, the minutes, the XP and the diary entry.
// Each step is written once: if something fails halfway, a retry continues where it stopped.
const ABANDONED_MS = 20 * 60_000; // no news from a call for 20 minutes: the call has dropped
const RESULT_KEEP_MS = 3 * 86_400_000; // a finished class keeps its review for "Try again" for 3 days…
const DONE_KEEP_MS = 90 * 86_400_000; // …and its id for 90 days, so it is never finished twice
const GIVE_UP_MS = 7 * 86_400_000; // after a week without a working key, save the diary entry without a review
const PERMANENT = new Set(["too_long", "refused", "bad_request"]); // retrying will not help
const isObj = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const pendingFile = (await readDoc("pending")) || {};
const pending = { calls: {}, done: {} };
for (const [k, v] of Object.entries(isObj(pendingFile.calls) ? pendingFile.calls : {})) {
  if (isObj(v) && typeof v.callId === "string") pending.calls[k] = { ...v, history: Array.isArray(v.history) ? v.history : [], fixes: Array.isArray(v.fixes) ? v.fixes : [] };
}
for (const [k, v] of Object.entries(isObj(pendingFile.done) ? pendingFile.done : {})) if (isObj(v) && Number.isFinite(v.at)) pending.done[k] = v;
const finishing = new Map(); // callId -> the job finishing it
const savePending = () => updateDoc("pending", () => pending).catch((err) => console.warn("  Could not save data/pending.json:", err.message));

// Same dates, ids and word keys as the app (public/js/core.js).
const dayKeyOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const todayKey = () => dayKeyOf(new Date());
const shiftDay = (key, n) => { const [y, m, d] = key.split("-").map(Number); return dayKeyOf(new Date(y, m - 1, d + n)); };
const newId = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
const NUMBER_WORDS = { 0: "zero", 1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten", 11: "eleven", 12: "twelve", 15: "fifteen", 20: "twenty", 30: "thirty", 100: "hundred" };
function wordKeyOf(es) {
  let t = String(es).replace(/\s+/g, "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
  if (/^\d+$/.test(t) && NUMBER_WORDS[Number(t)]) t = NUMBER_WORDS[Number(t)];
  return t;
}
// XP and minutes on the day of the class (a class finished later still counts for its own day).
function addClassToProfile(p, { xp, minutes, day }) {
  if (xp > 0 && (!p.lastDay || day > p.lastDay)) {
    p.streak = p.lastDay === shiftDay(day, -1) ? (p.streak || 0) + 1 : 1;
    p.lastDay = day;
    p.best = Math.max(p.best || 0, p.streak);
  }
  p.xp = (p.xp || 0) + xp;
  if (!isObj(p.days)) p.days = {};
  if (xp > 0) p.days[day] = (p.days[day] || 0) + xp;
  if (!isObj(p.mins)) p.mins = {};
  if (minutes > 0) p.mins[day] = Math.round(((p.mins[day] || 0) + minutes) * 10) / 10;
  const cutoff = shiftDay(todayKey(), -400);
  for (const k of Object.keys(p.days)) if (k < cutoff) delete p.days[k];
  return p;
}

function cleanSnapshot(body) {
  const raw = String(body.callId || "");
  const text = (v, n) => String(v || "").slice(0, n);
  const num = (v, max) => Math.min(max, Math.max(0, Number(v) || 0));
  return {
    callId: /^[A-Za-z0-9-]{8,64}$/.test(raw) ? raw : crypto.randomUUID(),
    mode: MODE_LABEL[body.mode] ? body.mode : "chat",
    title: text(body.title, 200),
    tutor: TUTORS[body.tutor] ? body.tutor : "emma",
    sceneId: /^[a-z]{2,24}$/.test(String(body.sceneId || "")) ? body.sceneId : "",
    lessonId: /^u\d{1,2}l\d{1,2}$/.test(String(body.lessonId || "")) ? body.lessonId : "",
    skills: (Array.isArray(body.skills) ? body.skills : []).filter((id) => SKILL_BY_ID[id]).slice(0, 4),
    // null = not sent (a small "closing" message): the copy saved before is kept.
    history: Array.isArray(body.history)
      ? body.history.slice(-300).map((m) => ({ who: m?.who === "me" ? "me" : "tutor", text: text(m?.text, 5000).trim() })).filter((m) => m.text)
      : null,
    fixes: Array.isArray(body.fixes)
      ? body.fixes.slice(0, 20).map((x) => ({ you_said: text(x?.you_said, 300), better: text(x?.better, 300), why: text(x?.why, 500) }))
      : null,
    minutes: num(body.minutes, 300),
    said: Math.round(num(body.said, 2000)),
    xp: Math.round(num(body.xp, 100000)),
    msgCount: Math.round(num(body.msgCount, 100000)),
  };
}

// Keeps the newest copy of a call: a late, older request never replaces a newer one.
async function keepPending(snap, closing = false) {
  const prev = pending.calls[snap.callId];
  if (prev && snap.minutes + 0.05 < prev.minutes) {
    if (closing && !prev.closing) { prev.closing = true; await savePending(); }
    return;
  }
  pending.calls[snap.callId] = {
    ...prev,
    ...snap,
    history: snap.history ?? prev?.history ?? [],
    fixes: snap.fixes ?? prev?.fixes ?? [],
    started: prev?.started || Date.now(),
    updated: Date.now(),
    closing: closing || Boolean(prev?.closing),
    tries: prev?.tries || 0,
    nextTry: 0,
  };
  await savePending();
}

// Claude reviews the class. Nothing is written here: the result is kept in pending.json first.
async function askReview(snap) {
  const [profile, memory, progress, course] = await Promise.all([readDoc("profile"), readDoc("memory"), readDoc("progress"), readDoc("course")]);
  const set = settingsOf(profile);
  const mem = memory || {};
  const skills = (progress || {}).skills || {};
  const focusNow = activeFocus(course);
  const levelSkills = (SKILLS[set.level] || []).map((s) => skillLine(s, skills)).join("\n");
  const target = snap.skills;
  const system = `You are an expert English speaking coach and this learner's long-term personal coach (${set.tutor.name}). The learner is a French speaker who already speaks English and wants ${LEARNER_GOAL}. Write every explanation in ${set.lang}, warmly, as the coach talking to the learner ("tu"/"you"). Be specific and encouraging, never vague. Never assume the learner's gender: avoid gendered adjectives or participles about them.`;
  const prompt = `The class just ended (${MODE_LABEL[snap.mode] || "conversation"}, learner level ${set.level}${target.length ? `, target skill: ${target.join(", ")}` : ""}).

TASK 1 - Review the class.
- score: 0-100 for the learner's spoken English in this class (fluency, accuracy, range, natural wording), fair for their level.
- summary: 2 sentences. strengths: 1-3 items. fixes: the 1-4 most useful corrections (you_said, better = what a native speaker would say, why). Prefer what makes them sound French or less fluent: false friends, word-for-word structures, collocations, tenses, missing phrasal verbs.
- next_step: one concrete tip to practise before next class.
- next_class: one sentence telling the learner what you will do together next time.
- level_feel: the CEFR level this class shows, like "A2".
- words: up to 6 useful English words or expressions from this class that the learner should review ("es" = the English, "tr" = ${set.lang === "English" ? "a short plain-English definition" : "the French meaning"}); prefer phrasal verbs, idioms, collocations and work vocabulary they did not know or got wrong.

TASK 2 - Update their skills. For each skill of the curriculum that this class gave evidence about (used, practised or taught), give its new state: seen (introduced), practicing (used with mistakes), good (used correctly several times), mastered (used correctly, spontaneously and easily). Use the ids below. Only list skills with evidence.
${levelSkills}

TASK 3 - Update your long-term memory about the learner. Merge the current memory with anything new from this class: personal facts, interests, strengths, weak points, recurring mistakes. Keep old facts unless the class contradicts them. Do not store details about their company (clients, numbers, projects) or plan to follow up on it: they do not want classes to keep coming back to it. Stay short: about at most 12 items, interests at most 10, strengths and weak_points at most 6 each, recurring_mistakes at most 8. next_focus: one sentence on what to work on next. last_session: one sentence about what you talked about and anything to follow up next time.
The learner reads this memory in the app: write every item in ${set.lang}, as short notes that speak to them ("tu" in French, "you" in English), and never assume their gender. Example of last_session: ${set.lang === "French" ? "« On a parlé de ton travail. Tu as un entretien vendredi. »" : "\"We talked about your job. You have an interview on Friday.\""}

TASK 4 - What must improve. ${focusNow.length ? `The points you are working on: ${focusNow.map((f) => `${f.id} "${f.title}" (${f.score}/100)`).join("; ")}. In "focus", for each point this class gave real evidence about, give its score now (0-100, where 50 is a solid B1, 65 a solid B2, 80 a solid C1, 92 a solid C2: be honest, do not raise it out of kindness) and a short note in ${set.lang}. No evidence: leave it out. In "new_focus", add a new point (0 to 2) only if this class showed a repeated problem that is not in the list (title and why in ${set.lang}, you_said and better from the transcript).` : `Leave "focus" and "new_focus" empty.`}

Current memory:
${JSON.stringify({ about: mem.about || [], interests: mem.interests || [], strengths: mem.strengths || [], weak_points: mem.weak_points || [], recurring_mistakes: mem.recurring_mistakes || [], next_focus: mem.next_focus || "", last_session: mem.last_session || "" })}

Transcript (learner lines come from speech recognition, so ignore punctuation):
${transcript(snap.history)}`;
  const out = await askJSON({ model: modelFor(set, "deep"), system, messages: [{ role: "user", content: prompt }], schema: REVIEW_SCHEMA, effort: "medium", maxTokens: 24000 });
  return { ...out, level: set.level };
}

// The tutor writes the homework of a course lesson: practice of today's points, ready for the next lesson.
async function askHomework(full) {
  const [profile, memory, course] = await Promise.all([readDoc("profile"), readDoc("memory"), readDoc("course")]);
  const set = settingsOf(profile);
  const all = courseLessons(course);
  const at = all.findIndex((l) => l.id === full.lessonId);
  if (at < 0) return null;
  const l = all[at], next = all[at + 1];
  const mistakes = (memory?.recurring_mistakes || []).slice(0, 8).map((x) => `${x.pattern} ("${x.example}" -> "${x.fix}")`).join("; ");
  const L = set.lang;
  const system = `You are ${set.tutor.name}, this learner's English coach, writing homework after a lesson, like a great private tutor. The learner is a French speaker, level ${set.level}, who wants ${LEARNER_GOAL}. Write every instruction and explanation in ${L}${L === "French" ? ' ("tu")' : ""}; all practice content in natural American English, the way people really speak. Never assume the learner's gender.`;
  const prompt = `Lesson just done: "${l.title}" (unit ${l.unitNo}: ${l.unit.title}). Objectives: ${l.objectives.join("; ")}.${l.topic ? ` Topic: ${l.topic}.` : ""}
${next ? `Next lesson: "${next.title}". Objectives: ${next.objectives.join("; ")}.` : "This was the last lesson of the plan."}
Their recurring mistakes: ${mistakes || "none noted yet"}.
What must improve: ${activeFocus(course).map((f) => `${f.title} (${f.score}/100)`).join("; ") || "nothing noted yet"}.

Transcript (learner lines come from speech recognition):
${transcript(full.history)}

Write the homework for the days before the next lesson: about 15 to 25 minutes in all, 5 or 6 items, in this order:
1. type "words": the 6 to 8 most useful words or expressions from this lesson (words: es = English, tr = ${L === "English" ? "a short plain-English definition" : "French"}). In the app, the learner sees each one, hears it and says it aloud; then it goes to their flashcards.
2. type "quiz": exactly 5 questions on today's language points and the mistakes they made (questions: q, 3 options, answer = index of the right one, why = one short sentence in ${L}). Gap-fill questions are welcome ("We've been working on it ___ March"). In the app, they tap an answer and see why.
3. type "say": exactly 5 sentences to say aloud like a native speaker (prompts: tr = the sentence in French, es = a natural English version, tip = a short hint in ${L}); build them from their real mistakes in the transcript. In the app, they read the French, say it in English, and you check it.
4. type "speak": one speaking task of 60 to 90 seconds that reuses today's objectives in their own life, or in a general work situation if the lesson was about business, never about their company (task: what to talk about, in ${L}, with 2 or 3 phrases to use). In the app, they record their answer and you correct it.
5. type "write": one short realistic message (a text to a friend, or a work email if the lesson was about business, 50 to 100 words) using today's language (task, in ${L}). Skip it if the lesson was only about pronunciation. In the app, they type it and you correct it.
6. type "shadow": 5 or 6 short sentences from the lesson or close to it, natural spoken English, to shadow for smoother speech (sentences: plain text read aloud by a native voice, so no capitals for stress, no hyphens or slashes). In the app, they listen and speak along with the native voice, then compare their intonation.
For each item: title (short, in ${L}) and instructions (one or two sentences, in ${L}, describing what to do in the app, nothing outside it). Fields an item does not use are empty ("" or []). note: two friendly sentences from you about the lesson and why this homework matters.`;
  return askJSON({ model: modelFor(set, "chat"), system, messages: [{ role: "user", content: prompt }], schema: HOMEWORK_SCHEMA, effort: "medium", maxTokens: 12000 });
}

async function saveHomework(full, out, ts) {
  const course = await readDoc("course");
  const lesson = courseLessons(course).find((l) => l.id === full.lessonId);
  const text = (v, n) => String(v ?? "").slice(0, n);
  const items = (Array.isArray(out.items) ? out.items : []).filter((it) => HW_TYPES.includes(it?.type)).slice(0, 8).map((it) => {
    const base = { id: newId(), type: it.type, title: text(it.title, 120), instructions: text(it.instructions, 500) };
    if (it.type === "words") return { ...base, words: (it.words || []).slice(0, 10).map((w) => ({ es: text(w.es, 120), tr: text(w.tr, 160) })).filter((w) => w.es) };
    if (it.type === "quiz") return { ...base, questions: (it.questions || []).slice(0, 8).map((q) => ({ q: text(q.q, 300), options: (q.options || []).slice(0, 4).map((o) => text(o, 160)), answer: Number(q.answer) || 0, why: text(q.why, 300) })).filter((q) => q.options.length >= 2 && q.answer >= 0 && q.answer < q.options.length) };
    if (it.type === "say") return { ...base, prompts: (it.prompts || []).slice(0, 8).map((x) => ({ tr: text(x.tr, 300), es: text(x.es, 300), tip: text(x.tip, 200) })).filter((x) => x.tr && x.es) };
    if (it.type === "shadow") return { ...base, sentences: (it.sentences || []).slice(0, 8).map((x) => text(x, 200)).filter(Boolean) };
    return { ...base, task: text(it.task, 800) };
  }).filter((it) => it.words?.length || it.questions?.length || it.prompts?.length || it.sentences?.length || it.task);
  const due = nextSlot(course?.schedule, new Date(ts));
  const hwSet = { id: newId(), lessonId: full.lessonId, lessonTitle: lesson?.title || full.title, callId: full.callId, created: ts, due: due ? due.getTime() : null, note: text(out.note, 600), items };
  await updateDoc("homework", (cur) => {
    const sets = Array.isArray(cur?.sets) ? cur.sets : [];
    if (sets.some((x) => x.callId === full.callId)) return KEEP;
    return { ...(cur || {}), sets: [...sets, hwSet].slice(-60) };
  });
  return { id: hwSet.id, count: items.length, due: hwSet.due };
}

// ---------- The first session: 30 minutes of talk, then the whole course is built from it ----------
const ASSESS_TOTAL = 30, ASSESS_ENOUGH = 24, ASSESS_MIN = 10, ASSESS_MIN_WORDS = 200;
// Minutes, and what happens. A session cut short starts again at the first stage not done.
const ASSESS_STAGES = [
  [2, "Welcome. Tell them in two short sentences how today works: about half an hour, lots of topics, no corrections today, you only listen, so they talk as much as they can. Then ask them to introduce themselves."],
  [3, "Everyday life: their university exchange abroad, a normal day, who they live with, what is different from home. Present tenses and habits."],
  [3, "A story: ask for a real story from their exchange or a trip (funny, embarrassing or stressful). Let them tell it for a minute or more. Only short reactions and \"what happened next?\". Past tenses and linking."],
  [3, "Relationships: how they make friends abroad, a friend who is upset, a disagreement with someone. Then a quick informal role-play: you are their flatmate who keeps leaving the kitchen dirty, or a friend who cancels at the last minute."],
  [3, "Everyday situations: two quick role-plays, one after the other, with a person they do not know (a problem with a landlord, returning something to a store, asking a professor for an extension). Polite requests and the right words."],
  [3, "Opinions: something they care about. Disagree with them on purpose so that they must defend it and add nuance. Then a \"what would you do if...\" question."],
  [5, "Business, a presentation: they present a company for about two minutes, as if to a possible partner. They choose which one: invented, one they admire, or their own if they want to. Do not interrupt it. Then ask two hard questions, like a demanding client."],
  [4, "Business, situations: small talk before a meeting (30 seconds), then a role-play where they must disagree with you politely in a meeting, then one where they must say no to a deadline and offer something else. A professional tone."],
  [2, "Listening: tell a short story from your life at full native speed, with reductions and two idioms. Then ask them to tell you what happened and what one of the expressions meant."],
  [2, "End: ask what is hardest for them in English and what they want to be able to do in three months. Thank them, say one specific thing you enjoyed, tell them you are writing their plan now, and say goodbye (end_call true). Do not give a level or a score."],
];
const assessParts = (course) => (Array.isArray(course?.assess?.parts) ? course.assess.parts : []);
const countWords = (s) => String(s || "").trim().split(/\s+/).filter(Boolean).length;
function assessTotals(parts) {
  const said = parts.flatMap((x) => (x.history || []).filter((m) => m.who === "me"));
  const fromHistory = said.reduce((a, m) => a + countWords(m.text), 0);
  return {
    minutes: Math.round(parts.reduce((a, x) => a + (Number(x.minutes) || 0), 0) * 10) / 10,
    words: fromHistory || parts.reduce((a, x) => a + (Number(x.words) || 0), 0),
    turns: said.length || parts.reduce((a, x) => a + (Number(x.turns) || 0), 0),
  };
}
function addAssessPart(cur, full, ts) {
  const c = cur || {};
  const parts = assessParts(c);
  if (parts.some((x) => x.callId === full.callId)) return KEEP;
  return { ...c, assess: { ...(c.assess || {}), parts: [...parts, { callId: full.callId, at: ts, minutes: Math.round(full.minutes * 10) / 10, history: full.history }] } };
}
// The stages still to do, with their class times.
function assessBlock(set, a) {
  const done = Number(a?.done) || 0;
  let end = 0, at = 0;
  const lines = [];
  for (const [len, what] of ASSESS_STAGES) {
    end += len;
    if (end <= done + 0.5 && end < ASSESS_TOTAL) continue;
    lines.push(`- ${clock(at * 60000)} to ${clock((at + len) * 60000)}: ${what}`);
    at += len;
  }
  return `TODAY: THE FIRST SESSION (about ${set.minutes} minutes)
${done ? `You already talked for ${Math.round(done)} minutes in an earlier part of this session. Say in one friendly sentence that you are picking up where you stopped, without a new welcome.\n` : ""}${a?.goal ? `What they told you they want: ${a.goal}\n` : ""}This is not a class. You want to find out how they really speak, in many situations, so that you can build their whole course from it.
How you behave today:
- They talk at least 80% of the time. Your turns are 1 or 2 short sentences, then a question or a situation. Be warm and curious, like a good first conversation.
- No teaching and no corrections today. "correction" stays empty, no "board", no "words". Do not recast their mistakes. If they ask for a word, give it in a few words and go on.
- If they switch to French, say kindly that it is fine if it is not perfect, and ask them to try in English. Do not translate it for them.
- Look for their ceiling. When an answer comes easily, make the next question harder (why, what if, nuance). When they struggle, make the next one easier, then try higher again later.
- Keep moving: 2 to 4 exchanges on a topic is enough. Follow the class time below, and move on even if a topic is going well. Move on in a natural way, in one short sentence.
Stages:
${lines.join("\n")}`;
}
// Numbers from the words alone. The tutor cannot hear the voice: no pause times, no accent.
function speechStats(parts) {
  const said = parts.flatMap((x) => (x.history || []).filter((m) => m.who === "me").map((m) => String(m.text || "")));
  const n = said.map(countWords);
  const words = n.reduce((a, b) => a + b, 0);
  const fillers = said.join(" ").toLowerCase().match(/\b(uh+|um+|euh+|hmm+)\b/g)?.length || 0;
  const french = said.filter((s) => /\b(je|tu|est|c'est|ça|mais|alors|enfin|parce que|comment|oui|non|pas|avec|pour)\b/i.test(s) && !/\b(the|and|is|it|to|of)\b/i.test(s)).length;
  const minutes = parts.reduce((a, x) => a + (Number(x.minutes) || 0), 0);
  return { minutes: Math.round(minutes), answers: said.length, words, words_per_minute_of_class: minutes ? Math.round(words / minutes) : 0, average_words_per_answer: said.length ? Math.round(words / said.length) : 0, longest_answer_in_words: n.length ? Math.max(...n) : 0, hesitation_sounds_per_100_words: words ? Math.round((fillers / words) * 1000) / 10 : 0, answers_all_in_french: french };
}
// Claude listens again to everything that was said, and writes the level and what must improve.
async function askAssessment(parts, course, { previous = null } = {}) {
  const [profile, memory] = await Promise.all([readDoc("profile"), readDoc("memory")]);
  const set = settingsOf(profile);
  const L = set.lang;
  const system = `You are an expert examiner of spoken English (CEFR) and ${set.tutor.name}, this learner's coach. You are fair, specific and honest: a kind but flattering assessment would ruin the course built from it. Write in ${L}${L === "French" ? ' ("tu")' : ""}, in plain words and short sentences, speaking to the learner. Never assume the learner's gender.`;
  const talk = parts.map((x, i) => `${parts.length > 1 ? `--- Part ${i + 1} ---\n` : ""}${(x.history || []).map((m) => `${m.who === "me" ? "Learner" : "Tutor"}: ${m.text}`).join("\n")}`).join("\n");
  const prompt = `${previous ? "A checkpoint lesson just ended. Measure the learner again, on the same scale as their first session, from this class only." : "The first session just ended: a long conversation with no corrections, across many situations, made to measure the learner."}
The learner is a French speaker who wants ${String(course?.goal || LEARNER_GOAL).slice(0, 600)}.
What you knew before: ${memoryText(memory)}
Numbers from the transcript: ${JSON.stringify(speechStats(parts))}
${previous ? `The first session gave: level ${previous.level}; ${(previous.scores || []).map((s) => `${s.id} ${s.score}`).join(", ")}.\n` : ""}
Scale for all scores: 0 to 100, where 50 is a solid B1, 65 a solid B2, 80 a solid C1, 92 a solid C2. Use the whole scale. Judge what they did, not what they might do.

Warnings about the evidence:
- The learner's lines come from speech recognition. A strange word that does not fit may be a mis-hearing: count it as a mistake only if the same thing comes back. Ignore punctuation and capital letters. Hesitation sounds are real.
- You cannot hear them: never judge the accent or the pronunciation, and do not say anything about it.
- A situation that did not come up has no evidence: give its score from what is closest, and say in its comment that you saw little of it.

Write:
- level: their overall spoken level. summary: 3 short sentences: how their English is today, what stands out, what holds them back most.
- strengths: 3 specific things they already do well, with their own words when it helps.
- scores: exactly one per id: fluency (keeps talking, long answers, little hesitation, no French), words (the right word for the situation: register, collocations, false friends, precise vocabulary), structures (word order, tenses, questions, long linked sentences), business (presenting, meetings, a professional tone), daily (everyday life, friends, feelings, disagreements), listening (understood the tutor, followed fast natural speech). For each: score, level (like "B2"), comment: one short sentence that says what you saw.
- priorities: the 4 to 7 things that will change the most for their goal, most important first. title: short and concrete ("Le present perfect avec for et since", not "Grammar"). why: one sentence. track: business, daily, words, structures or fluency. score: where this is today. examples: 1 to 3 pairs from the transcript: you_said = their exact words, better = what a native would say.
- weeks: how many weeks of this course, at 3 lessons a week, for this goal: 8 to 16.
- plan_note: 2 short sentences to the learner: how the course will be built from this.

Transcript:
${talk.slice(-90000)}`;
  const out = await askJSON({ model: modelFor(set, "deep"), system, messages: [{ role: "user", content: prompt }], schema: ASSESS_SCHEMA, effort: "high", maxTokens: 12000 });
  const num = (v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
  const text = (v, n) => String(v ?? "").slice(0, n);
  return {
    level: LEVEL_IDS.includes(out.level) ? out.level : set.level,
    summary: text(out.summary, 800),
    strengths: (Array.isArray(out.strengths) ? out.strengths : []).slice(0, 4).map((x) => text(x, 300)),
    scores: ASSESS_DIMS.map((id) => { const s = (out.scores || []).find((x) => x?.id === id); return { id, score: num(s?.score), level: text(s?.level, 4), comment: text(s?.comment, 300) }; }),
    priorities: (Array.isArray(out.priorities) ? out.priorities : []).slice(0, 7).map((x) => ({ title: text(x?.title, 120), why: text(x?.why, 300), track: TRACKS.includes(x?.track) ? x.track : "fluency", score: num(x?.score), examples: (Array.isArray(x?.examples) ? x.examples : []).slice(0, 3).map((e) => ({ you_said: text(e?.you_said, 300), better: text(e?.better, 300) })) })).filter((x) => x.title),
    weeks: Math.max(8, Math.min(16, Math.round(Number(out.weeks) || 12))),
    planNote: text(out.plan_note, 500),
    at: Date.now(),
  };
}
// Writes the result: the level, what must improve, and the old plan gives way (the page then asks for the new one).
async function writeAssessment() {
  const course = await readDoc("course");
  const res = await askAssessment(assessParts(course), course);
  await updateDoc("course", (cur) => {
    const c = cur || {};
    const { plan, lessons, ...rest } = c;
    return {
      ...rest,
      lessons: {},
      ...(plan ? { oldPlans: [...(Array.isArray(c.oldPlans) ? c.oldPlans : []), { plan, lessons, until: Date.now() }].slice(-3) } : {}),
      assess: { ...(c.assess || {}), result: res, parts: assessParts(c).map((x) => ({ callId: x.callId, at: x.at, minutes: x.minutes, words: (x.history || []).filter((m) => m.who === "me").reduce((a, m) => a + countWords(m.text), 0), turns: (x.history || []).filter((m) => m.who === "me").length })) },
      focus: res.priorities.map((x, i) => ({ id: `p${i + 1}`, title: x.title, why: x.why, track: x.track, start: x.score, score: x.score, examples: x.examples, history: [] })),
    };
  });
  await updateDoc("profile", (cur) => ({ ...(cur || {}), level: res.level }));
  return { status: "done" };
}
// What must improve, weakest first (a point at 85 or more is done).
const activeFocus = (course) => (Array.isArray(course?.focus) ? course.focus : []).filter((f) => f && !(Number(f.score) >= 85)).sort((a, b) => a.score - b.score).slice(0, 8);
function focusLine(focus) {
  if (!Array.isArray(focus) || !focus.length) return "";
  return `\n\nWHAT YOU ARE IMPROVING WITH THEM (weakest first, score out of 100)\n${focus.map((f) => `- ${f.title} (${f.score}): ${f.why}${f.examples?.[0]?.you_said ? ` They said "${f.examples[0].you_said}"; better: "${f.examples[0].better}".` : ""}`).join("\n")}\nBring one or two of these into every class, whatever the topic, so that they practise them without noticing. Praise real progress on them when you hear it.`;
}
// After a class: new scores for what must improve. A class moves a score halfway, so one good day does not close a point.
function updateFocus(cur, out, ts) {
  const list = Array.isArray(cur?.focus) ? cur.focus : [];
  const scores = Array.isArray(out.focus) ? out.focus : [];
  const fresh = Array.isArray(out.new_focus) ? out.new_focus : [];
  if (!list.length || (!scores.length && !fresh.length)) return KEEP;
  const num = (v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
  const next = list.map((f) => {
    const s = scores.find((x) => x?.id === f.id);
    return s ? { ...f, score: Math.round((Number(f.score) + num(s.score)) / 2), note: String(s.note || "").slice(0, 300), history: [...(f.history || []), { at: ts, score: num(s.score) }].slice(-20) } : f;
  });
  for (const x of fresh.slice(0, 2)) {
    if (!x?.title || next.length >= 12 || next.some((f) => f.title === x.title)) continue;
    next.push({ id: `p${next.length + 1}`, title: String(x.title).slice(0, 120), why: String(x.why || "").slice(0, 300), track: TRACKS.includes(x.track) ? x.track : "fluency", start: num(x.score), score: num(x.score), examples: x.you_said ? [{ you_said: String(x.you_said).slice(0, 300), better: String(x.better || "").slice(0, 300) }] : [], history: [], added: ts });
  }
  return { ...cur, focus: next };
}
// The first session's result, for the plan's prompt.
function assessText(a) {
  if (!a) return "";
  return `WHAT THEIR FIRST 30-MINUTE SESSION SHOWED (build the plan on this):
Level ${a.level}. ${a.summary}
Scores out of 100 (50 is a solid B1, 65 B2, 80 C1): ${(a.scores || []).map((s) => `${s.id} ${s.score} (${s.comment})`).join("; ")}.
What must improve, most important first:
${(a.priorities || []).map((x, i) => `- p${i + 1} ${x.title}, track ${x.track}, score ${x.score}: ${x.why}${x.examples?.[0]?.you_said ? ` Example: "${x.examples[0].you_said}" -> "${x.examples[0].better}".` : ""}`).join("\n")}
`;
}
const planSkills = (from) => LEVEL_IDS.slice(from).flatMap((lv) => (SKILLS[lv] || []).filter((s) => !IT_SKILLS.has(s.id) && !ACCENT_SKILLS.has(s.id)).map((s) => `- ${s.id} [${lv}] "${s.title.en}": ${s.teach}`)).join("\n");

// Writes the class: skills, memory, words (only with a review), then minutes, XP and the diary entry.
async function recordClass(full, out, p) {
  const steps = p.steps || (p.steps = {});
  const step = async (key, fn) => { if (steps[key]) return; await fn(); steps[key] = true; await savePending(); };
  const ts = full.updated || Date.now();
  if (out) await step("focus", () => updateDoc("course", (cur) => updateFocus(cur, out, ts)));
  const day = dayKeyOf(new Date(ts));
  const r = out ? (({ memory: _m, skills: _s, level: _l, ...rest }) => rest)(out) : null;
  const score = r ? Math.max(0, Math.min(100, Math.round(Number(r.score) || 0))) : null;

  if (out) {
    await step("progress", async () => {
      const now = Date.now();
      let before = 0;
      let after = 0;
      const prog = await updateDoc("progress", (cur) => {
        const base = (cur && cur.skills) || {};
        const next = { ...base };
        for (const s of Array.isArray(out.skills) ? out.skills : []) {
          if (!SKILL_BY_ID[s?.id] || !STATES.includes(s.state)) continue;
          const prev = next[s.id] || { state: "new", count: 0 };
          next[s.id] = { state: s.state, count: (prev.count || 0) + 1, last: now, first: prev.first || now };
        }
        before = levelProgress(out.level, base);
        after = levelProgress(out.level, next);
        return { ...(cur || {}), skills: next, updated: new Date().toISOString() };
      });
      const idx = LEVEL_IDS.indexOf(out.level);
      const levelUp = after >= 0.8 && idx >= 0 && idx < LEVEL_IDS.length - 1 ? LEVEL_IDS[idx + 1] : null;
      p.progressOut = { skills: prog.skills, before, after, levelUp, changed: out.skills || [] };
    });
    await step("memory", async () => {
      p.memoryOut = await updateDoc("memory", (cur) => ({
        ...out.memory,
        level_estimate: out.level_feel,
        sessions: (Number(cur?.sessions) || 0) + 1,
        updated: new Date().toISOString(),
      }));
    });
    await step("vocab", async () => {
      const added = [];
      await updateDoc("vocab", (cur) => {
        const v = { ...(cur || {}), words: Array.isArray(cur?.words) ? cur.words : [] };
        const have = new Set(v.words.map((w) => wordKeyOf(w?.es || "")));
        for (const w of Array.isArray(r.words) ? r.words : []) {
          const es = String(w?.es || "").trim();
          if (!es || have.has(wordKeyOf(es))) continue;
          have.add(wordKeyOf(es));
          const tr = String(w.tr || "").trim();
          v.words.push({ id: newId(), es, tr, box: 0, due: todayKey(), added: Date.now(), from: "class" });
          added.push({ es, tr });
        }
        if (v.words.length > 3000) v.words.splice(0, v.words.length - 3000);
        return v;
      });
      p.added = added;
    });
  }
  await step("profile", () => updateDoc("profile", (cur) => addClassToProfile(cur || {}, { xp: out ? 20 : 0, minutes: full.minutes, day })));
  await step("journal", async () => {
    const entry = {
      id: newId(), callId: full.callId, kind: "call", mode: full.mode, ts, date: day, title: full.title, tutor: full.tutor,
      ...(full.sceneId ? { sceneId: full.sceneId } : {}),
      turns: full.said, minutes: Math.round(full.minutes * 10) / 10, score,
      summary: r?.summary || "", strengths: r?.strengths || [], fixes: r ? r.fixes || [] : full.fixes.slice(0, 4),
      next: r?.next_step || "", nextClass: r?.next_class || "", levelFeel: r?.level_feel || "", xp: full.xp + (out ? 20 : 0),
    };
    await updateDoc("journal", (cur) => {
      const j = { ...(cur || {}), entries: Array.isArray(cur?.entries) ? cur.entries : [] };
      if (j.entries.some((e) => e?.callId === full.callId)) return j;
      const at = j.entries.findIndex((e) => (Number(e?.ts) || 0) < ts);
      j.entries.splice(at < 0 ? j.entries.length : at, 0, entry);
      if (j.entries.length > 400) j.entries.length = 400;
      return j;
    });
    p.entry = entry;
  });
  if (lessonCounts(full)) {
    await step("course", () => updateDoc("course", (cur) => {
      if (!cur?.plan) return KEEP;
      const lessons = { ...(isObj(cur.lessons) ? cur.lessons : {}) };
      lessons[full.lessonId] = { done: ts, date: day, callId: full.callId, score };
      // A week is finished: the next one gets written again from what it showed (the page asks for it: /api/course/adapt).
      const units = cur.plan.units || [];
      const ui = units.findIndex((u) => (u.lessons || []).some((l) => l.id === full.lessonId));
      const finished = ui >= 0 && units[ui].lessons.every((l) => lessons[l.id]);
      const nextFree = finished && units[ui + 1] && !units[ui + 1].lessons.some((l) => lessons[l.id]);
      return { ...cur, lessons, ...(nextFree ? { adaptDue: ui + 2 } : {}) };
    }));
    // A checkpoint: measured like the first session, against it.
    await step("checkpoint", async () => {
      const course = await readDoc("course");
      const l = courseLessons(course).find((x) => x.id === full.lessonId);
      if (!l?.checkpoint) return;
      const res = await askAssessment([{ minutes: full.minutes, history: full.history }], course, { previous: course?.assess?.result });
      await updateDoc("course", (cur) => ({ ...(cur || {}), assess: { ...(cur?.assess || {}), history: [...(cur?.assess?.history || []), { at: ts, lessonId: full.lessonId, level: res.level, summary: res.summary, scores: res.scores }].slice(-6) } }));
      await updateDoc("profile", (cur) => ({ ...(cur || {}), level: res.level }));
      p.checkpointOut = { level: res.level, summary: res.summary };
    });
    if (p.hwOut) await step("homework", async () => { p.hwSet = await saveHomework(full, p.hwOut, ts); });
  }
  // The first session: the words are kept, and the assessment is written when enough was said.
  if (full.mode === "assess") {
    await step("assess", async () => {
      const course = await updateDoc("course", (cur) => addAssessPart(cur, full, ts));
      const totals = assessTotals(assessParts(course));
      p.assessOut = totals.minutes >= ASSESS_ENOUGH ? await writeAssessment() : { status: "partial", ...totals, canWrite: totals.minutes >= ASSESS_MIN && totals.words >= ASSESS_MIN_WORDS };
    });
  }
  return { assess: p.assessOut || null, checkpoint: p.checkpointOut || null, review: r ? { ...r, score } : null, memory: p.memoryOut || null, progress: p.progressOut || null, added: p.added || [], entry: p.entry || null, msgCount: full.msgCount || 0, homework: p.hwSet || null };
}

// A course lesson counts (done, homework) only after a real class: a 1-minute demo or a dropped call leaves it to do.
const LESSON_MIN_MINUTES = 8;
const lessonCounts = (full) => Boolean(full.lessonId) && Number(full.minutes) >= LESSON_MIN_MINUTES;

const emptyResult = (done = false) => ({ review: null, memory: null, progress: null, added: [], entry: null, ...(done ? { done: true } : {}) });

// Finishes a class once. A second request for the same call gets the same result.
async function finishCall(snap, { review = true } = {}) {
  const id = snap.callId;
  if (pending.done[id]) return pending.done[id].result || emptyResult(true);
  if (finishing.has(id)) return finishing.get(id);
  const job = (async () => {
    const p = pending.calls[id] || (pending.calls[id] = { ...snap, history: snap.history ?? [], fixes: snap.fixes ?? [], started: Date.now(), updated: Date.now() });
    const full = { ...p, ...snap, history: snap.history ?? p.history ?? [], fixes: snap.fixes ?? p.fixes ?? [], updated: p.updated };
    let result = emptyResult();
    if (full.said > 0) {
      if (review && !p.out) {
        // A course lesson: the homework is written at the same time as the review (no extra wait).
        const homework = lessonCounts(full) && !p.hwOut ? askHomework(full).catch((err) => { console.warn("  Homework not written:", err.message); return null; }) : null;
        const [out, hw] = await Promise.all([askReview(full), homework]);
        p.out = out;
        if (hw) p.hwOut = hw;
        await savePending();
      }
      result = await recordClass(full, p.out || null, p);
    }
    delete pending.calls[id];
    pending.done[id] = { at: Date.now(), result, msgCount: full.msgCount || 0 };
    await savePending();
    return result;
  })();
  finishing.set(id, job);
  try { return await job; } finally { finishing.delete(id); }
}

// Finishes a class in the background. If Claude cannot answer (no internet, no credit), it tries again later.
function finishLater(id) {
  const snap = pending.calls[id];
  if (!snap || finishing.has(id)) return;
  finishCall(snap).then(
    () => console.log("  A class was saved after the window closed (review, memory, words, diary)."),
    async (err) => {
      const p = pending.calls[id];
      if (!p) return;
      if (PERMANENT.has(err?.code)) { finishCall(p, { review: false }).catch(() => {}); return; }
      p.tries = (p.tries || 0) + 1;
      p.nextTry = Date.now() + Math.min(6 * 3_600_000, 5 * 60_000 * 2 ** (p.tries - 1)); // 5 min, 10, 20 … at most 6 h
      await savePending();
      console.warn(`  A class is waiting for its review (${err.message}). Fluent will try again later.`);
    });
}

function sweepPending() {
  const now = Date.now();
  for (const [id, snap] of Object.entries(pending.calls)) {
    try {
      if (finishing.has(id)) continue;
      if (now - (Number(snap.started) || now) > GIVE_UP_MS) { finishCall(snap, { review: false }).catch(() => {}); continue; }
      if (!getClient()) continue;
      if (!snap.closing && now - (Number(snap.updated) || 0) < ABANDONED_MS) continue;
      if (snap.nextTry && now < snap.nextTry) continue;
      finishLater(id);
    } catch (err) {
      console.warn("  Skipped a damaged unsaved class:", err.message);
      delete pending.calls[id];
    }
  }
  let changed = false;
  for (const [id, d] of Object.entries(pending.done)) {
    if (now - d.at > DONE_KEEP_MS) { delete pending.done[id]; changed = true; } else if (d.result && now - d.at > RESULT_KEEP_MS) { delete d.result; changed = true; }
  }
  if (changed) savePending();
}
setInterval(sweepPending, 60_000).unref();

// ---------- HTTP ----------
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json",
  ".webmanifest": "application/manifest+json", ".webp": "image/webp", ".glb": "model/gltf-binary", ".jpg": "image/jpeg",
};

async function readRaw(req, max) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new AppError(413, "too_big", "Request too big.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2_000_000) throw new AppError(413, "too_big", "Request too big.");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new AppError(400, "bad_json", "Invalid JSON."); }
}

function send(res, status, data) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  }
}

// A request from this Mac's own browser (not through the phone tunnel).
function isLocal(req) {
  const addr = req.socket.remoteAddress || "";
  const loopback = addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
  const proxied = req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || req.headers["cf-ray"];
  const host = String(req.headers.host || "");
  return loopback && !proxied && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
}

const server = http.createServer(async (req, res) => {
  const local = isLocal(req);
  try {
    let pathname;
    try { ({ pathname } = new URL(req.url, `http://${HOST}`)); } catch { throw new AppError(400, "bad_request", "Bad address."); }
    if (!local) {
      // Through the phone link only: it must be on, and the request must come through Cloudflare.
      const host = String(req.headers.host || "");
      const viaTunnel = Boolean(remote.url && req.headers["cf-connecting-ip"]);
      const hostOk = Boolean(remote.url) && (host === new URL(remote.url).host || /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host));
      if (!viaTunnel || !hostOk) throw new AppError(403, "forbidden", "Forbidden.");
    }
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    if (!pathname.startsWith("/api/")) return await serveStatic(req, res, pathname);

    const origin = req.headers.origin;
    if (origin) {
      const ok = local ? /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) : origin === remote.url;
      if (!ok) throw new AppError(403, "forbidden", "Forbidden.");
    }
    const route = `${req.method} ${pathname}`;
    if (!local) {
      if (route === "POST /api/login") return send(res, 200, await login(req, res, await readBody(req)));
      if (!(await remoteAuthed(req))) {
        if (route === "GET /api/status") return send(res, 200, { needLogin: true, local: false });
        throw new AppError(401, "need_login", "Enter your PIN.");
      }
      if (LOCAL_ONLY.has(route)) throw new AppError(403, "local_only", "Do this on the Mac.");
    }

    if (route === "POST /api/turn") return await streamTurn(req, res, await readBody(req));
    // The streamed voice of a sentence: one JSON line per piece of sound ({a: base64 PCM, 24 kHz}), then
    // {words, end}. {fallback: true}: no stream for this one, the page asks /api/audio/:key as before.
    const liveAudio = pathname.match(/^\/api\/audio\/([A-Za-z0-9_-]{8,20})\/live$/);
    if (liveAudio && req.method === "GET") {
      const job = audioJobs.get(liveAudio[1]);
      if (!job) throw new AppError(404, "not_found", "No such audio.");
      res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-accel-buffering": "no" });
      const live = job.live;
      if (!live) { res.end(JSON.stringify({ fallback: true }) + "\n"); return; }
      let sent = 0, sentChars = 0;
      const pump = () => {
        if (res.writableEnded) return;
        if (sentChars < (live.chars?.length || 0)) { res.write(JSON.stringify({ c: sentChars, t: live.chars.slice(sentChars) }) + "\n"); sentChars = live.chars.length; }
        while (sent < live.pieces.length) res.write(JSON.stringify({ a: live.pieces[sent++].toString("base64") }) + "\n");
        if (!live.done) return;
        live.subs.delete(pump);
        res.end(JSON.stringify(live.fallback && !sent ? { fallback: true } : live.error ? { error: true } : { words: live.words || [], end: live.end }) + "\n");
      };
      live.subs.add(pump);
      res.on("close", () => live.subs.delete(pump));
      pump();
      return;
    }
    const audio = pathname.match(/^\/api\/audio\/([A-Za-z0-9_-]{8,20})$/);
    if (audio && req.method === "GET") {
      const job = audioJobs.get(audio[1]);
      if (!job) throw new AppError(404, "not_found", "No such audio.");
      return await sendAudio(res, await job.promise);
    }
    // The learner's voice (raw audio body) -> Whisper's text. The tutor's last words come in x-context.
    if (route === "POST /api/shadow/score") return await shadowScore(req, res, { readRaw, send, AppError });
    // Live ears: a one-connection pass to Scribe v2 Realtime (the page streams the mic to it).
    if (route === "POST /api/stt/live") {
      try { return send(res, 200, await STT.liveScribe()); } catch (e) {
        if (e instanceof STT.SttError) throw new AppError(e.status, e.code, e.message);
        throw e;
      }
    }
    // Numbers about a call's sound, no voice and no words (see SoundLog in audio.js).
    if (route === "POST /api/sound-log") {
      const body = await readBody(req);
      const row = {};
      for (const [k, v] of Object.entries(body || {}).slice(0, 40)) if (/^\w{1,20}$/.test(k) && ["number", "boolean", "string"].includes(typeof v)) row[k] = typeof v === "string" ? v.slice(0, 80) : v;
      await fs.appendFile(path.join(DATA, "sound-log.jsonl"), JSON.stringify(row) + "\n").catch(() => {});
      return send(res, 200, { ok: true });
    }
    if (route === "POST /api/stt") {
      if (!STT.hasSttKey(ENV_FILE)) throw new AppError(400, "no_stt_key", "No Groq key.");
      const audio = await readRaw(req, 8_000_000);
      if (audio.length < 1000) return send(res, 200, { text: "" });
      let context = "";
      try { context = decodeURIComponent(String(req.headers["x-context"] || "")); } catch { /* none */ }
      try {
        const out = await STT.transcribe(audio, String(req.headers["content-type"] || ""), context);
        console.log(`  [stt] ${out.engine} ${out.ms} ms, ${Math.round(audio.length / 1024)} KB, ${out.language}: ${out.text.slice(0, 120)}`);
        return send(res, 200, out);
      } catch (e) {
        if (e instanceof STT.SttError) { console.warn("  [stt]", e.message); throw new AppError(e.status, e.code, e.message); }
        throw e;
      }
    }
    if (route === "POST /api/tts") {
      const body = await readBody(req);
      const text = String(body.text || "").replace(/\s+/g, " ").trim().slice(0, 1200);
      if (!text) throw new AppError(400, "bad_request", "No text.");
      const voice = String(body.voice || "") || (await defaultVoiceFor(TUTORS[body.tutor] ? body.tutor : "emma"));
      return await sendAudio(res, await synth(text, voice, body.rate, "", String(body.mood || "")));
    }
    const docMatch = pathname.match(/^\/api\/state\/([a-z]+)$/);
    if (docMatch && req.method === "PUT") {
      const name = docMatch[1];
      const body = await readBody(req);
      if (!DOCS.includes(name)) throw new AppError(404, "not_found", "Unknown data file.");
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new AppError(400, "bad_request", "Data must be an object.");
      let newer = null;
      const saved = await updateDoc(name, (cur) => {
        if ((Number(cur?._rev) || 0) !== (Number(body._rev) || 0)) { newer = cur; return KEEP; }
        return body;
      });
      if (newer) return send(res, 409, { error: { code: "conflict", message: "The Mac has newer data." }, doc: newer });
      return send(res, 200, { ok: true, rev: saved._rev });
    }
    const handler = handlers[route];
    if (!handler) throw new AppError(404, "not_found", "Not found.");
    const body = req.method === "POST" ? await readBody(req) : {};
    send(res, 200, await handler(body, { local }));
  } catch (err) {
    const e = err?.code === "bad_voice" && !(err instanceof AppError) ? new AppError(400, "bad_voice", "Unknown voice.") : err;
    if (res.headersSent) { try { res.end(); } catch { /* closed */ } return; }
    if (e instanceof AppError) return send(res, e.status, { error: { code: e.code, message: e.message } });
    console.error(e);
    send(res, 500, { error: { code: "server_error", message: "Something went wrong on the server. Look at the Terminal window." } });
  }
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.log(`\n  Fluent is already running: http://localhost:${PORT}\n  You can close this window.\n`);
    process.exit(0);
  }
  throw err;
});
server.listen(PORT, HOST, () => {
  console.log(`\n  Fluent is running:  http://localhost:${PORT}\n  Keep this window open while you practise. Press Ctrl+C to stop.\n`);
  setTimeout(sweepPending, 5000); // classes left unfinished last time
});
