"use strict";
// Fluent — the video call with the tutor.
// Low latency: the reply streams in sentence by sentence and each sentence plays as soon as its
// audio exists. While the learner pauses, the next reply is already being prepared ("speculative
// turn"); if they keep talking it is thrown away, if they stop it plays right away.

const PHASES = [
  ["warmup", "Warm-up", "Échauffement"], ["learn", "Discover", "Découverte"], ["practice", "Practice", "Pratique"],
  ["free", "Conversation", "Conversation"], ["wrapup", "Wrap-up", "Bilan"],
];
const SPEC_MS = 300; // quiet time before we start preparing the reply (it plays only after the full pause)
const SPEC_LIVE_MS = 150; // the same with the live ears: their words are already Scribe's, so no need to wait as long
const RESUME_MS = 3000; // talking (or a tap) in the first seconds of the tutor's answer means "I was not finished"
const BARGE_WORDS = 2; // words of the learner's own (not the tutor's voice coming back) that stop the tutor
const DUCK_MS = 1300; // one word of the learner's lowers the tutor's voice; no second word by then: back to full
// Sounds a listener makes without taking the turn ("yeah", "mhm", "right"): they never stop the tutor.
const BACKCHANNEL = new Set(("yeah yes yep yup mhm mmm hmm huh uhhuh ooh okay right sure cool nice wow aha haha exactly true totally indeed "
  + "alright great interesting really got see fair enough makes sense definitely absolutely").split(" "));
// Words that mean "let me talk": one of them is enough.
const TAKE_TURN = new Set("wait sorry stop actually but hold hang excuse pardon what sec second moment".split(" "));

// Words people say while they look for the next word: "y…", "pero…", "eh…". After one of them, wait longer.
const HESITATION = /(?:^|\s)(uh+|um+|erm+|e+h|mm+|hmm+|euh+|so|and|but|or|because|that|which|the|a|an|to|of|in|on|with|for|my|your|is|are|was|like|if|when|than|more|very|really|kind of|sort of|i mean)$/i;

// How long the learner can pause before their turn is sent: [they sound finished, they may go on].
// 2026-10-29: a C1 learner had 0.7 s and felt rushed; a slower answer is better than being cut off mid-thought.
function pauseRange() {
  const p = S.profile.patience;
  if (p === "short") return [800, 1800];
  if (p === "normal") return [1200, 2600];
  if (p === "long") return [1800, 3600];
  return { A1: [1800, 3600], A2: [1600, 3400], B1: [1400, 3000] }[S.profile.level] || [1200, 2800];
}
// finished: what the quick check on the live words said (/api/react), or null while it is not back.
// Without it: longer after "and…", "but…", "the…" (they are looking for the next word). A voice still
// making sound ("eeeh…") never counts as a pause (see checkSilence).
function patienceMs(text = "", finished = null) {
  const [done, more] = pauseRange();
  if (finished != null) return finished ? done : more;
  const raw = String(text).trim();
  const t = raw.replace(/[.,;:!?…]+$/, ""); // the live ears add a full stop at the end of what they heard so far
  if (HESITATION.test(t) || /(\.\.|…)$/.test(raw)) return more;
  return done + (t.split(/\s+/).length < 4 ? 600 : 400);
}
// The reply prepared during the pause still fits what was finally heard (the browser often fixes a word at the end).
// exact: the live ears' words are Scribe's own, so a changed word is a real change ("Jeff" -> "Jake"): start again.
function sameTurn(a, b, exact = false) {
  const A = normText(a).split(" "), B = normText(b).split(" ");
  if (A.join(" ") === B.join(" ")) return true;
  if (exact) return false;
  return B.length >= 4 && A.length === B.length && lev(A, B) <= 1;
}
// Barge-in: while the tutor thinks and speaks, the mic stays open. What it hears may be the tutor's own
// voice coming back through the speakers (echo): words the tutor is saying do not count as the learner's.
// The tutor's words, and each pair of words joined ("roll out" heard as "rollout").
function echoTokens(text) {
  const t = normText(text).split(" ").filter(Boolean);
  return new Set([...t, ...t.slice(1).map((w, i) => t[i] + w)]);
}
const subWords = (word) => normText(word).split(" ").filter(Boolean); // "I've" -> i, ve; "2:00" -> 2, 00
// A heard word is the tutor's own when all its parts are: numbers are written many ways ("2", "2:00"), so they never count.
// Numbers said in words ("forty", "ten thirty") for digits the tutor wrote ("40", "10:30") are neutral too.
const NUMBER_WORDS = /^(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|point|percent|half|quarter|oh|am|pm)$/;
const isEcho = (word, echo) => subWords(word).every((w) => /^\d+$/.test(w) || NUMBER_WORDS.test(w) || echo.has(w)
  || (w.length > 3 && [...echo].some((e) => e.length > 3 && lev(e, w) <= 1))
  || (w.length === 3 && [...echo].some((e) => e.length === 4 && e.startsWith(w)))); // "you" for "your"
// What the mic heard, word by word: { w, own } (own: not the tutor's echo).
function heardWords(text, echo) {
  const raw = String(text || "").trim().split(/\s+/).filter(Boolean);
  const keys = raw.map((w) => normText(w).replace(/ /g, ""));
  const own = raw.map((w, i) => Boolean(keys[i]) && !isEcho(w, echo));
  // A tutor's word heard split in two ("back off" for "backoff") is the tutor's too.
  for (let i = 0; i + 1 < raw.length; i++) if (echo.has(keys[i] + keys[i + 1])) own[i] = own[i + 1] = false;
  return keys.map((w, i) => ({ w, own: own[i] }));
}
// The learner's own words: not the tutor's, and at least 3 letters (short words are too easy to mishear; "no" and "so" count).
const counts = (x) => x.own && (x.w.length >= 3 || x.w === "no" || x.w === "so");
function learnerWords(text, echo) {
  return heardWords(text, echo).filter(counts).map((x) => x.w);
}
// How many words at the start of what the mic heard are the tutor's echo. The learner's turn starts at their
// first word, with up to 2 short words before it ("I" in "I think": the tutor says "I" too).
function echoLead(text, echo) {
  const list = heardWords(text, echo);
  let i = list.findIndex(counts);
  if (i < 0) return list.length;
  for (let k = 0; k < 2 && i > 0 && list[i - 1].w.length <= 2; k++) i--;
  return i;
}
// The tutor's words in order, one per word ("I've" -> ive, "2" -> two).
const echoList = (text) => String(text || "").split(/\s+/).map(normToken).filter(Boolean);
// How many words at the start of what the mic heard repeat the tutor's words in order (their echo).
// One misheard or missed word is allowed; a lone common word ("I", "so") is not echo. The mic opens when the
// tutor starts talking, so their echo starts with their first words (the mic may miss the first 2 or 3).
function echoPrefix(heard, list) {
  const same = (a, b) => a === b || /^\d+$/.test(a) || NUMBER_WORDS.test(a) || (a.length > 3 && b.length > 3 && lev(a, b) <= 1);
  let best = 0;
  for (let s = 0; s < Math.min(list.length, 4); s++) {
    if (!same(heard[0] || "", list[s])) continue;
    let i = 0, j = s, miss = 0, good = 0;
    while (i < heard.length && j < list.length) {
      if (same(heard[i], list[j])) { i++; j++; good = i; continue; }
      if (miss++) break;
      if (j + 1 < list.length && same(heard[i], list[j + 1])) j++; // the mic missed a word
      else { i++; j++; } // a word misheard
    }
    best = Math.max(best, good);
  }
  return best >= 2 ? best : 0;
}
// The recording may replace the live words only if it says about as much: "you" from a poor recording must not erase a sentence.
const enoughWords = (w, live) => String(w || "").trim().split(/\s+/).length >= Math.ceil(String(live || "").trim().split(/\s+/).length * 0.5);
// What the mic heard, without the tutor's echo at its start.
function stripEcho(text, list) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  if (!list?.length) return words.join(" ");
  return words.slice(echoPrefix(words.map(normToken), list)).join(" ");
}

// Quick reactions: a first sentence that is only an exclamation ("Oh nice!", "Ha, no way!") would say the same
// thing twice right after one. It is left out then.
const EXCLAIM_WORDS = new Set(("oh ah aw ooh nice wow no way ha haha cool great awesome love that lovely brilliant right got it okay ok yeah "
  + "yes interesting huh hmm ouch dear amazing sweet fair enough sure well man gosh classic good for you congrats congratulations nooo damn "
  + "fantastic perfect excellent wonderful exciting fun funny shame sorry bummer").split(" "));
function onlyExclamation(text, name) {
  const w = normText(text).split(" ").filter(Boolean);
  return w.length > 0 && w.length <= 5 && !/\?/.test(text) && w.every((x) => EXCLAIM_WORDS.has(x) || x === normText(name));
}

// An early reaction check still fits the finished sentence: the same words, or its first 70 percent or more
// (one word may differ: the live words get fixed as they come).
function guessFits(guess, text) {
  if (closeText(guess, text)) return true;
  const a = normText(guess).split(" ").filter(Boolean), b = normText(text).split(" ").filter(Boolean);
  return a.length >= 4 && a.length >= 0.7 * b.length && lev(a, b.slice(0, a.length)) <= 1;
}

// Two transcripts of the same turn are close enough to keep a reply prepared from the first one.
function closeText(a, b) {
  const A = normText(a).split(" ").filter(Boolean), B = normText(b).split(" ").filter(Boolean);
  if (A.join(" ") === B.join(" ")) return true;
  return lev(A, B) / Math.max(1, A.length, B.length) <= 0.2;
}

function autoTr() {
  const a = S.profile.autoTr;
  if (a === "on") return true;
  if (a === "off") return false;
  return ["A1", "A2"].includes(S.profile.level);
}
// Subtitles (2026-11-10: "I don't need them to talk"). By default they only show when the tutor corrects,
// explains a structure (whiteboard, help card) or repeats on request. "all" shows every line, the learner's too.
const subsAll = () => S.profile.subs === "all";
const clock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

async function readSSE(res, onEvent) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let ev = "message", data = "";
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event: ")) ev = line.slice(7).trim();
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (!data) continue;
      let parsed;
      try { parsed = JSON.parse(data); } catch { continue; }
      onEvent(ev, parsed);
    }
  }
}

// One tutor turn: a streaming request + the voice that plays it.
class Turn {
  constructor(call, { opening = false, learner = null, speculative = false } = {}) {
    this.call = call;
    this.opening = opening;
    this.learner = learner; // the learner message this turn answers
    this.text = learner ? learner.text : "";
    this.committed = !speculative;
    this.ctrl = new AbortController();
    this.utt = null;
    this.msg = null;
    this.doneData = null;
    this.error = null;
    this.finished = false;
    this.aborted = false;
    this.firstSentenceAt = 0;
    this.t0 = performance.now();
  }
  history() {
    const list = this.call.msgs.filter((m) => !m.local).map((m) => ({ who: m.who, text: m.text, t: m.t, help: Boolean(m.help) }));
    if (this.learner && !this.call.msgs.includes(this.learner)) list.push({ who: "me", text: this.learner.text, t: this.learner.t, help: Boolean(this.learner.help) });
    return list;
  }
  async start() {
    const c = this.call;
    // A quick reaction, decided now: it plays first, and the answer is told it was said.
    const r = this.learner && !this.opening ? c.reactionFor(this) : null;
    if (r) this.addReaction(r, r.clip);
    const body = {
      callId: c.callId, config: c.config, opening: this.opening, history: this.opening ? [] : this.history(),
      voice: Speech.voiceFor(c.tutor).startsWith("browser:") ? "" : Speech.voiceFor(c.tutor), rate: Speech.rate(),
      reacted: r ? r.text : "",
    };
    try {
      const res = await fetch("/api/turn", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: this.ctrl.signal });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw data.error || { code: "error", message: L("Error " + res.status, "Erreur " + res.status) };
      }
      await readSSE(res, (ev, data) => this.onEvent(ev, data));
      if (!this.doneData && !this.error && !this.aborted) throw { code: "api_error", message: L("The answer stopped. Try again.", "La réponse s'est arrêtée. Réessaie.") };
    } catch (e) {
      if (this.aborted || e?.name === "AbortError") return;
      this.fail(e?.code ? e : { code: "server_down", message: L("Fluent is not running. Double-click start.command on the Mac.", "Fluent ne tourne pas. Double-clique sur start.command sur le Mac.") });
    } finally {
      this.finished = true;
      this.utt?.finish();
    }
  }
  onEvent(ev, d) {
    if (this.aborted) return;
    const c = this.call;
    if (ev === "call" && d.callId) c.callId = d.callId;
    else if (ev === "emotion") { this.emotion = d.emotion; if (this.committed) c.stage.setEmotion(d.emotion, 9000); }
    else if (ev === "sentence") this.onSentence(d);
    else if (ev === "done") { this.doneData = d; if (this.committed) c.applyDone(this, d); }
    else if (ev === "error") this.fail(d);
    else if (ev === "timing" && d.firstSentenceMs) this.serverFirst = d.firstSentenceMs;
  }
  onSentence(s) {
    const c = this.call;
    if (this.cut) return; // the learner interrupted: the rest of the answer is not said
    const first = !this.mainStarted;
    this.mainStarted = true;
    if (first && this.reaction && onlyExclamation(s.text, S.profile.name)) return; // already said by the quick reaction
    this.say(s.text, { key: s.key, browser: !s.key });
  }
  // A quick reaction ("¡Anda!"): a ready-made clip in the tutor's voice, before the real answer.
  addReaction(r, clip) {
    if (this.aborted || this.cut || this.mainStarted || !clip) return;
    this.reaction = r;
    this.say(r.text, { audio: Promise.resolve(clip) });
  }
  say(text, part) {
    const c = this.call;
    if (!this.firstSentenceAt) this.firstSentenceAt = performance.now();
    if (!this.msg) this.msg = { who: "tutor", text: "", tr: "", words: [], help: null, board: null, showTr: false, id: uid() };
    this.msg.text = this.msg.text ? this.msg.text + " " + text : text;
    if (!this.utt) {
      this.utt = new Utterance({
        tutor: c.tutor, hold: !this.committed,
        onstart: () => c.onSpeechStart(this),
        onend: (stopped) => c.onSpeechEnd(this, stopped),
        onsentence: () => c.renderSubs(),
      });
      if (!c.voiceOn) this.utt.stop();
    }
    this.utt.add({ text, ...part });
    if (this.committed) { c.ensureTutorMsg(this); c.renderTranscript(); }
  }
  fail(e) {
    if (this.error) return;
    this.error = e;
    this.utt?.stop();
    if (this.committed) this.call.onTurnError(this, e);
  }
  commit() {
    if (this.committed) return;
    this.committed = true;
    const c = this.call;
    if (this.reaction) c.reacted(this.reaction);
    if (this.emotion) c.stage.setEmotion(this.emotion, 9000);
    if (this.msg) c.ensureTutorMsg(this);
    this.utt?.commit();
    if (this.doneData) c.applyDone(this, this.doneData);
    if (this.error) c.onTurnError(this, this.error);
    c.renderTranscript();
  }
  abort() {
    this.aborted = true;
    try { this.ctrl.abort(); } catch { /* done */ }
    this.utt?.stop();
  }
  get waiting() { return this.committed && !this.firstSentenceAt && !this.error && !this.finished; }
}

class Call {
  constructor(config) {
    this.config = config;
    this.tutor = S.profile.tutor in TUTORS ? S.profile.tutor : "emma";
    this.t = TUTORS[this.tutor];
    this.msgs = [];
    this.callId = null;
    this.t0 = 0;
    this.startedAt = 0;
    this.awayMs = 0;
    this.hiddenAt = 0;
    this.connected = false;
    this.ended = false;
    this.turn = null;
    this.spec = null;
    this.listen = null;
    this.barge = null; // the mic open while the tutor thinks or speaks (see startBarge)
    this.listenStart = 0;
    this.handsFree = S.profile.handsFree !== false && Mic.ok;
    this.voiceOn = true;
    this.showTr = autoTr();
    this.phase = config.mode === "lesson" ? "warmup" : "none";
    this.done = [];
    this.float = null; // { kind: "board"|"help", data, msg }
    this.wordInfo = null;
    this.correction = null;
    this.pop = null; // "help" | "ask" | "type" | "ideas"
    this.ideas = null;
    this.ideasLoading = false;
    this.askListening = null;
    this.endOffered = false;
    this.xp = 0;
    this.subText = "";
    this.liveText = "";
    this.stage = Stage3D.ok(this.tutor) ? new Stage3D(this.tutor) : new TutorStage(this.tutor);
    this.mount();
    this.connect();
  }

  // ---------- Setup ----------
  mount() {
    const t = this.t;
    document.body.classList.add("in-call");
    this.el = h("div", { class: `call ${t.id}${IS_PHONE() ? "" : ""}` });
    this.liveChip = h("span", { class: "live-chip glass", "data-mode": "idle" }, h("i"), h("span", null, ""));
    this.timerEl = h("span", { class: "timer glass num" }, "0:00");
    this.phaseEl = h("div", { class: "phase-bar glass" });
    this.topicEl = h("div", { class: "topic-chip glass" });
    this.floatSlot = h("div");
    this.wordSlot = h("div");
    this.subLine = h("div", { class: "sub-line", "aria-live": "polite", "data-label": t.name });
    this.subTr = h("div", { class: "sub-tr" });
    this.youLine = h("div", { class: "you-line", "data-label": L("You", "Toi"), hidden: true });
    this.corrSlot = h("div");
    this.ideasSlot = h("div", { class: "ideas-slot" });
    this.ringEl = h("div", { class: "ringing" },
      h("div", { class: "halo" }, portrait(t.id)),
      h("h2", null, t.name),
      h("p", null, L(`Calling ${t.name}…`, `J'appelle ${t.name}…`)),
      h("button", { class: "ctl hang", style: "margin-top:20px", onclick: () => this.hangUp(), "aria-label": L("Hang up", "Raccrocher") }, h("span", { class: "b" }, icon("hangup", 26))));
    this.stageEl = h("div", { class: "stage", onclick: (e) => this.onStageTap(e) },
      this.stage.art,
      h("div", { class: "stage-top" }, this.liveChip, this.timerEl),
      this.config.mode === "lesson" ? null : this.topicEl,
      this.floatSlot, this.wordSlot,
      h("div", { class: "subs" }, this.subLine, this.subTr, this.youLine, this.corrSlot, this.ideasSlot),
      this.ringEl);
    this.goalsEl = h("div", { class: "goals" });
    this.transcriptEl = h("div", { class: "transcript" });
    this.trBtn = h("button", { class: "chip sm", onclick: () => { this.showTr = !this.showTr; this.renderAll(); } });
    this.side = h("aside", { class: "call-side" },
      h("div", { class: "side-head" },
        h("b", null, L("Transcript", "Texte de l'appel")),
        h("div", { class: "row nowrap" }, this.trBtn,
          h("button", { class: "icon-btn side-close", "aria-label": L("Close", "Fermer"), onclick: () => this.toggleSide(false) }, icon("down", 18)))),
      this.config.mode === "scene" ? this.goalsEl : null,
      this.transcriptEl);
    this.popSlot = h("div");
    this.endSlot = h("div");
    this.ctlRow = h("div", { class: "ctl-row" });
    this.hintEl = h("div", { class: "ctl-hint" });
    this.controls = h("div", { class: "call-controls" }, this.popSlot, this.endSlot, this.ctlRow, this.hintEl);
    this.el.append(h("div", { class: "call-body" }, h("div", { class: "call-main" }, this.stageEl, this.controls), this.side));
    $("#call-root").replaceChildren(this.el);
    this.ro = new ResizeObserver(() => this.el.style.setProperty("--controls-h", this.controls.offsetHeight + "px"));
    this.ro.observe(this.controls);
    this.timer = setInterval(() => this.everySecond(), 1000);
    this.renderAll();
  }

  // The mic comes before the first word. While Chrome was still asking for it (2026-11-05: no permission saved for this port), the first
  // answer fell to the browser's dictation: no echo cancelling, so it wrote "you" from the tutor's voice in the speakers.
  async askMic() {
    if (!Mic.ok || IS_IOS) return;
    const t0 = performance.now();
    const p = this.ringEl?.querySelector("p"), was = p?.textContent;
    const slow = setTimeout(() => {
      if (p && !this.ended && !MicMeter.stream) p.textContent = L("Allow your microphone at the top of the window. Pick “while visiting the site”, so that it stays allowed.", "Autorise ton micro en haut de la fenêtre. Choisis « lors de la visite du site », pour ne plus avoir à le refaire.");
    }, 700);
    const ready = MicMeter.start();
    ready.then(() => { if (!this.ended && LiveEars.ok) LiveEars.open(); });
    await Promise.race([ready, new Promise((r) => setTimeout(r, 25000))]); // no answer: the tutor starts anyway
    clearTimeout(slow);
    if (p && was) p.textContent = was;
    SoundLog.put("askMs", Math.round(performance.now() - t0));
    SoundLog.put("micDenied", MicMeter.denied);
    if (LiveEars.ok) await Promise.race([LiveEars.open().catch(() => {}), new Promise((r) => setTimeout(r, 2500))]);
  }

  async connect() {
    this.renderControls();
    SoundLog.begin();
    AudioOut.ensure();
    AudioOut.setVolume(S.profile.voiceVol);
    const micReady = this.askMic();
    try {
      const r = await api("/api/call", { config: this.config });
      if (this.ended) return;
      this.callId = r.callId;
      this.plan = r;
      this.renderTopic();
    } catch (e) {
      if (this.ended) return;
      const p = this.ringEl.querySelector("p");
      p.textContent = errText(e);
      const retry = h("button", { class: "btn", style: "margin-top:6px", onclick: (ev) => { ev.stopPropagation(); p.textContent = L(`Calling ${this.t.name}…`, `J'appelle ${this.t.name}…`); retry.remove(); settings?.remove(); this.connect(); } }, L("Try again", "Réessayer"));
      p.after(retry);
      const settings = (e.code === "no_key" || e.code === "bad_key") && UI.local ? h("button", { class: "btn ghost", style: "margin-top:6px", onclick: () => { this.hangUp(true); openSettings(); } }, L("Open Settings", "Ouvrir les Réglages")) : null;
      if (settings) retry.after(settings);
      return;
    }
    await micReady;
    if (this.ended) return;
    this.startTurn(new Turn(this, { opening: true }));
    this.loadReactions();
  }

  // ---------- Quick reactions ----------
  // The tutor's reactions ("Oh nice!", "No way!") are made once per call, in their voice, so they play at once.
  async loadReactions() {
    const voice = Speech.voiceFor(this.tutor);
    if (!voice || voice.startsWith("browser:")) return;
    try {
      const { reactions } = await api("/api/reactions", { tutor: this.tutor });
      const rate = Speech.rate();
      this.reacts = reactions.map((r) => ({ ...r, audio: fetchTTS(r.text, voice, rate, this.tutor, r.mood) }));
      for (const r of this.reacts) r.audio.then((clip) => { r.clip = clip; }, () => {});
      this.reactLog = [];
      this.reactAt = -1;
    } catch { this.reacts = null; }
  }
  // Asked early, on the live words (about once a second), so the answer is there when the learner stops.
  // The same check says whether they sound finished (see patienceMs), so it runs even without the reaction clips.
  guessReaction(text, now = false) {
    if (this.ended || !text || text.split(/\s+/).length < 3) return;
    const g = this.guess;
    if (g && normText(g.text) === normText(text)) return;
    // Not waiting for the previous check: a new one every 0.6 s or more, with 2 new words or more.
    if (!now && g && (performance.now() - g.at < 600 || text.split(/\s+/).length - g.text.split(/\s+/).length < 2)) return;
    const guess = { text, at: performance.now(), pending: true, id: null, finished: null };
    guess.p = api("/api/react", { tutor: this.tutor, level: S.profile.level, last: this.lastTutor()?.text || "", said: text, recent: (this.reactLog || []).slice(-3) })
      .then((r) => { guess.id = r.id || null; guess.finished = typeof r.finished === "boolean" ? r.finished : null; }, () => {}).finally(() => { guess.pending = false; });
    this.guess = guess;
    this.guesses = [...(this.guesses || []).slice(-4), guess];
  }
  // Natural, not automatic: only when it fits, never two turns in a row, at most about one turn in three,
  // and only if the early check on the live words is back by the time the answer starts (nothing waits).
  reactionFor(turn) {
    if (!this.reacts || !this.voiceOn || turn.learner?.help) return null;
    const n = this.msgs.filter((m) => m.who === "me" && !m.help).length + 1; // this turn's number
    if (this.reactAt >= n - 1 || (this.reactLog.length + 1) / (n + 1) > 0.4) return null;
    // The newest finished check that fits the whole sentence (a newer one may still be on its way).
    const g = [...(this.guesses || [])].reverse().find((x) => !x.pending && guessFits(x.text, turn.learner.text));
    if (!g?.id) return null;
    const r = this.reacts.find((x) => x.id === g.id);
    return r?.clip ? r : null;
  }
  reacted(r) {
    this.reactLog.push(r.id);
    this.reactAt = this.msgs.filter((m) => m.who === "me" && !m.help).length;
  }

  // How long a pause ends the learner's turn now: what the quick check said about these exact words,
  // plus what the app learned (each "I was not finished" adds a little; see notFinished).
  patience(text) {
    const g = (this.guesses || []).findLast((x) => !x.pending && x.finished != null && sameTurn(x.text, text));
    return patienceMs(text, g ? g.finished : null) + (S.profile.pauseBoost || 0);
  }
  // The tutor answered too early. The next pauses are a little longer (kept for the next calls too).
  notFinished() {
    this.cutEarly = true;
    S.profile.pauseBoost = Math.min(1500, (S.profile.pauseBoost || 0) + 300);
    save("profile");
  }

  // ---------- Turns ----------
  // An older turn stops talking, but keeps receiving its translation and corrections.
  retire(turn) {
    if (!turn) return;
    turn.utt?.stop();
    if (!turn.msg || !turn.committed) turn.abort();
  }

  startTurn(turn) {
    if (this.turn !== turn) this.retire(this.turn);
    this.turn = turn;
    this.correction = null;
    if (this.float) this.float.open = false;
    turn.start();
    this.renderAll();
  }

  ensureTutorMsg(turn) {
    if (!turn.msg || this.msgs.includes(turn.msg)) return;
    if (turn.learner && !this.msgs.includes(turn.learner)) this.msgs.push(turn.learner);
    this.msgs.push(turn.msg);
  }

  onSpeechStart(turn) {
    if (turn !== this.turn) return;
    turn.speakAt = performance.now();
    if (this.lastHeardAt && turn.learner) {
      console.info(`[fluent] the tutor answered ${Math.round(turn.speakAt - this.lastHeardAt)} ms after the learner's last word (Claude's first sentence: ${turn.serverFirst || "?"} ms)`);
      this.lastHeardAt = 0;
    }
    if (!this.connected) {
      this.connected = true;
      this.t0 = performance.now();
      this.startedAt = Date.now();
      this.ringEl.classList.add("gone");
      setTimeout(() => this.ringEl.remove(), 600);
    }
    this.youLine.hidden = true;
    this.renderSubs();
    this.renderControls();
    this.startBarge();
  }

  // Right after the tutor stopped: is this their voice coming back from the speakers, not an answer?
  // A phrase: nearly all of it is their words (one word misheard must not make it the learner's).
  // One or two words: only their very last ones, because "yes" or "great" may well be the learner's answer.
  echoTail(ctl, text) {
    if (!ctl.barge || !this.speechEndAt || ctl.lastChange - this.speechEndAt > 1800) return false;
    const said = this.lastTutor()?.text || "";
    const list = heardWords(text, echoTokens(said));
    if (!list.length) return false;
    if (list.length > 2) return list.filter(counts).length <= list.length * 0.25;
    const tail = echoList(said).slice(-6);
    return echoList(text).every((w) => tail.includes(w));
  }

  onSpeechEnd(turn, stopped) {
    if (turn !== this.turn || this.ended) return;
    this.unduck(true);
    this.speechEndAt = performance.now();
    this.renderControls();
    if (stopped) return;
    // Wait for the rest of the answer (help card, end of class) before opening the mic.
    const go = () => {
      if (this.ended || this.turn !== turn || this.listen) return;
      if (turn.doneData?.end_call) { this.stopBarge(); return this.renderControls(); }
      if (!this.handsFree || this.pop) { this.stopBarge(); return; }
      if (this.barge) {
        const b = this.barge;
        this.barge = null;
        b.echoList = echoList(this.turn?.msg?.text || "");
        // The learner may have started over the tutor's last words: keep their words, drop only the echo.
        const words = String(b.text || "").trim().split(/\s+/).filter(Boolean);
        const heardNow = heardWords(b.text, this.echoNow());
        const mostlyEcho = heardNow.filter(counts).length <= heardNow.length * 0.25; // one word misheard does not make the rest the learner's
        const lead = performance.now() - b.lastChange < 1500 && !mostlyEcho ? echoLead(b.text, this.echoNow()) : words.length;
        if (lead < words.length) b.skip = words.slice(0, lead).join(" ");
        else if (b.live) {
          b.reset(); // the live ears start clean
          // And so does the recording: with the tutor's voice in it, the full Scribe wrote "Ugh." before the learner's words.
          if (S.profile.ears !== "fast") { b.rec = Ears.record(); b.freshRec = Boolean(b.rec); }
        }
        else b.skip = words.join(" ");
        b.prefix = "";
        this.useListen(b);
      } else this.startListening();
    };
    setTimeout(go, 60);
  }

  applyDone(turn, d) {
    if (turn.applied) return;
    turn.applied = true;
    const m = turn.msg || (turn.msg = { who: "tutor", text: String(d.reply || "").trim(), id: uid() });
    this.ensureTutorMsg(turn);
    m.tr = d.translation || "";
    m.words = (d.words || []).filter((w) => w && w.es).slice(0, 2);
    const kind = d.help && d.help.kind && d.help.kind !== "none" ? d.help.kind : null;
    m.help = kind ? { kind, explanation: d.help.explanation || "", practice: d.help.practice || "" } : null;
    m.board = d.board && (d.board.title || (d.board.lines || []).length) ? { title: d.board.title || "", lines: (d.board.lines || []).slice(0, 8) } : null;
    if (!m.text && d.reply) m.text = String(d.reply).trim();
    const learner = turn.learner;
    if (learner && !learner.help) {
      if (!kind && d.correction && d.correction.needed && d.correction.better) {
        learner.fix = { you: d.correction.you_said, better: d.correction.better, why: d.correction.why };
        this.correction = { ...learner.fix, at: performance.now() };
        clearTimeout(this.corrTimer);
        this.corrTimer = setTimeout(() => { this.correction = null; this.renderCorrection(); }, 9000);
      }
      if (d.pronunciation_note) learner.pron = d.pronunciation_note;
      this.gain(5);
    }
    // A correction or a structure: this answer gets its subtitles. A whiteboard counts when it is a new one
    // (new title): the tutor often keeps the same board on screen for several answers.
    const prevBoard = [...this.msgs].reverse().find((x) => x.who === "tutor" && x !== m && x.board)?.board;
    const newBoard = Boolean(m.board && (!prevBoard || normText(prevBoard.title) !== normText(m.board.title)));
    m.teach = Boolean(kind || newBoard || (learner && learner.fix && !learner.help));
    this.renderSubs();
    for (const i of Array.isArray(d.goals_done) ? d.goals_done : []) {
      const tasks = this.config.scene?.tasks || [];
      if (Number.isInteger(i) && i >= 0 && i < tasks.length && !this.done.includes(i)) {
        this.done.push(i);
        this.gain(10);
        toast(L(`Goal done: ${tasks[i]} (+10 XP)`, `Objectif atteint : ${this.config.scene?.tasksFr?.[i] || tasks[i]} (+10 XP)`));
      }
    }
    if (d.phase && d.phase !== "none") this.phase = d.phase;
    // Cards start small (a pill), so the face stays visible; they open by themselves only when the learner asked for help.
    const asked = Boolean(turn.learner?.help);
    if (m.help && (m.help.explanation || m.help.practice)) this.float = { kind: "help", msg: m, open: asked };
    else if (m.board) this.float = { kind: "board", msg: m, open: asked };
    if (d.end_call) this.endOffered = true;
    this.renderAll();
    this.checkpoint();
  }

  onTurnError(turn, e) {
    if (turn !== this.turn) return;
    this.stage.setEmotion("empathetic", 5000);
    if (!this.connected) {
      this.ringEl.querySelector("p").textContent = errText(e);
      const retry = h("button", { class: "btn", style: "margin-top:6px", onclick: (ev) => { ev.stopPropagation(); this.ringEl.querySelector("p").textContent = L(`Calling ${this.t.name}…`, `J'appelle ${this.t.name}…`); retry.remove(); this.startTurn(new Turn(this, { opening: true })); } }, L("Try again", "Réessayer"));
      this.ringEl.querySelector("p").after(retry);
      if (e.code === "no_key" || e.code === "bad_key") retry.after(h("button", { class: "btn ghost", style: "margin-top:6px", onclick: () => { this.hangUp(true); openSettings(); } }, L("Open Settings", "Ouvrir les Réglages")));
      return;
    }
    this.lastError = { turn, e };
    toast(errText(e), 4000);
    this.renderAll();
  }

  retry() {
    const err = this.lastError;
    this.lastError = null;
    if (!err) return;
    const old = err.turn;
    this.startTurn(new Turn(this, { opening: old.opening, learner: old.learner }));
  }

  gain(n) { this.xp += n; addXP(n); }

  // ---------- The learner speaks ----------
  // prefix: the learner goes on with a sentence that was sent too early.
  startListening(prefix = "") {
    if (this.ended || this.listen || !this.connected) return;
    if (!Mic.ok) { this.openPop("type"); micError({ code: "unsupported" }); return; }
    Speech.stop();
    this.wordInfo = null;
    this.liveText = prefix;
    this.resumeText = prefix;
    this.guess = null; // a new answer: the reaction checks start again
    this.listenStart = performance.now();
    MicMeter.top = 0;
    this.silenceHelped = false;
    this.voiceAt = 0;
    this.stopBarge();
    // Live ears (Scribe while the learner speaks) when they work, else the browser's dictation + a recording.
    const ctl = (LiveEars.ok ? LiveEars : Mic).listen(this.t.accent, { prefix, onUpdate: (text) => this.onMicText(ctl, text) });
    this.listen = ctl;
    // The live words are fast but miss the first words of a French accent (measured 2026-11-05: 10 wrong words in 90, against 1).
    // So the recording goes to the full Scribe at each pause. The reply starts on time; only a clear difference restarts it.
    ctl.rec = ctl.live ? (S.profile.ears === "fast" ? null : ctl.backup) : Ears.record();
    ctl.prefix = String(prefix).trim();
    ctl.promise.then(({ text }) => this.onHeard(ctl, text)).catch((e) => {
      ctl.rec?.stop();
      if (this.listen === ctl) this.listen = null;
      this.spec?.abort();
      this.spec = null;
      micError(e);
      this.renderAll();
    });
    this.renderAll();
  }

  // The learner's words (without the tutor's echo when the mic was open during the tutor's turn).
  heard(ctl, raw) {
    if (!ctl.barge) return String(raw || "").trim();
    let t = String(raw || "").trim();
    // Opened while the tutor spoke and kept for the learner's turn: what it heard until then was the tutor's echo.
    if (ctl.skip) t = t.startsWith(ctl.skip) ? t.slice(ctl.skip.length) : t.split(/\s+/).slice(ctl.skip.split(/\s+/).length).join(" ");
    else t = stripEcho(t, ctl.echoList);
    return `${ctl.prefix || ""} ${t.trim()}`.trim();
  }

  onMicText(ctl, raw) {
    if (this.ended) return;
    if (this.listen === ctl) {
      const text = this.heard(ctl, raw);
      this.guessReaction(text);
      // Once Whisper has written the start of the turn, show its words, then the browser's newer words.
      const w = ctl.whisperShown;
      this.liveText = w && text.startsWith(w.base) ? `${w.text}${text.slice(w.base.length)}` : text;
      if (text) this.stage.nod();
      if (this.spec && !sameTurn(this.spec.text, text, ctl.live)) { this.spec.abort(); this.spec = null; }
      this.renderYou();
      return;
    }
    if (this.barge !== ctl) return;
    const echo = this.echoNow();
    const all = learnerWords(raw, echo).filter((w) => !BACKCHANNEL.has(w));
    const words = all.slice(ctl.forgiven || 0); // a lone word that lowered the voice for nothing no longer counts
    if (!words.length) return;
    // While the tutor is still thinking (no voice, so no echo), one word is enough: the learner was going on.
    // While they speak: two words, or one "wait", "sorry", "but"…
    if (!Speech.speaking() || words.length >= BARGE_WORDS || words.some((w) => TAKE_TURN.has(w))) this.bargeIn(ctl, echo);
    else if (!this.duckAt) {
      // One word: the tutor's voice goes down at once, like someone who hears they are being interrupted.
      this.duckAt = performance.now();
      this.stage.react?.("hear");
      ctl.duckN = all.length;
      SoundLog.count("ducks");
      AudioOut.duck(true);
    }
  }
  unduck(now = false) {
    if (!this.duckAt) return;
    this.duckAt = 0;
    AudioOut.duck(false, now);
  }

  // ---------- Barge-in: the learner just talks to interrupt, like on a real call ----------
  startBarge() {
    if (this.ended || this.listen || this.barge || !this.connected || !this.handsFree || !Mic.ok || IS_IOS || this.pop || this.endOffered) return;
    if (UI.eleven && !LiveEars.ok) return; // the browser's dictation has no echo cancelling: it would write the tutor's voice
    const ctl = (LiveEars.ok ? LiveEars : Mic).listen(this.t.accent, { onUpdate: (text) => this.onMicText(ctl, text) });
    ctl.barge = true;
    ctl.rec = ctl.live ? null : Ears.record();
    this.barge = ctl;
    ctl.promise.catch(() => {}).finally(() => { if (this.barge === ctl) this.barge = null; });
  }
  stopBarge() {
    const b = this.barge;
    this.barge = null;
    if (b && b !== this.listen) { b.rec?.stop(); b.abort(); }
  }
  // What the mic may hear back: the words the tutor is saying now, and their reply so far.
  echoNow() {
    return echoTokens(`${Speech.current?.text || ""} ${this.turn?.msg?.text || ""}`);
  }

  // Right after their own turn (the tutor is thinking or has just started): they had not finished.
  // (the answer is still being written, its audio is loading, or it has played for less than RESUME_MS).
  isEarly() {
    const t = this.turn;
    return Boolean(t && t.learner && !t.learner.help && !t.cut && (!t.speakAt || performance.now() - t.speakAt < RESUME_MS)
      && (!t.msg || this.msgs.at(-1) === t.msg || this.msgs.at(-1) === t.learner));
  }

  bargeIn(ctl, echo) {
    const t = this.turn;
    this.barge = null;
    ctl.echoList = echoList(`${Speech.current?.text || ""}`);
    // What the mic heard before the learner's first word was the tutor's echo: their turn starts after it.
    const lead = echoLead(ctl.text, echo);
    if (lead) ctl.skip = String(ctl.text).trim().split(/\s+/).slice(0, lead).join(" ");
    const early = this.isEarly();
    // Where the tutor's voice was (read before stopping it).
    const u = t?.utt;
    const pos = u && u === Speech.current && u.cur ? Math.floor(u.charPos() ?? 0) : null;
    Speech.stop();
    this.unduck(true);
    if (early) {
      this.notFinished();
      t.abort();
      this.msgs = this.msgs.filter((m) => m !== t.msg && m !== t.learner);
      if (this.float?.msg === t.msg) this.float = null;
      this.correction = null;
      this.turn = null;
      ctl.prefix = t.learner.text;
    } else {
      if (t?.msg) this.cutTutor(t, pos);
      ctl.prefix = "";
    }
    this.stage.setEmotion("curious", 2500);
    this.stage.react?.("interrupted");
    this.useListen(ctl);
  }

  // The tutor was interrupted: the transcript (and the next prompt) keeps only what they really said, with "…".
  cutTutor(t, pos) {
    const m = t.msg;
    t.cut = true;
    let said = pos == null ? m.text : m.text.slice(0, Math.max(0, pos)).replace(/\s+\S*$/, "");
    if (said.trim().length < 4) said = m.text.split(/\s+/).slice(0, 3).join(" ");
    m.text = `${said.trim().replace(/[.,!?…]+$/, "")}…`;
    m.cut = true;
    this.renderSubs(m.text);
    this.renderTranscript();
  }

  // A mic already open (the barge-in session) becomes the learner's turn: no restart, no lost first word.
  useListen(ctl) {
    if (this.listen && this.listen !== ctl) this.listen.abort();
    this.listen = ctl;
    if (ctl.live && !ctl.rec && S.profile.ears !== "fast") ctl.rec = ctl.backup; // an interruption: the exact words too
    this.wordInfo = null;
    this.resumeText = ctl.prefix || "";
    this.guess = null; // a new answer: the reaction checks start again
    this.liveText = this.heard(ctl, ctl.text);
    this.listenStart = performance.now();
    MicMeter.top = 0;
    this.silenceHelped = false;
    this.voiceAt = performance.now();
    ctl.promise.then(({ text }) => this.onHeard(ctl, text)).catch((e) => {
      ctl.rec?.stop();
      if (this.listen === ctl) this.listen = null;
      this.spec?.abort();
      this.spec = null;
      micError(e);
      this.renderAll();
    });
    this.renderAll();
  }

  stopListening(send = true) {
    const ctl = this.listen;
    if (!ctl) return;
    ctl.byUs = true; // stopped on purpose: do not reopen the mic by itself
    if (send) ctl.cut(); else { this.listen = null; ctl.abort(); this.spec?.abort(); this.spec = null; this.liveText = ""; this.renderAll(); }
  }

  // What Whisper heard (prefix: words sent before "I was not finished"), or "" to keep the browser's text.
  async whisper(ctl) {
    let w = await Ears.hear(ctl.rec, this.lastTutor()?.text || "");
    if (ctl.barge && !ctl.freshRec) w = stripEcho(w, ctl.echoList);
    return w ? `${ctl.prefix || ""} ${w}`.trim() : "";
  }

  async onHeard(ctl, text) {
    if (this.listen === ctl) this.listen = null;
    if (this.ended) { ctl.rec?.stop(); return; }
    text = this.heard(ctl, text);
    if (text) { SoundLog.count("turns"); if (!ctl.live) SoundLog.count("dictation"); }
    if (!text) {
      ctl.rec?.stop();
      this.spec?.abort();
      this.spec = null;
      this.renderAll();
      // Hands-free: the mic never switches off by itself while it is the learner's turn.
      if (!ctl.byUs && this.handsFree && !this.pop && !Speech.speaking() && !this.turn?.waiting) setTimeout(() => { if (!this.listen && !this.ended && !Speech.speaking()) this.startListening(); }, 250);
      return;
    }
    this.lastHeardAt = ctl.lastChange;
    let spec = this.spec;
    this.spec = null;
    if (spec && !spec.error && sameTurn(spec.text, text, ctl.live)) {
      // Scribe's text when it has it (it heard the same words), else the browser's final words.
      if (spec.heard) await spec.heard;
      spec = spec.replacement || spec; // started again from Scribe's words
      ctl.rec?.stop();
      if (this.ended || spec.aborted) return;
      if (!spec.whisper) spec.learner.text = text;
      SoundLog.count(spec.whisper ? "exactWords" : "liveWords");
      this.msgs.push(spec.learner);
      if (!spec.whisper) this.refine(ctl, spec.learner); // the full Scribe's words stay: they are the exact ones
      this.retire(this.turn);
      this.turn = spec;
      spec.commit();
      this.renderAll();
      this.startBarge();
      return;
    }
    spec?.abort();
    let exact = false;
    if (ctl.rec) {
      this.liveText = text;
      this.renderYou();
      const w = await this.whisper(ctl);
      ctl.rec.stop();
      if (this.ended || this.listen || this.turn?.waiting) return; // the learner moved on meanwhile
      if (w && !enoughWords(w, text)) SoundLog.count("shortRec");
      else if (w && (!ctl.barge || ctl.freshRec || closeText(text, w))) { text = w; exact = true; }
      SoundLog.count(exact ? "exactWords" : "liveWords");
    }
    this.sendText(text);
    if (ctl.live && !exact) this.refine(ctl, this.msgs.findLast((m) => m.who === "me"));
  }

  // Live ears: Scribe's final words for a turn arrive a moment after it was sent. They replace the live words
  // in the transcript (and in what the tutor reads next) when they say the same thing a little more exactly.
  refine(ctl, msg) {
    ctl.finalText?.then((raw) => {
      const t = raw && this.heard(ctl, raw);
      // Close to the live words, or the same words with the end that was missing.
      if (!t || !msg || t === msg.text || !(closeText(msg.text, t) || normText(t).startsWith(normText(msg.text)))) return;
      msg.text = t;
      this.renderTranscript();
    });
  }

  // Called ~10 times a second while listening: detects the end of the learner's turn.
  checkSilence(now) {
    const ctl = this.listen;
    if (!ctl) return;
    // Voice loudness, against the room's own noise: someone saying "eeeh…" is still talking.
    const lvl = MicMeter.level;
    this.noise = this.noise == null ? lvl : lvl < this.noise ? this.noise * 0.9 + lvl * 0.1 : this.noise * 0.998 + lvl * 0.002;
    if (MicMeter.analyser && lvl > Math.max(0.12, this.noise * 3)) this.voiceAt = now;
    const text = this.heard(ctl, ctl.text);
    if (text && this.echoTail(ctl, text)) {
      if (now - ctl.lastChange > 900) { SoundLog.count("echoTail"); ctl.skip = ""; ctl.reset?.(); this.liveText = ""; this.renderYou(); }
      return;
    }
    // Nothing at all comes from the mic: say so, rather than a tutor who seems deaf.
    const silent = !text && MicMeter.analyser && now - this.listenStart > 7000 && MicMeter.top < 0.0008;
    if (silent !== Boolean(this.micSilent)) { this.micSilent = silent; this.renderControls(); }
    // After "I was not finished", wait for new words (the mic button sends at any time).
    if (!text || text === this.resumeText) {
      // A long silence: offer a small "need an idea?" button (nothing pops up by itself).
      if (now - this.listenStart > 12000 && !this.silenceHelped && this.msgs.length) {
        this.silenceHelped = true;
        this.stage.setEmotion("encouraging", 4000);
        this.renderIdeas();
      }
      return;
    }
    // The sound counts for at most 2.5 s after the last new word (a noisy room must not block the turn).
    const heardAt = Math.max(ctl.lastChange, Math.min(this.voiceAt || 0, ctl.lastChange + 2500));
    const quiet = now - heardAt;
    const patience = this.patience(text);
    const specMs = ctl.live ? SPEC_LIVE_MS : SPEC_MS;
    // A pause: ask at once whether these exact words sound finished (the answer is back in about 0.5 s).
    if (quiet > specMs) this.guessReaction(text, true);
    // Prepare the reply as soon as the learner pauses, so it is ready when the pause is long enough
    // (on a long wait, a little later: they often go on, and each early start is a request for nothing).
    if (!this.spec && quiet > Math.max(specMs, patience - 1600) && !this.turn?.waiting) {
      const learner = { who: "me", text, t: this.t0 ? now - this.t0 : 0, id: uid() };
      const spec = new Turn(this, { learner, speculative: true });
      this.spec = spec;
      // The reply starts now, from the browser's words (~0.7 s sooner than waiting for Scribe).
      spec.start();
      if (ctl.rec) {
        // Meanwhile Scribe (or Whisper) writes the voice down. Close to the browser's words: keep the reply,
        // with Scribe's text in the transcript. Clearly different: start the reply again from Scribe's words.
        // spec.text stays the browser's words: they tell whether the learner said more since.
        spec.heard = this.whisper(ctl).then((w) => {
          if (!w || spec.aborted || spec.committed) return;
          if (!enoughWords(w, learner.text)) { SoundLog.count("shortRec"); return; }
          if (closeText(learner.text, w)) {
            learner.text = w;
            spec.whisper = true;
          } else if (ctl.barge && !ctl.freshRec) {
            return; // an interruption: the recording also holds the tutor's voice, so it only corrects small things
          } else {
            spec.abort();
            const again = new Turn(this, { learner: { ...learner, text: w }, speculative: true });
            again.text = spec.text;
            again.whisper = true;
            spec.replacement = again;
            if (this.spec === spec) this.spec = again;
            again.start();
          }
          // Show these words on screen too: they are the ones the tutor gets (more accurate than the browser's).
          if (this.listen === ctl) {
            ctl.whisperShown = { base: spec.text, text: w };
            const live = this.heard(ctl, ctl.text);
            this.liveText = live.startsWith(spec.text) ? `${w}${live.slice(spec.text.length)}` : w;
            this.renderYou();
          }
        });
      }
    }
    // The live ears may still owe the last words (closed at the pause, about 0.2 to 0.5 s; a rescue from
    // the recording, about 1 s): wait for them a little.
    if (quiet > patience && !(ctl.owes?.() && quiet < patience + 1500)) ctl.cut();
  }

  sendText(text, extra = {}) {
    text = String(text || "").trim();
    if (!text || this.ended) return;
    this.stopListening(false);
    Speech.stop();
    const learner = { who: "me", text, t: this.t0 ? performance.now() - this.t0 : 0, id: uid(), ...extra };
    this.msgs.push(learner);
    this.youLine.hidden = true;
    this.pop = this.pop === "type" ? null : this.pop;
    this.clearIdeas();
    this.startTurn(new Turn(this, { learner }));
    if (!extra.help) this.startBarge();
  }

  helpSend(text) { this.pop = null; this.sendText(text, { help: true }); }

  // ---------- Help tools ----------
  lastTutor() { return [...this.msgs].reverse().find((m) => m.who === "tutor"); }

  replay(msg, rate) {
    if (!msg) return;
    this.stopListening(false);
    const u = new Utterance({ tutor: this.tutor, onstart: () => this.renderSubs(), onend: (stopped) => { this.renderControls(); if (!stopped && this.handsFree && !this.pop) setTimeout(() => this.startListening(), 180); }, onsentence: () => this.renderSubs() });
    const voice = Speech.voiceFor(this.tutor);
    const r = rate ?? Speech.rate();
    for (const part of splitSentences(msg.text)) {
      if (voice && !voice.startsWith("browser:")) u.add({ text: part, audio: fetchTTS(part, voice, r, this.tutor) });
      else u.add({ text: part, browser: true, rate: r });
    }
    u.finish();
    this.replayUtt = u;
    msg.replayed = true; // asked to hear it again: its subtitles help
    this.subText = "";
    this.renderSubs(msg.text);
    this.renderControls();
  }

  // Answer ideas for the tutor's LAST question, shown small under the subtitles (never over the face).
  async askIdeas() {
    const forMsg = this.lastTutor();
    if (this.ideasLoading || !forMsg) return;
    if (this.pop === "help") this.pop = null;
    this.ideasLoading = true;
    this.ideasFor = forMsg;
    this.ideas = null;
    this.renderControls();
    this.renderIdeas();
    try {
      const r = await api("/api/hint", { callId: this.callId, config: this.config, history: this.msgs.filter((m) => !m.local).map((m) => ({ who: m.who, text: m.text })) });
      // Too late: the tutor already said something new.
      if (this.ideasFor === forMsg && this.lastTutor() === forMsg) this.ideas = (r.suggestions || []).filter((s) => s && s.es).slice(0, 3);
    } catch (e) {
      toast(errText(e));
    }
    this.ideasLoading = false;
    this.renderControls();
    this.renderIdeas();
  }
  clearIdeas() {
    this.ideas = null;
    this.ideasFor = null;
    this.noNudgeFor = this.lastTutor();
    this.renderIdeas();
  }
  renderIdeas() {
    const slot = this.ideasSlot;
    if (!slot) return;
    const current = this.ideasFor && this.ideasFor === this.lastTutor();
    if (current && this.ideas?.length) {
      slot.replaceChildren(h("div", { class: "ideas-strip", onclick: (e) => e.stopPropagation() },
        h("span", { class: "ideas-label" }, icon("bulb", 14), L("You could say:", "Tu peux dire :")),
        ...this.ideas.map((s) => h("button", { class: "idea", title: s.tr, onclick: () => {
          const u = Speech.say(s.es, { tutor: this.tutor, rate: Math.min(0.85, Speech.rate()), onend: (stopped) => { if (!stopped && this.handsFree) this.startListening(); } });
          if (!u && this.handsFree) this.startListening();
        } }, h("b", null, s.es), this.showTr ? h("span", null, s.tr) : null)),
        h("button", { class: "idea-x", "aria-label": L("Close", "Fermer"), onclick: () => this.clearIdeas() }, icon("x", 14))));
    } else if (current && this.ideasLoading) {
      slot.replaceChildren(h("div", { class: "ideas-strip" }, h("span", { class: "ideas-label" }, icon("bulb", 14), L("Finding ideas…", "Je cherche des idées…"))));
    } else if (this.silenceHelped && this.listen && !this.listen.text && !this.ideas && !this.ideasLoading && this.ideasFor !== this.lastTutor() && this.noNudgeFor !== this.lastTutor()) {
      slot.replaceChildren(h("button", { class: "idea-nudge", onclick: (e) => { e.stopPropagation(); this.askIdeas(); } }, icon("bulb", 15), L("Need an idea?", "Besoin d'une idée ?")));
    } else {
      slot.replaceChildren();
    }
  }

  async askListen() {
    if (this.askListening) { this.askListening.stop(); return; }
    this.stopListening(false);
    Speech.stop();
    if (!Mic.ok) { micError({ code: "unsupported" }); return; }
    const ctl = Mic.listen("fr-FR", { // the learner asks for a French word or phrase
      onUpdate: (t) => { const el = $("#ask-input"); if (el) el.value = t; },
    });
    this.askListening = ctl;
    this.renderControls();
    // Stop by itself after a short pause.
    const watch = setInterval(() => { if (ctl.text && performance.now() - ctl.lastChange > 1200) ctl.stop(); }, 150);
    try {
      const { text } = await ctl.promise;
      if (text) this.helpSend(`How do you say « ${text} » in English?`);
    } catch (e) { micError(e); }
    clearInterval(watch);
    this.askListening = null;
    this.renderControls();
  }

  async practice(m) {
    if (!m.help?.practice) return;
    if (m.practicing) { m.practicing.stop(); return; }
    this.stopListening(false);
    Speech.stop();
    if (!Mic.ok) { micError({ code: "unsupported" }); return; }
    const ctl = Mic.listen(this.t.accent, { onUpdate: () => this.stage.nod() });
    m.practicing = ctl;
    this.renderFloat();
    const watch = setInterval(() => { if (ctl.text && performance.now() - ctl.lastChange > 1100) ctl.stop(); }, 150);
    try {
      const res = await ctl.promise;
      clearInterval(watch);
      m.practicing = null;
      if (!res.text) { toast(L("I did not hear anything.", "Je n'ai rien entendu.")); this.renderFloat(); return; }
      const sc = scoreSpeech(m.help.practice, res.text);
      const first = !m.practiceResult;
      m.practiceResult = { ...sc, said: res.text };
      if (first) this.gain(sc.score >= 80 ? 3 : 1);
      this.renderFloat();
      if (sc.score >= 80) { this.stage.setEmotion("happy", 3500); Speech.say(pick(["Well done!", "Perfect!", "That's it!", "Spot on!"]), { tutor: this.tutor }); }
      else { this.stage.setEmotion("encouraging", 4000); this.stage.focusMouth?.(); Speech.say(`Almost. Listen: ${m.help.practice}`, { tutor: this.tutor, rate: 0.8 }); }
    } catch (e) {
      clearInterval(watch);
      m.practicing = null;
      this.renderFloat();
      micError(e);
    }
  }

  async showWord(word, sentence) {
    const clean = String(word).replace(/^[¿¡"'«“(]+|[.,!?;:"'»”)…]+$/g, "");
    if (!clean) return;
    this.stopListening(false);
    Speech.say(clean, { tutor: this.tutor, rate: 0.8 });
    const key = clean.toLowerCase() + "|" + sentence;
    const info = { word: clean, sentence, data: UI.wordCache.get(key) || null, loading: false, error: null };
    info.loading = !info.data;
    this.wordInfo = info;
    this.renderWordCard();
    if (info.data) return;
    try {
      const d = await api("/api/word", { word: clean, sentence });
      UI.wordCache.set(key, d);
      info.data = d;
    } catch (e) { info.error = e; }
    info.loading = false;
    if (this.wordInfo === info) this.renderWordCard();
  }

  // The tutor just started to answer, and the learner taps: they were not finished. Drop the answer and listen on.
  canResume() {
    const t = this.turn;
    return Boolean(t && t.learner && !t.learner.help && t.speakAt && Speech.speaking() && performance.now() - t.speakAt < RESUME_MS && this.msgs.at(-1) === t.msg);
  }
  resume() {
    const t = this.turn;
    this.notFinished();
    t.abort();
    this.msgs = this.msgs.filter((m) => m !== t.msg && m !== t.learner);
    if (this.float?.msg === t.msg) this.float = null;
    this.correction = null;
    this.turn = null;
    this.stage.setEmotion("encouraging", 2500);
    this.startListening(t.learner.text);
  }

  onStageTap(e) {
    if (e.target.closest("button, .float-card, input, a")) return;
    if (!this.connected) return;
    // Tap the video to interrupt the tutor and answer.
    if (this.canResume()) { this.resume(); return; }
    if (Speech.speaking()) { this.stage.react?.("interrupted"); Speech.stop(); this.startListening(); return; }
    if (this.wordInfo) { this.wordInfo = null; this.renderWordCard(); }
  }

  micTap() {
    if (!this.connected) return;
    if (this.listen) { this.stopListening(true); return; }
    if (this.canResume()) { this.resume(); return; }
    if (this.turn?.waiting) return;
    this.pop = this.pop === "ask" || this.pop === "type" ? null : this.pop;
    this.startListening();
  }

  openPop(kind) {
    this.pop = this.pop === kind ? null : kind;
    if (this.pop === "type" || this.pop === "ask") { this.stopListening(false); this.stopBarge(); }
    this.renderControls();
    if (this.pop === "type") setTimeout(() => $("#type-input")?.focus(), 30);
    if (this.pop === "ask") setTimeout(() => $("#ask-input")?.focus(), 30);
  }

  toggleSide(open) {
    this.el.classList.toggle("side-open", open ?? !this.el.classList.contains("side-open"));
    if (this.el.classList.contains("side-open")) this.scrollTranscript(true);
  }

  // ---------- End ----------
  hangUp(silent = false) {
    if (this.ended) return;
    this.ended = true;
    this.turn?.abort();
    this.spec?.abort();
    this.listen?.abort();
    this.stopBarge();
    this.unduck(true);
    // A whole class without "I was not finished": the pauses may get a little shorter again.
    if (!this.cutEarly && this.said() >= 5 && S.profile.pauseBoost) { S.profile.pauseBoost = Math.max(0, S.profile.pauseBoost - 150); save("profile"); }
    this.askListening?.abort();
    Speech.stop();
    SoundLog.finish();
    LiveEars.close();
    MicMeter.stop();
    clearInterval(this.timer);
    this.ro?.disconnect();
    document.body.classList.remove("in-call");
    $("#call-root").replaceChildren();
    this.stage.dispose?.();
    UI.call = null;
    const minutes = this.minutes();
    const said = this.said();
    // When the learner spoke, the Mac counts the minutes with the class; otherwise count them here.
    if (said < 1 && minutes > 0.2) addMinutes(minutes);
    // The page is closing: the Mac finishes the class by itself.
    if (silent) { this.checkpoint({ closing: true }); render(); return; }
    if (!this.msgs.some((m) => m.who === "me")) { render(); return; }
    startFeedback(this, minutes, said);
  }

  // ---------- Saving the class as it goes ----------
  // After each reply, the Mac keeps a copy of the call. If the window closes or the phone drops the call,
  // the Mac still writes the review, the tutor's memory, the new words and the diary entry.
  // A "part" of the call: normally the whole call. If the Mac already finished the class (the call
  // looked dropped) and the learner goes on talking, the rest is saved as a new part.
  partMsgs() { return this.msgs.slice(this.partFrom || 0); }
  minutes() { return this.connected ? Math.max(0, Date.now() - Math.max(this.startedAt, this.partAt || 0) - this.awayMs) / 60000 : 0; }
  said() { return this.partMsgs().filter((m) => m.who === "me" && !m.help).length; }
  snapshot() {
    const msgs = this.partMsgs();
    return {
      callId: this.part > 1 ? `${this.callId}-p${this.part}` : this.callId,
      mode: this.config.mode, title: this.config.title || "", tutor: this.tutor, sceneId: this.config.sceneId || "", lessonId: this.config.courseLesson || "",
      skills: (this.plan?.skills || []).map((s) => s.id),
      history: msgs.filter((m) => !m.local && m.text).map((m) => ({ who: m.who, text: m.text })),
      fixes: msgs.filter((m) => m.fix).map((m) => ({ you_said: m.fix.you, better: m.fix.better, why: m.fix.why })),
      minutes: this.minutes(), said: this.said(), xp: this.xp - (this.partXp || 0), msgCount: this.msgs.length,
    };
  }
  checkpoint({ closing = false } = {}) {
    if (!this.callId || this.said() < 1) return;
    this.savedAt = Date.now();
    const snap = this.snapshot();
    let body = JSON.stringify({ ...snap, closing });
    const size = (s) => new Blob([s]).size;
    // A request sent while the page closes must stay small (the browser allows about 64 KB in all).
    // The Mac already has the earlier messages from the last save, so a long call sends only its totals.
    if (closing && size(body) > 40000) { const { history, fixes, ...totals } = snap; body = JSON.stringify({ ...totals, closing }); }
    const keepalive = (closing || document.hidden) && size(body) <= 40000;
    fetch("/api/call/save", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d?.done || this.ended) return;
        this.part = (this.part || 1) + 1;
        this.partFrom = Math.min(this.msgs.length, d.msgCount || this.msgs.length);
        this.partAt = Date.now();
        this.partXp = this.xp;
      })
      .catch(() => {});
  }
  onHidden() {
    this.hiddenAt = Date.now();
    this.checkpoint();
  }
  onVisible() {
    if (!this.hiddenAt) return;
    const away = Date.now() - this.hiddenAt;
    this.hiddenAt = 0;
    // Away for more than 10 minutes: the call has dropped, like a real video call. Finish it with the review.
    if (away > 10 * 60_000 && this.connected) { this.awayMs += away; this.hangUp(); }
  }

  // ---------- Rendering ----------
  mode() {
    if (Speech.speaking()) return "speaking";
    if (this.listen || this.askListening) return "listening";
    if (this.turn?.waiting || this.ideasLoading || (this.wordInfo && this.wordInfo.loading)) return "thinking";
    return "idle";
  }

  statusText(mode) {
    const n = this.t.name;
    if (!this.connected) return L("Connecting…", "Connexion…");
    if (mode === "speaking") return L(`${n} is speaking`, `${n} parle`);
    if (mode === "listening") return L("Listening…", "Je t'écoute…");
    if (mode === "thinking") return L(`${n} is thinking…`, `${n} réfléchit…`);
    return L("Your turn", "À toi");
  }

  renderAll() {
    this.renderTopic();
    this.renderPhase();
    this.renderSubs();
    this.renderYou();
    this.renderFloat();
    this.renderWordCard();
    this.renderCorrection();
    this.renderIdeas();
    this.renderTranscript();
    this.renderControls();
  }

  everySecond() {
    const now = Date.now();
    // The page was frozen (lid closed, phone asleep) for more than 10 minutes: the call has dropped.
    if (this.lastTick && now - this.lastTick > 10 * 60_000 && this.connected) { this.awayMs += now - this.lastTick; this.lastTick = now; this.hangUp(); return; }
    this.lastTick = now;
    if (this.connected) this.timerEl.textContent = clock(performance.now() - this.t0) + (this.config.mode === "assess" && this.plan?.minutes ? ` / ${this.plan.minutes}:00` : "");
    // Tell the Mac every 5 minutes that the call is still open.
    if (this.connected && now - (this.savedAt || 0) > 5 * 60_000) this.checkpoint();
  }

  renderTopic() {
    if (this.config.mode === "lesson") return;
    let text = "";
    if (this.config.mode === "news" && this.plan?.news?.[0]) text = "📰 " + this.plan.news[0].title;
    else if (this.config.mode === "news") text = L("📰 Today's news", "📰 L'actualité du jour");
    else if (this.config.mode === "scene") text = "🎭 " + (LT({ fr: this.config.scene?.fr, en: this.config.scene?.en }) || this.config.scene?.title || "");
    else if (this.config.mode === "assess") text = L("🎯 First session: talk as much as you can", "🎯 Première séance : parle autant que tu peux");
    else if (this.config.topic) text = "💬 " + this.config.topic;
    this.topicEl.textContent = text;
    this.topicEl.hidden = !text;
  }

  renderPhase() {
    if (this.config.mode !== "lesson") return;
    const idx = PHASES.findIndex((p) => p[0] === this.phase);
    this.phaseEl.replaceChildren(...PHASES.map((p, i) => h("span", { class: `ph${i < idx ? " done" : i === idx ? " now" : ""}` }, h("i"), h("span", null, L(p[1], p[2])))));
  }

  // Subtitles of what the tutor is saying, word by word. Each word can be tapped.
  renderSubs(force) {
    const u = Speech.current;
    // Like captions on a video call: the sentence being said, then the last one (often the question).
    // The whole answer is in the transcript.
    let text = force ? splitSentences(force).at(-1) || force : "";
    this.subOffset = null;
    if (!text) {
      if (u && (u === this.turn?.utt || u === this.replayUtt) && u.cur) {
        const s = u.cur.sent;
        text = s.text;
        this.subOffset = s.start;
      } else {
        const m = this.turn?.msg && this.msgs.includes(this.turn.msg) ? this.turn.msg : this.lastTutor();
        text = m ? splitSentences(m.text).at(-1) || "" : "";
      }
    }
    if (text !== this.subText) {
      this.subText = text;
      this.subLine.replaceChildren();
      this.subWords = [];
      let pos = 0;
      for (const part of text.split(/(\s+)/)) {
        if (!part) continue;
        if (/^\s+$/.test(part)) { this.subLine.append(part); pos += part.length; continue; }
        const b = h("button", { class: "w", type: "button", onclick: (e) => { e.stopPropagation(); this.showWord(part, text); } }, part);
        b._s = pos; b._e = pos + part.length;
        this.subLine.append(b);
        this.subWords.push(b);
        pos += part.length;
      }
      this.subMark = -2;
    }
    const m = this.lastTutor();
    this.subTr.textContent = this.showTr && m && m.tr && text && m.text.includes(text.slice(0, 20)) ? m.tr : "";
    // Which answer the line belongs to: the one being said, the one replayed, else the latest.
    const shownMsg = u && u === this.turn?.utt && u.cur ? this.turn.msg
      : u && u === this.replayUtt && u.cur ? this.lastReplayed()
        : this.turn?.msg && this.msgs.includes(this.turn.msg) ? this.turn.msg : m;
    const shown = subsAll() || Boolean(shownMsg && (shownMsg.teach || shownMsg.replayed));
    this.subLine.hidden = !shown || !text;
    this.subTr.hidden = !shown || !this.subTr.textContent;
  }
  lastReplayed() { return [...this.msgs].reverse().find((x) => x.who === "tutor" && x.replayed); }

  markSubs() {
    const u = Speech.current;
    const mine = u && (u === this.turn?.utt || u === this.replayUtt);
    const pos = mine && u.cur && this.subOffset != null ? u.charPos() - this.subOffset : null;
    const key = pos == null ? -1 : Math.floor(pos);
    if (key === this.subMark) return;
    this.subMark = key;
    for (const b of this.subWords || []) {
      const said = pos == null || b._e <= pos;
      b.classList.toggle("said", said);
      b.classList.toggle("now", pos != null && b._s <= pos && b._e > pos);
    }
  }

  renderYou() {
    const listening = Boolean(this.listen);
    // The learner's own captions: shown as soon as the mic is open, then word by word (only with every subtitle on).
    if (!subsAll()) this.youLine.hidden = true;
    else if (listening) {
      this.youLine.hidden = false;
      this.youLine.textContent = this.liveText || L("Listening…", "Je t'écoute…");
      this.youLine.classList.toggle("empty", !this.liveText);
    } else if (this.turn?.waiting && this.turn.learner) {
      this.youLine.hidden = false;
      this.youLine.textContent = this.turn.learner.text;
    } else this.youLine.hidden = true;
  }

  renderFloat() {
    const f = this.float;
    this.stageEl.classList.toggle("has-card", Boolean(f && f.open));
    if (!f) { this.floatSlot.replaceChildren(); return; }
    const m = f.msg;
    // On a phone the card starts small, so it never hides the tutor's face.
    if (!f.open) {
      const label = f.kind === "help" ? L("Help card", "Aide") : (m.board?.title || L("Whiteboard", "Tableau"));
      this.floatSlot.replaceChildren(h("button", { class: "float-pill glass", onclick: (e) => { e.stopPropagation(); f.open = true; this.renderFloat(); } },
        icon(f.kind === "help" ? "bulb" : "board", 16), h("span", null, label), icon("down", 16)));
      return;
    }
    const close = h("span", { class: "row nowrap", style: "gap:6px" },
      IS_PHONE() ? h("button", { class: "fc-x", "aria-label": L("Minimise", "Réduire"), onclick: (e) => { e.stopPropagation(); f.open = false; this.renderFloat(); } }, icon("down", 16)) : null,
      h("button", { class: "fc-x", "aria-label": L("Close", "Fermer"), onclick: (e) => { e.stopPropagation(); this.float = null; this.renderFloat(); } }, icon("x", 16)));
    let card;
    if (f.kind === "help" && m.help) {
      const title = m.help.kind === "vocab" ? L("Word help", "Vocabulaire") : m.help.kind === "rephrase" ? L("Said more simply", "Plus simplement") : L("Explanation", "Explication");
      card = h("div", { class: "float-card" },
        h("div", { class: "fc-head" }, h("span", { class: "eyebrow" }, icon("bulb", 14), title), close),
        m.help.explanation ? h("p", null, m.help.explanation) : null,
        m.board ? boardEl(m.board, this) : null,
        m.help.practice ? h("div", { class: "practice-box" },
          h("div", { class: "practice-phrase" }, m.practiceResult ? marksEl(m.practiceResult.marks) : m.help.practice),
          h("div", { class: "row" },
            h("button", { class: "chip", onclick: () => Speech.say(m.help.practice, { tutor: this.tutor, rate: 0.8 }) }, icon("speaker", 14), L("Listen", "Écouter")),
            h("button", { class: `chip${m.practicing ? " on" : ""}`, onclick: () => this.practice(m) }, icon("mic", 14), m.practicing ? L("Stop", "Stop") : L("I repeat", "Je répète")),
            m.practiceResult ? h("span", { class: `badge ${scoreClass(m.practiceResult.score)}` }, `${m.practiceResult.score}%`) : null)) : null);
    } else if (m.board) {
      card = h("div", { class: "float-card" },
        h("div", { class: "fc-head" }, h("span", { class: "eyebrow" }, icon("board", 14), L("Whiteboard", "Tableau")), close),
        boardEl(m.board, this));
    }
    this.floatSlot.replaceChildren(card || "");
  }

  renderWordCard() {
    const w = this.wordInfo;
    if (!w) { this.wordSlot.replaceChildren(); return; }
    const saved = w.data && wordSaved(w.data.base || w.word);
    this.wordSlot.replaceChildren(h("div", { class: "float-card word-card", onclick: (e) => e.stopPropagation() },
      h("div", { class: "fc-head" }, h("div", null, h("div", { class: "eyebrow" }, L("Word", "Mot")), h("h3", null, w.word)),
        h("button", { class: "fc-x", "aria-label": L("Close", "Fermer"), onclick: () => { this.wordInfo = null; this.renderWordCard(); } }, icon("x", 16))),
      w.loading ? h("p", { class: "muted" }, L("Looking it up…", "Je cherche…")) : null,
      w.error ? h("p", { class: "muted" }, errText(w.error)) : null,
      w.data ? h("div", { class: "stack tight" },
        h("p", null, h("b", null, w.data.tr)),
        w.data.base && w.data.base.toLowerCase() !== w.word.toLowerCase() ? h("p", { class: "small muted" }, L("Dictionary form: ", "Forme de base : "), h("b", null, w.data.base)) : null,
        w.data.note ? h("p", { class: "small" }, w.data.note) : null,
        w.data.example ? h("p", { class: "small muted" }, "« ", w.data.example, " »") : null) : null,
      h("div", { class: "row" },
        h("button", { class: "chip", onclick: () => Speech.say(w.word, { tutor: this.tutor, rate: 0.75 }) }, icon("speaker", 14), L("Listen", "Écouter")),
        w.data ? h("button", { class: `chip${saved ? " saved" : ""}`, onclick: () => { const es = w.data.base || w.word; if (addWord(es, w.data.tr)) toast(L(`Saved: ${es}`, `Ajouté à tes mots : ${es}`)); this.renderWordCard(); } }, icon(saved ? "check" : "plus", 14), saved ? L("In my words", "Dans mes mots") : L("Add to my words", "Ajouter à mes mots")) : null)));
  }

  renderCorrection() {
    const c = this.correction;
    if (!c || this.pop) { this.corrSlot.replaceChildren(); return; }
    // One short line; the explanation shows when tapped.
    this.corrSlot.replaceChildren(h("div", { class: "corr-toast", onclick: (e) => { e.stopPropagation(); c.open = !c.open; clearTimeout(this.corrTimer); this.renderCorrection(); } },
      h("span", { class: "ico" }, icon("sparkle", 16)),
      h("div", { class: "ct" }, h("s", null, c.you), " → ", h("b", null, c.better), c.why && c.open ? h("span", { class: "why" }, c.why) : null),
      h("button", { class: "icon-btn", "aria-label": L("Listen", "Écouter"), onclick: (e) => { e.stopPropagation(); Speech.say(c.better, { tutor: this.tutor, rate: 0.85 }); } }, icon("speaker", 16))));
  }

  renderTranscript() {
    const el = this.transcriptEl;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    this.trBtn.replaceChildren(icon("translate", 14), this.showTr ? L("Translation on", "Traduction : oui") : L("Translation off", "Traduction : non"));
    this.trBtn.setAttribute("aria-pressed", String(this.showTr));
    this.trBtn.classList.toggle("on", this.showTr);
    if (this.config.mode === "scene") {
      this.goalsEl.replaceChildren(...(this.config.scene?.tasks || []).map((task, i) => h("span", { class: `goal${this.done.includes(i) ? " done" : ""}` }, this.done.includes(i) ? icon("check", 13) : null, L(task, this.config.scene?.tasksFr?.[i] || task))));
    }
    const out = [];
    for (const m of this.msgs) {
      if (m.who === "tutor") {
        out.push(h("div", { class: "msg tutor" },
          h("div", { class: "es" }, tokensEl(m.text, (w) => this.showWord(w, m.text))),
          (this.showTr || m.showTr) && m.tr ? h("div", { class: "tr" }, m.tr) : null,
          h("div", { class: "msg-tools" },
            h("button", { class: "chip sm", onclick: () => this.replay(m) }, icon("speaker", 13), L("Listen", "Écouter")),
            h("button", { class: "chip sm", title: L("Slowly", "Lentement"), "aria-label": L("Listen slowly", "Écouter lentement"), onclick: () => this.replay(m, 0.68) }, icon("turtle", 13)),
            !this.showTr && m.tr ? h("button", { class: "chip sm", onclick: () => { m.showTr = !m.showTr; this.renderTranscript(); } }, m.showTr ? L("Hide", "Masquer") : L("Translate", "Traduire")) : null,
            (m.words || []).map((w) => {
              const saved = wordSaved(w.es);
              return h("button", { class: `chip sm${saved ? " saved" : ""}`, title: w.tr, onclick: () => { if (addWord(w.es, w.tr)) toast(L(`Saved: ${w.es}`, `Ajouté à tes mots : ${w.es}`)); this.renderTranscript(); } }, icon(saved ? "check" : "plus", 12), w.es);
            }))));
        if (m.help && m.help.explanation) out.push(h("div", { class: "note help" }, h("b", null, m.help.kind === "vocab" ? L("Word help", "Vocabulaire") : m.help.kind === "rephrase" ? L("Said more simply", "Plus simplement") : L("Explanation", "Explication")), h("span", null, m.help.explanation), m.help.practice ? h("span", null, "→ ", h("b", null, m.help.practice)) : null));
        if (m.board) out.push(h("div", { class: "note board" }, h("b", null, m.board.title || L("Whiteboard", "Tableau")), ...m.board.lines.map((l) => h("span", null, l))));
      } else {
        out.push(h("div", { class: `msg me${m.help ? " ask" : ""}` }, m.text));
        if (m.fix) out.push(h("div", { class: "note fix" },
          h("span", null, h("s", null, m.fix.you), " → ", h("b", null, m.fix.better)),
          m.fix.why ? h("span", { class: "why" }, m.fix.why) : null,
          h("span", { class: "row", style: "margin-top:4px" },
            h("button", { class: "chip sm", onclick: () => Speech.say(m.fix.better, { tutor: this.tutor }) }, icon("speaker", 13), L("Listen", "Écouter")),
            h("button", { class: "chip sm", onclick: () => { if (addWord(m.fix.better, L(`Instead of "${m.fix.you}"`, `Au lieu de « ${m.fix.you} »`), { kind: "fix" })) toast(L("Added to your words", "Ajouté à tes mots")); else toast(L("Already in your words", "Déjà dans tes mots")); } }, icon("plus", 13), L("Add to my words", "Ajouter à mes mots")))));
        if (m.pron) out.push(h("div", { class: "note pron" }, h("b", null, L("Pronunciation", "Prononciation")), h("span", null, m.pron)));
      }
    }
    if (this.turn?.waiting && this.connected) out.push(h("div", { class: "typing", "aria-label": L("Thinking", "Réflexion") }, h("i"), h("i"), h("i")));
    if (this.lastError) out.push(h("div", { class: "error-box" }, h("span", null, errText(this.lastError.e)), h("button", { class: "btn sm", onclick: () => this.retry() }, L("Try again", "Réessayer"))));
    if (!out.length) out.push(h("p", { class: "muted small", style: "text-align:center;margin-top:20px" }, L("The conversation will appear here.", "La conversation s'affichera ici.")));
    el.replaceChildren(...out);
    if (nearBottom) this.scrollTranscript();
  }

  scrollTranscript(now) {
    requestAnimationFrame(() => { this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight; });
  }

  renderControls() {
    const mode = this.mode();
    const listening = Boolean(this.listen);
    const micState = listening ? "listening" : mode === "speaking" ? "speaking" : mode === "thinking" ? "thinking" : !this.handsFree ? "muted" : "idle";
    this.micBtn = h("button", { class: "mic-big", "data-state": micState, disabled: !this.connected, onclick: () => this.micTap(),
      "aria-label": listening ? L("Send now", "Envoyer") : mode === "speaking" ? (this.canResume() ? L("I was not finished", "Je n'avais pas fini") : L("Interrupt and answer", "Interrompre et répondre")) : L("Speak", "Parler") },
      h("span", { class: "mic-lvl" }),
      this.ringSvg = this.makeRing(),
      icon(listening ? "send" : "mic", 32));
    const ctl = (ico, label, onclick, extra = {}) => h("button", { class: `ctl ${extra.cls || ""}`, onclick, disabled: extra.disabled, "aria-label": label, title: label }, h("span", { class: "b" }, icon(ico, extra.size || 24)), h("span", null, label));
    this.ctlRow.replaceChildren(
      ctl("chat", L("Transcript", "Texte"), () => { this.toggleSide(); this.renderControls(); }, { cls: this.el.classList.contains("side-open") ? "on" : "" }),
      ctl("help", L("Help", "Aide"), () => this.openPop("help"), { cls: this.pop === "help" || this.pop === "ideas" || this.pop === "ask" ? "on" : "", disabled: !this.connected }),
      this.micBtn,
      ctl("keyboard", L("Type", "Écrire"), () => this.openPop("type"), { cls: this.pop === "type" ? "on" : "", disabled: !this.connected }),
      ctl("hangup", L("Hang up", "Raccrocher"), () => this.hangUp(), { cls: "hang", size: 26 }));

    let hint = "";
    if (!this.connected) hint = L(`${this.t.name} is joining the call…`, `${this.t.name} arrive dans l'appel…`);
    else if (listening && this.resumeText && this.liveText === this.resumeText) hint = L("Go on, I'm listening…", "Continue, je t'écoute…");
    else if (listening && this.micSilent) hint = L("I can't hear anything yet. Speak, or pick another mic in Settings.", "Je n'entends rien pour l'instant. Parle, ou choisis un autre micro dans Réglages.");
    else if (listening) hint = this.liveText ? L("Pause when you're done · tap to send now", "Fais une pause quand tu as fini · touche pour envoyer") : L("Speak English… (or French if you're stuck)", "Parle anglais… (ou français si tu bloques)");
    else if (mode === "speaking" && this.canResume()) hint = this.barge ? L("Not finished? Just keep talking", "Pas fini ? Continue simplement à parler") : L("Not finished? Tap the mic to go on", "Pas fini ? Touche le micro pour continuer");
    else if (mode === "speaking") hint = this.barge ? L("Just talk to interrupt", "Parle pour l'interrompre") : L("Tap the video or the mic to interrupt", "Touche la vidéo ou le micro pour l'interrompre");
    else if (mode === "thinking") hint = "";
    else if (!Mic.ok) hint = L("Voice input needs Chrome or Safari. Tap Type to write.", "La voix demande Chrome ou Safari. Touche Écrire.");
    else hint = this.handsFree ? L("Tap the mic to talk", "Touche le micro pour parler") : L("Tap the mic to talk · hands-free is off", "Touche le micro pour parler · mode mains libres désactivé");
    this.hintEl.textContent = hint;

    // End of class banner
    this.endSlot.replaceChildren(this.endOffered && !this.ended ? h("div", { class: "end-banner" },
      icon("check", 18), L("Class finished. Well done!", "Cours terminé. Well done!"),
      h("button", { class: "btn sm green", onclick: () => this.hangUp() }, L("See my review", "Voir mon bilan")),
      h("button", { class: "btn sm ghost", onclick: () => { this.endOffered = false; this.renderControls(); if (this.handsFree) this.startListening(); } }, L("Keep talking", "Continuer"))) : "");

    this.popSlot.replaceChildren(this.popEl() || "");
    this.renderCorrection();
  }

  makeRing() {
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("class", "ring-svg");
    s.setAttribute("viewBox", "0 0 100 100");
    s.innerHTML = `<circle cx="50" cy="50" r="47" fill="none" stroke="rgba(255,255,255,0.9)" stroke-width="4" stroke-linecap="round" stroke-dasharray="295.3" stroke-dashoffset="295.3"/>`;
    this.ringCircle = s.firstChild;
    return s;
  }

  popEl() {
    const last = this.lastTutor();
    const busy = Boolean(this.turn?.waiting);
    if (this.pop === "help") {
      const b = (ico, label, onclick, disabled, on) => h("button", { onclick, disabled, class: on ? "on" : "" }, icon(ico, 24), label);
      return h("div", { class: "call-pop" },
        h("div", { class: "help-grid" },
          b("turtle", L("Repeat slowly", "Répète lentement"), () => { this.pop = null; this.replay(last, 0.68); }, !last),
          b("repeat", L("I didn't understand", "Je n'ai pas compris"), () => this.helpSend("Sorry, I didn't catch that. Could you say it again, a bit slower and with simpler words?"), !last || busy),
          b("ask", L("How do I say…?", "Comment on dit… ?"), () => this.openPop("ask"), busy),
          b("bulb", L("Answer ideas", "Idées de réponse"), () => this.askIdeas(), !this.msgs.length || busy),
          b("translate", this.showTr ? L("Translation: on", "Traduction : oui") : L("Translation: off", "Traduction : non"), () => { this.showTr = !this.showTr; this.renderAll(); }, false, this.showTr),
          b("hand", this.handsFree ? L("Hands-free: on", "Mains libres : oui") : L("Hands-free: off", "Mains libres : non"), () => { this.handsFree = !this.handsFree; S.profile.handsFree = this.handsFree; save("profile"); this.renderControls(); }, !Mic.ok, this.handsFree)));
    }
    if (this.pop === "ask") {
      const input = h("input", { class: "input", id: "ask-input", autocomplete: "off", placeholder: L("Type or say it in English", "Écris ou dis-le en français") });
      return h("form", { class: "call-pop", onsubmit: (e) => { e.preventDefault(); const v = input.value.trim(); if (!v) return input.focus(); this.helpSend(`How do you say « ${v} » in English?`); } },
        h("div", { class: "pop-head" }, h("b", null, L("How do I say…?", "Comment on dit… ?")), h("button", { type: "button", class: "icon-btn plain", "aria-label": L("Close", "Fermer"), onclick: () => this.openPop("ask") }, icon("x", 18))),
        h("div", { class: "in-row" },
          h("button", { type: "button", class: `icon-btn${this.askListening ? " on" : ""}`, "aria-label": L("Say it", "Dis-le"), onclick: () => this.askListen() }, icon(this.askListening ? "send" : "mic", 18)),
          input,
          h("button", { class: "btn sm", type: "submit", disabled: busy }, L("Ask", "Demander"))));
    }
    if (this.pop === "type") {
      const input = h("input", { class: "input", id: "type-input", autocomplete: "off", placeholder: L("Type in English…", "Écris en anglais…") });
      return h("form", { class: "call-pop", onsubmit: (e) => { e.preventDefault(); const v = input.value.trim(); if (!v) return input.focus(); this.sendText(v); } },
        h("div", { class: "in-row" }, input, h("button", { class: "btn sm", type: "submit", disabled: busy, "aria-label": L("Send", "Envoyer") }, icon("send", 18))));
    }
    if (this.pop === "ideas") {
      return h("div", { class: "call-pop" },
        h("div", { class: "pop-head" }, h("b", null, L("Ideas: say one out loud", "Idées : dis-en une à voix haute")), h("button", { class: "icon-btn plain", "aria-label": L("Close", "Fermer"), onclick: () => { this.pop = null; this.renderControls(); } }, icon("x", 18))),
        this.ideasLoading ? h("p", { class: "muted small" }, L("Finding ideas…", "Je cherche des idées…")) : null,
        this.ideas ? h("div", { class: "suggest" }, this.ideas.map((s) => h("button", { onclick: () => {
          const u = Speech.say(s.es, { tutor: this.tutor, rate: 0.85, onend: (stopped) => { if (!stopped && this.handsFree) this.startListening(); } });
          if (!u && this.handsFree) this.startListening();
          this.pop = null;
          this.renderControls();
        } }, h("b", null, s.es), h("span", null, s.tr)))) : null);
    }
    return null;
  }

  // ---------- Animation frame ----------
  frame(now) {
    const mode = this.mode();
    const u = Speech.current;
    if (this.duckAt && now - this.duckAt > DUCK_MS) { // only one word (a cough, a misheard echo): the tutor goes on
      if (this.barge) this.barge.forgiven = this.barge.duckN;
      this.unduck();
    }
    const mine = u && u.playing;
    this.stage.frame(now, {
      mode,
      level: mine ? VoiceMeter.level() : 0,
      bands: mine ? VoiceMeter.bands() : null,
      viseme: mine ? u.viseme() : null,
      mouth: mine ? u.mouth() : null,
      latency: mine ? AudioOut.ctx?.outputLatency || 0 : 0,
      question: mine ? u.question() : false,
      userLevel: mode === "listening" ? MicMeter.read() : 0,
    });
    this.markSubs();
    if (this.liveChip.dataset.mode !== mode || this.lastStatus !== this.statusText(mode)) {
      this.liveChip.dataset.mode = mode;
      this.lastStatus = this.statusText(mode);
      this.liveChip.lastChild.textContent = this.lastStatus;
    }
    if (this.lastMode !== mode) { this.lastMode = mode; this.renderControls(); this.renderYou(); if (mode !== "speaking") this.renderTranscript(); }
    const resumable = mode === "speaking" && this.canResume();
    if (resumable !== this.lastResumable) { this.lastResumable = resumable; this.renderControls(); }
    if (this.listen) {
      this.checkSilence(now);
      const ctl = this.listen;
      const quiet = ctl && ctl.text ? now - ctl.lastChange : 0;
      const p = ctl && ctl.text ? clamp((quiet - 250) / (this.patience(this.heard(ctl, ctl.text)) - 250), 0, 1) : 0;
      if (this.ringCircle) this.ringCircle.setAttribute("stroke-dashoffset", String(295.3 * (1 - p)));
      if (this.micBtn) this.micBtn.style.setProperty("--lvl", String(1 + MicMeter.level * 0.35));
    } else if (this.ringCircle && this.ringCircle.getAttribute("stroke-dashoffset") !== "295.3") {
      this.ringCircle.setAttribute("stroke-dashoffset", "295.3");
    }
  }
}

function boardEl(board, call) {
  return h("div", { class: "stack tight" },
    board.title ? h("h3", null, board.title) : null,
    h("div", { class: "board-lines" }, board.lines.map((line) => h("button", { onclick: (e) => { e.stopPropagation(); const es = line.split(/\s[=·—-]\s|:/)[0]; Speech.say(es, { tutor: call.tutor, rate: 0.8 }); } }, line))));
}

function tokensEl(text, onWord) {
  const wrap = h("span", { class: "toks" });
  for (const part of String(text).split(/(\s+)/)) {
    if (!part) continue;
    if (/^\s+$/.test(part)) wrap.append(part);
    else wrap.append(h("button", { class: "tok", type: "button", onclick: () => onWord(part) }, part));
  }
  return wrap;
}

function splitSentences(text) {
  const raw = String(text).match(/[^.!?…]+[.!?…]+["»”)]*\s*|[^.!?…]+$/g) || [text];
  return raw.map((s) => s.trim()).filter(Boolean);
}

function startCall(config) {
  if (UI.call) return;
  if (UI.hasKey === false) {
    if (!UI.local) { toast(L("First, add your API key on the Mac (Settings).", "Ajoute d'abord ta clé API sur le Mac (Réglages)."), 4500); return; }
    toast(L("First, add your API key in Settings.", "D'abord, ajoute ta clé API dans les Réglages."), 4000);
    openSettings();
    return;
  }
  AudioOut.unlock();
  Speech.stop();
  UI.feedback = null;
  UI.call = new Call(config);
}

// =====================================================================
// After the call: the review
// =====================================================================
async function startFeedback(call, minutes, said) {
  const f = {
    status: "loading", tutor: call.tutor, mode: call.config.mode, title: call.config.title || "", minutes, said, xp: call.xp,
    skills: call.plan?.skills || [], config: call.config, error: null, result: null,
    snap: { ...call.snapshot(), minutes },
  };
  UI.feedback = f;
  UI.tab = "home";
  render();
  window.scrollTo(0, 0);
  if (said < 1) { f.status = "short"; render(); return; }
  await runReview(f);
}

function goalToast(before) {
  const goal = Number(S.profile.minutes) || 15;
  if (before < goal && minutesToday() >= goal) toast(L(`Daily goal reached. Well done! ${liveStreak()}-day streak`, `Objectif du jour atteint. Well done! Série : ${pl(liveStreak(), "jour", "jours")}`), 4000);
}

// The Mac writes everything (review, skills, memory, new words, XP, diary), then the app reloads it.
// skip = "Save without review": the diary entry only. A retry never saves the class twice.
async function runReview(f, { skip = false } = {}) {
  try {
    const before = minutesToday();
    const out = await api("/api/review", { ...f.snap, skipReview: skip });
    await syncState().catch(() => {});
    goalToast(before);
    if (UI.feedback !== f) return;
    if (skip || !out.review) { UI.feedback = null; render(); return; }
    if (UI.tab !== "home") toast(L("Your review is ready on Home.", "Ton bilan est prêt sur l'Accueil."), 4000);
    const r = out.review;
    f.xp = out.entry?.xp ?? f.xp + 20;
    f.result = { ...r, score: clamp(Math.round(Number(r.score) || 0), 0, 100), added: out.added || [], progress: out.progress, homework: out.homework || null };
    f.status = "done";
    if (out.assess?.status === "done") setTimeout(ensurePlan, 0);
    setTimeout(maybeAdapt, 0);
  } catch (e) {
    if (UI.feedback !== f) return;
    if (skip) { toast(errText(e), 4000); return; }
    f.status = "error";
    f.error = e;
  }
  render();
}
