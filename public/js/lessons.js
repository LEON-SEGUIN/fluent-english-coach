"use strict";
// Fluent — "Cours": short theory lessons (rules, tables, key phrases), then exercises out loud:
// listen and repeat, a quiz, questions to answer by voice, and a call with the tutor to use it for real.

const lessonCache = new Map();

// The lessons of one level, in order. B2 (where most learners of this app start) begins with the sounds and the phrases that keep a conversation going.
function lessonList(level) {
  return [...(level === "B2" ? CURRICULUM.starter || [] : []), ...(CURRICULUM.skills[level] || [])];
}
const lessonInfo = (id) => LEVEL_IDS.flatMap(lessonList).find((l) => l.id === id) || null;
const lessonDone = (id) => (S.progress.lessons || {})[id] || null;
function nextLesson(level) {
  return lessonList(level).find((l) => !lessonDone(l.id)) || null;
}

async function openLesson(id) {
  Speech.stop();
  Mic.stopAll();
  const info = lessonInfo(id);
  if (!info) return;
  const ls = { id, info, data: lessonCache.get(id) || null, error: null, t0: Date.now(), order: {}, answers: {}, rep: {}, speak: {}, shown: {}, finished: false };
  UI.lesson = ls;
  if (UI.tab !== "lessons") setTab("lessons"); else render();
  window.scrollTo(0, 0);
  if (ls.data) return;
  try {
    const d = await api("/api/lesson", { id });
    lessonCache.set(id, d);
    if (UI.lesson === ls) { ls.data = d; render(); }
  } catch (e) {
    if (UI.lesson === ls) { ls.error = e; render(); }
  }
}
function closeLesson() {
  Speech.stop();
  Mic.stopAll();
  UI.lesson = null;
  render();
  window.scrollTo(0, 0);
}

// "**I've been working** for **three years**" -> text with the English in bold; a tap on a bold word says it.
// inline: one line of text (no paragraphs).
function richText(text, inline = false) {
  const line = (para) => para.split(/(\*\*[^*]+\*\*)/).map((part) => {
    const m = part.match(/^\*\*([^*]+)\*\*$/);
    if (!m) return part;
    // A gap to fill ("I ___ here since 2023") is shown in bold but not read aloud.
    if (/_{2,}/.test(m[1])) return h("b", null, m[1]);
    return h("button", { class: "say-word", type: "button", title: L("Listen", "Écouter"), onclick: () => Speech.say(m[1], { rate: 0.85 }) }, m[1]);
  });
  if (inline) return line(String(text).replace(/\s*\n+\s*/g, " "));
  return String(text).split(/\n{2,}/).map((para) => h("p", null, line(para)));
}

// Tables: the cells in English can be tapped to hear them.
const NOT_SPOKEN = /fran[cç]ais|french|traduction|translation|usage|son$|sound|sens|meaning|situation|lettre|letter|nombre$|number|syllabe|stress|pronom|pronoun|moment|r[eè]gle|rule|^$/i;
function lessonTable(t) {
  const n = t.rows[0]?.length || 0;
  const spokenCol = (i) => (t.head.length ? !NOT_SPOKEN.test(t.head[i] || "") : n === 2 ? i === 0 : true);
  return h("div", { class: "lesson-table-wrap" }, h("table", { class: "lesson-table" },
    t.head.length ? h("thead", null, h("tr", null, t.head.map((c) => h("th", null, c)))) : null,
    h("tbody", null, t.rows.map((r) => h("tr", null, r.map((c, i) => h("td", null,
      spokenCol(i) && /[a-z]/i.test(c) ? h("button", { class: "say-cell", type: "button", onclick: () => Speech.say(c.replace(/^\d+\s+/, ""), { rate: 0.85 }) }, c) : c)))))));
}

// Quiz options in a random order, the same while the lesson stays open.
function quizOrder(ls, qi, n) {
  if (!ls.order[qi]) ls.order[qi] = Array.from({ length: n }, (_, i) => i).sort(() => Math.random() - 0.5);
  return ls.order[qi];
}

async function lessonRepeat(i) {
  const ls = UI.lesson;
  const ph = ls?.data?.phrases[i];
  if (!ph) return;
  if (UI.listening) { UI.listening.stop(); return; }
  if (!Mic.ok) { micError({ code: "unsupported" }); return; }
  Speech.stop();
  ls.rep[i] = { live: "" };
  render();
  let res;
  try { res = await listenOnce(tutorNow().accent, (t) => { ls.rep[i].live = t; const el = $(`#rep-live-${i}`); if (el) el.textContent = t || "…"; }); } catch (e) { ls.rep[i] = null; render(); micError(e); return; }
  if (UI.lesson !== ls) return;
  if (!res.text) { ls.rep[i] = null; render(); toast(L("I did not hear anything. Try again.", "Je n'ai rien entendu. Réessaie.")); return; }
  const sc = scoreSpeech(ph.es, res.text);
  ls.rep[i] = { said: res.text, score: sc.score, marks: sc.marks };
  render();
  if (sc.score >= 80) Speech.say(pick(["Well done!", "Perfect!", "Spot on!", "That's it!"]));
}

async function lessonSpeak(i) {
  const ls = UI.lesson;
  const sp = ls?.data?.speak[i];
  if (!sp) return;
  if (UI.listening) { UI.listening.stop(); return; }
  if (!Mic.ok) { micError({ code: "unsupported" }); return; }
  Speech.stop();
  ls.speak[i] = { live: "" };
  render();
  let res;
  try { res = await listenOnce(tutorNow().accent, (t) => { ls.speak[i].live = t; const el = $(`#speak-live-${i}`); if (el) el.textContent = t || "…"; }, 1600); } catch (e) { ls.speak[i] = null; render(); micError(e); return; }
  if (UI.lesson !== ls) return;
  if (!res.text) { ls.speak[i] = null; render(); toast(L("I did not hear anything. Try again.", "Je n'ai rien entendu. Réessaie.")); return; }
  ls.speak[i] = { said: res.text, judging: true };
  render();
  try {
    const j = await api("/api/judge", { tr: `Answer the question "${sp.es}" (${sp.tr})`, es: sp.model, said: res.text });
    if (UI.lesson !== ls) return;
    ls.speak[i] = { said: res.text, correct: Boolean(j.correct), score: clamp(Math.round(Number(j.score) || 0), 0, 100), better: j.better || sp.model, note: j.note || "" };
    Speech.say(ls.speak[i].correct ? pick(["Well done!", "Perfect!", "Nice one!"]) : ls.speak[i].better);
  } catch (e) {
    // No key or no internet: show the model answer instead of a grade.
    ls.speak[i] = { said: res.text, better: sp.model, note: errText(e) };
  }
  render();
}

function finishLesson() {
  const ls = UI.lesson;
  if (!ls?.data || ls.finished) return;
  ls.finished = true;
  const qs = ls.data.quiz;
  const right = qs.filter((q, i) => ls.answers[i] === q.answer).length;
  const quiz = qs.length ? Math.round((right / qs.length) * 100) : null;
  const first = !lessonDone(ls.id);
  S.progress.lessons = { ...(S.progress.lessons || {}), [ls.id]: { done: today(), quiz, n: ((lessonDone(ls.id) || {}).n || 0) + 1 } };
  // A skill read in a lesson counts as "seen": the tutor builds on it in the next class.
  if (Object.values(CURRICULUM.skills).some((list) => (list || []).some((s) => s.id === ls.id)) && skillState(ls.id) === "new") {
    S.progress.skills = { ...(S.progress.skills || {}), [ls.id]: { state: "seen", count: 0, last: Date.now(), first: Date.now() } };
  }
  save("progress");
  const xp = first ? 15 : 5;
  addXP(xp);
  ls.xp = xp;
  addMinutes(Math.min(20, Math.max(1, (Date.now() - ls.t0) / 60000)));
  logEntry({ id: uid(), kind: "lesson", ts: Date.now(), date: today(), title: ls.data.title, score: quiz, xp, turns: Object.keys(ls.rep).length });
  render();
  Speech.say(pick(["Well done!", "Brilliant!", "Great job!"]));
}

// Practise the lesson out loud with the tutor, in a real call.
function practiseLesson(ls) {
  const title = ls.data?.title || LT(ls.info.title);
  if (ls.id === "a0-sounds") return startCall({ mode: "chat", title, topic: "Pronunciation practice: short everyday sentences with the sounds r, rr, j, ll, ñ, z and the five vowels. Ask me to repeat sentences and give friendly tips." });
  if (ls.id === "a0-survival") return startCall({ mode: "chat", title, topic: "Practise survival phrases: talk a bit fast on purpose so I ask you to repeat, to slow down, how to say a word or what a word means. Then praise me when I use them." });
  startCall({ mode: "lesson", skills: [ls.id], title });
}

function viewLearn() {
  if (UI.lesson) return viewLesson();
  const p = S.profile;
  const level = UI.lessonLevel || p.level || "B2";
  const list = lessonList(level);
  const next = nextLesson(level);
  const doneN = list.filter((l) => lessonDone(l.id)).length;
  const tutor = tutorNow();
  const hero = next ? h("section", { class: "learn-hero" },
    h("div", { class: "stack tight" },
      h("div", { class: "eyebrow" }, doneN ? L("Next lesson", "Cours suivant") : L("Start here", "Commence ici")),
      h("h2", null, LT(next.title)),
      h("p", { class: "small muted" }, L("5 minutes of theory, then you say it out loud. Then practise it in a call.", "5 minutes de théorie, puis tu le dis à voix haute. Ensuite, tu pratiques en appel."))),
    h("button", { class: "btn lg", onclick: () => openLesson(next.id) }, icon("book", 20), L("Open", "Ouvrir")))
    : h("section", { class: "learn-hero" }, h("div", { class: "stack tight" }, h("div", { class: "eyebrow" }, L("Level done", "Niveau terminé")), h("h2", null, L(`You read every ${level} lesson. Well done!`, `Tu as lu tous les cours ${level}. Well done!`)),
      h("p", { class: "small muted" }, L(`Now talk with ${tutor.name} to make it automatic.`, `Maintenant, parle avec ${tutor.name} pour que ça devienne automatique.`))));
  return h("div", { class: "stack" },
    h("div", null, h("div", { class: "eyebrow" }, L("Lessons", "Cours")), h("h1", null, L("The rules, simply", "La théorie, simplement"))),
    h("div", { class: "chips level-chips", role: "tablist" }, LEVEL_IDS.map((id) => h("button", { class: `chip${id === level ? " on" : ""}`, role: "tab", "aria-selected": String(id === level), onclick: () => { UI.lessonLevel = id; render(); } }, id))),
    hero,
    h("section", { class: "card" },
      h("div", { class: "card-head" }, h("h3", null, `${level} · ${LT(levelInfo(level))}`), h("span", { class: "small muted num" }, `${doneN} / ${list.length}`)),
      h("p", { class: "small muted" }, L(`${tutor.name} writes each of these lessons the first time you open it (about 30 seconds), then it stays on your Mac.`, `${tutor.name} écrit chaque cours la première fois que tu l'ouvres (environ 30 secondes), puis il reste sur ton Mac.`)),
      h("div", { class: "lesson-list" }, list.map((l, i) => {
        const d = lessonDone(l.id);
        return h("button", { class: `lesson-row${d ? " done" : ""}${next && next.id === l.id ? " next" : ""}`, onclick: () => openLesson(l.id) },
          h("span", { class: "num-dot" }, d ? icon("check", 16) : String(i + 1)),
          h("span", { class: "t" }, h("b", null, LT(l.title)), h("span", null, l.ex)),
          d && d.quiz != null ? h("span", { class: `badge ${scoreClass(d.quiz)}` }, `${d.quiz}%`) : null,
          icon("chevron", 18));
      }))));
}

function viewLesson() {
  const ls = UI.lesson;
  const t = tutorNow();
  const back = h("button", { class: "btn sm ghost", onclick: closeLesson }, icon("back", 16), L("Lessons", "Cours"));
  if (ls.error) return h("div", { class: "stack" }, back, errorBox(ls.error, () => { const id = ls.id; UI.lesson = null; openLesson(id); }));
  if (!ls.data) return h("div", { class: "stack" }, back, h("div", { class: "card focus-card" }, portrait(t.id, "lg"),
    h("p", null, L(`${t.name} is writing this lesson for you…`, `${t.name} écrit ce cours pour toi…`)), h("p", { class: "small muted" }, L("About 30 seconds, only the first time.", "Environ 30 secondes, seulement la première fois."))));
  const d = ls.data;
  // The level whose list holds this lesson (ids like "biz-present" or "word-colloc" do not start with a level).
  const level = LEVEL_IDS.find((lv) => lessonList(lv).some((l) => l.id === ls.id)) || (ls.id.startsWith("a0-") ? "B2" : ls.id.slice(0, 2).toUpperCase());
  const list = lessonList(level);
  const idx = list.findIndex((l) => l.id === ls.id);
  const after = list[idx + 1] || null;
  const answered = Object.keys(ls.answers).length;
  const right = d.quiz.filter((q, i) => ls.answers[i] === q.answer).length;
  const listening = Boolean(UI.listening);

  const sections = d.sections.map((s) => h("section", { class: "card lesson-sec" },
    h("h3", null, s.title),
    h("div", { class: "lesson-text" }, richText(s.text)),
    s.table ? lessonTable(s.table) : null,
    s.tip ? h("div", { class: "lesson-tip" }, icon("bulb", 16), h("span", null, richText(s.tip, true))) : null));

  const phrases = h("section", { class: "card stack" },
    h("div", null, h("div", { class: "eyebrow" }, L("Out loud", "À voix haute")), h("h3", null, L("Listen and repeat", "Écoute et répète"))),
    h("p", { class: "small muted" }, L("Tap the speaker, then the mic, and say the sentence.", "Touche le haut-parleur, puis le micro, et dis la phrase.")),
    h("div", { class: "rep-list" }, d.phrases.map((ph, i) => {
      const r = ls.rep[i];
      const live = r && r.live != null && r.said == null;
      return h("div", { class: "rep-row" },
        h("button", { class: "icon-btn", "aria-label": L("Listen", "Écouter"), onclick: () => Speech.say(ph.es, { rate: 0.85 }) }, icon("speaker", 18)),
        h("div", { class: "rep-t" },
          r?.marks ? marksEl(r.marks) : h("b", null, ph.es),
          h("span", { class: "muted small" }, ph.tr),
          live ? h("span", { class: "said", id: `rep-live-${i}` }, r.live || "…") : null),
        r?.score != null ? h("span", { class: `badge ${scoreClass(r.score)}` }, `${r.score}%`) : null,
        h("button", { class: `icon-btn${live && listening ? " on" : ""}`, "aria-label": live ? L("Stop", "Arrêter") : L("Say it", "Dis-le"), onclick: () => lessonRepeat(i) }, icon(live && listening ? "send" : "mic", 18)));
    })));

  const mistakes = d.mistakes.length ? h("section", { class: "card stack tight" },
    h("h3", null, L("Mistakes to avoid", "Erreurs à éviter")),
    d.mistakes.map((m) => h("div", { class: "fix-item" },
      h("span", null, h("s", null, m.wrong), " → ", h("button", { class: "say-word", onclick: () => Speech.say(m.right, { rate: 0.85 }) }, m.right)),
      h("span", { class: "muted small" }, richText(m.why, true))))) : null;

  const quiz = d.quiz.length ? h("section", { class: "card stack" },
    h("div", { class: "spread" }, h("div", null, h("div", { class: "eyebrow" }, L("Check", "Vérifie")), h("h3", null, L("Quiz", "Quiz"))),
      answered === d.quiz.length ? h("span", { class: `badge ${scoreClass((right / d.quiz.length) * 100)}` }, `${right} / ${d.quiz.length}`) : h("span", { class: "small muted num" }, `${answered} / ${d.quiz.length}`)),
    d.quiz.map((q, qi) => {
      const a = ls.answers[qi];
      return h("div", { class: "quiz-q" },
        h("p", { class: "q" }, richText(q.q, true)),
        h("div", { class: "quiz-opts" }, quizOrder(ls, qi, q.options.length).map((oi) => h("button", {
          class: `quiz-opt${a == null ? "" : oi === q.answer ? " right" : oi === a ? " wrong" : " off"}`, disabled: a != null,
          onclick: () => { ls.answers[qi] = oi; render(); if (oi === q.answer) Speech.say(pick(["Yes!", "Correct!", "That's it!"])); },
        }, a != null && oi === q.answer ? icon("check", 15) : null, q.options[oi].replace(/\*\*/g, "")))),
        a != null ? h("p", { class: "small muted why" }, richText(q.why, true)) : null);
    })) : null;

  const speak = d.speak.length ? h("section", { class: "card stack" },
    h("div", null, h("div", { class: "eyebrow" }, L("Your turn", "À toi")), h("h3", null, L("Answer out loud", "Réponds à voix haute"))),
    h("p", { class: "small muted" }, L(`${t.name} asks, you answer with your own words.`, `${t.name} pose la question, tu réponds avec tes mots.`)),
    d.speak.map((sp, i) => {
      const r = ls.speak[i];
      const live = r && r.live != null && r.said == null;
      return h("div", { class: "speak-q" },
        h("div", { class: "row nowrap", style: "gap:10px" },
          h("button", { class: "icon-btn", "aria-label": L("Listen to the question", "Écouter la question"), onclick: () => Speech.say(sp.es) }, icon("speaker", 18)),
          h("div", { class: "grow" }, h("b", null, sp.es), h("div", { class: "muted small" }, sp.tr)),
          h("button", { class: `icon-btn${live && listening ? " on" : ""}`, "aria-label": L("Answer", "Répondre"), disabled: r?.judging, onclick: () => lessonSpeak(i) }, icon(live && listening ? "send" : "mic", 18))),
        live ? h("p", { class: "said", id: `speak-live-${i}` }, r.live || "…") : null,
        r?.judging ? h("p", { class: "small muted" }, L("Checking…", "Je vérifie…")) : null,
        r && r.said && !r.judging ? h("div", { class: "speak-res" },
          h("p", { class: "said" }, L(`You said: “${r.said}”`, `Tu as dit : « ${r.said} »`)),
          r.score != null ? h("span", { class: `badge ${r.correct ? "ok" : "low"}` }, r.correct ? L("Correct", "Correct") : L("Almost", "Presque")) : null,
          r.better ? h("p", null, h("button", { class: "say-word", onclick: () => Speech.say(r.better, { rate: 0.85 }) }, r.better)) : null,
          r.note ? h("p", { class: "small muted" }, richText(r.note, true)) : null) : null,
        !r && !ls.shown[i] ? h("button", { class: "link small", onclick: () => { ls.shown[i] = true; render(); } }, L("See an example", "Voir un exemple")) : null,
        !r && ls.shown[i] ? h("p", { class: "small muted" }, L("For example: ", "Par exemple : "), h("button", { class: "say-word", onclick: () => Speech.say(sp.model, { rate: 0.85 }) }, sp.model)) : null);
    })) : null;

  const end = ls.finished ? h("section", { class: "card stack lesson-end" },
    h("div", { class: "row nowrap", style: "gap:14px" }, portrait(t.id, "md"),
      h("div", null, h("h3", null, L("Lesson done. Well done!", "Cours terminé. Well done!")), h("p", { class: "small muted" }, `+${ls.xp} XP · ${L(`Now use it with ${t.name}: that is how it sticks.`, `Maintenant, utilise-le avec ${t.name} : c'est comme ça que ça rentre.`)}`))),
    h("div", { class: "row" },
      h("button", { class: "btn green", onclick: () => practiseLesson(ls) }, icon("phone", 18), L(`Practise with ${t.name}`, `Pratiquer avec ${t.name}`)),
      after ? h("button", { class: "btn ghost", onclick: () => openLesson(after.id) }, L("Next lesson", "Cours suivant"), icon("chevron", 16)) : null,
      h("button", { class: "btn ghost", onclick: closeLesson }, L("All lessons", "Tous les cours"))))
    : h("section", { class: "card stack lesson-end" },
      h("p", { class: "small muted" }, answered < d.quiz.length ? L("Tip: do the quiz before you finish.", "Conseil : fais le quiz avant de terminer.") : L("Well done. Mark the lesson as done.", "Bien joué. Marque le cours comme terminé.")),
      h("div", { class: "row" },
        h("button", { class: "btn", onclick: finishLesson }, icon("check", 18), L("I finished this lesson", "J'ai fini ce cours")),
        h("button", { class: "btn ghost", onclick: () => practiseLesson(ls) }, icon("phone", 18), L(`Practise with ${t.name}`, `Pratiquer avec ${t.name}`))));

  return h("div", { class: "stack lesson" },
    h("div", { class: "spread" }, back, h("span", { class: "small muted num" }, `${level} · ${L("lesson", "cours")} ${idx + 1} / ${list.length}`)),
    h("div", null,
      h("div", { class: "eyebrow" }, `${L("Lesson", "Cours")} · ${d.minutes} min`),
      h("h1", null, d.title),
      d.goal ? h("p", { class: "lesson-goal" }, richText(d.goal, true)) : null),
    ...sections, phrases, mistakes, quiz, speak, end);
}
