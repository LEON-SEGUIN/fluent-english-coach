"use strict";
// Fluent — core: small helpers, content, saved data, server calls, progress.

// =====================================================================
// DOM helpers
// =====================================================================
const $ = (s, el = document) => el.querySelector(s);

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "style") el.style.cssText = v;
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (k === "value") el.value = v;
      else if (k === "html") el.innerHTML = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

const ICONS = {
  home: '<path d="M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5h-5v5H5a1 1 0 0 1-1-1z"/>',
  phone: '<path d="M5 4h3.5l1.7 4.3-2.2 1.4a11 11 0 0 0 6.3 6.3l1.4-2.2L20 15.5V19a1.5 1.5 0 0 1-1.6 1.5A16 16 0 0 1 3.5 5.6 1.5 1.5 0 0 1 5 4z"/>',
  hangup: '<path d="M3.2 13.6c4.9-4.1 12.7-4.1 17.6 0 .6.5.7 1.4.2 2l-1.4 1.6c-.4.5-1.1.6-1.7.3l-2.6-1.3a1.2 1.2 0 0 1-.7-1.1v-1.6a12 12 0 0 0-5.2 0v1.6c0 .5-.3.9-.7 1.1l-2.6 1.3c-.6.3-1.3.2-1.7-.3L3 15.6c-.5-.6-.4-1.5.2-2z" fill="currentColor" stroke="none"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  micoff: '<path d="M15 10V6a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 4.6 2.5M5 11a7 7 0 0 0 11.4 5.4M19 11a7 7 0 0 1-.5 2.6M12 18v3M4 4l16 16"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2.5"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.6M12 17h.01"/>',
  chat: '<path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-7l-4.5 3.5V17H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"/>',
  news: '<path d="M4 5h12v14H6a2 2 0 0 1-2-2zM16 9h3a1 1 0 0 1 1 1v7a2 2 0 0 1-4 0"/><path d="M7 9h6M7 12.5h6M7 16h3.5"/>',
  masks: '<path d="M4 5c3 1.3 6 1.3 9 0v6a4.5 4.5 0 0 1-9 0z"/><path d="M13 9.5c2.4 1 4.6 1 7 0v5.5a4.5 4.5 0 0 1-7.6 3.2"/><path d="M6.5 9.5h.01M10.5 9.5h.01M7 12.5c.9.8 2.1.8 3 0M15.5 13h.01M18 13h.01M15.6 16.4c.7-.6 1.9-.6 2.6 0"/>',
  cap: '<path d="M2.5 9.5 12 5l9.5 4.5L12 14z"/><path d="M6.5 11.5v4.2c3.2 2.4 7.8 2.4 11 0v-4.2M21.5 9.5v5"/>',
  cards: '<rect x="3" y="7" width="13" height="14" rx="2"/><path d="M8 3h11a2 2 0 0 1 2 2v12"/>',
  path: '<circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M8.5 18H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  flame: '<path d="M12 3c.8 3.6 4.5 5.6 4.5 10.2A4.5 4.5 0 0 1 12 18a4.5 4.5 0 0 1-4.5-4.8c0-2.6 1.7-3.6 1.9-6.2 1 .9 1.8 2 1.9 3.6C12.3 8.6 12.4 5.8 12 3z" fill="currentColor"/>',
  speaker: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16.5 9a4 4 0 0 1 0 6M19 6.5a8 8 0 0 1 0 11"/>',
  turtle: '<path d="M4 15c0-4 3.5-7 8-7s8 3 8 7z"/><path d="M6 15l-1 3M18 15l1 3M20 13h2"/>',
  translate: '<path d="M4 5h8M8 3v2M6 5c0 4 2.5 7 6 8M10 5c-.5 3-3 6.5-6 8"/><path d="M13 21l4-9 4 9M14.5 18h5"/>',
  bulb: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.8 10.6c.6.6.8 1.3.8 2.4h6c0-1.1.2-1.8.8-2.4A6 6 0 0 0 12 3z"/>',
  repeat: '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/>',
  ask: '<path d="M4 5h16v11H9l-5 4z"/><path d="M9.5 9.2a2.5 2.5 0 0 1 4.8.8c0 1.5-2.3 1.7-2.3 2.8M12 14.5h.01"/>',
  hand: '<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11M11 10.5V4a1.5 1.5 0 0 1 3 0v6.5M14 10.5V5.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-.5a6 6 0 0 1-4.6-2.2L2.6 15.9a1.5 1.5 0 0 1 2.3-2l3.1 3"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  chevron: '<path d="M9 5l7 7-7 7"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  send: '<path d="M4 12l16-8-6 16-2.5-6.5z"/>',
  book: '<path d="M4 4h6a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4zM20 4h-5a2 2 0 0 0-2 2"/><path d="M13 20a2 2 0 0 1 2-2h5V4"/>',
  board: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20l4-4 4 4M7 8h6M7 11.5h9"/>',
  star: '<path d="M12 3.5l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.8l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 20a8 8 0 0 1 16 0"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  smartphone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  play: '<path d="M8 5v14l11-7z" fill="currentColor"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.7-4.3L4 8M4 4v4h4M4 13a8 8 0 0 0 14.7 4.3L20 16M20 20v-4h-4"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/>',
};
function icon(name, size = 20) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("width", size);
  s.setAttribute("height", size);
  s.setAttribute("fill", "none");
  s.setAttribute("stroke", "currentColor");
  s.setAttribute("stroke-width", "2");
  s.setAttribute("stroke-linecap", "round");
  s.setAttribute("stroke-linejoin", "round");
  s.setAttribute("aria-hidden", "true");
  s.innerHTML = ICONS[name] || "";
  return s;
}

function ring(frac, size = 56, stroke = 6, label = null, color = "var(--azafran)") {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const off = c * (1 - Math.max(0, Math.min(1, frac || 0)));
  const wrap = h("div", { class: "ring", style: `width:${size}px;height:${size}px` });
  wrap.innerHTML = `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" style="stroke:var(--surface-2)" stroke-width="${stroke}"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" style="stroke:${color}" stroke-width="${stroke}" stroke-linecap="round"
      stroke-dasharray="${c}" stroke-dashoffset="${off}" transform="rotate(-90 ${size / 2} ${size / 2})"/></svg>`;
  if (label != null) wrap.append(h("span", { class: "ring-label" }, label));
  return wrap;
}

let toastTimer = null;
function toast(text, ms = 2800) {
  const el = $("#toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// =====================================================================
// Small utilities
// =====================================================================
function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const today = () => dayKey(new Date());
function addDays(key, n) {
  const [y, m, d] = key.split("-").map(Number);
  return dayKey(new Date(y, m - 1, d + n));
}
function parseDay(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
// "1 jour", "2 jours" (French: 0 and 1 are singular; English: only 1).
const pl = (n, one, many) => `${n} ${(S.profile.lang === "English" ? n === 1 : n <= 1) ? one : many}`;
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const normText = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9ñ ]+/g, " ").replace(/\s+/g, " ").trim();
const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const IS_PHONE = () => window.matchMedia("(max-width: 900px)").matches;

// =====================================================================
// Content
// =====================================================================
const TUTORS = {
  emma: { id: "emma", name: "Emma", city: "London", flag: "🇬🇧", country: { fr: "Royaume-Uni", en: "UK" }, accent: "en-GB", blurb: { fr: "Accent britannique. Ex-développeuse, vive et curieuse, adore l'escalade et les jeux indé.", en: "British accent. Former developer, sharp and curious, loves climbing and indie games." } },
  jake: { id: "jake", name: "Jake", city: "San Francisco", flag: "🇺🇸", country: { fr: "États-Unis", en: "USA" }, accent: "en-US", blurb: { fr: "Accent américain. Ex-manager tech en start-up, drôle et détendu, adore le surf et les podcasts.", en: "American accent. Former start-up engineering manager, funny and relaxed, loves surfing and podcasts." } },
};

// Filled from /api/curriculum at start (same data as the server).
let CURRICULUM = { levels: [], skills: {}, states: ["new", "seen", "practicing", "good", "mastered"] };
const LEVEL_IDS = ["A1", "A2", "B1", "B2", "C1", "C2"];

const INTERESTS = [
  ["travel", "✈️", "Voyages", "Travel"], ["food", "🥘", "Cuisine", "Food"], ["football", "⚽", "Football", "Football"],
  ["sport", "🏃", "Sport", "Sport"], ["music", "🎸", "Musique", "Music"], ["cinema", "🎬", "Cinéma & séries", "Film & TV"],
  ["tech", "💻", "Tech & IA", "Tech & AI"], ["business", "💼", "Business", "Business"], ["news", "📰", "Actualité", "News"],
  ["automation", "⚙️", "Automatisation", "Automation"], ["startups", "🚀", "Start-ups", "Start-ups"], ["clients", "🤝", "Clients & vente", "Clients & sales"],
  ["books", "📚", "Livres", "Books"], ["art", "🎨", "Art & design", "Art & design"], ["science", "🔭", "Science", "Science"],
  ["games", "🎮", "Jeux vidéo", "Video games"], ["nature", "🌿", "Nature", "Nature"], ["fashion", "👟", "Mode", "Fashion"],
  ["history", "🏛️", "Histoire", "History"], ["family", "👨‍👩‍👧", "Famille", "Family"], ["party", "🎉", "Sorties", "Going out"],
];

const SCENES = [
  { id: "diner", level: "B1", title: "Order at an American diner", fr: "Commander dans un diner américain", en: "Order at an American diner", role: "a fast, friendly waitress at a diner in California who keeps the small talk going", tasks: ["Order with \"Can I get…\"", "Answer her questions about how you want it", "Make a little small talk", "Ask for the check and leave a tip"], tasksFr: ["Commander avec « Can I get… »", "Répondre à ses questions sur ta commande", "Faire un peu de small talk", "Demander l'addition et laisser un pourboire"] },
  { id: "rideshare", level: "B1", title: "Chat with your Uber driver", fr: "Discuter avec ton chauffeur Uber", en: "Chat with your Uber driver", role: "a chatty Uber driver in Los Angeles who loves giving local tips", tasks: ["Confirm your name and where you're going", "Say where you're from", "Ask for a local tip", "Ask to be dropped off at the corner"], tasksFr: ["Confirmer ton nom et ta destination", "Dire d'où tu viens", "Demander un bon plan local", "Demander à descendre au coin de la rue"] },
  { id: "store", level: "B1", title: "Return something at a store", fr: "Rapporter un article en magasin", en: "Return something at a store", role: "a store clerk who is polite but sticks to the rules", tasks: ["Say what's wrong with it", "Ask for a refund", "Stay polite when they say no", "Find a solution"], tasksFr: ["Dire ce qui ne va pas", "Demander un remboursement", "Rester poli quand on te dit non", "Trouver une solution"] },
  { id: "airport", level: "B1", title: "Cancelled flight at the airport", fr: "Vol annulé à l'aéroport", en: "Cancelled flight at the airport", role: "a tired airline agent at the gate after a flight was cancelled", tasks: ["Explain your situation", "Ask about the next flight", "Ask what they can do for you", "Thank them and confirm the plan"], tasksFr: ["Expliquer ta situation", "Demander le prochain vol", "Demander ce qu'ils peuvent faire pour toi", "Remercier et confirmer la solution"] },
  { id: "barbecue", level: "B2", title: "Meet people at a barbecue", fr: "Rencontrer des gens à un barbecue", en: "Meet people at a barbecue", role: "a friendly neighbor at a backyard barbecue in Texas who loves stories", tasks: ["Introduce yourself naturally", "Tell a short funny story", "Ask real follow-up questions", "Leave the conversation politely"], tasksFr: ["Te présenter naturellement", "Raconter une petite histoire drôle", "Poser de vraies questions de relance", "Quitter la conversation poliment"] },
  { id: "plans", level: "B2", title: "Make weekend plans with a friend", fr: "Organiser le week-end avec un ami", en: "Make weekend plans with a friend", role: "an American friend who keeps changing the plan", tasks: ["Suggest something to do", "Say no without being rude", "Use \"I'm down\" or \"rain check\"", "Agree on a time and place"], tasksFr: ["Proposer une activité", "Dire non sans être impoli", "Utiliser « I'm down » ou « rain check »", "Fixer une heure et un lieu"] },
  { id: "doctor", level: "B2", title: "At urgent care", fr: "Chez le médecin aux États-Unis", en: "At urgent care", role: "a kind but busy nurse at an urgent care clinic", tasks: ["Describe how you feel", "Say how long it's been going on", "Ask about the medicine", "Ask what it will cost"], tasksFr: ["Décrire ce que tu ressens", "Dire depuis combien de temps", "Poser une question sur le médicament", "Demander combien ça coûte"] },
  { id: "shows", level: "B2", title: "Argue about a TV show", fr: "Débattre d'une série", en: "Argue about a TV show", role: "an American friend who loved the series finale that the learner hated", tasks: ["Give your opinion with feeling", "Disagree in a friendly way", "Tell what happened without getting lost", "Recommend something else"], tasksFr: ["Donner ton avis avec conviction", "Être en désaccord gentiment", "Raconter ce qui se passe sans te perdre", "Recommander autre chose"] },
  { id: "networking", level: "B2", title: "Networking event", fr: "Soirée de networking", en: "Networking event", role: "a marketing director at a business mixer in New York", tasks: ["Introduce yourself in 20 seconds", "Ask what they do and follow up", "Find something in common", "Leave politely and stay in touch"], tasksFr: ["Te présenter en 20 secondes", "Demander ce qu'elle fait et relancer", "Trouver un point commun", "Partir poliment et garder le contact"] },
  { id: "meeting", level: "B2", title: "Speak up in a meeting", fr: "Prendre la parole en réunion", en: "Speak up in a meeting", role: "a manager at a US company who talks a lot and rarely stops for others", tasks: ["Jump in politely", "Disagree without being rude", "Sum up what was decided", "Agree on next steps"], tasksFr: ["Couper la parole poliment", "Être en désaccord sans être impoli", "Résumer ce qui a été décidé", "Fixer la suite"] },
  { id: "bizcall", level: "B2", title: "A business call from start to finish", fr: "Un appel pro du début à la fin", en: "A business call from start to finish", role: "a possible partner at a US company on a video call", tasks: ["Start with a little small talk", "Say why you're calling", "Ask what they need", "Agree on a next step"], tasksFr: ["Commencer par un peu de small talk", "Dire pourquoi tu appelles", "Demander ce dont il a besoin", "Fixer une prochaine étape"] },
  { id: "idea", level: "C1", title: "Present an idea to your boss", fr: "Présenter une idée à ta direction", en: "Present an idea to your boss", role: "a busy American director with five minutes and many questions", tasks: ["Say the problem in one sentence", "Present your idea clearly", "Answer a hard question", "Ask for a decision"], tasksFr: ["Dire le problème en une phrase", "Présenter ton idée clairement", "Répondre à une question difficile", "Demander une décision"] },
  { id: "raise", level: "C1", title: "Negotiate a better deal", fr: "Négocier un meilleur accord", en: "Negotiate a better deal", role: "a manager who likes the learner but says the budget is tight", tasks: ["Say what you want clearly", "Give your reasons calmly", "Answer \"the budget is tight\"", "Trade something and close"], tasksFr: ["Dire clairement ce que tu veux", "Donner tes raisons calmement", "Répondre à « le budget est serré »", "Échanger une concession et conclure"] },
  { id: "standup", level: "B1", title: "Daily stand-up", fr: "Le stand-up du matin", en: "Daily stand-up", role: "the team lead running a fast daily stand-up on a video call, with a slightly impatient tone", tasks: ["Say what you did yesterday", "Say what you're doing today", "Mention a blocker", "Ask a teammate for help"], tasksFr: ["Dire ce que tu as fait hier", "Dire ce que tu fais aujourd'hui", "Signaler un blocage", "Demander de l'aide à un collègue"] },
  { id: "smalltalk", level: "B1", title: "Coffee chat with a new colleague", fr: "Pause café avec un nouveau collègue", en: "Coffee chat with a new colleague", role: "a friendly new colleague from the London office on their first week", tasks: ["Introduce yourself and your role", "Ask them two questions", "Tell a short story about your weekend", "Suggest grabbing lunch"], tasksFr: ["Te présenter et présenter ton rôle", "Lui poser deux questions", "Raconter ton week-end en quelques phrases", "Proposer de déjeuner ensemble"] },
  { id: "codereview", level: "B2", title: "Code review", fr: "Revue de code", en: "Code review", role: "a senior developer reviewing the learner's pull request, who has a few concerns", tasks: ["Explain what your PR does", "Defend one of your choices", "Accept a suggestion gracefully", "Agree on next steps"], tasksFr: ["Expliquer ce que fait ta PR", "Défendre un de tes choix", "Accepter une remarque avec élégance", "Se mettre d'accord sur la suite"] },
  { id: "explain", level: "B2", title: "Explain it to a non-tech client", fr: "Expliquer à un client non technique", en: "Explain it to a non-tech client", role: "a non-technical small-business owner who wants to understand what an automation or an AI agent will do for them", tasks: ["Explain what the tool does in simple words", "Use an analogy", "Answer a worried question", "Say what happens next"], tasksFr: ["Expliquer ce que fait l'outil simplement", "Utiliser une comparaison", "Répondre à une inquiétude", "Dire la suite des étapes"] },
  { id: "sprint", level: "B2", title: "Sprint planning", fr: "Planification de sprint", en: "Sprint planning", role: "a product manager who wants to squeeze too many features into the next sprint", tasks: ["Estimate a task out loud", "Push back on scope", "Suggest a priority order", "Agree on the sprint goal"], tasksFr: ["Estimer une tâche à voix haute", "Refuser poliment d'en faire trop", "Proposer un ordre de priorité", "Valider l'objectif du sprint"] },
  { id: "interview", level: "C1", title: "Technical job interview", fr: "Entretien technique", en: "Technical job interview", role: "a hiring manager at a US tech company interviewing the learner for a senior role", tasks: ["Pitch your background in one minute", "Describe a hard problem you solved (STAR)", "Think out loud on a design question", "Ask a smart question about the team"], tasksFr: ["Résumer ton parcours en une minute", "Raconter un problème difficile résolu (méthode STAR)", "Réfléchir à voix haute sur une question de conception", "Poser une question pertinente sur l'équipe"] },
  { id: "incident", level: "C1", title: "Production incident call", fr: "Appel d'incident en production", en: "Production incident call", role: "a stressed engineering manager on an urgent call because production is down and customers are complaining", tasks: ["Describe the impact clearly", "Give a status update", "Propose a mitigation", "Commit to a post-mortem"], tasksFr: ["Décrire clairement l'impact", "Faire un point de situation", "Proposer une solution temporaire", "T'engager sur un post-mortem"] },
  { id: "angryclient", level: "C1", title: "Unhappy client call", fr: "Client mécontent", en: "Unhappy client call", role: "an unhappy client whose project is late and who threatens to cancel the contract", tasks: ["Acknowledge the frustration", "Explain what went wrong without excuses", "Offer a concrete plan", "Rebuild trust before hanging up"], tasksFr: ["Reconnaître sa frustration", "Expliquer ce qui s'est passé sans te justifier", "Proposer un plan concret", "Regagner sa confiance avant de raccrocher"] },
  { id: "demo", level: "C1", title: "Product demo and Q&A", fr: "Démo produit et questions", en: "Product demo and Q&A", role: "a sharp prospect watching the learner's product demo and asking tough questions about price, security and integration", tasks: ["Open with the problem you solve", "Walk them through the demo", "Handle a tough question", "Close with a next step"], tasksFr: ["Commencer par le problème que tu résous", "Dérouler la démo", "Gérer une question piège", "Conclure avec une prochaine étape"] },
  { id: "architecture", level: "C1", title: "Architecture debate", fr: "Débat d'architecture", en: "Architecture debate", role: "a senior architect who disagrees with the learner's design and prefers a different approach", tasks: ["Present your design", "Explain a trade-off", "Counter an objection politely", "Find a compromise"], tasksFr: ["Présenter ta conception", "Expliquer un compromis technique", "Contrer une objection poliment", "Trouver un terrain d'entente"] },
  { id: "negotiate", level: "C2", title: "Negotiate a contract", fr: "Négocier un contrat", en: "Negotiate a contract", role: "a tough procurement manager at a large company negotiating the price and scope of a contract", tasks: ["Present your offer", "Push back on a price cut", "Trade something for something", "Close the deal"], tasksFr: ["Présenter ton offre", "Refuser une baisse de prix", "Échanger une concession contre une autre", "Conclure l'accord"] },
  { id: "pitch", level: "C2", title: "Pitch to an investor", fr: "Pitcher devant un investisseur", en: "Pitch to an investor", role: "a sceptical venture capitalist in San Francisco with ten minutes to spare", tasks: ["Hook them in 30 seconds", "Explain the business model", "Answer a hard question with confidence", "Ask for the next meeting"], tasksFr: ["Accrocher en 30 secondes", "Expliquer le modèle économique", "Répondre avec aplomb à une question difficile", "Obtenir un prochain rendez-vous"] },
];

const STARTER = [
  ["I'm down", "I'd like to do that", "je suis partant"],
  ["to hang out", "to spend time with friends", "traîner, passer du temps ensemble"],
  ["to take a rain check", "to say no now but maybe later", "remettre à plus tard"],
  ["no way", "I can't believe it", "pas possible"],
  ["to figure something out", "to find the answer", "trouver la solution"],
  ["to run into someone", "to meet someone by chance", "tomber sur quelqu'un"],
  ["to play it by ear", "to decide as you go", "voir comment ça se passe, improviser"],
  ["to be on the same page", "to agree, understand the same thing", "être sur la même longueur d'onde"],
  ["to touch base", "to briefly get in contact", "faire un point rapide"],
  ["to push back on something", "to resist or disagree politely", "refuser, s'opposer poliment"],
];

// =====================================================================
// Saved data (the local server keeps it in ./data)
// =====================================================================
const DEFAULTS = {
  profile: {
    name: "", lang: "French", level: "B2", support: "auto", minutes: 15, tutor: "emma", interests: [],
    voices: {}, rate: "auto", tier: "balanced", handsFree: true, patience: "auto", autoTr: "auto", theme: "light",
    onboarded: false, xp: 0, streak: 0, best: 0, lastDay: null, days: {}, mins: {},
  },
  vocab: { words: [] },
  journal: { entries: [] },
  memory: {},
  progress: { skills: {}, lessons: {} },
  course: { schedule: { days: [1, 3, 5], time: "19:00" }, lessons: {} },
  homework: { sets: [] },
};
let S = structuredClone(DEFAULTS);
const L = (en, fr) => (S.profile.lang === "English" ? en : fr);
const LT = (o) => (o ? (S.profile.lang === "English" ? o.en : o.fr) ?? o.en ?? "" : "");

const UI = {
  tab: "home", hasKey: null, stt: false, eleven: false, offline: false, local: true, needLogin: false, status: null,
  call: null, feedback: null, drill: null, review: null, news: null, newsLoading: false, lesson: null, lessonLevel: null,
  wordFilter: "", openLevel: null, settingsReset: false, wordCache: new Map(), onb: null,
};

// What the Mac has for each data file (the version last loaded or saved). With it, changes made in two
// places at once (Mac and phone, or the Mac finishing a class) are merged instead of overwritten.
const BASE = {};
const saveTimers = {};
const saveChains = {};
const sameJSON = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isPlain = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const COUNTERS = /^profile\.(xp|days\.[\d-]+|mins\.[\d-]+)$/; // both sides added: add both
const NEWEST = /^profile\.(streak|best|lastDay)$/; // both sides changed: keep the highest
function merge3(base, mine, theirs, path) {
  if (sameJSON(mine, base)) return theirs;
  if (sameJSON(theirs, base)) return mine;
  if (COUNTERS.test(path) && (typeof mine === "number" || typeof theirs === "number")) return Math.round(((Number(mine) || 0) + (Number(theirs) || 0) - (Number(base) || 0)) * 10) / 10;
  if (NEWEST.test(path)) return (mine ?? "") > (theirs ?? "") ? mine : theirs;
  if (Array.isArray(mine) && Array.isArray(theirs)) return mergeList(Array.isArray(base) ? base : [], mine, theirs, path);
  if (isPlain(mine) && isPlain(theirs)) {
    const b = isPlain(base) ? base : {};
    const out = {};
    for (const k of new Set([...Object.keys(theirs), ...Object.keys(mine)])) {
      const v = merge3(b[k], mine[k], theirs[k], `${path}.${k}`);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  return mine;
}
// Lists (words, diary entries, notes): keep what each side added, drop what this side removed.
function mergeList(base, mine, theirs, path) {
  const key = (x) => (isPlain(x) && x.id != null ? "id:" + x.id : "v:" + JSON.stringify(x));
  const b = new Map(base.map((x) => [key(x), x]));
  const m = new Map(mine.map((x) => [key(x), x]));
  const out = [];
  const seen = new Set();
  for (const t of theirs) {
    const k = key(t);
    if (b.has(k) && !m.has(k)) continue;
    seen.add(k);
    out.push(m.has(k) ? merge3(b.get(k), m.get(k), t, path + "[]") : t);
  }
  for (const x of mine) { const k = key(x); if (!b.has(k) && !seen.has(k)) out.push(x); }
  return out;
}
// Replaces a data file's content in place, so screens holding S.profile (Settings…) stay up to date.
function replaceDoc(name, value) {
  const target = S[name];
  for (const k of Object.keys(target)) delete target[k];
  Object.assign(target, value);
}
// Saves one data file on the Mac, one request at a time per file.
// closing = the page is closing: one small request the browser still sends (about 64 KB at most).
function putDoc(name, closing = false) {
  if (closing) {
    const body = JSON.stringify(S[name]);
    return fetch(`/api/state/${name}`, { method: "PUT", headers: { "content-type": "application/json" }, body, keepalive: new Blob([body]).size < 20000 });
  }
  const run = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const body = JSON.stringify(S[name]);
      const res = await fetch(`/api/state/${name}`, { method: "PUT", headers: { "content-type": "application/json" }, body });
      if (res.ok) {
        const { rev } = await res.json().catch(() => ({}));
        BASE[name] = JSON.parse(body);
        if (rev) { BASE[name]._rev = rev; S[name]._rev = rev; }
        return res;
      }
      if (res.status !== 409) return res;
      // The Mac has a newer version: merge both, then save again.
      const { doc } = await res.json().catch(() => ({}));
      const theirs = isPlain(doc) ? doc : {};
      replaceDoc(name, merge3(BASE[name], S[name], theirs, name));
      if (name === "journal" && Array.isArray(S.journal.entries)) S.journal.entries.sort((a, b) => (b.ts || 0) - (a.ts || 0));
      S[name]._rev = theirs._rev;
      BASE[name] = structuredClone(theirs);
      if (!UI.call) { render(); renderPill(); }
    }
    return { ok: false };
  };
  const p = (saveChains[name] || Promise.resolve()).then(run, run);
  saveChains[name] = p.catch(() => {});
  return p;
}
function save(name) {
  clearTimeout(saveTimers[name]);
  saveTimers[name] = setTimeout(async () => {
    delete saveTimers[name];
    try {
      const res = await putDoc(name);
      if (!res.ok) throw new Error();
    } catch {
      toast(L("Could not save. Is Fluent still running on the Mac?", "Impossible d'enregistrer. Fluent tourne toujours sur le Mac ?"));
    }
  }, 350);
}
// Sends the waiting saves now: before the page closes, or before the app reloads its data from the Mac.
function flushSaves(closing = false) {
  return Promise.all(Object.keys(saveTimers).map((name) => {
    clearTimeout(saveTimers[name]);
    delete saveTimers[name];
    return putDoc(name, closing).catch(() => {});
  }));
}

async function api(path, body, opts = {}) {
  let res;
  try {
    res = await fetch(path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: opts.signal });
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    throw { code: "server_down", message: L("Fluent is not running. Double-click start.command on the Mac.", "Fluent ne tourne pas. Double-clique sur start.command sur le Mac.") };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = data.error || { code: "error", message: L("Something went wrong. Try again.", "Un problème est survenu. Réessaie.") };
    if (err.code === "no_key" || err.code === "bad_key") UI.hasKey = false;
    if (err.code === "need_login") { UI.needLogin = true; render(); }
    throw err;
  }
  return data;
}

// Error messages from the server are in English; give the main ones in French too.
function errText(e) {
  const fr = {
    no_key: "Ajoute ta clé API Anthropic dans les Réglages.",
    bad_key: "Ta clé API ne marche pas. Vérifie-la dans les Réglages.",
    no_credit: "Ton compte Anthropic n'a plus de crédit. Ajoute du crédit sur console.anthropic.com.",
    rate_limited: "Trop de demandes. Attends une minute et réessaie.",
    offline: "Pas de connexion à Claude. Vérifie ton internet.",
    server_down: "Fluent ne tourne pas. Double-clique sur start.command sur le Mac.",
    refused: "Le prof n'a pas pu répondre. Dis-le autrement.",
    api_error: "Erreur de Claude. Réessaie.",
    too_long: "La réponse a été coupée. Réessaie.",
    bad_json: "Réponse illisible. Réessaie.",
    no_access: "Ta clé ne peut pas utiliser ce modèle. Choisis un autre « Cerveau » dans les Réglages.",
    bad_pin: "Le code doit avoir de 6 à 10 chiffres.",
    no_pin: "Choisis d'abord un code (Réglages › Téléphone).",
    tunnel_failed: "Le lien téléphone n'a pas pu s'ouvrir. Vérifie ton internet et réessaie.",
    server_error: "Erreur sur le Mac. Regarde la fenêtre du Terminal.",
    bad_request: "Claude a refusé la demande. Réessaie.",
    local_only: "À faire sur le Mac.",
    locked: "Trop d'essais. Attends 10 minutes.",
  };
  if (S.profile.lang !== "English" && e && fr[e.code]) return fr[e.code];
  return e?.message || L("Something went wrong.", "Un problème est survenu.");
}

// =====================================================================
// Progress: XP, minutes, streak, words
// =====================================================================
function addXP(n) {
  const p = S.profile, t = today();
  if (p.lastDay !== t) {
    p.streak = p.lastDay === addDays(t, -1) ? (p.streak || 0) + 1 : 1;
    p.lastDay = t;
    p.best = Math.max(p.best || 0, p.streak);
  }
  p.xp = (p.xp || 0) + n;
  p.days[t] = (p.days[t] || 0) + n;
  const cutoff = addDays(t, -400);
  for (const k of Object.keys(p.days)) if (k < cutoff) delete p.days[k];
  save("profile");
  renderPill();
}
function addMinutes(min) {
  const p = S.profile, t = today();
  p.mins = p.mins || {};
  const before = p.mins[t] || 0;
  p.mins[t] = Math.round((before + min) * 10) / 10;
  save("profile");
  const goal = Number(p.minutes) || 15;
  if (before < goal && p.mins[t] >= goal) toast(L(`Daily goal reached. Well done! ${liveStreak()}-day streak`, `Objectif du jour atteint. Well done! Série : ${pl(liveStreak(), "jour", "jours")}`), 4000);
}
function liveStreak() {
  const p = S.profile, t = today();
  return p.lastDay === t || p.lastDay === addDays(t, -1) ? p.streak || 0 : 0;
}
function minutesToday() { return (S.profile.mins || {})[today()] || 0; }

function dueWords() {
  const t = today();
  return S.vocab.words.filter((w) => (w.due || "") <= t);
}
const wordKey = (es) => normToken(String(es).replace(/\s+/g, ""));
function wordSaved(es) { const k = wordKey(es); return S.vocab.words.some((w) => wordKey(w.es) === k); }
function addWord(es, tr, extra = {}) {
  es = String(es || "").trim();
  if (!es || wordSaved(es)) return false;
  S.vocab.words.push({ id: uid(), es, tr: String(tr || "").trim(), box: 0, due: today(), added: Date.now(), ...extra });
  if (S.vocab.words.length > 3000) S.vocab.words.splice(0, S.vocab.words.length - 3000);
  save("vocab");
  return true;
}
function logEntry(entry) {
  S.journal.entries.unshift(entry);
  if (S.journal.entries.length > 400) S.journal.entries.length = 400;
  save("journal");
}

// =====================================================================
// Speech scoring: compare what you said with the target, word by word
// =====================================================================
const NUMBERS = { 0: "zero", 1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten", 11: "eleven", 12: "twelve", 15: "fifteen", 20: "twenty", 30: "thirty", 100: "hundred" };
function normToken(raw) {
  let t = String(raw).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
  if (/^\d+$/.test(t) && NUMBERS[Number(t)]) t = NUMBERS[Number(t)];
  return t;
}
function lev(a, b) {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}
function scoreSpeech(target, said) {
  const T = String(target).split(/\s+/).map((raw) => ({ raw, n: normToken(raw) })).filter((x) => x.n);
  const W = String(said).split(/\s+/).map(normToken).filter(Boolean);
  const n = T.length, m = W.length;
  const eq = (a, b) => (a === b ? 2 : a.length > 3 && lev(a, b) <= 1 ? 1 : 0);
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const e = eq(T[i].n, W[j]);
      dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1], e ? dp[i + 1][j + 1] + e : 0);
    }
  }
  const marks = T.map((t) => ({ w: t.raw, s: "miss" }));
  let i = 0, j = 0;
  while (i < n && j < m) {
    const e = eq(T[i].n, W[j]);
    if (e && dp[i][j] === dp[i + 1][j + 1] + e) { marks[i].s = e === 2 ? "hit" : "near"; i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  const pts = marks.reduce((a, mk) => a + (mk.s === "hit" ? 1 : mk.s === "near" ? 0.6 : 0), 0);
  return { marks, score: n ? Math.round((pts / n) * 100) : 0 };
}
function marksEl(marks) {
  return h("div", { class: "marks" }, marks.map((mk) => h("span", { class: `w ${mk.s}` }, mk.w)));
}
const scoreClass = (s) => (s >= 80 ? "ok" : s >= 60 ? "mid" : "low");

// =====================================================================
// Tutor faces
// =====================================================================
const tutorNow = () => TUTORS[S.profile.tutor] || TUTORS.emma;

// A still face (close-up) for lists and cards.
function portrait(id, size = "", live = false) {
  const st = id === "jake" ? new JakeStill() : new TutorStage(id, { viewBox: TutorStage.FACE_VIEWBOX || "110 92 180 180", still: true });
  if (typeof st.frame === "function") { try { st.frame(performance.now(), { mode: "idle", level: 0 }); } catch { /* still pose */ } }
  return h("div", { class: `portrait ${size} ${id}` }, st.art, live ? h("span", { class: "live-dot" }) : null);
}

// Living faces on the home screen: they blink and breathe while visible.
// A first name typed in capitals reads like shouting: ALEX -> Alex.
const niceName = (n) => (/[a-zà-ÿ]/.test(n) || !n ? n : n[0] + n.slice(1).toLowerCase());
const liveFaces = new Set();
function liveFace(id) {
  const st = id === "jake" ? new JakeStill() : new TutorStage(id, { viewBox: TutorStage.FACE_VIEWBOX || "110 92 180 180" });
  liveFaces.add(st);
  return st;
}

// Level and skills helpers (from the curriculum)
const levelInfo = (id) => CURRICULUM.levels.find((l) => l.id === id) || { id, fr: id, en: id, es: id, can: { fr: "", en: "" } };
const skillState = (id) => (S.progress.skills || {})[id]?.state || "new";
const STATE_DOTS = { new: 0, seen: 1, practicing: 2, good: 3, mastered: 4 };
function levelPct(level) {
  const list = CURRICULUM.skills[level] || [];
  if (!list.length) return 0;
  return list.filter((s) => ["good", "mastered"].includes(skillState(s.id))).length / list.length;
}
function nextSkill(level = S.profile.level) {
  const list = CURRICULUM.skills[level] || [];
  const rank = (s) => ({ practicing: 0, seen: 1, new: 2 })[skillState(s.id)] ?? 9;
  return [...list].map((s, i) => ({ s, i, r: rank(s) })).filter((x) => x.r < 9).sort((a, b) => a.r - b.r || a.i - b.i)[0]?.s || null;
}
