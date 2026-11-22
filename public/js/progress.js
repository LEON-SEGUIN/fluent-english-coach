"use strict";
// Fluent — seeing the improvement: today's short to-do list (Home), a progress summary (Home)
// and the Progress tab (charts of the class scores, the practice per week and the accent, what the
// tutor is working on, the skills by level, the diary). Charts: one series each, thin marks, a hover
// tooltip, and a hidden table for screen readers (see the dataviz rules: no legend for one series).

// ---------- Data ----------
const classScores = () => S.journal.entries.filter((e) => (e.kind === "call" || e.kind === "talk") && e.score != null).slice(0, 24).reverse();
const shadowScores = () => S.journal.entries.filter((e) => e.kind === "shadow" && e.score != null).slice(0, 24).reverse();
// Minutes per week (Monday to Sunday), the last n weeks, oldest first.
function weeklyMinutes(n = 8) {
  const t = today();
  const monday = addDays(t, -((parseDay(t).getDay() + 6) % 7));
  return Array.from({ length: n }, (_, i) => {
    const start = addDays(monday, -7 * (n - 1 - i));
    let min = 0;
    for (let d = 0; d < 7; d++) min += (S.profile.mins || {})[addDays(start, d)] || 0;
    return { start, min: Math.round(min) };
  });
}
const shortDate = (ts) => new Date(ts).toLocaleDateString(S.profile.lang === "English" ? "en-GB" : "fr-FR", { day: "numeric", month: "short" });
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

// ---------- Charts ----------
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// A real SVG element (h() makes HTML elements).
function svgEl(attrs, inner) {
  const holder = document.createElement("div");
  holder.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" ${Object.entries(attrs).map(([k, v]) => `${k}="${esc(v)}"`).join(" ")}>${inner}</svg>`;
  return holder.firstElementChild;
}
// A hover tooltip shared by the charts of a page: the nearest point to the pointer.
function chartHover(wrap, svg, pts, onTip) {
  const tip = h("div", { class: "chart-tip", hidden: true });
  const line = svg.querySelector(".chart-cross");
  wrap.append(tip);
  const show = (i) => {
    const p = pts[i];
    if (!p) return;
    tip.hidden = false;
    tip.replaceChildren(...onTip(p));
    const box = svg.getBoundingClientRect(), wBox = wrap.getBoundingClientRect();
    const x = box.left - wBox.left + (p.x / svg.viewBox.baseVal.width) * box.width;
    tip.style.left = `${Math.min(wBox.width - tip.offsetWidth - 4, Math.max(4, x - tip.offsetWidth / 2))}px`;
    if (line) { line.setAttribute("x1", p.x); line.setAttribute("x2", p.x); line.style.opacity = "1"; }
    svg.querySelectorAll(".chart-hit").forEach((el, k) => el.classList.toggle("on", k === i));
  };
  const hide = () => { tip.hidden = true; if (line) line.style.opacity = "0"; svg.querySelectorAll(".chart-hit.on").forEach((el) => el.classList.remove("on")); };
  svg.addEventListener("pointermove", (e) => {
    const box = svg.getBoundingClientRect();
    const x = ((e.clientX - box.left) / box.width) * svg.viewBox.baseVal.width;
    let best = 0;
    pts.forEach((p, i) => { if (Math.abs(p.x - x) < Math.abs(pts[best].x - x)) best = i; });
    show(best);
  });
  svg.addEventListener("pointerleave", hide);
  svg.addEventListener("focus", () => show(pts.length - 1));
  svg.addEventListener("blur", hide);
  svg.addEventListener("keydown", (e) => {
    const cur = pts.findIndex((_, k) => svg.querySelectorAll(".chart-hit")[k]?.classList.contains("on"));
    if (e.key === "ArrowLeft") show(Math.max(0, cur - 1));
    if (e.key === "ArrowRight") show(Math.min(pts.length - 1, cur + 1));
  });
}

// A line over time, 0-100. points: [{ y, label, sub }]
function lineChart(points, { title, unit = "" } = {}) {
  const W = 640, H = 200, padL = 34, padR = 44, padT = 14, padB = 26;
  const n = points.length;
  const x = (i) => padL + (n === 1 ? (W - padL - padR) / 2 : (i / (n - 1)) * (W - padL - padR));
  const y = (v) => padT + (1 - v / 100) * (H - padT - padB);
  const pts = points.map((p, i) => ({ ...p, x: x(i), yy: y(p.y) }));
  const path = pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.yy.toFixed(1)}`).join(" ");
  const area = `${path} L${pts.at(-1).x.toFixed(1)} ${y(0)} L${pts[0].x.toFixed(1)} ${y(0)} Z`;
  const last = pts.at(-1);
  const grid = [0, 50, 100].map((v) => `<line class="chart-grid" x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"/><text class="chart-axis" x="${padL - 8}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join("");
  const svg = svgEl({ class: "chart", viewBox: `0 0 ${W} ${H}`, role: "img", tabindex: "0", "aria-label": `${title}: ${pts.map((p) => `${p.label} ${p.y}`).join(", ")}` },
    `${grid}
      <line class="chart-cross" x1="0" x2="0" y1="${padT}" y2="${y(0)}"/>
      ${n > 1 ? `<path class="chart-area" d="${area}"/><path class="chart-line" d="${path}"/>` : ""}
      ${pts.map((p, i) => `<circle class="chart-hit${i === n - 1 ? " last" : ""}" cx="${p.x}" cy="${p.yy}" r="${i === n - 1 ? 5 : 4}"/>`).join("")}
      <text class="chart-end" x="${last.x + 10}" y="${last.yy + 5}">${last.y}${unit}</text>
      <text class="chart-axis" x="${pts[0].x}" y="${H - 6}" text-anchor="${n > 1 ? "start" : "middle"}">${esc(pts[0].label)}</text>
      ${n > 1 ? `<text class="chart-axis" x="${last.x}" y="${H - 6}" text-anchor="end">${esc(last.label)}</text>` : ""}`);
  const wrap = h("div", { class: "chart-wrap" }, svg,
    h("table", { class: "sr" }, h("caption", null, title), points.map((p) => h("tr", null, h("td", null, p.label), h("td", null, `${p.y}${unit}`)))));
  chartHover(wrap, svg, pts, (p) => [h("b", null, `${p.y}${unit}`), h("span", null, p.label), p.sub ? h("span", null, p.sub) : null]);
  return wrap;
}

// Columns, one per week. bars: [{ value, label, sub }]
function columnChart(bars, { title, unit = "" } = {}) {
  const W = 640, H = 190, padL = 34, padR = 12, padT = 22, padB = 26;
  const max = Math.max(10, ...bars.map((b) => b.value));
  const top = Math.ceil(max / 10) * 10;
  const band = (W - padL - padR) / bars.length;
  const bw = Math.min(24, band * 0.6);
  const y = (v) => padT + (1 - v / top) * (H - padT - padB);
  const pts = bars.map((b, i) => ({ ...b, x: padL + band * i + band / 2 }));
  const r = 4;
  const col = (p, i) => {
    if (!p.value) return "";
    const x0 = p.x - bw / 2, y0 = y(p.value), base = y(0), hgt = Math.max(r, base - y0);
    // Rounded at the data end (top), square at the baseline.
    return `<path class="chart-col${i === pts.length - 1 ? " last" : ""}" d="M${x0} ${base} V${base - hgt + r} Q${x0} ${base - hgt} ${x0 + r} ${base - hgt} H${x0 + bw - r} Q${x0 + bw} ${base - hgt} ${x0 + bw} ${base - hgt + r} V${base} Z"/>`;
  };
  const last = pts.at(-1);
  const svg = svgEl({ class: "chart", viewBox: `0 0 ${W} ${H}`, role: "img", tabindex: "0", "aria-label": `${title}: ${pts.map((p) => `${p.label} ${p.value}${unit}`).join(", ")}` },
    `<line class="chart-grid" x1="${padL}" x2="${W - padR}" y1="${y(0)}" y2="${y(0)}"/><line class="chart-grid" x1="${padL}" x2="${W - padR}" y1="${y(top)}" y2="${y(top)}"/>
      <text class="chart-axis" x="${padL - 8}" y="${y(top) + 4}" text-anchor="end">${top}</text><text class="chart-axis" x="${padL - 8}" y="${y(0) + 4}" text-anchor="end">0</text>
      <line class="chart-cross" x1="0" x2="0" y1="${padT}" y2="${y(0)}"/>
      ${pts.map(col).join("")}
      ${pts.map((p) => `<rect class="chart-hit col" x="${p.x - band / 2}" y="${padT}" width="${band}" height="${y(0) - padT}"/>`).join("")}
      ${last.value ? `<text class="chart-end" x="${last.x}" y="${y(last.value) - 7}" text-anchor="middle">${last.value}${unit}</text>` : ""}
      <text class="chart-axis" x="${pts[0].x}" y="${H - 6}" text-anchor="middle">${esc(pts[0].label)}</text>
      <text class="chart-axis" x="${last.x}" y="${H - 6}" text-anchor="middle">${esc(last.label)}</text>`);
  const wrap = h("div", { class: "chart-wrap" }, svg,
    h("table", { class: "sr" }, h("caption", null, title), bars.map((b) => h("tr", null, h("td", null, b.label), h("td", null, `${b.value}${unit}`)))));
  chartHover(wrap, svg, pts, (p) => [h("b", null, `${p.value}${unit}`), h("span", null, p.sub || p.label)]);
  return wrap;
}

// ---------- Home: today's to-do list ----------
function todayCard() {
  const rows = [];
  const todo = typeof hwTodo === "function" ? hwTodo() : [];
  const left = todo.reduce((a, x) => a + hwOpen(x), 0);
  if (S.course?.plan) {
    rows.push({ done: !left, ico: "check", title: L("Homework", "Devoirs"),
      sub: left ? L(`${left} exercise${left === 1 ? "" : "s"} left`, `${left} exercice${left === 1 ? "" : "s"} à faire`) : L("All done", "Tout est fait"),
      act: left ? [L("Continue", "Continuer"), () => openHomework(todo[0].id)] : null });
  }
  const goal = typeof shadowGoal === "function" ? shadowGoal() : 10;
  const shDone = typeof shadowToday === "function" ? shadowToday() : 0;
  rows.push({ done: shDone >= goal, ico: "repeat", title: L(`Accent workout · ${goal} min`, `Entraînement d'accent · ${goal} min`),
    sub: shDone >= goal ? L("Done today", "Fait aujourd'hui")
      : typeof shadowFocus === "function" ? L(`${Math.floor(shDone)} of ${goal} min · day ${shadowDay() + 1}: ${shadowFocus().en}`, `${Math.floor(shDone)} sur ${goal} min · jour ${shadowDay() + 1} : ${shadowFocus().fr}`)
        : L(`${Math.floor(shDone)} of ${goal} min · shadowing, headphones on`, `${Math.floor(shDone)} sur ${goal} min · shadowing, avec écouteurs`),
    act: shDone >= goal ? null : [L("Start", "Commencer"), () => startShadow({ minutes: goal })] });
  const due = dueWords().length;
  rows.push({ done: !due, ico: "cards", title: L("Words to review", "Mots à réviser"),
    sub: due ? L(`${due} card${due === 1 ? "" : "s"} · 2 to 5 min`, `${due} carte${due === 1 ? "" : "s"} · 2 à 5 min`) : L("Nothing due today", "Rien à réviser aujourd'hui"),
    act: due ? [L("Review", "Réviser"), () => startReview()] : null });
  const doneN = rows.filter((r) => r.done).length;
  return h("section", { class: "card today-card" },
    h("div", { class: "card-head" }, h("h3", null, L("Today", "Aujourd'hui")), h("span", { class: `badge ${doneN === rows.length ? "ok" : ""}` }, `${doneN} / ${rows.length}`)),
    h("div", { class: "todo-list" }, rows.map((r) => h("div", { class: `todo${r.done ? " done" : ""}` },
      h("span", { class: "todo-ico" }, icon(r.done ? "check" : r.ico, 18)),
      h("span", { class: "grow" }, h("b", null, r.title), h("span", { class: "small muted" }, r.sub)),
      r.act ? h("button", { class: "btn sm", onclick: r.act[1] }, r.act[0]) : null))));
}

// ---------- Home: the progress in one look ----------
function progressSummary() {
  const scores = classScores();
  const mem = S.memory || {};
  const weeks = weeklyMinutes(2);
  const recent = scores.slice(-3).map((e) => e.score), before = scores.slice(-6, -3).map((e) => e.score);
  const trend = recent.length && before.length ? Math.round(avg(recent) - avg(before)) : null;
  const tile = (label, value, sub) => h("div", { class: "stat-tile" }, h("span", { class: "small muted" }, label), h("b", null, value), sub ? h("span", { class: "small muted" }, sub) : null);
  return h("section", { class: "card stack progress-mini" },
    h("div", { class: "card-head" }, h("h3", null, L("Your progress", "Tes progrès")),
      h("button", { class: "btn sm ghost", onclick: () => setTab("progress") }, L("See all", "Tout voir"), icon("chevron", 16))),
    h("div", { class: "tiles" },
      tile(L("Level", "Niveau"), mem.level_estimate || S.profile.level, mem.level_estimate ? L(`${tutorNow().name}'s estimate`, `estimé par ${tutorNow().name}`) : L("your setting", "ton réglage")),
      tile(L("Last classes", "Derniers cours"), recent.length ? `${Math.round(avg(recent))}/100` : "—", trend != null ? L(`${trend >= 0 ? "+" : ""}${trend} vs before`, `${trend >= 0 ? "+" : ""}${trend} vs avant`) : L("speaking score", "note à l'oral")),
      tile(L("This week", "Cette semaine"), `${weeks[1].min} min`, L(`last week ${weeks[0].min} min`, `semaine dernière ${weeks[0].min} min`))),
    scores.length >= 2 ? lineChart(scores.map((e) => ({ y: e.score, label: shortDate(e.ts), sub: e.title })), { title: L("Speaking score per class", "Note à l'oral par cours") }) : null);
}

// ---------- The Progress tab ----------
function viewProgress() {
  const p = S.profile, mem = S.memory || {};
  const scores = classScores(), shadows = shadowScores();
  const weeks = weeklyMinutes(8);
  const lessonsDone = typeof courseLessons === "function" ? courseLessons().filter((l) => courseDone(l.id)).length : 0;
  const lessonsAll = typeof courseLessons === "function" ? courseLessons().length : 0;
  const totalMin = Object.values(p.mins || {}).reduce((a, b) => a + b, 0);
  const learned = S.vocab.words.filter((w) => (w.box || 0) >= 3).length;
  const tile = (label, value, sub) => h("div", { class: "stat-tile" }, h("span", { class: "small muted" }, label), h("b", null, value), sub ? h("span", { class: "small muted" }, sub) : null);
  const chartCard = (title, sub, chart, empty) => h("section", { class: "card stack tight" },
    h("div", null, h("h3", null, title), h("p", { class: "small muted" }, sub)), chart || h("p", { class: "muted empty" }, empty));
  const parts = journeySections();
  return h("div", { class: "stack" },
    h("div", null, h("div", { class: "eyebrow" }, L("Progress", "Progrès")), h("h1", null, L("Your road to fluent English", "Ton chemin vers un anglais fluide"))),
    h("div", { class: "tiles big" },
      tile(L("Level", "Niveau"), mem.level_estimate || p.level, L(`goal: C1 · ${tutorNow().name}'s estimate`, `objectif : C1 · estimé par ${tutorNow().name}`)),
      tile(L("Course", "Programme"), lessonsAll ? `${lessonsDone}/${lessonsAll}` : "—", L("lessons done", "cours faits")),
      tile(L("Practice", "Pratique"), totalMin >= 60 ? `${Math.floor(totalMin / 60)}h${String(Math.round(totalMin % 60)).padStart(2, "0")}` : `${Math.round(totalMin)} min`, L(`best streak ${pl(p.best || 0, "day", "days")}`, `record ${pl(p.best || 0, "jour", "jours")} de suite`)),
      tile(L("Words known", "Mots acquis"), String(learned), L(`of ${S.vocab.words.length} saved`, `sur ${S.vocab.words.length} gardés`))),
    chartCard(L("Speaking score per class", "Note à l'oral par cours"), L(`${tutorNow().name}'s score after each class: accuracy, range, fluency, natural wording.`, `La note de ${tutorNow().name} après chaque cours : justesse, richesse, aisance, tournures naturelles.`),
      scores.length ? lineChart(scores.map((e) => ({ y: e.score, label: shortDate(e.ts), sub: e.title })), { title: L("Speaking score per class", "Note à l'oral par cours") }) : null,
      L("Your first class will start the chart.", "Ton premier cours lancera le graphique.")),
    chartCard(L("Practice per week", "Pratique par semaine"), L("Minutes of classes, homework and exercises, Monday to Sunday.", "Minutes de cours, devoirs et exercices, du lundi au dimanche."),
      columnChart(weeks.map((w, i) => ({ value: w.min, label: i === weeks.length - 1 ? L("this week", "cette sem.") : shortDate(parseDay(w.start).getTime()), sub: L(`week of ${shortDate(parseDay(w.start).getTime())}`, `semaine du ${shortDate(parseDay(w.start).getTime())}`) })), { title: L("Practice per week", "Pratique par semaine"), unit: " min" })),
    chartCard(L("Accent", "Accent"), L("Your shadowing score: words, melody and rhythm compared with a native voice.", "Ta note de shadowing : mots, mélodie et rythme comparés à une voix native."),
      shadows.length ? lineChart(shadows.map((e) => ({ y: e.score, label: shortDate(e.ts), sub: e.title })), { title: L("Shadowing score", "Note de shadowing") }) : null,
      L("Do a shadowing session (Practice) to start this chart.", "Fais une séance de shadowing (Pratique) pour lancer ce graphique.")),
    parts.memory, h("section", { class: "card" }, h("h3", { style: "margin-bottom:12px" }, L("Skills by level", "Compétences par niveau")), parts.levels), parts.timeline);
}
