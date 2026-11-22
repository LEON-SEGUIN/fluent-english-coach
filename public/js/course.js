"use strict";
// Fluent — the course, like a private tutor: a learning plan in units, lessons on fixed days,
// and homework after each lesson (words, quiz, say it like a native, speaking, writing, shadowing).
// The Mac writes the plan (/api/course/plan) and the homework (at the end of a course lesson);
// the page keeps the lesson days and the homework answers (data/course.json, data/homework.json).

const WEEKDAYS = [["Sun", "Dim"], ["Mon", "Lun"], ["Tue", "Mar"], ["Wed", "Mer"], ["Thu", "Jeu"], ["Fri", "Ven"], ["Sat", "Sam"]];
const DEFAULT_SCHEDULE = { days: [1, 3, 5], time: "19:00" };

// ---------- The plan ----------
// The plan's lessons in order, each with its unit (same ids as the server: "u<unit>l<lesson>").
function courseLessons() {
  const units = S.course?.plan?.units || [];
  return units.flatMap((u, ui) => (u.lessons || []).map((l, li) => ({ ...l, id: l.id || `u${ui + 1}l${li + 1}`, unit: u, unitNo: ui + 1, no: 0 })))
    .map((l, i) => ({ ...l, no: i + 1 }));
}
const courseDone = (id) => (S.course?.lessons || {})[id] || null;
const nextCourseLesson = () => courseLessons().find((l) => !courseDone(l.id)) || null;
const schedule = () => ({ ...DEFAULT_SCHEDULE, ...(S.course?.schedule || {}) });

// The next lesson slots after `from` (same rule as nextSlot in server.js).
function nextSlots(n = 3, from = new Date()) {
  const sc = schedule();
  const days = (sc.days || []).map(Number);
  const [hh, mm] = String(sc.time || "19:00").split(":").map(Number);
  const out = [];
  for (let i = 0; i < 60 && out.length < n && days.length; i++) {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i, hh || 0, mm || 0);
    if (days.includes(d.getDay()) && d > from) out.push(d);
  }
  return out;
}
// "Wed 30 Oct · 19:00", and "today" / "tomorrow" / "in 3 days".
function whenText(d) {
  if (!d) return "";
  const loc = S.profile.lang === "English" ? "en-GB" : "fr-FR";
  const day = d.toLocaleDateString(loc, { weekday: "short", day: "numeric", month: "short" });
  const time = d.toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit" });
  return `${day} · ${time}`;
}
function relDay(d) {
  if (!d) return "";
  const days = Math.round((parseDay(dayKey(d)) - parseDay(today())) / 864e5);
  if (days <= 0) return L("today", "aujourd'hui");
  if (days === 1) return L("tomorrow", "demain");
  return L(`in ${days} days`, `dans ${days} jours`);
}

// ---------- The first session: 30 minutes of talk, then a course made from it ----------
const DEFAULT_GOAL = () => L(
  "Be really fluent. At ease in business English: presenting a company, meetings, calls. At ease in everyday life and relationships, on my university exchange abroad. With the right words for each situation and the right sentence structures every time.",
  "Être vraiment fluide. À l'aise en anglais business : présenter une entreprise, les réunions, les appels. À l'aise au quotidien et dans mes relations, pendant mon échange universitaire à l'étranger. Avec les bons mots dans chaque situation et les bonnes structures de phrases à chaque fois.");
const ASSESS_TOTAL = 30, ASSESS_MIN = 10;
const assessOf = () => S.course?.assess || {};
const assessMinutes = () => (assessOf().parts || []).reduce((a, x) => a + (Number(x.minutes) || 0), 0);
const ASSESS_LABEL = {
  fluency: ["Fluency", "La fluidité"], words: ["The right words", "Les mots justes"], structures: ["Sentence structures", "Les structures de phrases"],
  business: ["Business English", "L'anglais business"], daily: ["Everyday life and relationships", "Le quotidien et les relations"], listening: ["Understanding", "La compréhension"],
};
const TRACK_LABEL = { business: ["Business", "Business"], daily: ["Everyday life", "Quotidien"], words: ["The right word", "Le bon mot"], structures: ["Structures", "Structures"], fluency: ["Fluency", "Fluidité"] };

function startAssess() {
  startCall({ mode: "assess", title: L("First session: your level", "Première séance : ton niveau") });
}
// The first session again: the plan stays until the new result replaces it.
function redoAssess() {
  S.course.assess = { history: assessOf().history || [] };
  save("course");
  UI.planEdit = false;
  UI.planForm = null;
  render();
}
// Writes the result now, from what was said so far.
async function writeAssessNow() {
  if (UI.assessWriting) return;
  UI.assessWriting = true;
  UI.assessError = null;
  render();
  try {
    await api("/api/assess/finish", {});
    await syncState();
    setTimeout(ensurePlan, 0);
  } catch (e) { UI.assessError = e; }
  UI.assessWriting = false;
  render();
}
// The result is there and there is no plan yet: the tutor writes it (a failure waits for the "try again" button).
function ensurePlan() {
  if (S.course?.plan || !assessOf().result || UI.planning) return;
  const sc = schedule();
  createPlan({ goal: S.course.goal || DEFAULT_GOAL(), weeks: assessOf().result.weeks, days: sc.days, time: sc.time });
}
// A week is finished: the tutor writes the next one again from what it showed. Once per page load if it fails.
async function maybeAdapt() {
  if (!S.course?.adaptDue || UI.adapting || UI.call) return;
  UI.adapting = true;
  try {
    await api("/api/course/adapt", { scenes: SCENES.map((s) => ({ id: s.id, title: s.en, level: s.level })) });
    await syncState();
    UI.adapting = false;
    if (!UI.call) render();
  } catch (e) { console.warn("[plan] next week not adapted:", e?.message || e); }
}

function scoreRow(title, score, sub, note) {
  return h("div", { class: "score-row" },
    h("div", { class: "spread" }, h("b", null, title), h("span", { class: "small muted num" }, sub)),
    h("div", { class: "bar" }, h("i", { style: `width:${clamp(Number(score) || 0, 0, 100)}%` })),
    note ? h("span", { class: "small muted" }, note) : null);
}
// The whole result of the first session.
function assessReport(r) {
  return h("div", { class: "stack" },
    h("section", { class: "card score-hero" },
      h("div", { class: "level-big" }, r.level),
      h("div", { class: "stack tight grow", style: "min-width:220px" },
        h("div", { class: "eyebrow" }, L("Your level today", "Ton niveau aujourd'hui")),
        h("p", null, r.summary))),
    h("section", { class: "card stack tight" }, h("h3", null, L("Where you are", "Où tu en es")),
      (r.scores || []).map((s) => scoreRow(L(...(ASSESS_LABEL[s.id] || [s.id, s.id])), s.score, `${s.score}/100${s.level ? ` · ${s.level}` : ""}`, s.comment))),
    r.strengths?.length ? h("section", { class: "card stack tight" }, h("h3", null, L("What you already do well", "Ce que tu fais déjà bien")), h("ul", null, r.strengths.map((s) => h("li", null, s)))) : null,
    r.priorities?.length ? h("section", { class: "card stack tight" }, h("h3", null, L("What we will improve", "Ce qu'on va améliorer")),
      r.priorities.map((x, i) => h("div", { class: "fix-item" },
        h("b", null, `${i + 1}. ${x.title}`),
        h("span", { class: "muted small" }, x.why),
        (x.examples || []).map((e) => h("span", null, h("s", null, e.you_said), " → ", h("b", null, e.better)))))) : null,
    r.planNote ? h("div", { class: "quote" }, r.planNote) : null,
    h("p", { class: "small muted" }, L("Your tutor only has your words, not your voice, so this says nothing about your accent. The accent workout measures that.", "Ton prof n'a que tes mots, pas ta voix : ce bilan ne dit rien de ton accent. Le travail d'accent, dans la pratique, le mesure.")));
}
// The plan being written, or ready, under a result.
function planState() {
  if (UI.planning?.error) return errorBox(UI.planning.error, ensureRetry);
  if (S.course?.plan) return h("button", { class: "btn lg", onclick: () => { UI.feedback = null; UI.openUnit = null; setTab("lessons"); window.scrollTo(0, 0); } }, icon("book", 20), L("See my course", "Voir mon programme"));
  return h("section", { class: "card focus-card" }, portrait(tutorNow().id, "lg"),
    h("h3", null, L(`${tutorNow().name} is writing your course from this…`, `${tutorNow().name} écrit ton programme à partir de ça…`)),
    h("p", { class: "small muted" }, L("About one minute.", "Environ une minute.")),
    h("div", { class: "skeleton", style: "height:14px;width:70%" }));
}
function ensureRetry() { UI.planning = null; ensurePlan(); }

// Before the first session (or in the middle of it).
function assessSetup() {
  const t = tutorNow();
  const sc = schedule();
  const state = UI.planForm || (UI.planForm = { days: [...sc.days], time: sc.time, weeks: 12, goal: S.course?.goal || DEFAULT_GOAL() });
  const mins = Math.round(assessMinutes());
  const left = Math.max(5, ASSESS_TOTAL - mins);
  const go = async () => {
    AudioOut.unlock();
    S.course.goal = String(state.goal || "").trim().slice(0, 600);
    S.course.schedule = { days: state.days, time: state.time };
    save("course");
    await flushSaves();
    UI.planForm = null;
    startAssess();
  };
  if (UI.assessWriting) {
    return h("section", { class: "card focus-card" }, portrait(t.id, "lg"),
      h("h3", null, L(`${t.name} is writing your results…`, `${t.name} écrit ton bilan…`)),
      h("p", { class: "small muted" }, L("One or two minutes.", "Une ou deux minutes.")),
      h("div", { class: "skeleton", style: "height:14px;width:70%" }));
  }
  const goal = h("textarea", { class: "input", rows: 4, oninput: (e) => { state.goal = e.target.value; } }, state.goal);
  return h("section", { class: "card stack plan-setup" },
    h("div", null,
      h("div", { class: "eyebrow" }, L("First session", "Première séance")),
      h("h2", null, mins ? L(`${left} minutes left with ${t.name}`, `Encore ${left} minutes avec ${t.name}`) : L(`30 minutes to show ${t.name} how you speak`, `30 minutes pour montrer à ${t.name} comment tu parles`))),
    mins ? h("p", { class: "muted" }, L(`You already talked for ${mins} minute${mins === 1 ? "" : "s"}. ${t.name} picks up where you stopped.`, `Tu as déjà parlé ${mins} minute${mins === 1 ? "" : "s"}. ${t.name} reprend là où vous en étiez.`))
      : h("p", { class: "muted" }, L(`${t.name} gets you talking about many things: your life, a story, your relationships, a company presentation, a meeting. No corrections that day: ${t.name} only listens. At the end, you get your level and what to improve, and ${t.name} builds your whole course from it.`, `${t.name} te fait parler de plein de choses : ta vie, une histoire, tes relations, une présentation d'entreprise, une réunion. Aucune correction ce jour-là : ${t.name} écoute. À la fin, tu as ton niveau et ce qu'il faut améliorer, et ${t.name} construit tout ton programme à partir de ça.`)),
    h("div", { class: "field" }, h("label", null, L("Your goal", "Ton objectif")), goal),
    h("div", { class: "field" }, h("label", null, L("Lesson days, after this session", "Jours de cours, après cette séance")),
      h("div", { class: "sched-days" }, WEEKDAYS.map(([en, fr], d) => h("button", { type: "button", class: `chip${state.days.includes(d) ? " on" : ""}`, "aria-pressed": String(state.days.includes(d)),
        onclick: () => { state.days = state.days.includes(d) ? state.days.filter((x) => x !== d) : [...state.days, d].sort(); render(); } }, L(en, fr))))),
    h("div", { class: "field" }, h("label", null, L("Time", "Heure")), h("input", { class: "input", type: "time", value: state.time, onchange: (e) => { state.time = e.target.value || "19:00"; } })),
    UI.assessError ? errorBox(UI.assessError, writeAssessNow) : null,
    h("div", { class: "row" },
      h("button", { class: "btn lg call-btn", disabled: !state.days.length, onclick: go }, icon("phone", 20), mins ? L("Pick up the session", "Reprendre la séance") : L("Start the session (30 min)", "Commencer la séance (30 min)")),
      mins >= ASSESS_MIN ? h("button", { class: "btn ghost", onclick: writeAssessNow }, L("Get my results now", "Avoir mon bilan maintenant")) : null),
    h("p", { class: "small muted" }, L("You can stop and pick it up later. Find a quiet place, and keep going in English even if it isn't perfect.", "Tu peux t'arrêter et reprendre plus tard. Mets-toi au calme, et reste en anglais même si ce n'est pas parfait.")));
}
// With a plan: the level, what is improving, and the checkpoints.
function assessPanel() {
  const a = assessOf(), r = a.result, focus = S.course?.focus || [];
  if (!r) {
    if (!(a.parts || []).length) return h("section", { class: "card row spread" }, h("b", null, L("New first session", "Nouvelle première séance")), h("button", { class: "btn sm call-btn", onclick: startAssess }, icon("phone", 16), L("Start", "Commencer")));
    return h("section", { class: "card row spread" }, h("b", null, L(`First session: ${Math.round(assessMinutes())} of ${ASSESS_TOTAL} minutes`, `Première séance : ${Math.round(assessMinutes())} minutes sur ${ASSESS_TOTAL}`)), h("button", { class: "btn sm call-btn", onclick: startAssess }, icon("phone", 16), L("Pick up", "Reprendre")));
  }
  const last = (a.history || []).at(-1);
  return h("section", { class: "card stack tight" },
    h("div", { class: "spread" }, h("h3", null, L("What we are improving", "Ce qu'on améliore")), h("span", { class: "badge mid" }, L(`Level ${last?.level || r.level}`, `Niveau ${last?.level || r.level}`))),
    last ? h("p", { class: "small" }, h("b", null, L("Last checkpoint: ", "Dernier point d'étape : ")), last.summary) : null,
    focus.map((f) => scoreRow(f.title, f.score, Number(f.score) >= 85 ? L("done", "acquis") : f.start != null && f.start !== f.score ? `${f.start} → ${f.score}` : `${f.score}/100`, f.note || "")),
    h("details", null, h("summary", { class: "small" }, L("See my first-session results", "Voir mon bilan de la première séance")), assessReport(r)));
}

async function createPlan(form) {
  if (UI.planning && !UI.planning.error) return;
  UI.planning = { error: null };
  render();
  try {
    S.course.schedule = { days: form.days, time: form.time };
    save("course");
    await flushSaves();
    await api("/api/course/plan", {
      goal: form.goal, weeks: form.weeks, perWeek: form.days.length,
      scenes: SCENES.map((s) => ({ id: s.id, title: s.en, level: s.level })),
    });
    await syncState();
    UI.planning = null;
    UI.planEdit = false;
    toast(L(`${tutorNow().name} wrote your learning plan.`, `${tutorNow().name} a écrit ton programme.`), 3500);
  } catch (e) {
    UI.planning = { error: e };
  }
  render();
}

function startCourseLesson(l) {
  const scene = l.scene ? SCENES.find((s) => s.id === l.scene) : null;
  startCall({ mode: "lesson", courseLesson: l.id, skills: l.skills || [], title: l.title, ...(scene ? { scene, sceneId: scene.id } : {}) });
}

// ---------- Homework ----------
const hwSets = () => (Array.isArray(S.homework?.sets) ? S.homework.sets : []);
const hwOpen = (set) => (set.items || []).filter((it) => !it.result).length;
const hwTodo = () => hwSets().filter((x) => hwOpen(x) > 0);
const hwScore = (set) => {
  const done = (set.items || []).filter((it) => it.result);
  return done.length ? Math.round(done.reduce((a, it) => a + (Number(it.result.score) || 0), 0) / done.length) : null;
};
const HW_ICON = { words: "cards", quiz: "check", say: "translate", speak: "mic", write: "chat", shadow: "repeat" };
const HW_KIND = {
  words: ["Words", "Mots"], quiz: ["Quiz", "Quiz"], say: ["Say it like a native", "Dis-le comme un natif"],
  speak: ["Speaking", "Oral"], write: ["Writing", "Écrit"], shadow: ["Shadowing", "Shadowing"],
};
const HW_MIN = { words: 3, quiz: 3, say: 4, speak: 4, write: 5, shadow: 5 };

function openHomework(setId, itemId = null) {
  Speech.stop();
  Mic.stopAll();
  UI.hw = { setId, itemId, run: null };
  if (itemId) prepItem();
  if (UI.tab !== "homework") setTab("homework"); else render();
  window.scrollTo(0, 0);
}
const hwSet = () => hwSets().find((x) => x.id === UI.hw?.setId) || null;
const hwItem = () => (hwSet()?.items || []).find((it) => it.id === UI.hw?.itemId) || null;

// A new run of the open item (the exercise's state while it is on screen).
function prepItem() {
  const it = hwItem();
  if (!it) return;
  UI.hw.run = { i: 0, answers: {}, scores: [], result: null, busy: false, live: null, text: "", t0: Date.now(), check: null, error: null };
}

// Saves an item's result, with XP and minutes. A second try keeps the best score.
function finishItem(score, note = "") {
  const set = hwSet(), it = hwItem();
  if (!set || !it) return;
  const first = !it.result;
  score = clamp(Math.round(Number(score) || 0), 0, 100);
  if (first || score >= (it.result.score || 0)) it.result = { score, at: Date.now(), note: String(note).slice(0, 200) };
  save("homework");
  if (first) {
    addXP(score >= 80 ? 10 : 6);
    addMinutes(Math.min(15, Math.max(1, (Date.now() - UI.hw.run.t0) / 60000)) || HW_MIN[it.type] || 3);
  }
  if (!hwOpen(set) && !set.done) {
    set.done = Date.now();
    save("homework");
    logEntry({ id: uid(), kind: "homework", ts: Date.now(), date: today(), title: L(`Homework · ${set.lessonTitle}`, `Devoirs · ${set.lessonTitle}`), score: hwScore(set), xp: 0, turns: (set.items || []).length });
    toast(L(`Homework done! ${tutorNow().name} will see it in your next lesson.`, `Devoirs finis ! ${tutorNow().name} les verra au prochain cours.`), 4000);
  }
  UI.hw.run.result = { score };
  render();
}

// Records the learner's voice: the browser's live words, and Scribe/Whisper's text at the end.
async function hwListen(run, { quietMs = 1600, maxMs = 120000, onText } = {}) {
  if (!Mic.ok) { micError({ code: "unsupported" }); return ""; }
  Speech.stop();
  const ctl = Mic.listen(tutorNow().accent, { onUpdate: (t) => { run.live = t; onText?.(t); } });
  UI.listening = ctl;
  const rec = Ears.record();
  const t0 = performance.now();
  const timer = setInterval(() => {
    const quiet = performance.now() - ctl.lastChange;
    if ((ctl.text && quiet > quietMs) || performance.now() - t0 > maxMs || (!ctl.text && quiet > 15000)) ctl.stop();
  }, 200);
  render();
  try {
    const { text } = await ctl.promise;
    const better = await Ears.hear(rec, "");
    rec?.stop();
    return (better || text || "").trim();
  } catch (e) {
    rec?.stop();
    micError(e);
    return "";
  } finally {
    clearInterval(timer);
    if (UI.listening === ctl) UI.listening = null;
    run.live = null;
  }
}

// ---------- Screens: Home cards ----------
function nextLessonCard() {
  const t = tutorNow();
  if (!S.course?.plan) {
    if (assessOf().result) setTimeout(ensurePlan, 0);
    const mins = Math.round(assessMinutes());
    return h("section", { class: `class-card next-lesson ${t.id}` },
      h("div", { class: "face-wrap" }, h("div", { class: "face" }, liveFace(t.id).art), h("span", { class: "live-dot" })),
      h("div", null,
        h("div", { class: "eyebrow" }, L("First session", "Première séance")),
        assessOf().result
          ? h("h2", null, L(`${t.name} is writing your course…`, `${t.name} écrit ton programme…`))
          : h("h2", null, mins ? L(`${mins} of ${ASSESS_TOTAL} minutes done`, `${mins} minutes sur ${ASSESS_TOTAL} déjà faites`) : L(`30 minutes to show ${t.name} how you speak`, `30 minutes pour montrer à ${t.name} comment tu parles`)),
        assessOf().result ? null : h("p", { class: "sub" }, L(`Many topics, no corrections. ${t.name} then builds your whole course from what you said.`, `Plein de sujets, aucune correction. ${t.name} construit ensuite tout ton programme à partir de ce que tu as dit.`)),
        assessOf().result ? null : h("button", { class: "btn call-btn", onclick: () => setTab("lessons") }, icon("phone", 22), mins ? L("Pick up the session", "Reprendre la séance") : L("Prepare the session", "Préparer la séance"))));
  }
  const l = nextCourseLesson();
  const all = courseLessons();
  const slot = nextSlots(1)[0];
  const todo = hwTodo();
  if (!l) {
    return h("section", { class: `class-card next-lesson ${t.id}` },
      h("div", { class: "face-wrap" }, h("div", { class: "face" }, liveFace(t.id).art)),
      h("div", null, h("div", { class: "eyebrow" }, L("Plan completed", "Programme terminé")),
        h("h2", null, L("You finished your learning plan!", "Tu as fini ton programme !")),
        h("button", { class: "btn call-btn", onclick: () => { UI.planEdit = true; setTab("lessons"); } }, icon("sparkle", 22), L("Plan the next step", "Préparer la suite"))));
  }
  return h("section", { class: `class-card next-lesson ${t.id}` },
    h("div", { class: "face-wrap" }, h("div", { class: "face" }, liveFace(t.id).art), h("span", { class: "live-dot", title: L("Online", "En ligne") })),
    h("div", null,
      h("div", { class: "eyebrow" }, L(`Next lesson · ${l.no} of ${all.length}`, `Prochain cours · ${l.no} sur ${all.length}`)),
      h("h2", null, l.title),
      slot ? h("p", { class: "when" }, icon("clock", 16), ` ${whenText(slot)} · ${relDay(slot)}`) : null,
      h("p", { class: "sub" }, L(`Unit ${l.unitNo}: ${l.unit.title}`, `Unité ${l.unitNo} : ${l.unit.title}`)),
      l.objectives?.length ? h("ul", { class: "objectives" }, l.objectives.map((o) => h("li", null, o))) : null,
      h("div", { class: "row" },
        h("button", { class: "btn call-btn", onclick: () => startCourseLesson(l) }, icon("phone", 22), L(`Join the lesson with ${t.name}`, `Rejoindre le cours avec ${t.name}`)),
        (l.skills || [])[0] && typeof lessonInfo === "function" && lessonInfo(l.skills[0])
          ? h("button", { class: "btn ghost light", onclick: () => openLesson(l.skills[0]) }, icon("book", 18), L("Prepare (5 min)", "Préparer (5 min)")) : null),
      todo.length ? h("p", { class: "last" }, icon("check", 14), " ", L(`Homework to finish before the lesson: ${todo.reduce((a, x) => a + hwOpen(x), 0)} exercise(s).`, `Devoirs à finir avant le cours : ${todo.reduce((a, x) => a + hwOpen(x), 0)} exercice(s).`)) : null));
}

function homeworkCard() {
  const todo = hwTodo();
  const open = todo.reduce((a, x) => a + hwOpen(x), 0);
  const first = todo[0];
  return h("section", { class: "card hw-card" },
    h("div", { class: "card-head" }, h("h3", null, icon("check", 18), " ", L("Homework", "Devoirs")), open ? h("span", { class: "badge mid" }, L(`${open} to do`, `${open} à faire`)) : h("span", { class: "badge ok" }, L("All done", "Tout est fait"))),
    first
      ? h("div", { class: "stack tight" },
        h("p", { class: "small muted" }, L(`From “${first.lessonTitle}”`, `Du cours « ${first.lessonTitle} »`), first.due ? ` · ${L("due", "pour le")} ${whenText(new Date(first.due))}` : ""),
        h("div", { class: "hw-chips" }, (first.items || []).map((it) => h("button", { class: `chip sm${it.result ? " on" : ""}`, onclick: () => openHomework(first.id, it.id) }, icon(it.result ? "check" : HW_ICON[it.type], 13), LT({ en: HW_KIND[it.type][0], fr: HW_KIND[it.type][1] })))),
        h("button", { class: "btn", onclick: () => openHomework(first.id) }, L("Continue my homework", "Continuer mes devoirs")))
      : h("p", { class: "small muted" }, S.course?.plan
        ? L("New homework arrives after each lesson.", "De nouveaux devoirs arrivent après chaque cours.")
        : L("Homework starts after your first session.", "Les devoirs commencent après ta première séance.")));
}

// ---------- Screens: Lessons tab ----------
function planSetup() {
  const p = S.profile;
  const sc = schedule();
  const state = UI.planForm || (UI.planForm = {
    days: [...sc.days], time: sc.time, weeks: 12,
    goal: S.course?.goal || DEFAULT_GOAL(),
  });
  if (UI.planning && !UI.planning.error) {
    return h("section", { class: "card focus-card" }, portrait(tutorNow().id, "lg"),
      h("h2", null, L(`${tutorNow().name} is writing your learning plan…`, `${tutorNow().name} écrit ton programme…`)),
      h("p", { class: "small muted" }, L("About one minute. Units, lessons, objectives and role-plays, made for you.", "Environ une minute. Des unités, des cours, des objectifs et des jeux de rôle, faits pour toi.")),
      h("div", { class: "skeleton", style: "height:14px;width:70%" }), h("div", { class: "skeleton", style: "height:14px;width:50%" }));
  }
  const goal = h("textarea", { class: "input", rows: 3, oninput: (e) => { state.goal = e.target.value; } }, state.goal);
  return h("section", { class: "card stack plan-setup" },
    h("div", null, h("div", { class: "eyebrow" }, L("Your learning plan", "Ton programme")), h("h2", null, L("Let's plan your lessons", "Organisons tes cours"))),
    h("p", { class: "muted" }, L(`Like with a private tutor: ${tutorNow().name} writes a plan for the coming weeks, you meet on fixed days, and you get homework after each lesson.`, `Comme avec un prof particulier : ${tutorNow().name} écrit un programme pour les semaines à venir, vous vous retrouvez à jours fixes, et tu as des devoirs après chaque cours.`)),
    h("div", { class: "field" }, h("label", null, L("Your goal", "Ton objectif")), goal),
    h("div", { class: "field" }, h("label", null, L("Lesson days", "Jours de cours")),
      h("div", { class: "sched-days" }, WEEKDAYS.map(([en, fr], d) => h("button", { type: "button", class: `chip${state.days.includes(d) ? " on" : ""}`, "aria-pressed": String(state.days.includes(d)),
        onclick: () => { state.days = state.days.includes(d) ? state.days.filter((x) => x !== d) : [...state.days, d].sort(); render(); } }, L(en, fr)))),
      h("span", { class: "small muted" }, L("Three 30-minute lessons a week works better than one long one.", "Trois cours de 30 minutes par semaine marchent mieux qu'un seul long."))),
    h("div", { class: "row" },
      h("div", { class: "field" }, h("label", null, L("Time", "Heure")), h("input", { class: "input", type: "time", value: state.time, onchange: (e) => { state.time = e.target.value || "19:00"; } })),
      h("div", { class: "field" }, h("label", null, L("Length", "Durée")),
        h("select", { class: "input", onchange: (e) => { state.weeks = Number(e.target.value); } },
          [[4, L("4 weeks", "4 semaines")], [8, L("8 weeks", "8 semaines")], [12, L("12 weeks", "12 semaines")], [16, L("16 weeks", "16 semaines")]].map(([v, t]) => { const o = h("option", { value: v }, t); if (v === state.weeks) o.selected = true; return o; }))),
      h("div", { class: "field" }, h("label", null, L("Class length", "Durée d'un cours")),
        h("select", { class: "input", onchange: (e) => { p.minutes = Number(e.target.value); save("profile"); } },
          [[20, "20 min"], [30, "30 min"], [45, "45 min"]].map(([v, t]) => { const o = h("option", { value: v }, t); if (v === Number(p.minutes)) o.selected = true; return o; })))),
    UI.planning?.error ? errorBox(UI.planning.error, () => createPlan(state)) : null,
    h("div", { class: "row" },
      h("button", { class: "btn lg", disabled: !state.days.length, onclick: () => createPlan(state) }, icon("sparkle", 20),
        S.course?.plan ? L("Write a new plan", "Écrire un nouveau programme") : L("Create my learning plan", "Créer mon programme")),
      S.course?.plan ? h("button", { class: "btn ghost", onclick: () => { UI.planEdit = false; UI.planForm = null; render(); } }, L("Cancel", "Annuler")) : null,
      S.course?.plan ? h("button", { class: "btn ghost", onclick: redoAssess }, icon("phone", 16), L("Redo the 30-minute session", "Refaire la séance de 30 minutes")) : null),
    S.course?.plan ? h("p", { class: "small muted" }, L("A new plan starts again from lesson 1. Your past lessons stay in Progress.", "Un nouveau programme repart du cours 1. Tes cours passés restent dans Progrès.")) : null);
}

function scheduleEditor() {
  const sc = schedule();
  const set = (days, time) => { S.course.schedule = { days, time }; save("course"); render(); };
  return h("div", { class: "sched" },
    h("div", { class: "sched-days" }, WEEKDAYS.map(([en, fr], d) => h("button", { type: "button", class: `chip sm${sc.days.includes(d) ? " on" : ""}`, "aria-pressed": String(sc.days.includes(d)),
      onclick: () => set(sc.days.includes(d) ? sc.days.filter((x) => x !== d) : [...sc.days, d].sort(), sc.time) }, L(en, fr)))),
    h("input", { class: "input sched-time", type: "time", value: sc.time, "aria-label": L("Lesson time", "Heure du cours"), onchange: (e) => set(sc.days, e.target.value || "19:00") }));
}

function lessonRow(l, next) {
  const d = courseDone(l.id);
  const entry = d?.callId ? S.journal.entries.find((e) => e.callId === d.callId) : null;
  const scene = l.scene ? SCENES.find((s) => s.id === l.scene) : null;
  return h("div", { class: `lesson-item${d ? " done" : ""}${next ? " next" : ""}` },
    h("span", { class: "num-dot" }, d ? icon("check", 16) : String(l.no)),
    h("div", { class: "grow stack tight" },
      h("b", null, l.title),
      l.objectives?.length ? h("span", { class: "small muted" }, l.objectives.join(" · ")) : null,
      h("span", { class: "row" },
        l.checkpoint ? h("span", { class: "badge mid" }, L("Checkpoint", "Point d'étape")) : null,
        TRACK_LABEL[l.track] ? h("span", { class: "badge" }, L(...TRACK_LABEL[l.track])) : null,
        scene ? h("span", { class: "badge" }, icon("masks", 12), " ", L(scene.en, scene.fr)) : null,
        d?.score != null ? h("span", { class: `badge ${scoreClass(d.score)}` }, `${d.score}`) : null,
        d ? h("span", { class: "small muted" }, d.date ? new Date(d.done).toLocaleDateString(S.profile.lang === "English" ? "en-GB" : "fr-FR", { day: "numeric", month: "short" }) : "") : null),
      entry?.summary && next !== true ? h("details", null, h("summary", { class: "small" }, L("Lesson notes", "Notes du cours")),
        h("p", { class: "small" }, entry.summary),
        (entry.fixes || []).length ? h("ul", { class: "small" }, entry.fixes.map((x) => h("li", null, h("s", null, x.you_said), " → ", h("b", null, x.better)))) : null) : null),
    h("div", { class: "lesson-actions" },
      (l.skills || [])[0] && typeof lessonInfo === "function" && lessonInfo(l.skills[0]) ? h("button", { class: "icon-btn", title: L("Theory (5 min)", "Théorie (5 min)"), "aria-label": L("Theory", "Théorie"), onclick: () => openLesson(l.skills[0]) }, icon("book", 18)) : null,
      h("button", { class: `btn sm${next ? " green" : " ghost"}`, onclick: () => startCourseLesson(l) }, icon("phone", 16), d ? L("Redo", "Refaire") : L("Start", "Commencer"))));
}

function viewLessons() {
  if (UI.lesson) return viewLesson();
  if (UI.library) return h("div", { class: "stack" }, h("button", { class: "btn sm ghost", onclick: () => { UI.library = false; render(); } }, icon("back", 16), L("Lessons", "Cours")), viewLearn());
  const plan = S.course?.plan;
  if (!plan && assessOf().result) {
    setTimeout(ensurePlan, 0);
    return h("div", { class: "stack" },
      h("div", null, h("div", { class: "eyebrow" }, L("Lessons", "Cours")), h("h1", null, L("Your results", "Ton bilan"))),
      assessReport(assessOf().result),
      planState());
  }
  if (!plan) {
    return h("div", { class: "stack" },
      h("div", null, h("div", { class: "eyebrow" }, L("Lessons", "Cours")), h("h1", null, L("Your course", "Ton cours"))),
      UI.hasKey === false ? setupCard() : null,
      assessSetup());
  }
  if (UI.planEdit || UI.planning) {
    return h("div", { class: "stack" },
      h("div", null, h("div", { class: "eyebrow" }, L("Lessons", "Cours")), h("h1", null, L("Your course", "Ton cours"))),
      UI.hasKey === false ? setupCard() : null,
      planSetup());
  }
  setTimeout(maybeAdapt, 0);
  const all = courseLessons();
  const doneN = all.filter((l) => courseDone(l.id)).length;
  const next = nextCourseLesson();
  const slots = nextSlots(3);
  const upcoming = all.filter((l) => !courseDone(l.id)).slice(0, 3);
  UI.openUnit = UI.openUnit ?? (next ? next.unitNo : 1);
  return h("div", { class: "stack" },
    h("div", null, h("div", { class: "eyebrow" }, L("Lessons", "Cours")), h("h1", null, plan.title || L("Your course", "Ton cours"))),
    UI.hasKey === false ? setupCard() : null,
    h("section", { class: "card stack tight course-head" },
      plan.goal ? h("p", null, plan.goal) : null,
      h("div", { class: "spread" }, h("b", null, L(`${doneN} of ${all.length} lessons done`, `${doneN} cours faits sur ${all.length}`)), h("span", { class: "small muted num" }, `${Math.round((doneN / Math.max(1, all.length)) * 100)}%`)),
      h("div", { class: "bar" }, h("i", { style: `width:${Math.round((doneN / Math.max(1, all.length)) * 100)}%` })),
      h("div", { class: "field" }, h("label", null, L("Lesson days and time", "Jours et heure des cours")), scheduleEditor())),
    nextLessonCard(),
    assessPanel(),
    upcoming.length > 1 ? h("section", { class: "card stack tight" },
      h("h3", null, L("Coming up", "À venir")),
      upcoming.map((l, i) => h("div", { class: "upcoming" },
        h("span", { class: "when-chip" }, slots[i] ? whenText(slots[i]) : "—"),
        h("span", { class: "grow" }, h("b", null, l.title), h("span", { class: "small muted" }, ` · ${L("unit", "unité")} ${l.unitNo}`))))) : null,
    h("div", { class: "section-title" }, h("h2", null, L("Learning plan", "Programme")), h("span", { class: "small muted" }, L(`${plan.units.length} units`, `${plan.units.length} unités`))),
    plan.units.map((u, ui) => {
      const ls = all.filter((l) => l.unitNo === ui + 1);
      const uDone = ls.filter((l) => courseDone(l.id)).length;
      const open = UI.openUnit === ui + 1;
      return h("section", { class: `card unit${open ? " open" : ""}` },
        h("button", { class: "unit-head", "aria-expanded": String(open), onclick: () => { UI.openUnit = open ? 0 : ui + 1; render(); } },
          h("span", { class: `unit-no${uDone === ls.length ? " done" : ""}` }, uDone === ls.length ? icon("check", 16) : String(ui + 1)),
          h("span", { class: "grow" }, h("b", null, u.title), h("span", { class: "small muted" }, u.goal), u.note ? h("span", { class: "small unit-note" }, icon("sparkle", 13), " ", u.note) : null),
          h("span", { class: "small muted num" }, `${uDone}/${ls.length}`), icon(open ? "down" : "chevron", 18)),
        open ? h("div", { class: "unit-lessons" }, ls.map((l) => lessonRow(l, next && next.id === l.id))) : null);
    }),
    h("section", { class: "card row spread" },
      h("div", null, h("b", null, L("Theory library", "Bibliothèque de théorie")), h("p", { class: "small muted" }, L("Short lessons for every skill, from B1 to C2.", "Des cours courts pour chaque compétence, du B1 au C2."))),
      h("button", { class: "btn ghost", onclick: () => { UI.library = true; render(); window.scrollTo(0, 0); } }, icon("book", 18), L("Open", "Ouvrir"))),
    h("div", { class: "row" }, h("button", { class: "btn sm ghost", onclick: () => { UI.planEdit = true; render(); window.scrollTo(0, 0); } }, icon("refresh", 16), L("Change my plan", "Changer de programme"))));
}

// ---------- Screens: Homework tab ----------
function viewHomework() {
  if (UI.hw?.itemId && hwItem()) return viewHwItem();
  if (UI.hw?.setId && hwSet()) return viewHwSet();
  const sets = [...hwSets()].reverse();
  const todo = sets.filter((x) => hwOpen(x) > 0), done = sets.filter((x) => hwOpen(x) === 0);
  const setCard = (x) => {
    const n = (x.items || []).length, left = hwOpen(x), sc = hwScore(x);
    return h("button", { class: "card hw-set", onclick: () => openHomework(x.id) },
      h("div", { class: "spread" },
        h("div", { class: "stack tight" }, h("b", null, x.lessonTitle), h("span", { class: "small muted" },
          new Date(x.created).toLocaleDateString(S.profile.lang === "English" ? "en-GB" : "fr-FR", { weekday: "short", day: "numeric", month: "short" }),
          x.due && left ? ` · ${L("due", "pour le")} ${whenText(new Date(x.due))}` : "")),
        left ? ring((n - left) / n, 44, 5, `${n - left}/${n}`, "var(--azul)") : h("span", { class: `badge ${scoreClass(sc ?? 0)}` }, sc != null ? `${sc}` : "✓")),
      h("div", { class: "hw-chips" }, (x.items || []).map((it) => h("span", { class: `chip sm${it.result ? " on" : ""}` }, icon(it.result ? "check" : HW_ICON[it.type], 13), LT({ en: HW_KIND[it.type][0], fr: HW_KIND[it.type][1] })))));
  };
  return h("div", { class: "stack" },
    h("div", null, h("div", { class: "eyebrow" }, L("Homework", "Devoirs")), h("h1", null, L("Between lessons", "Entre les cours"))),
    todo.length ? h("div", { class: "stack tight" }, h("h3", null, L("To do", "À faire")), todo.map(setCard)) :
      h("section", { class: "card focus-card" }, portrait(tutorNow().id, "lg"),
        h("h3", null, sets.length ? L("All your homework is done.", "Tous tes devoirs sont faits.") : L("No homework yet", "Pas encore de devoirs")),
        h("p", { class: "small muted" }, L(`After each course lesson, ${tutorNow().name} gives you 15 to 25 minutes of exercises made from what you said.`, `Après chaque cours, ${tutorNow().name} te donne 15 à 25 minutes d'exercices faits à partir de ce que tu as dit.`)),
        S.course?.plan ? null : h("button", { class: "btn", onclick: () => setTab("lessons") }, L("Prepare my first session", "Préparer ma première séance"))),
    done.length ? h("div", { class: "stack tight" }, h("h3", null, L("Done", "Faits")), done.slice(0, 12).map(setCard)) : null);
}

function viewHwSet() {
  const set = hwSet();
  const back = h("button", { class: "btn sm ghost", onclick: () => { UI.hw = null; render(); } }, icon("back", 16), L("Homework", "Devoirs"));
  const t = tutorNow();
  return h("div", { class: "stack" },
    back,
    h("div", null, h("div", { class: "eyebrow" }, L("Homework", "Devoirs")), h("h1", null, set.lessonTitle)),
    set.note ? h("section", { class: "card row nowrap tutor-note" }, portrait(t.id, "sm"), h("div", { class: "quote" }, set.note)) : null,
    h("div", { class: "stack tight" }, (set.items || []).map((it, i) => h("button", { class: `card hw-item${it.result ? " done" : ""}`, onclick: () => openHomework(set.id, it.id) },
      h("span", { class: "ico" }, icon(it.result ? "check" : HW_ICON[it.type], 22)),
      h("span", { class: "grow stack tight" },
        h("span", { class: "eyebrow" }, `${i + 1} · ${LT({ en: HW_KIND[it.type][0], fr: HW_KIND[it.type][1] })} · ~${HW_MIN[it.type]} min`),
        h("b", null, it.title), h("span", { class: "small muted" }, it.instructions)),
      it.result ? h("span", { class: `badge ${scoreClass(it.result.score)}` }, `${it.result.score}`) : icon("chevron", 18)))));
}

function viewHwItem() {
  const it = hwItem(), set = hwSet();
  if (!UI.hw.run) prepItem();
  const run = UI.hw.run;
  const back = h("button", { class: "btn sm ghost", onclick: () => { Speech.stop(); Mic.stopAll(); UI.hw.itemId = null; UI.hw.run = null; render(); } }, icon("back", 16), set.lessonTitle);
  const head = h("div", null, h("div", { class: "eyebrow" }, LT({ en: HW_KIND[it.type][0], fr: HW_KIND[it.type][1] })), h("h1", null, it.title), h("p", { class: "muted" }, it.instructions));
  let body;
  if (run.result) body = hwDone(it, run);
  else if (it.type === "words") body = hwWords(it, run);
  else if (it.type === "quiz") body = hwQuiz(it, run);
  else if (it.type === "say") body = hwSay(it, run);
  else if (it.type === "shadow") body = hwShadow(it, run);
  else body = hwOpenTask(it, run);
  return h("div", { class: "stack" }, back, head, body);
}

function hwDone(it, run) {
  const set = hwSet();
  const nextItem = (set.items || []).find((x) => !x.result && x.id !== it.id);
  const sc = run.result.score;
  return h("section", { class: "card stack score-hero" },
    ring(sc / 100, 96, 9, String(sc), sc >= 80 ? "var(--ok)" : sc >= 60 ? "var(--azafran)" : "var(--warn)"),
    h("div", { class: "stack tight grow" },
      h("h2", null, sc >= 80 ? L("Great work!", "Super travail !") : sc >= 60 ? L("Good job.", "Bien joué.") : L("Done. Keep going!", "Fait. Continue !")),
      run.check ? hwCheckEl(run.check) : null,
      h("div", { class: "row" },
        nextItem ? h("button", { class: "btn", onclick: () => openHomework(set.id, nextItem.id) }, L("Next exercise", "Exercice suivant"), icon("chevron", 16)) : h("button", { class: "btn", onclick: () => openHomework(set.id) }, L("Back to the homework", "Retour aux devoirs")),
        h("button", { class: "btn ghost", onclick: () => { prepItem(); render(); } }, icon("refresh", 16), L("Try again", "Recommencer")))));
}

// Words: hear each one, see its meaning, say it; then they go to the flashcards.
function hwWords(it, run) {
  const w = it.words[run.i];
  if (!w) {
    if (!run.finishing) {
      run.finishing = true;
      if (it.type === "words") for (const x of it.words) addWord(x.es, x.tr, { from: "homework" });
      const avg = run.scores.length ? run.scores.reduce((a, b) => a + b, 0) / run.scores.length : 100;
      setTimeout(() => finishItem(avg, it.type === "words" ? L("words said aloud", "mots dits à voix haute") : ""), 0);
    }
    return h("div", { class: "card skeleton", style: "height:80px" });
  }
  const said = run.answers[run.i];
  return h("section", { class: "card stack drill-card" },
    h("div", { class: "spread" }, h("span", { class: "small muted num" }, `${run.i + 1} / ${it.words.length}`), h("button", { class: "chip sm", onclick: () => Speech.say(w.es, { rate: 0.85 }) }, icon("speaker", 13), L("Listen", "Écouter"))),
    h("h2", { class: "big-phrase" }, w.es),
    h("p", { class: "muted" }, w.tr),
    said ? h("div", { class: "stack tight" }, marksEl(said.marks), h("span", { class: `badge ${scoreClass(said.score)}` }, `${said.score}`)) : h("p", { class: "small muted", id: "hw-live" }, run.live ?? L("Say it out loud.", "Dis-le à voix haute.")),
    h("div", { class: "row center" },
      micButton(async () => {
        if (UI.listening) { UI.listening.stop(); return; }
        const text = await hwListen(run, { quietMs: 1100, onText: (t) => { const el = $("#hw-live"); if (el) el.textContent = t || "…"; } });
        if (!text) { render(); return; }
        const sc = scoreSpeech(w.es, text);
        run.answers[run.i] = sc;
        render();
        if (sc.score >= 80) Speech.say(pick(["Nice!", "Perfect!", "Spot on!"]));
      }),
      h("button", { class: "btn ghost", onclick: () => { run.scores.push(said ? said.score : 0); run.i++; render(); if (it.words[run.i]) Speech.say(it.words[run.i].es, { rate: 0.9 }); } }, said ? L("Next", "Suivant") : L("Skip", "Passer"), icon("chevron", 16))));
}

function hwQuiz(it, run) {
  const answered = Object.keys(run.answers).length;
  const right = it.questions.filter((q, i) => run.answers[i] === q.answer).length;
  return h("div", { class: "stack" },
    it.questions.map((q, qi) => {
      const a = run.answers[qi];
      return h("section", { class: "card stack tight quiz-q" },
        h("b", null, `${qi + 1}. ${q.q}`),
        h("div", { class: "quiz-opts" }, q.options.map((o, oi) => h("button", {
          class: `quiz-opt${a != null && oi === q.answer ? " right" : ""}${a === oi && oi !== q.answer ? " wrong" : ""}`, disabled: a != null,
          onclick: () => { run.answers[qi] = oi; render(); if (oi === q.answer) Speech.say(pick(["Yes!", "Correct!", "That's it!"])); },
        }, o))),
        a != null ? h("p", { class: "small muted" }, q.why) : null);
    }),
    h("button", { class: "btn lg", disabled: answered < it.questions.length, onclick: () => finishItem((right / it.questions.length) * 100, `${right}/${it.questions.length}`) },
      L(`Finish (${answered}/${it.questions.length})`, `Terminer (${answered}/${it.questions.length})`)));
}

// Say it like a native: a French sentence, said in English, checked by the tutor (/api/judge).
function hwSay(it, run) {
  const pr = it.prompts[run.i];
  if (!pr) {
    if (!run.finishing) {
      run.finishing = true;
      const avg = run.scores.length ? run.scores.reduce((a, b) => a + b, 0) / run.scores.length : 0;
      setTimeout(() => finishItem(avg), 0);
    }
    return h("div", { class: "card skeleton", style: "height:80px" });
  }
  const res = run.answers[run.i];
  return h("section", { class: "card stack drill-card" },
    h("span", { class: "small muted num" }, `${run.i + 1} / ${it.prompts.length}`),
    h("h2", { class: "big-phrase" }, pr.tr),
    pr.tip && !res ? h("p", { class: "small muted" }, icon("bulb", 14), " ", pr.tip) : null,
    res ? h("div", { class: "stack tight" },
      h("p", null, h("span", { class: "muted" }, L("You said: ", "Tu as dit : ")), res.said),
      h("p", null, h("b", null, res.better), " ", h("button", { class: "chip sm", onclick: () => Speech.say(res.better) }, icon("speaker", 13))),
      h("p", { class: "small" }, h("span", { class: `badge ${scoreClass(res.score)}` }, `${res.score}`), " ", res.note))
      : h("p", { class: "small muted", id: "hw-live" }, run.busy ? L("Checking…", "Je vérifie…") : run.live ?? L("Say it in English.", "Dis-le en anglais.")),
    h("div", { class: "row center" },
      res ? null : micButton(async () => {
        if (UI.listening) { UI.listening.stop(); return; }
        const text = await hwListen(run, { onText: (t) => { const el = $("#hw-live"); if (el) el.textContent = t || "…"; } });
        if (!text) { render(); return; }
        run.busy = true;
        render();
        try {
          const j = await api("/api/judge", { tr: pr.tr, es: pr.es, said: text });
          run.answers[run.i] = { said: text, score: clamp(Math.round(Number(j.score) || 0), 0, 100), better: j.better || pr.es, note: j.note || "" };
          Speech.say(j.better || pr.es);
        } catch (e) { toast(errText(e)); }
        run.busy = false;
        render();
      }, run.busy),
      h("button", { class: "btn ghost", onclick: () => { run.scores.push(res ? res.score : 0); run.i++; render(); } }, res ? L("Next", "Suivant") : L("Skip", "Passer"), icon("chevron", 16))));
}

// Shadowing: the daily shadowing module with the lesson's sentences (shadow.js), else a simple repeat-after.
function hwShadow(it, run) {
  if (typeof startShadow === "function") { // shadow.js
    return h("section", { class: "card stack" },
      h("ol", { class: "shadow-list" }, it.sentences.map((s) => h("li", null, s, " ", h("button", { class: "chip sm", onclick: () => Speech.say(s) }, icon("speaker", 13))))),
      h("button", { class: "btn lg", onclick: () => {
        const setId = UI.hw.setId;
        startShadow({ sentences: it.sentences, title: it.title, onDone: (r) => { openHomework(setId, it.id); finishItem(r?.avg ?? 70, L(`shadowing, ${r?.tries || 0} tries`, `shadowing, ${r?.tries || 0} essais`)); } });
      } },
        icon("repeat", 20), L("Start shadowing", "Commencer le shadowing")));
  }
  return hwWords({ ...it, words: it.sentences.map((s) => ({ es: s, tr: "" })) }, run);
}

// Speaking or writing task: the tutor checks the answer (/api/homework/check).
function hwOpenTask(it, run) {
  const speak = it.type === "speak";
  const box = h("textarea", { class: "input", rows: speak ? 4 : 7, placeholder: speak ? L("Your words appear here. You can fix them before sending.", "Tes mots apparaissent ici. Tu peux les corriger avant d'envoyer.") : L("Write your message here.", "Écris ton message ici."),
    oninput: (e) => { run.text = e.target.value; } }, run.text);
  const send = async () => {
    const text = (run.text || "").trim();
    if (!text) return toast(L("Say or write your answer first.", "Dis ou écris d'abord ta réponse."));
    run.busy = true;
    run.error = null;
    render();
    try {
      run.check = await api("/api/homework/check", { kind: it.type, task: it.task, text });
      run.busy = false;
      finishItem(run.check.score, String(run.check.feedback || "").slice(0, 160));
      return;
    } catch (e) { run.error = e; }
    run.busy = false;
    render();
  };
  return h("section", { class: "card stack" },
    h("div", { class: "quote" }, it.task),
    speak ? h("div", { class: "row center" },
      micButton(async () => {
        if (UI.listening) { UI.listening.stop(); return; }
        const text = await hwListen(run, { quietMs: 4000, maxMs: 150000, onText: (t) => { const el = $("#hw-live"); if (el) el.textContent = t || "…"; } });
        if (text) run.text = [run.text, text].filter(Boolean).join(" ");
        render();
      }, run.busy),
      h("span", { class: "small muted", id: "hw-live" }, UI.listening ? (run.live || L("Listening… pause 4 seconds to stop.", "Je t'écoute… fais une pause de 4 secondes pour arrêter.")) : L("Tap and talk for 60 to 90 seconds.", "Touche et parle 60 à 90 secondes."))) : null,
    box,
    run.error ? errorBox(run.error, send) : null,
    h("button", { class: "btn lg", disabled: run.busy, onclick: send }, run.busy ? L(`${tutorNow().name} is reading…`, `${tutorNow().name} lit…`) : L("Send to my tutor", "Envoyer à mon prof")));
}

function hwCheckEl(c) {
  return h("div", { class: "stack tight" },
    c.feedback ? h("p", null, c.feedback) : null,
    (c.fixes || []).length ? h("div", { class: "stack tight" }, c.fixes.map((x) => h("div", { class: "fix-item" },
      h("span", null, h("s", null, x.you_said), " → ", h("b", null, x.better)), h("span", { class: "muted small" }, x.why)))) : null,
    c.better ? h("details", null, h("summary", { class: "small" }, L("The native version", "La version native")),
      h("p", null, c.better, " ", h("button", { class: "chip sm", onclick: () => Speech.say(c.better) }, icon("speaker", 13), L("Listen", "Écouter")))) : null);
}
