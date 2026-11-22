"use strict";
// Fluent — navigation, the animation loop, keyboard shortcuts and start-up.

const TAB_IDS = ["home", "lessons", "homework", "practice", "progress"];
// Tab names of the first version (links, the page's address): Talk is in Practice, Lessons and Journey were renamed.
const OLD_TABS = { talk: "practice", learn: "lessons", journey: "progress" };

function setTab(tab) {
  tab = OLD_TABS[tab] || tab;
  if (!TAB_IDS.includes(tab)) tab = "home";
  if (UI.tab !== tab) { Speech.stop(); Mic.stopAll(); }
  // Leaving a shadowing session: keep what was done (minutes, scores), then close it.
  if (UI.shadow) { if (UI.shadow.tries > UI.shadow.saved.tries) shadowFinish(); closeShadow(); }
  // A finished review stays until it has been seen on Home.
  if (UI.feedback && UI.feedback.status !== "loading" && UI.tab === "home") UI.feedback = null;
  UI.tab = tab;
  if (location.hash !== "#" + tab) history.replaceState(null, "", "#" + tab);
  render();
  window.scrollTo(0, 0);
}

function render() {
  liveFaces.clear();
  const view = $("#view");
  let content;
  const bare = UI.needLogin || UI.offline || !S.profile.onboarded;
  document.body.classList.toggle("bare", bare);
  if (UI.needLogin) content = viewLogin();
  else if (UI.offline) content = h("div", { class: "card stack", style: "max-width:520px;margin:8vh auto 0" },
    h("h2", null, L("Fluent is not running", "Fluent ne tourne pas")),
    h("p", null, L("Double-click start.command in the Learn English folder on your Mac. Then this page works.", "Double-clique sur start.command dans le dossier Learn English sur ton Mac. Ensuite cette page marche.")),
    h("button", { class: "btn", onclick: () => location.reload() }, L("Reload", "Recharger")));
  else if (!S.profile.onboarded) content = viewOnboarding();
  else if (UI.shadow) content = viewShadow();
  else if (UI.tab === "lessons") content = viewLessons();
  else if (UI.tab === "homework") content = viewHomework();
  else if (UI.tab === "practice") content = viewPractice();
  else if (UI.tab === "progress") content = viewProgress();
  else content = viewHome();
  view.replaceChildren(content);
  renderNav();
  renderPill();
  document.documentElement.lang = S.profile.lang === "English" ? "en" : "fr";
}

// One animation loop for every living face on screen.
function tick(now) {
  requestAnimationFrame(tick);
  if (UI.call) { UI.call.frame(now); return; }
  for (const st of liveFaces) {
    if (!st.art.isConnected) { liveFaces.delete(st); continue; }
    st.frame(now, { mode: "idle", level: 0 });
  }
}
requestAnimationFrame(tick);

// Keyboard: hold Space to talk; Escape closes things.
let spaceTalking = false;
function micAction() {
  if (UI.call) return () => UI.call.micTap();
  if (UI.shadow?.phase === "work") return shadowMic;
  if (UI.tab === "practice" && UI.drill && !UI.drill.loading && !UI.drill.finished && !UI.drill.error) return drillMic;
  if (UI.tab === "practice" && UI.review && !UI.review.finished && !UI.review.revealed) return flashMic;
  return null;
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!$("#settings").hidden) return closeSettings();
    if (UI.call?.pop) { UI.call.pop = null; UI.call.renderControls(); return; }
    if (UI.call?.wordInfo) { UI.call.wordInfo = null; UI.call.renderWordCard(); return; }
  }
  if (e.code !== "Space" || e.repeat) return;
  if (e.target.closest("input, textarea, select, button, [contenteditable]")) return;
  if (!$("#settings").hidden) return;
  const act = micAction();
  if (!act) return;
  e.preventDefault();
  const listening = UI.call ? Boolean(UI.call.listen) : Boolean(UI.listening);
  if (listening) { act(); return; } // a second press sends
  spaceTalking = true;
  act();
});
document.addEventListener("keyup", (e) => {
  if (e.code !== "Space" || !spaceTalking) return;
  e.preventDefault();
  spaceTalking = false;
  // Holding Space = push-to-talk: releasing sends (after a short hold only).
  if (UI.call?.listen && performance.now() - UI.call.listenStart > 700) UI.call.stopListening(true);
  else if (!UI.call && UI.listening && performance.now() - UI.listening.lastChange < 30000) UI.listening.stop();
});

$("#open-settings").append(icon("gear"));
$("#open-settings").addEventListener("click", openSettings);
$("#settings").addEventListener("click", (e) => { if (e.target.id === "settings") closeSettings(); });
document.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", (e) => { e.preventDefault(); setTab(b.dataset.tab); }));
window.addEventListener("hashchange", () => { if (!UI.call) setTab(location.hash.slice(1)); });
// Leaving the page during a call: stop the voice and the mic, and let the Mac finish the class
// (review, memory, words, diary). Waiting saves are sent before the page goes.
let leftCall = false;
window.addEventListener("pagehide", () => {
  if (UI.shadow && UI.shadow.tries > UI.shadow.saved.tries) shadowFinish();
  flushSaves(true);
  if (UI.call) { leftCall = true; UI.call.hangUp(true); }
});
// Back from the browser's page cache: the Mac is finishing the class, so start again with fresh data.
window.addEventListener("pageshow", (e) => { if (e.persisted && leftCall) location.reload(); });
// A phone can close a hidden page without warning: save now, and end a call left for a long time.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { UI.call?.onHidden(); flushSaves(true); } else UI.call?.onVisible();
});

function migrate(p) {
  // Older versions stored a model name and English by default.
  if (!p.tier) p.tier = "balanced";
  delete p.model;
  delete p.voice;
  if (typeof p.handsFree !== "boolean" || p.onboarded !== true) p.handsFree = true;
  if (!p.mins) p.mins = {};
  if (!Array.isArray(p.interests)) p.interests = [];
  if (!p.minutes || p.goal) { p.minutes = p.minutes || 15; delete p.goal; }
  delete p.plan;
  delete p.autoSpeak;
  // Old defaults (voice a bit fast, short pause before sending): move to the automatic settings once.
  // The light look became the default (2026-10-28): "Automatic" (follows the Mac, often dark) moves to light once.
  if (!p.mig3) {
    if (!p.theme || p.theme === "auto") p.theme = "light";
    p.mig3 = true;
  }
  if (!p.mig2) {
    if (p.rate === 0.9 || p.rate == null) p.rate = "auto";
    if (p.patience === "normal" || p.patience == null) p.patience = "auto";
    p.mig2 = true;
  }
  return p;
}

// The Mac keeps the data (./data). Loads it into S.
async function loadState() {
  const state = await api("/api/state");
  for (const k of Object.keys(DEFAULTS)) {
    const doc = state[k] && typeof state[k] === "object" ? state[k] : {};
    BASE[k] = structuredClone(doc);
    replaceDoc(k, { ...structuredClone(DEFAULTS[k]), ...doc });
  }
  if (!Array.isArray(S.vocab.words)) S.vocab.words = [];
  if (!Array.isArray(S.journal.entries)) S.journal.entries = [];
  if (!S.profile.days || typeof S.profile.days !== "object") S.profile.days = {};
  if (!S.progress.skills) S.progress.skills = {};
  S.profile = migrate(S.profile);
}
// After the Mac changed the data (end of class): send waiting saves, then reload.
async function syncState() {
  await flushSaves();
  await Promise.all(Object.values(saveChains));
  await loadState();
  renderPill();
}

async function init() {
  const hash = OLD_TABS[location.hash.slice(1)] || location.hash.slice(1);
  UI.tab = TAB_IDS.includes(hash) ? hash : "home";
  try {
    const status = await api("/api/status");
    UI.status = status;
    UI.local = status.local !== false;
    if (status.needLogin) { UI.needLogin = true; render(); return; }
    UI.hasKey = status.hasKey;
    UI.stt = Boolean(status.stt);
    UI.eleven = Boolean(status.eleven);
    const [, cur] = await Promise.all([loadState(), api("/api/curriculum")]);
    CURRICULUM = cur;
    // The goals changed on 2026-11-05: the old plan is put aside, and the first session comes next. Once.
    if (!S.profile.mig4) {
      try {
        await api("/api/course/new-goals", {});
        S.profile.mig4 = true;
        save("profile");
        await syncState();
      } catch (e) { console.warn("[plan] the old plan stays for now:", e?.message || e); }
    }
    Speech.init();
  } catch (e) {
    if (e?.code !== "need_login") UI.offline = true;
  }
  applyTheme();
  render();
  if (S.profile?.tutor === "jake") setTimeout(() => Stage3D.preload(), 800); // his 3D body is ready when the call starts
}
init();
