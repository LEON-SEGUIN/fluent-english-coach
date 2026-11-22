"use strict";
// Fluent — screens: home, practice (with the free calls), progress, review after a call, first-time setup,
// phone login, settings. The course, its lessons and the homework are in course.js.

const TABS = [
  ["home", "home", "Home", "Accueil"],
  ["lessons", "cap", "Lessons", "Cours"],
  ["homework", "check", "Homework", "Devoirs"],
  ["practice", "cards", "Practice", "Pratique"],
  ["progress", "path", "Progress", "Progrès"],
];

function renderNav() {
  const todo = typeof hwTodo === "function" ? hwTodo().reduce((a, x) => a + hwOpen(x), 0) : 0;
  const make = (cls) => TABS.map(([id, ico, en, fr]) => {
    const b = h("button", { type: "button", "aria-current": UI.tab === id && !UI.feedback ? "page" : "false", onclick: () => setTab(id) },
      cls ? h("span", { class: "nav-ico" }, icon(ico, 22)) : icon(ico, 18), h("span", null, L(en, fr)),
      id === "homework" && todo ? h("span", { class: "nav-badge", "aria-label": L(`${todo} to do`, `${todo} à faire`) }, String(todo)) : null);
    return b;
  });
  $("#tabs").replaceChildren(...make(false));
  $("#bottom-nav").replaceChildren(...make(true));
  const gear = $("#open-settings");
  gear.setAttribute("aria-label", L("Settings", "Réglages"));
  gear.title = L("Settings", "Réglages");
}

function renderPill() {
  const el = $("#pill-streak");
  if (!el) return;
  el.replaceChildren(icon("flame", 16), h("span", null, `${liveStreak()}`));
  el.title = L(`${liveStreak()}-day streak`, `Série : ${pl(liveStreak(), "jour", "jours")}`);
}

function errorBox(err, retry) {
  return h("div", { class: "error-box" },
    h("span", null, errText(err)),
    h("span", { class: "row" },
      retry ? h("button", { class: "btn sm danger", onclick: retry }, L("Try again", "Réessayer")) : null,
      (err?.code === "no_key" || err?.code === "bad_key") && UI.local ? h("button", { class: "btn sm", onclick: openSettings }, L("Open Settings", "Ouvrir les Réglages")) : null));
}

// ---------- API key ----------
function keyForm(onDone) {
  const input = h("input", { class: "input", type: "password", placeholder: "sk-ant-…", autocomplete: "off" });
  const status = h("p", { class: "small muted" });
  const btn = h("button", { class: "btn", type: "submit" }, L("Connect", "Connecter"));
  const form = h("form", { class: "stack tight", onsubmit: async (e) => {
    e.preventDefault();
    btn.disabled = true;
    status.textContent = L("Checking your key…", "Je vérifie ta clé…");
    try {
      await api("/api/key", { key: input.value });
      UI.hasKey = true;
      toast(L("Connected. Your tutor is waiting for you.", "C'est connecté. Ton prof t'attend."));
      onDone?.();
    } catch (err) {
      status.textContent = err.code === "bad_key" ? L("This key does not work. Copy it again (it starts with sk-ant-).", "Cette clé ne marche pas. Recopie-la (elle commence par sk-ant-).") : errText(err);
      btn.disabled = false;
    }
  } }, h("div", { class: "topic-form" }, h("div", { class: "grow" }, input), btn), status);
  return form;
}

// Groq key: Whisper writes down the learner's voice (free account, see stt.js).
function sttKeyForm(onDone) {
  const input = h("input", { class: "input", type: "password", placeholder: "gsk_…", autocomplete: "off" });
  const status = h("p", { class: "small muted" });
  const btn = h("button", { class: "btn", type: "submit" }, L("Connect", "Connecter"));
  return h("form", { class: "stack tight", onsubmit: async (e) => {
    e.preventDefault();
    btn.disabled = true;
    status.textContent = L("Checking your key…", "Je vérifie ta clé…");
    try {
      await api("/api/stt-key", { key: input.value });
      UI.stt = true;
      toast(L("Connected. Your tutor now hears you much better.", "C'est connecté. Ton prof t'entend beaucoup mieux."));
      onDone?.();
    } catch (err) {
      status.textContent = err.code === "bad_key" ? L("This key does not work. Copy it again (it starts with gsk_).", "Cette clé ne marche pas. Recopie-la (elle commence par gsk_).") : errText(err);
      btn.disabled = false;
    }
  } }, h("div", { class: "topic-form" }, h("div", { class: "grow" }, input), btn), status);
}

// ElevenLabs: the tutor's voice (pay as you go). After a new key, the voice list is read again.
function elevenKeyForm(onDone) {
  const input = h("input", { class: "input", type: "password", placeholder: "sk_…", autocomplete: "off", "aria-label": L("ElevenLabs key", "Clé ElevenLabs") });
  const status = h("p", { class: "small muted" });
  const btn = h("button", { class: "btn", type: "submit" }, L("Connect", "Connecter"));
  return h("form", { class: "stack tight", onsubmit: async (e) => {
    e.preventDefault();
    btn.disabled = true;
    status.textContent = L("Checking your key…", "Je vérifie ta clé…");
    try {
      await api("/api/voice-key", { key: input.value });
      UI.eleven = true;
      await Speech.init();
      toast(L("Connected. Tap “Test” to hear your tutor's new voice.", "C'est connecté. Touche « Tester » pour entendre la nouvelle voix de ton prof."), 4000);
      onDone?.();
    } catch (err) {
      status.textContent = err.code === "bad_key" ? L("This key does not work. Copy it again (it starts with sk_).", "Cette clé ne marche pas. Recopie-la (elle commence par sk_).")
        : err.code === "no_tts" ? L("This key cannot make speech. Create a new key and allow “Text to Speech”.", "Cette clé ne peut pas faire de voix. Crée une nouvelle clé et autorise « Text to Speech ».")
        : errText(err);
      btn.disabled = false;
    }
  } }, h("div", { class: "topic-form" }, h("div", { class: "grow" }, input), btn), status);
}

function setupCard() {
  if (!UI.local) return h("section", { class: "notice" }, icon("lock", 20), h("p", null, L("Add your Anthropic API key on the Mac first (Settings).", "Ajoute d'abord ta clé API Anthropic sur le Mac (Réglages).")));
  return h("section", { class: "card stack" },
    h("div", null, h("div", { class: "eyebrow" }, L("One-time setup", "Une seule fois")), h("h2", null, L("Connect your tutor to Claude", "Connecte ton prof à Claude"))),
    h("p", null, L("Your tutor runs on Claude. It needs an Anthropic API key. You pay per use: about 10 to 30 cents for a 15-minute class.", "Ton prof fonctionne avec Claude. Il faut une clé API Anthropic. Tu paies à l'usage : environ 10 à 30 centimes pour un cours de 15 minutes.")),
    h("ol", null,
      h("li", null, L("Open ", "Ouvre "), h("a", { href: "https://console.anthropic.com/settings/keys", target: "_blank", rel: "noopener" }, "console.anthropic.com/settings/keys"), L(" and sign in.", " et connecte-toi.")),
      h("li", null, L("Add a little credit in Billing (5 dollars is a lot of practice).", "Ajoute un peu de crédit dans Billing (5 dollars = beaucoup de pratique).")),
      h("li", null, L("Click Create Key, copy it, and paste it here.", "Clique sur Create Key, copie la clé et colle-la ici."))),
    keyForm(() => render()),
    h("p", { class: "small muted" }, L("The key stays on this Mac, in the .env file of the Learn English folder.", "La clé reste sur ce Mac, dans le fichier .env du dossier Learn English.")));
}

// =====================================================================
// Home
// =====================================================================
function viewHome() {
  if (UI.feedback) return viewFeedback();
  const p = S.profile;
  const lvl = p.level;
  const pct = levelPct(lvl);
  const dateStr = new Date().toLocaleDateString(p.lang === "English" ? "en-GB" : "fr-FR", { weekday: "long", day: "numeric", month: "long" });
  const idx = LEVEL_IDS.indexOf(lvl);
  const nextLvl = idx >= 0 && idx < LEVEL_IDS.length - 1 ? LEVEL_IDS[idx + 1] : null;
  const levelUp = pct >= 0.8 && nextLvl ? h("section", { class: "levelup" },
    h("div", { class: "big" }, "🎉"),
    h("div", { class: "grow" }, h("b", null, L(`You're ready for ${nextLvl}!`, `Le ${nextLvl} t'attend !`)), h("p", { class: "small" }, L(`You master most of ${lvl}.`, `Tu maîtrises l'essentiel du ${lvl}.`))),
    h("button", { class: "btn sm", onclick: () => { p.level = nextLvl; save("profile"); toast(L(`Welcome to ${nextLvl}!`, `Bienvenue au niveau ${nextLvl} !`)); render(); } }, L(`Go to ${nextLvl}`, `Passer au ${nextLvl}`))) : null;
  return h("div", { class: "stack" },
    h("div", { class: "hello" }, h("div", null, h("div", { class: "eyebrow" }, dateStr), h("h1", null, p.name ? L(`Hi, ${niceName(p.name)}!`, `Salut ${niceName(p.name)} !`) : L("Hi there!", "Salut !")))),
    UI.hasKey === false ? setupCard() : null,
    levelUp, nextLessonCard(), todayCard(), progressSummary());
}

// =====================================================================
// Free calls (in Practice): the tutor, free talk, today's news, role-plays
// =====================================================================
async function loadNews() {
  if (UI.news || UI.newsLoading) return;
  UI.newsLoading = true;
  try { UI.news = (await api("/api/news")).news || []; } catch { UI.news = []; }
  UI.newsLoading = false;
  if (UI.tab === "practice") render();
}

function talkSections() {
  const p = S.profile;
  loadNews();
  const tutorPick = h("div", { class: "tutor-pick" }, Object.values(TUTORS).map((t) =>
    h("button", { class: "tutor-opt", "aria-pressed": String(p.tutor === t.id), onclick: () => { p.tutor = t.id; save("profile"); render(); } },
      portrait(t.id, "md"),
      h("div", { class: "grow" }, h("b", null, `${t.name} · ${t.city}`), h("div", { class: "small muted" }, LT(t.blurb)),
        h("span", { class: "chip sm", style: "margin-top:8px", onclick: (e) => { e.stopPropagation(); Speech.say(t.id === "jake" ? "Hey! I'm Jake, from San Francisco. Wanna grab a virtual coffee and chat?" : "Hiya! I'm Emma, from London. Fancy a quick chat?", { tutor: t.id }); } }, icon("speaker", 13), L("Hear the voice", "Écouter la voix"))))));


  const topic = h("input", { class: "input", placeholder: L("A topic? e.g. my last client project, AI agents, my weekend", "Un sujet ? ex. mon dernier projet client, les agents IA, mon week-end") });
  const interests = (p.interests || []).map((id) => INTERESTS.find((x) => x[0] === id)).filter(Boolean);
  const free = h("section", { class: "card stack tight", id: "free-talk" },
    h("div", null, h("div", { class: "eyebrow" }, L("Free talk", "Discussion libre")), h("h2", null, L("Talk about anything", "Parle de tout"))),
    h("form", { class: "topic-form", onsubmit: (e) => { e.preventDefault(); const v = topic.value.trim(); startCall({ mode: "chat", topic: v, title: v || L("Free talk", "Discussion libre") }); } },
      h("div", { class: "grow" }, topic), h("button", { class: "btn green", type: "submit" }, icon("phone", 18), L("Call", "Appeler"))),
    interests.length ? h("div", { class: "row" }, interests.map((it) => h("button", { class: "chip", onclick: () => startCall({ mode: "chat", topic: L(it[3], it[2]), title: L(it[3], it[2]) }) }, `${it[1]} ${L(it[3], it[2])}`))) : null);

  const news = h("section", { class: "stack tight" },
    h("div", { class: "section-title" }, h("h3", null, L("Today's news", "L'actualité du jour")), h("span", { class: "small muted" }, "BBC · Ars Technica · TechCrunch")),
    UI.newsLoading && !UI.news ? h("div", { class: "card skeleton", style: "height:120px" }) : null,
    UI.news && !UI.news.length ? h("div", { class: "row" }, h("p", { class: "muted" }, L("No news right now (no internet?).", "Pas d'actualité pour l'instant (pas d'internet ?).")),
      h("button", { class: "btn sm ghost", onclick: () => { UI.news = null; loadNews(); render(); } }, L("Try again", "Réessayer"))) : null,
    UI.news && UI.news.length ? h("div", { class: "news-list" }, UI.news.slice(0, 6).map((n) =>
      h("button", { class: "news-item", onclick: () => startCall({ mode: "news", headline: n.id, title: n.title }) },
        h("div", { class: "grow" }, h("div", { class: "src" }, n.source), h("div", { class: "t" }, n.title), n.summary ? h("div", { class: "s" }, n.summary) : null),
        h("span", { class: "go" }, icon("phone", 18))))) : null);

  const best = {};
  for (const e of S.journal.entries) if (e.mode === "scene" && e.score != null && e.sceneId) best[e.sceneId] = Math.max(best[e.sceneId] || 0, e.score);
  const lvlIdx = LEVEL_IDS.indexOf(p.level);
  const scenes = [...SCENES].sort((a, b) => Math.abs(LEVEL_IDS.indexOf(a.level) - lvlIdx) - Math.abs(LEVEL_IDS.indexOf(b.level) - lvlIdx));
  const sceneGrid = h("section", { class: "stack tight", id: "scenes" },
    h("div", { class: "section-title" }, h("h3", null, L("Role-plays", "Jeux de rôle")), h("span", { class: "small muted" }, L("Closest to your level first", "Les plus proches de ton niveau d'abord"))),
    h("div", { class: "scenes" }, scenes.map((s) => h("button", { class: "scene", onclick: () => startCall({ mode: "scene", scene: s, sceneId: s.id, title: L(s.en, s.fr) }) },
      h("span", { class: "t" }, L(s.en, s.fr)), h("span", { class: "small muted" }, L(s.tasks, s.tasksFr || s.tasks).slice(0, 2).join(" · ")),
      h("span", { class: "meta" }, h("span", { class: "badge" }, s.level), h("span", { class: "badge" }, L(`${s.tasks.length} goals`, `${s.tasks.length} objectifs`)), best[s.id] != null ? h("span", { class: `badge ${scoreClass(best[s.id])}` }, `${best[s.id]}`) : null)))));

  const open = UI.callsOpen || "";
  const pick = (id, ico, title, text) => h("button", { class: `mode${open === id ? " on" : ""}`, "aria-expanded": String(open === id), onclick: () => { UI.callsOpen = open === id ? "" : id; render(); } },
    h("span", { class: "ico" }, icon(ico, 22)), h("span", { class: "txt" }, h("b", null, title), h("span", null, text)));
  return h("div", { class: "stack", id: "calls" },
    h("div", { class: "section-title" }, h("h2", null, L("Free calls", "Appels libres")), h("span", { class: "small muted" }, L("Outside the course, as often as you like", "En dehors du cours, autant que tu veux"))),
    h("div", { class: "modes" },
      pick("free", "chat", L("Free talk", "Discussion libre"), L("Any topic, your life, your work.", "N'importe quel sujet, ta vie, ton travail.")),
      pick("news", "news", L("Today's news", "L'actualité du jour"), L("Real tech and world headlines.", "Les vraies infos tech et monde.")),
      pick("scenes", "masks", L("Role-plays", "Jeux de rôle"), L("Stand-up, client call, interview…", "Stand-up, appel client, entretien…"))),
    open === "free" ? h("div", { class: "stack tight" }, free, tutorPick) : null,
    open === "news" ? news : null,
    open === "scenes" ? sceneGrid : null);
}

// =====================================================================
// Practice: flashcards (spoken) + Speak-style drills + my words
// =====================================================================
function listenOnce(lang, onUpdate, quietMs = 1300) {
  const ctl = Mic.listen(lang, { onUpdate });
  UI.listening = ctl;
  const timer = setInterval(() => { if (ctl.text && performance.now() - ctl.lastChange > quietMs) ctl.stop(); else if (!ctl.text && performance.now() - ctl.lastChange > 12000) ctl.stop(); }, 150);
  return ctl.promise.finally(() => { clearInterval(timer); if (UI.listening === ctl) UI.listening = null; });
}

async function startDrill(kind, count = 8, focus = "") {
  Speech.stop();
  Mic.stopAll();
  UI.drill = { kind, count, focus, phrases: [], i: 0, loading: true, error: null, result: null, results: [], judging: false, live: null, revealed: false, finished: false, logged: false, xp: 0 };
  render();
  const d = UI.drill;
  try {
    const r = await api("/api/drill", { kind, count, focus });
    if (UI.drill !== d) return;
    d.phrases = (r.phrases || []).filter((x) => x && x.es).slice(0, 10);
    if (!d.phrases.length) throw { message: L("No phrases came back. Try again.", "Aucune phrase reçue. Réessaie.") };
    d.loading = false;
    render();
    if (kind === "repeat") playPhrase();
  } catch (e) {
    if (UI.drill !== d) return;
    d.loading = false;
    d.error = e;
    render();
  }
}
function playPhrase(rate) {
  const d = UI.drill;
  const ph = d && d.phrases[d.i];
  if (ph) Speech.say(ph.es, { rate });
}
async function drillMic() {
  const d = UI.drill;
  if (!d || d.loading || d.judging || d.finished) return;
  if (UI.listening) { UI.listening.stop(); return; }
  Speech.stop();
  if (!Mic.ok) { micError({ code: "unsupported" }); return; }
  d.live = "";
  const p = listenOnce(tutorNow().accent, (text) => { d.live = text; const el = $("#drill-live"); if (el) el.textContent = text || "…"; });
  render();
  let res;
  try { res = await p; } catch (e) { d.live = null; render(); micError(e); return; }
  d.live = null;
  if (UI.drill !== d) return;
  if (!res.text) { render(); toast(L("I did not hear anything. Try again.", "Je n'ai rien entendu. Réessaie.")); return; }
  const phrase = d.phrases[d.i];
  if (d.kind === "repeat") {
    const sc = scoreSpeech(phrase.es, res.text);
    d.result = { said: res.text, score: sc.score, marks: sc.marks };
    recordDrill(d, sc.score, sc.score >= 80 ? 3 : sc.score >= 50 ? 2 : 1);
    render();
    if (sc.score >= 80) Speech.say(pick(["Well done!", "Perfect!", "Spot on!"]));
  } else {
    d.judging = true;
    render();
    try {
      const j = await api("/api/judge", { tr: phrase.tr, es: phrase.es, said: res.text });
      if (UI.drill !== d) return;
      d.result = { said: res.text, score: clamp(Math.round(Number(j.score) || 0), 0, 100), correct: Boolean(j.correct), better: j.better, note: j.note };
      recordDrill(d, d.result.score, d.result.correct ? 4 : 1);
      d.revealed = true;
      Speech.say(j.better || phrase.es);
    } catch (e) {
      toast(errText(e));
    } finally {
      if (UI.drill === d) { d.judging = false; render(); }
    }
  }
}
function recordDrill(d, score, xp) {
  if (d.results[d.i] == null) { d.results[d.i] = score; addXP(xp); d.xp += xp; }
  else d.results[d.i] = Math.max(d.results[d.i], score);
}
function nextPhrase() {
  const d = UI.drill;
  if (d.results[d.i] == null) d.results[d.i] = 0;
  d.result = null;
  d.revealed = false;
  if (d.i + 1 >= d.phrases.length) {
    d.finished = true;
    if (!d.logged) {
      d.logged = true;
      const avg = Math.round(d.results.reduce((a, b) => a + b, 0) / d.results.length);
      logEntry({ id: uid(), kind: "drill", ts: Date.now(), date: today(), title: d.kind === "repeat" ? L("Repeat after me", "Répète après moi") : L("Say it like a native", "Dis-le comme un natif"), score: avg, xp: d.xp, turns: d.phrases.length });
      addMinutes(d.phrases.length * 0.4);
    }
    render();
    return;
  }
  d.i++;
  render();
  if (d.kind === "repeat") playPhrase();
}

const INTERVAL = [0, 1, 2, 4, 8, 16, 32];
function startReview() {
  const due = dueWords();
  if (!due.length) { toast(L("No words to review right now.", "Aucun mot à réviser pour l'instant.")); return; }
  const queue = due.map((w) => w.id).sort(() => Math.random() - 0.5).slice(0, 30);
  UI.review = { queue, i: 0, revealed: false, result: null, live: null, again: new Set(), correct: 0, t0: Date.now() };
  if (UI.tab !== "practice") setTab("practice"); else render();
}
const currentCard = () => { const r = UI.review; return r && S.vocab.words.find((w) => w.id === r.queue[r.i]); };
async function flashMic() {
  const r = UI.review, w = currentCard();
  if (!r || !w || r.revealed) return;
  if (UI.listening) { UI.listening.stop(); return; }
  if (!Mic.ok) { micError({ code: "unsupported" }); return; }
  r.live = "";
  const p = listenOnce(tutorNow().accent, (text) => { r.live = text; const el = $("#flash-live"); if (el) el.textContent = text || "…"; });
  render();
  try {
    const res = await p;
    r.live = null;
    if (UI.review !== r) return;
    if (!res.text) { render(); toast(L("I did not hear anything. Try again.", "Je n'ai rien entendu. Réessaie.")); return; }
    r.result = { said: res.text, ...scoreSpeech(w.es, res.text) };
    revealCard();
  } catch (e) { r.live = null; render(); micError(e); }
}
function revealCard() {
  const r = UI.review, w = currentCard();
  r.revealed = true;
  render();
  if (w) Speech.say(w.es);
}
function gradeCard(knew) {
  const r = UI.review, w = currentCard();
  if (!w) return;
  const t = today();
  if (knew) {
    w.box = clamp((w.box || 0) + 1, 1, 6);
    w.due = addDays(t, INTERVAL[w.box]);
    if (!r.again.has(w.id)) { r.correct++; addXP(2); }
  } else {
    w.box = 0;
    w.due = t;
    if (!r.again.has(w.id)) { r.again.add(w.id); r.queue.push(w.id); }
  }
  save("vocab");
  r.i++;
  r.revealed = false;
  r.result = null;
  if (r.i >= r.queue.length) { r.finished = true; addMinutes((Date.now() - r.t0) / 60000); }
  render();
}

function micButton(onclick, disabled) {
  const listening = Boolean(UI.listening);
  return h("button", { class: `mic${listening ? " listening" : ""}`, disabled, "aria-label": listening ? L("Send now", "Envoyer") : L("Speak", "Parler"), onclick }, icon(listening ? "send" : "mic", 30));
}

function viewPractice() {
  if (UI.review) return viewReview();
  if (UI.drill) return viewDrill();
  const words = S.vocab.words;
  const due = dueWords().length;
  const focus = h("input", { class: "input", placeholder: L("e.g. phrasal verbs, the th sound, small talk with a client", "ex. les phrasal verbs, le son th, le small talk avec un client") });
  const es = h("input", { class: "input", placeholder: L("English word or phrase", "Mot ou expression en anglais"), autocomplete: "off" });
  const tr = h("input", { class: "input", placeholder: L("Translation (optional)", "Traduction (optionnel)"), autocomplete: "off" });
  const addForm = h("form", { class: "add-form", onsubmit: async (e) => {
    e.preventDefault();
    const word = es.value.trim();
    if (!word) return es.focus();
    let meaning = tr.value.trim();
    if (!meaning && UI.hasKey) { try { meaning = (await api("/api/translate", { es: word })).tr || ""; } catch { /* empty */ } }
    if (addWord(word, meaning)) toast(L(`Saved: ${word}`, `Ajouté à tes mots : ${word}`)); else toast(L("Already in your words", "Déjà dans tes mots"));
    render();
  } }, es, tr, h("button", { class: "btn", type: "submit" }, icon("plus", 18), L("Add", "Ajouter")));
  const q = UI.wordFilter.toLowerCase();
  const shown = [...words].reverse().filter((w) => !q || w.es.toLowerCase().includes(q) || (w.tr || "").toLowerCase().includes(q));
  const filter = words.length > 12 ? h("input", { class: "input", id: "word-filter", style: "max-width:260px", placeholder: L("Search", "Rechercher"), value: UI.wordFilter,
    oninput: (e) => { UI.wordFilter = e.target.value; const pos = e.target.selectionStart; render(); const el = $("#word-filter"); el.focus(); el.setSelectionRange(pos, pos); } }) : null;
  const dm = (kind, ico, title, text) => h("section", { class: "card" },
    h("div", { class: "ico" }, icon(ico, 22)), h("h3", null, title), h("p", { class: "muted small" }, text),
    h("div", { class: "row" },
      h("button", { class: "btn", onclick: () => startDrill(kind, 8, focus.value.trim()) }, L("8 phrases", "8 phrases")),
      h("button", { class: "btn ghost", onclick: () => startDrill(kind, 4, focus.value.trim()) }, L("Just 4", "4 seulement"))));
  return h("div", { class: "stack" },
    h("div", null, h("div", { class: "eyebrow" }, L("Practice", "Pratique")), h("h1", null, L("Little and often", "Un peu, souvent"))),
    UI.hasKey === false ? setupCard() : null,
    typeof shadowCard === "function" ? shadowCard(true) : null,
    h("section", { class: "practice-hero" },
      h("div", null, h("div", { class: "eyebrow" }, L("Spaced review", "Révision espacée")),
        h("h2", null, due ? L(`${due} word${due === 1 ? "" : "s"} to review`, `${due} mot${due === 1 ? "" : "s"} à réviser`) : L("All reviewed for today", "Tout est révisé pour aujourd'hui")),
        h("p", { class: "small muted" }, L("See the meaning, say the English out loud. Words you know come back later and later.", "Tu vois le sens, tu dis l'anglais à voix haute. Les mots que tu connais reviennent de plus en plus tard."))),
      due ? h("button", { class: "btn lg", onclick: startReview }, icon("mic", 20), L("Start", "Commencer")) : null),
    talkSections(),
    h("details", { class: "card fold", open: UI.foldDrills || null, ontoggle: (e) => { UI.foldDrills = e.target.open; } }, h("summary", null, h("b", null, L("Quick drills", "Exercices rapides")), h("span", { class: "small muted" }, L("Repeat after me · Say it like a native", "Répète après moi · Dis-le comme un natif"))),
      h("div", { class: "stack", style: "margin-top:14px" },
        h("div", { class: "grid-2 drill-modes" },
          dm("repeat", "repeat", L("Repeat after me", "Répète après moi"), L("Listen, say it back, see which words came out right.", "Écoute, répète, et vois quels mots sont justes.")),
          dm("translate", "translate", L("Say it like a native", "Dis-le comme un natif"), L("Read a sentence in French and say it the way a native colleague would.", "Lis une phrase en français et dis-la comme un collègue anglophone."))),
        h("div", { class: "field" }, h("label", null, L("Drill focus (optional)", "Thème des exercices (optionnel)")), focus))),
    h("details", { class: "card fold", open: UI.foldWords || null, ontoggle: (e) => { UI.foldWords = e.target.open; } }, h("summary", null, h("b", null, L(`My words · ${words.length}`, `Mes mots · ${words.length}`)), h("span", { class: "small muted" }, L("Add, listen, delete", "Ajouter, écouter, supprimer"))),
      h("div", { class: "stack", style: "margin-top:14px" }, addForm,
        filter,
        words.length ? h("div", { class: "word-list" }, shown.slice(0, 300).map((w) => h("div", { class: "word-row" },
          h("div", { class: "wt" }, h("b", null, w.es), h("span", null, w.tr || "")),
          h("span", { class: "boxes", title: L(`Memory: ${w.box || 0}/6`, `Mémorisation : ${w.box || 0}/6`) }, Array.from({ length: 6 }, (_, i) => h("i", { class: i < (w.box || 0) ? "f" : "" }))),
          h("button", { class: "icon-btn plain", "aria-label": L(`Listen to ${w.es}`, `Écouter ${w.es}`), onclick: () => Speech.say(w.es) }, icon("speaker", 18)),
          h("button", { class: "icon-btn plain", "aria-label": L(`Delete ${w.es}`, `Supprimer ${w.es}`), onclick: () => { S.vocab.words = S.vocab.words.filter((x) => x.id !== w.id); save("vocab"); render(); } }, icon("trash", 17)))))
          : h("div", { class: "empty stack", style: "align-items:center" },
            h("p", null, L("No words yet. Tap any word your tutor says to save it. After each class, new words are added here.", "Pas encore de mots. Touche un mot dit par ton prof pour le garder. Après chaque cours, les nouveaux mots arrivent ici.")),
            h("button", { class: "btn ghost", onclick: () => { for (const s of STARTER) addWord(s[0], L(s[1], s[2])); toast(L("Added 10 starter words", "10 mots de départ ajoutés")); render(); } }, L("Add 10 starter words", "Ajouter 10 mots de départ"))))));
}

function viewDrill() {
  const d = UI.drill;
  const t = tutorNow();
  if (d.loading) return h("div", { class: "card focus-card" }, portrait(t.id, "lg"), h("p", null, L(`${t.name} is building drills from your mistakes and interests…`, `${t.name} prépare des exercices avec tes erreurs et tes goûts…`)));
  if (d.error) return h("div", { class: "stack" }, errorBox(d.error, () => startDrill(d.kind, d.count, d.focus)), h("button", { class: "btn ghost", onclick: () => { UI.drill = null; render(); } }, L("Back", "Retour")));
  if (d.finished) {
    const avg = Math.round(d.results.reduce((a, b) => a + b, 0) / Math.max(1, d.results.length));
    const weak = d.phrases.filter((_, i) => (d.results[i] || 0) < 70);
    return h("div", { class: "stack" },
      h("div", null, h("div", { class: "eyebrow" }, L("Drill complete", "Exercice terminé")), h("h1", null, avg >= 80 ? "Excellent!" : avg >= 60 ? "Nice work!" : "Keep going!")),
      h("section", { class: "card score-hero" }, ring(avg / 100, 90, 9, String(avg), avg >= 80 ? "var(--ok)" : avg >= 60 ? "var(--azafran)" : "var(--warn)"),
        h("div", { class: "stack tight" }, h("span", { class: "badge ok" }, `+${d.xp} XP`), h("p", null, L(`${d.phrases.length} phrases. Average ${avg}.`, `${d.phrases.length} phrases. Moyenne ${avg}.`)))),
      h("section", { class: "card word-list" }, d.phrases.map((ph, i) => h("div", { class: "word-row" },
        h("div", { class: "wt" }, h("b", null, ph.es), h("span", null, ph.tr)),
        h("span", { class: `badge ${scoreClass(d.results[i] || 0)}` }, String(d.results[i] || 0)),
        h("button", { class: "icon-btn plain", "aria-label": L("Listen", "Écouter"), onclick: () => Speech.say(ph.es) }, icon("speaker", 18))))),
      h("div", { class: "row" },
        weak.length ? h("button", { class: "btn", onclick: (e) => { let n = 0; for (const ph of weak) if (addWord(ph.es, ph.tr)) n++; toast(n ? L(`Added to your words: ${pl(n, "phrase", "phrases")}`, `Ajouté à tes mots : ${pl(n, "phrase", "phrases")}`) : L("Already in your words", "Déjà dans tes mots")); e.currentTarget.disabled = true; } }, L(`Add to my words (${weak.length})`, `Ajouter à mes mots (${weak.length})`)) : null,
        h("button", { class: weak.length ? "btn ghost" : "btn", onclick: () => startDrill(d.kind, d.count, d.focus) }, L("New set", "Nouvelle série")),
        h("button", { class: "btn ghost", onclick: () => { UI.drill = null; render(); } }, L("Done", "Terminé"))));
  }
  const ph = d.phrases[d.i];
  const r = d.result;
  const listening = Boolean(UI.listening);
  let card;
  if (d.kind === "repeat") {
    card = h("section", { class: "card focus-card" },
      h("div", { class: "eyebrow" }, L("Listen and repeat", "Écoute et répète")),
      r ? marksEl(r.marks) : h("div", { class: "target" }, ph.es),
      h("div", { class: "muted" }, ph.tr),
      h("div", { class: "row", style: "justify-content:center" },
        h("button", { class: "chip", onclick: () => playPhrase() }, icon("speaker", 14), L("Listen", "Écouter")),
        h("button", { class: "chip", onclick: () => playPhrase(0.65) }, icon("turtle", 14), L("Slowly", "Lentement"))),
      r ? h("div", { class: "stack tight", style: "align-items:center" }, h("span", { class: `badge ${scoreClass(r.score)}` }, L(`Match ${r.score}%`, `Précision : ${r.score} %`)), h("p", { class: "said" }, L(`I heard: “${r.said}”`, `J'ai entendu : « ${r.said} »`))) : null,
      ph.tip ? h("p", { class: "small muted" }, ph.tip) : null);
  } else {
    card = h("section", { class: "card focus-card" },
      h("div", { class: "eyebrow" }, L("Say it like a native", "Dis-le comme un natif")),
      h("div", { class: "prompt" }, ph.tr),
      d.revealed && !r ? h("div", { class: "target" }, ph.es) : null,
      r ? h("div", { class: "stack tight", style: "align-items:center" },
        h("span", { class: `badge ${r.correct ? "ok" : "low"}` }, r.correct ? L(`Correct · ${r.score}`, `Correct · ${r.score}`) : L(`Not quite · ${r.score}`, `Pas tout à fait · ${r.score}`)),
        h("p", { class: "said" }, L(`You said: “${r.said}”`, `Tu as dit : « ${r.said} »`)),
        h("div", { class: "target" }, r.better || ph.es),
        r.note ? h("p", { class: "small" }, r.note) : null) : null,
      !r && !d.revealed && ph.tip ? h("p", { class: "small muted" }, L("Hint: ", "Indice : "), ph.tip) : null,
      d.judging ? h("p", { class: "muted" }, L("Checking…", "Je vérifie…")) : null);
  }
  return h("div", { class: "stack" },
    h("div", { class: "spread" }, h("button", { class: "btn sm ghost", onclick: () => { Speech.stop(); Mic.stopAll(); UI.drill = null; render(); } }, icon("back", 16), L("Stop", "Arrêter")), h("span", { class: "muted small num" }, `${d.i + 1} / ${d.phrases.length}`)),
    h("div", { class: "progress-line" }, h("i", { style: `width:${(d.i / d.phrases.length) * 100}%` })),
    card,
    d.live != null ? h("p", { class: "said", id: "drill-live", style: "text-align:center" }, d.live || "…") : null,
    h("div", { class: "dock" },
      h("div", { class: "dock-row" },
        h("div", { class: "left" },
          d.kind === "translate" && !r && !d.revealed ? h("button", { class: "btn sm ghost", onclick: () => { d.revealed = true; if (d.results[d.i] == null) d.results[d.i] = 0; render(); Speech.say(ph.es); } }, L("Show", "Voir")) : null,
          r ? h("button", { class: "btn sm ghost", onclick: () => { d.result = null; d.revealed = false; render(); if (d.kind === "repeat") playPhrase(); } }, icon("repeat", 16), L("Again", "Encore")) : null),
        micButton(drillMic, d.judging),
        h("div", { class: "right" }, h("button", { class: `btn sm${r || d.revealed ? "" : " ghost"}`, onclick: nextPhrase }, d.i + 1 >= d.phrases.length ? L("Finish", "Terminer") : r || d.revealed ? L("Next", "Suivant") : L("Skip", "Passer")))),
      h("div", { class: "hint-line" }, listening ? L("Listening… pause when you're done", "Je t'écoute… fais une pause quand tu as fini") : L("Tap the mic and say it out loud", "Touche le micro et dis-le à voix haute") + (IS_PHONE() ? "" : L(" · or hold Space", " · ou garde Espace enfoncé")))));
}

function viewReview() {
  const r = UI.review;
  if (r.finished) {
    return h("div", { class: "stack" },
      h("div", null, h("div", { class: "eyebrow" }, L("Review done", "Révision terminée")), h("h1", null, "Done!")),
      h("section", { class: "card" }, h("p", null, L(`You knew ${r.correct} of ${r.queue.length - r.again.size} words on the first try. +${r.correct * 2} XP.`, `Trouvés du premier coup : ${r.correct} sur ${r.queue.length - r.again.size}. +${r.correct * 2} XP.`))),
      h("div", { class: "row" }, h("button", { class: "btn", onclick: () => { UI.review = null; render(); } }, L("Back", "Retour")), h("button", { class: "btn ghost", onclick: () => { UI.review = null; setTab("home"); } }, L("Home", "Accueil"))));
  }
  const w = currentCard();
  if (!w) { UI.review = null; return viewPractice(); }
  const res = r.result;
  return h("div", { class: "stack" },
    h("div", { class: "spread" }, h("button", { class: "btn sm ghost", onclick: () => { Mic.stopAll(); UI.review = null; render(); } }, icon("back", 16), L("Stop", "Arrêter")), h("span", { class: "muted small num" }, `${Math.min(r.i + 1, r.queue.length)} / ${r.queue.length}`)),
    h("div", { class: "progress-line" }, h("i", { style: `width:${(r.i / r.queue.length) * 100}%` })),
    h("section", { class: "card focus-card" },
      h("div", { class: "eyebrow" }, w.kind === "fix" ? L("Say it correctly", "Dis-le correctement") : L("How do you say", "Comment dit-on")),
      h("div", { class: "prompt" }, w.tr || L("(no translation)", "(pas de traduction)")),
      r.revealed ? h("div", { class: "stack tight", style: "align-items:center" },
        res ? marksEl(res.marks) : h("div", { class: "target" }, w.es),
        res ? h("p", { class: "said" }, L(`I heard: “${res.said}” · ${res.score}%`, `J'ai entendu : « ${res.said} » · ${res.score} %`)) : null,
        h("button", { class: "chip", onclick: () => Speech.say(w.es) }, icon("speaker", 14), L("Listen", "Écouter"))) : null),
    r.live != null ? h("p", { class: "said", id: "flash-live", style: "text-align:center" }, r.live || "…") : null,
    h("div", { class: "dock" },
      r.revealed
        ? h("div", { class: "row", style: "justify-content:center" },
          h("button", { class: `btn ${res && res.score >= 80 ? "ghost" : "danger"}`, onclick: () => gradeCard(false) }, L("Again", "À revoir")),
          h("button", { class: `btn${res && res.score < 80 ? " ghost" : ""}`, onclick: () => gradeCard(true) }, icon("check", 18), L("I knew it", "Je savais")))
        : h("div", { class: "dock-row" }, h("div", { class: "left" }), micButton(flashMic), h("div", { class: "right" }, h("button", { class: "btn sm ghost", onclick: revealCard }, L("Show", "Voir")))),
      h("div", { class: "hint-line" }, r.revealed ? L("Be honest. Words you miss come back sooner.", "Sois honnête. Les mots ratés reviennent plus tôt.") : L("Say the English out loud", "Dis l'anglais à voix haute") + (IS_PHONE() ? "" : L(" · or hold Space", " · ou garde Espace enfoncé")))));
}

// =====================================================================
// Journey: the road from A1 to C2, what the tutor knows, history
// =====================================================================
function journeySections() {
  const p = S.profile, mem = S.memory || {}, t = today();
  const tutor = tutorNow();
  const curIdx = LEVEL_IDS.indexOf(p.level);
  if (UI.openLevel == null) UI.openLevel = p.level;

  const levels = h("div", { class: "lvl-path" }, (CURRICULUM.levels.length ? CURRICULUM.levels : LEVEL_IDS.map((id) => ({ id, fr: id, en: id }))).map((lv, i) => {
    const pct = levelPct(lv.id);
    const cls = i < curIdx ? "done" : i === curIdx ? "now" : "";
    const open = UI.openLevel === lv.id;
    const skills = CURRICULUM.skills[lv.id] || [];
    return h("div", { class: `lvl ${cls}` },
      h("div", { class: "node" }, lv.id),
      h("button", { class: "lvl-head", "aria-expanded": String(open), onclick: () => { UI.openLevel = open ? "" : lv.id; render(); } },
        h("span", { class: "t" }, h("b", null, LT(lv)), h("span", { class: "small muted" }, lv.can ? LT(lv.can) : "")),
        h("span", { class: "row nowrap" }, h("span", { class: "small muted num" }, `${Math.round(pct * 100)}%`), icon(open ? "down" : "chevron", 18))),
      open ? h("div", { class: "lvl-body" },
        h("div", { class: "bar" }, h("i", { style: `width:${Math.round(pct * 100)}%` })),
        h("div", { class: "skill-list" }, skills.map((s) => {
          const st = skillState(s.id);
          return h("button", { class: "skill", title: L("Start a class on this", "Faire un cours là-dessus"), onclick: () => startCall({ mode: "lesson", skills: [s.id], title: LT(s.title) }) },
            h("span", { class: "dots", title: ({ new: L("not started", "pas commencé"), seen: L("introduced", "découvert"), practicing: L("practising", "en cours"), good: L("good", "acquis"), mastered: L("mastered", "maîtrisé") })[st] || "" }, Array.from({ length: 4 }, (_, k) => h("i", { class: k < STATE_DOTS[st] ? "f" : "" }))),
            h("span", { class: "t" }, h("b", null, LT(s.title)), h("span", null, s.ex)),
            h("span", { class: "go" }, icon("phone", 16)));
        })),
        i !== curIdx ? h("button", { class: "btn sm ghost", style: "align-self:flex-start", onclick: () => { p.level = lv.id; save("profile"); toast(L(`Your level is now ${lv.id}`, `Ton niveau est maintenant ${lv.id}`)); render(); } }, L(`Set my level to ${lv.id}`, `Mettre mon niveau à ${lv.id}`)) : null) : null);
  }));

  // What the tutor remembers (editable)
  const removeItem = (key, idx) => { const arr = [...(S.memory[key] || [])]; arr.splice(idx, 1); S.memory = { ...S.memory, [key]: arr }; save("memory"); render(); };
  const group = (label, key, fmt = (x) => x) => {
    const items = Array.isArray(mem[key]) ? mem[key] : [];
    if (!items.length) return null;
    return h("div", { class: "mem-group" }, h("div", { class: "eyebrow" }, label),
      h("div", { class: "mem-items" }, items.map((x, i) => h("span", { class: "mem-item" }, fmt(x),
        h("button", { "aria-label": L("Forget this", "Oublier"), title: L("Forget this", "Oublier"), onclick: () => removeItem(key, i) }, icon("x", 14))))));
  };
  const note = h("input", { class: "input", placeholder: L(`Tell ${tutor.name} something about you (job, hobbies, a trip…)`, `Dis quelque chose à ${tutor.name} sur toi (travail, loisirs, un voyage…)`) });
  const hasMem = ["about", "interests", "strengths", "weak_points", "recurring_mistakes"].some((k) => Array.isArray(mem[k]) && mem[k].length) || mem.next_focus;
  const memory = h("section", { class: "card stack" },
    h("div", { class: "row nowrap", style: "gap:14px" }, portrait(tutor.id, "md"),
      h("div", null, h("h3", null, L(`What ${tutor.name} remembers about you`, `Ce que ${tutor.name} sait de toi`)), h("p", { class: "small muted" }, L("Updated after each class. Remove anything wrong.", "Mis à jour après chaque cours. Supprime ce qui est faux.")))),
    hasMem ? null : h("p", { class: "muted" }, L("Nothing yet. After your first class, your tutor starts to remember you.", "Rien pour l'instant. Après ton premier cours, ton prof commence à se souvenir de toi.")),
    mem.next_focus ? h("div", { class: "quote" }, h("b", null, L("Next focus: ", "Prochain objectif : ")), mem.next_focus) : null,
    group(L("About you", "À propos de toi"), "about"),
    group(L("Interests", "Centres d'intérêt"), "interests"),
    group(L("Strengths", "Points forts"), "strengths"),
    group(L("Weak points", "Points à travailler"), "weak_points"),
    group(L("Recurring mistakes", "Erreurs fréquentes"), "recurring_mistakes", (x) => `${x.pattern} : « ${x.example} » → « ${x.fix} »`),
    h("form", { class: "topic-form", onsubmit: (e) => {
      e.preventDefault();
      const v = note.value.trim();
      if (!v) return note.focus();
      S.memory = { ...S.memory, about: [...(S.memory.about || []), v] };
      save("memory");
      toast(L(`${tutor.name} will remember that`, `${tutor.name} s'en souviendra`));
      render();
    } }, h("div", { class: "grow" }, note), h("button", { class: "btn", type: "submit" }, L("Add", "Ajouter"))));

  const entries = S.journal.entries.slice(0, 40);
  const timeline = h("section", { class: "stack tight" }, h("h2", null, L("Diary", "Journal")),
    entries.length ? h("div", { class: "timeline" }, entries.map((e) => h("details", { class: "entry" },
      h("summary", null,
        h("span", { class: "when" }, shortDate(e.ts)),
        h("span", { class: "what" }, h("b", null, e.title || L("Class", "Cours")), h("div", { class: "small muted" }, e.kind === "drill" ? L(`Drill · ${pl(e.turns, "phrase", "phrases")}`, `Exercice · ${pl(e.turns, "phrase", "phrases")}`) : e.kind === "lesson" ? L("Lesson · theory and exercises", "Cours · théorie et exercices") : e.kind === "shadow" ? L(`Shadowing · ${pl(e.turns || 0, "try", "tries")}`, `Shadowing · ${pl(e.turns || 0, "essai", "essais")}`) : e.kind === "homework" ? L(`Homework · ${pl(e.turns || 0, "exercise", "exercises")}`, `Devoirs · ${pl(e.turns || 0, "exercice", "exercices")}`) : `${TUTORS[e.tutor]?.name || ""} · ${e.minutes ? Math.round(e.minutes) + " min · " : ""}${L(pl(e.turns, "answer", "answers"), pl(e.turns, "réponse", "réponses"))}`)),
        e.score != null ? h("span", { class: `badge ${scoreClass(e.score)}` }, String(e.score)) : null),
      h("div", { class: "body" },
        e.summary ? h("p", null, e.summary) : null,
        (e.fixes || []).map((f) => h("div", { class: "fix-item" }, h("span", null, h("s", null, f.you_said), " → ", h("b", null, f.better)), h("span", { class: "muted small" }, f.why))),
        e.next ? h("p", { class: "small" }, h("b", null, L("Tip: ", "Conseil : ")), e.next) : null))))
      : h("div", { class: "card empty" }, L("Your classes and drills will appear here.", "Tes cours et exercices apparaîtront ici.")));

  return { levels, memory, timeline };
}

// =====================================================================
// Review after a call
// =====================================================================
function viewFeedback() {
  const f = UI.feedback;
  const t = TUTORS[f.tutor] || TUTORS.emma;
  const close = () => { UI.feedback = null; render(); window.scrollTo(0, 0); };
  if (f.mode === "assess" && f.status === "done") {
    const res = assessOf().result;
    if (!res) {
      const mins = Math.round(assessMinutes()), left = Math.max(5, ASSESS_TOTAL - mins);
      if (UI.assessWriting) return h("div", { class: "stack" }, assessSetup());
      return h("div", { class: "stack" },
        h("div", null, h("div", { class: "eyebrow" }, L("First session", "Première séance")), h("h1", null, L(`${mins} of ${ASSESS_TOTAL} minutes done`, `${mins} minutes sur ${ASSESS_TOTAL} faites`))),
        h("p", { class: "muted" }, mins >= ASSESS_MIN
          ? L(`You can pick it up later, for a fuller result (${left} minutes left). Or get your results now, from what you said so far.`, `Tu peux reprendre plus tard, pour un bilan plus complet (encore ${left} minutes). Ou avoir ton bilan maintenant, avec ce que tu as déjà dit.`)
          : L(`${t.name} needs at least ${ASSESS_MIN} minutes of talk for a fair result. Your words are saved: you pick up where you stopped.`, `${t.name} a besoin d'au moins ${ASSESS_MIN} minutes de conversation pour un bilan juste. Tes mots sont gardés : vous reprendrez là où vous en étiez.`)),
        UI.assessError ? errorBox(UI.assessError, writeAssessNow) : null,
        h("div", { class: "row" },
          h("button", { class: "btn green", onclick: () => { close(); startAssess(); } }, icon("phone", 18), L("Pick up the session", "Reprendre la séance")),
          mins >= ASSESS_MIN ? h("button", { class: "btn", onclick: writeAssessNow }, L("Get my results now", "Avoir mon bilan maintenant")) : null,
          h("button", { class: "btn ghost", onclick: close }, L("Later", "Plus tard"))));
    }
    return h("div", { class: "stack" },
      h("div", null, h("div", { class: "eyebrow" }, L("First session", "Première séance")), h("h1", null, L("Your results", "Ton bilan"))),
      assessReport(res),
      planState());
  }
  if (f.status === "loading") {
    return h("div", { class: "stack" },
      h("div", null, h("div", { class: "eyebrow" }, L("Class review", "Bilan du cours")), h("h1", null, f.title || L("Class", "Cours"))),
      h("section", { class: "card focus-card" }, portrait(t.id, "lg"),
        h("p", null, f.mode === "assess" ? L(`${t.name} is reading everything you said and writing your results…`, `${t.name} relit tout ce que tu as dit et écrit ton bilan…`) : L(`${t.name} is writing your review and updating your notes…`, `${t.name} écrit ton bilan et met à jour ses notes sur toi…`)),
        h("p", { class: "small muted" }, L("You can use the other tabs meanwhile; your review will be here.", "Tu peux aller dans les autres onglets en attendant : ton bilan sera ici.")),
        h("div", { class: "skeleton", style: "height:14px;width:70%" }), h("div", { class: "skeleton", style: "height:14px;width:50%" })));
  }
  if (f.status === "short") {
    return h("div", { class: "stack" },
      h("h1", null, L("Short call", "Appel court")),
      h("p", { class: "muted" }, L("Say a few things next time and you'll get a full review.", "Dis quelques phrases la prochaine fois et tu auras un vrai bilan.")),
      h("button", { class: "btn", onclick: close }, L("OK", "OK")));
  }
  if (f.status === "error") {
    return h("div", { class: "stack" },
      h("h1", null, L("Class review", "Bilan du cours")),
      errorBox(f.error, () => { f.status = "loading"; render(); runReview(f); }),
      h("button", { class: "btn ghost", onclick: () => runReview(f, { skip: true }) }, L("Save without review", "Garder sans bilan")));
  }
  const r = f.result;
  const color = r.score >= 80 ? "var(--ok)" : r.score >= 60 ? "var(--azafran)" : "var(--warn)";
  const prog = r.progress || {};
  const changed = (prog.changed || []).map((c) => ({ ...c, skill: Object.values(CURRICULUM.skills).flat().find((s) => s.id === c.id) })).filter((c) => c.skill);
  const stateLabel = { seen: L("introduced", "découvert"), practicing: L("practising", "en cours"), good: L("good", "acquis"), mastered: L("mastered", "maîtrisé") };
  return h("div", { class: "stack" },
    h("div", null, h("div", { class: "eyebrow" }, L("Class review", "Bilan du cours")), h("h1", null, f.title || L("Class", "Cours"))),
    prog.levelUp ? h("section", { class: "levelup" }, h("div", { class: "big" }, "🎉"),
      h("div", { class: "grow" }, h("b", null, L(`You're ready for ${prog.levelUp}!`, `Le ${prog.levelUp} t'attend !`))),
      h("button", { class: "btn sm", onclick: () => { S.profile.level = prog.levelUp; save("profile"); toast(L(`Welcome to ${prog.levelUp}!`, `Bienvenue au niveau ${prog.levelUp} !`)); prog.levelUp = null; render(); } }, L(`Go to ${prog.levelUp}`, `Passer au ${prog.levelUp}`))) : null,
    h("section", { class: "card score-hero" },
      ring(r.score / 100, 96, 9, String(r.score), color),
      h("div", { class: "stack tight grow", style: "min-width:220px" },
        h("div", { class: "row" },
          r.level_feel ? h("span", { class: "badge mid" }, L(`Estimated level: ${r.level_feel}`, `Niveau estimé : ${r.level_feel}`)) : null,
          h("span", { class: "badge ok" }, `+${f.xp} XP`),
          h("span", { class: "badge" }, `${Math.max(1, Math.round(f.minutes))} min`),
          h("span", { class: "badge" }, L(`${f.said} answer${f.said === 1 ? "" : "s"}`, `${f.said} réponse${f.said === 1 ? "" : "s"}`))),
        h("p", null, r.summary))),
    r.homework ? h("section", { class: "card row spread hw-ready" },
      h("div", { class: "stack tight" }, h("b", null, L(`Your homework is ready: ${r.homework.count} exercises`, `Tes devoirs sont prêts : ${r.homework.count} exercices`)),
        h("span", { class: "small muted" }, r.homework.due ? L(`To do before your next lesson (${whenText(new Date(r.homework.due))}).`, `À faire avant ton prochain cours (${whenText(new Date(r.homework.due))}).`) : L("To do before your next lesson.", "À faire avant ton prochain cours."))),
      h("button", { class: "btn", onclick: () => { UI.feedback = null; openHomework(r.homework.id); } }, icon("check", 18), L("Start my homework", "Commencer mes devoirs"))) : null,
    changed.length ? h("section", { class: "card stack tight" }, h("h3", null, L("Your skills", "Tes compétences")),
      changed.map((c) => h("div", { class: "spread" }, h("span", null, LT(c.skill.title)), h("span", { class: `badge ${c.state === "good" || c.state === "mastered" ? "ok" : "blue"}` }, stateLabel[c.state] || c.state)))) : null,
    r.strengths?.length ? h("section", { class: "card stack tight" }, h("h3", null, L("What went well", "Ce qui a bien marché")), h("ul", null, r.strengths.map((s) => h("li", null, s)))) : null,
    r.fixes?.length ? h("section", { class: "card stack tight" }, h("h3", null, L("To fix", "À corriger")),
      r.fixes.map((x) => h("div", { class: "fix-item" },
        h("span", null, h("s", null, x.you_said), " → ", h("b", null, x.better)),
        h("span", { class: "muted small" }, x.why),
        h("span", { class: "row", style: "margin-top:4px" },
          h("button", { class: "chip sm", onclick: () => Speech.say(x.better, { tutor: f.tutor }) }, icon("speaker", 13), L("Listen", "Écouter")),
          h("button", { class: "chip sm", onclick: () => { if (addWord(x.better, L(`Instead of "${x.you_said}"`, `Au lieu de « ${x.you_said} »`), { kind: "fix" })) toast(L("Added to your words", "Ajouté à tes mots")); else toast(L("Already in your words", "Déjà dans tes mots")); } }, icon("plus", 13), L("Add to my words", "Ajouter à mes mots")))))) : null,
    r.added?.length ? h("section", { class: "card stack tight" }, h("h3", null, L(`Added to your words: ${pl(r.added.length, "new word", "new words")}`, `Ajouté à tes mots : ${pl(r.added.length, "nouveau mot", "nouveaux mots")}`)),
      h("div", { class: "row added-words" }, r.added.map((w) => h("button", { class: "chip", title: w.tr, onclick: () => Speech.say(w.es, { tutor: f.tutor }) }, h("b", null, w.es), h("span", { class: "muted" }, ` · ${w.tr}`))))) : null,
    r.next_class || r.next_step ? h("section", { class: "card stack tight" },
      h("div", { class: "row nowrap", style: "gap:12px" }, portrait(t.id, "sm"), h("b", null, t.name)),
      r.next_step ? h("div", { class: "quote" }, r.next_step) : null,
      r.next_class ? h("p", { class: "small muted" }, h("b", null, L("Next class: ", "Prochain cours : ")), r.next_class) : null) : null,
    h("div", { class: "row" },
      h("button", { class: "btn green", onclick: () => { const cfg = f.config; close(); startCall(cfg); } }, icon("phone", 18), L("Call again", "Rappeler")),
      h("button", { class: "btn ghost", onclick: close }, L("Done", "Terminé"))));
}

// =====================================================================
// First-time setup
// =====================================================================
function viewOnboarding() {
  const o = UI.onb || (UI.onb = { step: 0 });
  const p = S.profile;
  const steps = UI.local && !UI.hasKey ? 7 : 6;
  const next = () => { o.step++; render(); window.scrollTo(0, 0); };
  const back = () => { o.step = Math.max(0, o.step - 1); render(); };
  const finish = () => { p.onboarded = true; save("profile"); UI.onb = null; UI.planEdit = !S.course?.plan; UI.tab = S.course?.plan ? "home" : "lessons"; render(); toast(L(`${tutorNow().name} is waiting for your call!`, `${tutorNow().name} attend ton appel !`), 3500); };
  const dots = h("div", { class: "onb-steps" }, Array.from({ length: steps }, (_, i) => h("i", { class: i <= o.step ? "on" : "" })));
  const opt = (pressed, em, title, sub, onclick) => h("button", { class: "opt", "aria-pressed": String(pressed), onclick }, h("span", { class: "em" }, em), h("span", { class: "t" }, title, sub ? h("span", null, sub) : null));
  const foot = (canNext = true, label) => h("div", { class: "onb-foot" },
    o.step > 0 ? h("button", { class: "btn ghost", onclick: back }, icon("back", 18), L("Back", "Retour")) : h("span"),
    h("button", { class: "btn lg", disabled: !canNext, onclick: o.step >= steps - 1 ? finish : next }, label || L("Continue", "Continuer"), icon("chevron", 18)));
  let body;
  if (o.step === 0) {
    body = [h("div", { class: "row nowrap", style: "gap:-10px" }, portrait("emma", "lg"), portrait("jake", "lg")),
      h("h1", null, "Welcome to Fluent!"),
      h("p", { class: "muted" }, L("Your own English speaking coach on a video call. A real voice, real situations (friends, going out, travel, meetings, calls), and a coach who remembers you and works on your accent.", "Ton propre coach d'anglais en appel vidéo. Une vraie voix, de vraies situations (amis, sorties, voyages, réunions, appels), et un coach qui se souvient de toi et travaille ton accent.")),
      h("div", { class: "field-label" }, "Explications en… / Explanations in…"),
      h("div", { class: "opt-grid two" },
        opt(p.lang !== "English", "🇫🇷", "Français", "Les explications seront en français", () => { p.lang = "French"; save("profile"); render(); }),
        opt(p.lang === "English", "🇬🇧", "English", "Full immersion: the whole app in English", () => { p.lang = "English"; save("profile"); render(); })),
      foot()];
  } else if (o.step === 1) {
    const input = h("input", { class: "input", value: p.name, placeholder: L("Your first name", "Ton prénom"), autocomplete: "given-name", oninput: (e) => { p.name = e.target.value.trim().slice(0, 40); save("profile"); } });
    setTimeout(() => input.focus(), 50);
    body = [h("h1", null, L("What's your name?", "Comment tu t'appelles ?")), h("p", { class: "muted" }, L("Your tutor will call you by your name.", "Ton prof t'appellera par ton prénom.")),
      h("form", { onsubmit: (e) => { e.preventDefault(); next(); } }, input), foot()];
  } else if (o.step === 2) {
    const lv = (id, em, fr, en, sfr, sen) => opt(p.level === id, em, L(en, fr), L(sen, sfr), () => { p.level = id; save("profile"); render(); });
    body = [h("h1", null, L("Your English today?", "Ton anglais aujourd'hui ?")), h("p", { class: "muted" }, L("No stress: your tutor adapts in real time, and you can change it later.", "Pas de stress : ton prof s'adapte en direct, et tu peux changer plus tard.")),
      h("div", { class: "opt-grid" },
        lv("B1", "🌳", "Je me débrouille", "I get by", "Je tiens une conversation, mais je cherche mes mots", "I can hold a conversation, but I search for words"),
        lv("B2", "🏔️", "Je parle bien", "I speak well", "Je parle de presque tout, avec des erreurs et un accent français", "I can discuss most things, with mistakes"),
        lv("C1", "🚀", "J'ai un niveau avancé", "I'm advanced", "Je veux la nuance, l'aisance et sonner naturel en réunion", "I want nuance, ease and to sound natural in meetings"),
        lv("C2", "🏆", "Je veux sonner natif", "I want to sound native", "Humour, précision, influence, comme un natif", "Humour, precision, influence, like a native")),
      foot()];
  } else if (o.step === 3) {
    const set = new Set(p.interests || []);
    body = [h("h1", null, L("What do you like?", "Qu'est-ce que tu aimes ?")), h("p", { class: "muted" }, L("Your tutor will talk about these topics with you. Pick as many as you want.", "Ton prof parlera de ces sujets avec toi. Choisis-en autant que tu veux.")),
      h("div", { class: "interest-chips" }, INTERESTS.map(([id, em, fr, en]) => h("button", { class: `chip${set.has(id) ? " on" : ""}`, onclick: () => { set.has(id) ? set.delete(id) : set.add(id); p.interests = [...set]; save("profile"); render(); } }, `${em} ${L(en, fr)}`))),
      foot()];
  } else if (o.step === 4) {
    body = [h("h1", null, L("Choose your tutor", "Choisis ton prof")), h("p", { class: "muted" }, L("Tap to hear their voice. You can switch any time.", "Touche pour entendre sa voix. Tu peux changer quand tu veux.")),
      h("div", { class: "opt-grid" }, Object.values(TUTORS).map((t) => h("button", { class: "opt", "aria-pressed": String(p.tutor === t.id), onclick: () => { p.tutor = t.id; save("profile"); render(); Speech.say(t.id === "jake" ? `Hey${p.name ? " " + p.name : ""}! I'm Jake. Awesome to meet you!` : `Hi${p.name ? " " + p.name : ""}! I'm Emma. Lovely to meet you!`, { tutor: t.id }); } },
        portrait(t.id, "md"), h("span", { class: "t" }, `${t.name} · ${t.city} ${t.flag}`, h("span", null, LT(t.blurb)))))),
      foot()];
  } else if (o.step === 5) {
    const g = (n, em, fr, en) => opt(Number(p.minutes) === n, em, `${n} min`, L(en, fr), () => { p.minutes = n; save("profile"); render(); });
    body = [h("h1", null, L("How much time per day?", "Combien de temps par jour ?")), h("p", { class: "muted" }, L("Classes last about this long. A little every day beats a lot once a week.", "Tes cours dureront à peu près ce temps-là. Un peu chaque jour vaut mieux que beaucoup une fois par semaine.")),
      h("div", { class: "opt-grid two" }, g(5, "☕", "Juste un café", "Just a coffee"), g(10, "🙂", "Tranquille", "Easy"), g(15, "💪", "Régulier (conseillé)", "Regular (recommended)"), g(20, "🔥", "Sérieux", "Serious"), g(30, "🚀", "Intensif", "Intense")),
      foot(true, steps === 6 ? L("Let's go", "C'est parti") : null)];
  } else {
    body = [h("div", { class: "eyebrow" }, L("Last step", "Dernière étape")), setupCard(),
      h("div", { class: "onb-foot" }, h("button", { class: "btn ghost", onclick: back }, icon("back", 18), L("Back", "Retour")), h("button", { class: "btn lg", onclick: finish }, UI.hasKey ? L("Let's go", "C'est parti") : L("Later", "Plus tard"), icon("chevron", 18)))];
  }
  return h("div", { class: "onb" }, dots, ...body);
}

// =====================================================================
// Phone login (when Fluent is opened through the private phone link)
// =====================================================================
function viewLogin() {
  const st = UI.pin || (UI.pin = { value: "", error: "", busy: false });
  const press = async (k) => {
    if (st.busy) return;
    if (k === "del") st.value = st.value.slice(0, -1);
    else if (st.value.length < 10) st.value += k;
    st.error = "";
    render();
  };
  const submit = async () => {
    if (st.value.length < 6) { st.error = L("At least 6 digits", "Au moins 6 chiffres"); render(); return; }
    st.busy = true;
    render();
    try {
      await api("/api/login", { pin: st.value });
      UI.needLogin = false;
      UI.pin = null;
      location.reload();
    } catch (e) {
      st.error = e.code === "locked" ? L("Too many tries. Wait 10 minutes.", "Trop d'essais. Attends 10 minutes.") : L("Wrong PIN", "Code incorrect");
      st.value = "";
      st.busy = false;
      render();
    }
  };
  return h("div", { class: "login" },
    h("span", { class: "mark", style: "width:56px;height:56px;border-radius:16px" }),
    h("h1", null, "Fluent"),
    h("p", { class: "muted" }, L("Enter the PIN you chose on your Mac.", "Entre le code choisi sur ton Mac.")),
    h("div", { class: "pin-dots" }, Array.from({ length: Math.max(6, st.value.length) }, (_, i) => h("i", { class: i < st.value.length ? "f" : "" }))),
    st.error ? h("p", { style: "color:var(--warn);font-weight:700" }, st.error) : null,
    h("div", { class: "pin-pad" }, ["1", "2", "3", "4", "5", "6", "7", "8", "9", "del", "0", "ok"].map((k) =>
      h("button", { "aria-label": k === "del" ? L("Delete", "Effacer") : k === "ok" ? "OK" : k, onclick: () => (k === "ok" ? submit() : press(k)) }, k === "del" ? icon("back", 22) : k === "ok" ? icon("check", 24) : k))));
}

// =====================================================================
// Settings
// =====================================================================
function openSettings() {
  UI.settingsReset = false;
  renderSettings();
  $("#settings").hidden = false;
  refreshRemote();
}
function closeSettings() {
  $("#settings").hidden = true;
  applyTheme();
  render();
}
async function refreshRemote() {
  if (!UI.local) return;
  try { UI.remote = await api("/api/remote"); } catch { UI.remote = null; }
  if (!$("#settings").hidden) renderSettings();
}

let qrLib = null;
function loadQR() {
  if (qrLib) return qrLib;
  qrLib = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js";
    s.onload = () => resolve(window.qrcode);
    s.onerror = reject;
    document.head.append(s);
  });
  return qrLib;
}

function renderSettings() {
  const p = S.profile;
  const set = (key, val, rerender) => { p[key] = val; save("profile"); if (rerender) renderSettings(); };
  // Automatic leaves out Bluetooth, iPhone and virtual mics (see MicMeter). The names appear once the mic has been allowed.
  const micField = () => {
    const el = sel(S.profile.micId || "", [["", L("Automatic (recommended)", "Automatique (conseillé)")]], (v) => set("micId", v));
    navigator.mediaDevices?.enumerateDevices?.().then((list) => {
      for (const d of list) {
        if (d.kind !== "audioinput" || !d.label || d.deviceId === "default" || d.deviceId === "communications") continue;
        el.append(h("option", { value: d.deviceId }, d.label));
      }
      el.value = S.profile.micId || "";
    }).catch(() => {});
    return el;
  };
  const sel = (value, options, onchange) => h("select", { class: "input", onchange: (e) => onchange(e.target.value) },
    options.map(([v, label]) => { const o = h("option", { value: v }, label); if (String(v) === String(value)) o.selected = true; return o; }));
  const field = (label, control, hint) => {
    const c = control?.matches?.("input,select") ? control : control?.querySelector?.("input,select");
    if (c && !c.hasAttribute("aria-label")) c.setAttribute("aria-label", label);
    return h("div", { class: "field" }, h("label", null, label), control, hint ? h("span", { class: "small muted" }, hint) : null);
  };
  const toggle = (label, sub, checked, onchange) => h("label", { class: "toggle" }, h("span", null, h("b", null, label), sub ? h("span", { class: "small muted", style: "display:block" }, sub) : null), h("input", { type: "checkbox", checked, onchange: (e) => onchange(e.target.checked) }));
  if (!Speech.browserVoices.length) Speech.loadBrowser();
  const qLabel = { eleven: "ElevenLabs", natural: L("Natural, online", "Naturelle, en ligne"), premium: "Premium", enhanced: L("Enhanced", "Améliorée"), default: "" };
  const voiceField = (t) => {
    const opts = [["", L("Automatic", "Automatique")],
      ...Speech.voices.map((v) => [v.id, `${v.name} · ${v.lang}${qLabel[v.quality] ? " · " + qLabel[v.quality] : ""}`]),
      ...Speech.browserVoices.filter((v) => /google/i.test(v.name)).map((v) => ["browser:" + v.voiceURI, `${v.name} · Chrome`])];
    return field(L(`Voice of ${t.name}`, `Voix de ${t.name}`), h("div", { class: "topic-form" },
      h("div", { class: "grow" }, sel((p.voices || {})[t.id] || "", opts, (v) => { p.voices = { ...(p.voices || {}), [t.id]: v }; save("profile"); })),
      h("button", { class: "btn ghost", type: "button", onclick: () => Speech.say(`Hi${p.name ? " " + p.name : ""}, I'm ${t.name}. How's your day going?`, { tutor: t.id }) }, icon("speaker", 16), L("Test", "Tester"))));
  };

  // API key
  const keyBlock = UI.local ? h("div", { class: "field" },
    h("label", null, L("Anthropic API key", "Clé API Anthropic")),
    h("span", { class: "small muted" }, UI.hasKey ? L("Connected. Paste a new key to replace it.", "Connectée. Colle une nouvelle clé pour la remplacer.") : L("Not connected yet.", "Pas encore connectée.")),
    keyForm(() => renderSettings())) : null;
  const sttBlock = UI.local ? h("div", { class: "field" },
    h("label", null, L("Groq key (speech recognition, free backup)", "Clé Groq (reconnaissance de la voix, secours gratuit)")),
    h("span", { class: "small muted" }, UI.stt
      ? L("Connected: Whisper writes down what you say, even with an accent or in French. Paste a new key to replace it.", "Connectée : Whisper écrit ce que tu dis, même avec un accent ou en français. Colle une nouvelle clé pour la remplacer.")
      : [L("Free. Open ", "Gratuit. Ouvre "), h("a", { href: "https://console.groq.com/keys", target: "_blank", rel: "noopener" }, "console.groq.com/keys"), L(", sign in, click Create API Key, copy it and paste it here.", ", connecte-toi, clique sur Create API Key, copie la clé et colle-la ici.")]),
    sttKeyForm(() => renderSettings())) : null;
  const elevenBlock = UI.local ? h("div", { class: "field" },
    h("label", null, L("ElevenLabs key (the most human voice, the sharpest ears)", "Clé ElevenLabs (la voix la plus humaine, l'oreille la plus fine)")),
    h("span", { class: "small muted" }, UI.eleven
      ? L("Connected: your tutor speaks with ElevenLabs and hears you with Scribe (together about $0.60 for a 30-minute class). Choose the voice below. Paste a new key to replace it.", "Connectée : ton prof parle avec ElevenLabs et t'entend avec Scribe (en tout environ 0,60 $ pour un cours de 30 minutes). Choisis la voix plus bas. Colle une nouvelle clé pour la remplacer.")
      : [L("Pay as you go. Open ", "Paiement à l'usage. Ouvre "), h("a", { href: "https://elevenlabs.io/app/settings/api-keys", target: "_blank", rel: "noopener" }, "elevenlabs.io › API keys"), L(", create a key with “Text to Speech”, “Speech to Text” and “Voices: read” allowed, copy it and paste it here.", ", crée une clé avec « Text to Speech », « Speech to Text » et « Voices : read » autorisés, copie-la et colle-la ici.")]),
    elevenKeyForm(() => renderSettings())) : null;

  // Phone access
  const r = UI.remote || {};
  let phone = null;
  if (UI.local) {
    const pin = h("input", { class: "input", type: "password", inputmode: "numeric", placeholder: L("6 to 10 digit PIN", "Code de 6 à 10 chiffres"), autocomplete: "new-password" });
    const qrBox = h("div", { class: "qr" });
    if (r.running && r.url) loadQR().then((qrcode) => { const q = qrcode(0, "M"); q.addData(r.url); q.make(); qrBox.innerHTML = q.createSvgTag({ cellSize: 6, margin: 0, scalable: true }); }).catch(() => { qrBox.textContent = ""; });
    phone = h("div", { class: "group" },
      h("div", { class: "field" },
        h("label", null, L("Use Fluent on your phone", "Utiliser Fluent sur ton téléphone")),
        h("span", { class: "small muted" }, L("Opens a private https link to this Mac (free, through Cloudflare). Protected by your PIN. Keep the Mac on with the lid open; Fluent stops it from sleeping while the link is on.", "Ouvre un lien https privé vers ce Mac (gratuit, via Cloudflare). Protégé par ton code. Le Mac doit rester allumé et l'écran ouvert ; Fluent l'empêche de se mettre en veille tant que le lien est actif.")),
        h("form", { class: "topic-form", onsubmit: async (e) => { e.preventDefault(); try { await api("/api/pin", { pin: pin.value }); toast(L("PIN saved", "Code enregistré")); pin.value = ""; refreshRemote(); } catch (err) { toast(errText(err)); } } },
          h("div", { class: "grow" }, pin), h("button", { class: "btn ghost", type: "submit" }, r.hasPin ? L("Change PIN", "Changer le code") : L("Set PIN", "Choisir le code")))),
      h("div", { class: "field" },
        r.running && r.url
          ? h("div", { class: "row", style: "gap:16px;align-items:flex-start" }, qrBox,
            h("div", { class: "stack tight grow" },
              h("b", null, L("Scan with your phone's camera", "Scanne avec l'appareil photo du téléphone")),
              h("a", { href: r.url, target: "_blank", rel: "noopener", class: "small", style: "word-break:break-all" }, r.url),
              h("span", { class: "small muted" }, L("Then: Share › Add to Home Screen, for an app icon. The link changes each time you restart it.", "Ensuite : Partager › Sur l'écran d'accueil, pour avoir une icône. Le lien change à chaque redémarrage.")),
              h("button", { class: "btn sm line", style: "align-self:flex-start", onclick: async () => { await api("/api/remote/stop", {}); refreshRemote(); } }, L("Turn off", "Désactiver"))))
          : h("button", { class: "btn green", disabled: !r.hasPin || r.starting, style: "align-self:flex-start", onclick: async (e) => {
            e.currentTarget.disabled = true;
            e.currentTarget.textContent = L("Opening the link… (first time: download, ~30 s)", "Ouverture du lien… (1re fois : téléchargement, ~30 s)");
            try { await api("/api/remote/start", {}); } catch (err) { toast(errText(err), 5000); }
            refreshRemote();
          } }, icon("smartphone", 18), r.starting ? L("Opening…", "Ouverture…") : L("Turn on the phone link", "Activer le lien téléphone")),
        !r.running && !r.hasPin ? h("span", { class: "small muted" }, L("Choose a PIN first.", "Choisis d'abord un code.")) : null,
        r.error ? h("span", { class: "small", style: "color:var(--warn)" }, L("The phone link could not open. Check your internet and try again.", "Le lien téléphone n'a pas pu s'ouvrir. Vérifie ton internet et réessaie.")) : null));
  }

  const ints = new Set(p.interests || []);
  const sheet = $("#settings .sheet");
  sheet.replaceChildren(
    h("div", { class: "spread" }, h("h2", { id: "settings-title" }, L("Settings", "Réglages")), h("button", { class: "icon-btn", "aria-label": L("Close", "Fermer"), onclick: closeSettings }, icon("x"))),
    h("div", { class: "eyebrow group-title" }, L("You", "Toi")),
    h("div", { class: "group" },
      field(L("First name", "Prénom"), h("input", { class: "input", value: p.name, onchange: (e) => set("name", e.target.value.trim().slice(0, 40)) })),
      field(L("App language", "Langue de l'app"), sel(p.lang, [["French", "Français"], ["English", "English"]], (v) => { set("lang", v); renderSettings(); renderNav(); })),
      field(L("Your level", "Ton niveau"), sel(p.level, LEVEL_IDS.map((id) => [id, `${id} · ${LT(levelInfo(id))}`]), (v) => set("level", v))),
      field(L(`Help in ${L("English", "French")}`, "Aide en français"), sel(p.support, [["auto", L("Automatic (by level)", "Automatique (selon le niveau)")], ["high", L("A lot", "Beaucoup")], ["some", L("A little", "Un peu")], ["none", L("None: English only", "Aucune : tout en anglais")]], (v) => set("support", v))),
      field(L("Daily goal", "Objectif quotidien"), sel(p.minutes, [[5, "5 min"], [10, "10 min"], [15, "15 min"], [20, "20 min"], [30, "30 min"]], (v) => set("minutes", Number(v)))),
      field(L("Interests", "Centres d'intérêt"), h("div", { class: "interest-chips" }, INTERESTS.map(([id, em, fr, en]) => h("button", { class: `chip sm${ints.has(id) ? " on" : ""}`, type: "button", onclick: () => { ints.has(id) ? ints.delete(id) : ints.add(id); set("interests", [...ints], true); } }, `${em} ${L(en, fr)}`))))),
    h("div", { class: "eyebrow group-title" }, L("Tutor", "Prof")),
    h("div", { class: "group" },
      field(L("Tutor", "Prof"), sel(p.tutor, Object.values(TUTORS).map((t) => [t.id, `${t.name} · ${t.city}`]), (v) => set("tutor", v))),
      voiceField(TUTORS.emma),
      voiceField(TUTORS.jake),
      field(L("Speaking speed", "Vitesse de parole"), sel(p.rate, [["auto", L("Automatic (slower for beginners)", "Automatique (plus lente pour les débutants)")], [0.72, L("Slow", "Lente")], [0.85, L("A bit slow", "Un peu lente")], [1, L("Natural", "Naturelle")], [1.1, L("Fast", "Rapide")]], (v) => set("rate", v === "auto" ? "auto" : Number(v))),
        L("“Natural” voices are the most human (free, they need the internet). If they do not answer, a Mac voice takes over by itself.", "Les voix « naturelles » sont les plus humaines (gratuites, il faut internet). Si elles ne répondent pas, une voix du Mac prend le relais toute seule.")),
      field(L("Brain", "Cerveau"), sel(p.tier, [["balanced", L("Natural and fast (recommended)", "Naturel et rapide (conseillé)")], ["fast", L("Instant and cheapest", "Instantané et moins cher")], ["max", L("Smartest (slower replies)", "Le plus intelligent (réponses plus lentes)")]], (v) => set("tier", v)))),
    h("div", { class: "eyebrow group-title" }, L("During calls", "Pendant les appels")),
    h("div", { class: "group" },
      toggle(L("Hands-free", "Mains libres"), L("The mic opens by itself when the tutor stops talking, and sends when you pause.", "Le micro s'ouvre tout seul quand le prof a fini, et envoie quand tu fais une pause."), p.handsFree !== false, (v) => set("handsFree", v)),
      field(L("Pause before sending", "Pause avant d'envoyer"), sel(p.patience, [["auto", L("Automatic (longer when you are mid-thought)", "Automatique (plus longue quand tu n'as pas fini)")], ["short", L("Short", "Courte")], ["normal", L("Normal", "Normale")], ["long", L("Long: I need time to think", "Longue : j'ai besoin de réfléchir")]], (v) => set("patience", v))),
      field(L("Microphone", "Micro"), micField()),
      field(L("Tutor's volume", "Volume du prof"), sel(p.voiceVol || "loud", [["normal", L("Normal", "Normal")], ["loud", L("Loud (recommended)", "Fort (conseillé)")], ["max", L("Very loud", "Très fort")]], (v) => { set("voiceVol", v); AudioOut.ensure(); AudioOut.setVolume(v); })),
      field(L("Writing down your voice", "Transcription de ta voix"), sel(p.ears || "exact", [["exact", L("Most exact (recommended)", "La plus exacte (conseillé)")], ["fast", L("Fastest", "La plus rapide")]], (v) => set("ears", v))),
      field(L("Subtitles", "Sous-titres"), sel(p.subs === "all" ? "all" : "teach", [["teach", L("Corrections and structures only", "Corrections et structures seulement")], ["all", L("Everything that is said", "Tout ce qui est dit")]], (v) => set("subs", v))),
      field(L("Translation under subtitles", "Traduction sous les sous-titres"), sel(p.autoTr, [["auto", L("Automatic (A1–A2)", "Automatique (A1–A2)")], ["on", L("Always", "Toujours")], ["off", L("Never", "Jamais")]], (v) => set("autoTr", v)))),
    phone ? h("div", { class: "eyebrow group-title" }, L("Phone", "Téléphone")) : null,
    phone,
    keyBlock ? h("div", { class: "eyebrow group-title" }, L("API key", "Clé API")) : null,
    keyBlock ? h("div", { class: "group" }, keyBlock, sttBlock, elevenBlock) : null,
    h("div", { class: "eyebrow group-title" }, L("Look", "Apparence")),
    h("div", { class: "group" }, field(L("Theme", "Thème"), sel(p.theme || "auto", [["auto", L("Automatic", "Automatique")], ["light", L("Light", "Clair")], ["dark", L("Dark", "Sombre")]], (v) => { set("theme", v); applyTheme(); }))),
    h("div", { class: "spread", style: "padding-top:4px" },
      h("span", { class: "small muted" }, L("Your progress is saved in the data folder, next to the app.", "Ta progression est enregistrée dans le dossier data, à côté de l'app.")),
      UI.settingsReset
        ? h("button", { class: "btn sm danger", onclick: () => {
          S = structuredClone(DEFAULTS);
          for (const k of Object.keys(DEFAULTS)) save(k);
          UI.drill = null; UI.review = null; UI.feedback = null;
          closeSettings();
          toast(L("All progress was reset", "Toute la progression a été effacée"));
        } }, L("Tap again to erase everything", "Touche encore pour tout effacer"))
        : h("button", { class: "btn sm line", onclick: () => { UI.settingsReset = true; renderSettings(); } }, L("Reset all progress", "Tout effacer"))),
    h("button", { class: "btn lg block", onclick: closeSettings }, L("Done", "Terminé")));
}

function applyTheme() {
  const t = S.profile.theme;
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  // The phone's top bar follows the chosen look, not only the phone's own setting.
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    const dark = t === "dark" || (t !== "light" && /dark/.test(m.media));
    m.content = dark ? "#0E1122" : "#FFFFFF";
  });
}
