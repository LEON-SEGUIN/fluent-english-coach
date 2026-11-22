"use strict";
// Jake in 3D on the video call (asked on 2026-11-04: no moustache, no glasses, realistic, moving hands and brows,
// some movement in the room, "not too much"). Same methods as TutorStage (art, frame, setEmotion, nod), so call.js barely
// changes. Model and motion capture: Microsoft Rocketbox (MIT), see jake3d/CREDITS.md. Library: three.js, in vendor/.
//  - body: real motion capture clips, always mixed with a quiet idle clip, so gestures stay moderate. The important words
//    get a small beat of the hand and the head, so the gestures go with what he says;
//  - mouth: the letters being spoken, at the time the voice says them, become English mouth shapes (th, sh, r, silent e…);
//  - face: emotions, brows, blinks and the gaze are morphs and bones moved by the code, on top of the clips;
//  - listening: he leans in when you speak, nods at the end of your phrases, and waits with raised brows after a question;
//  - accent: when he talks about the tongue, the teeth or the lips, the camera comes close to his mouth;
//  - room: he shifts his weight and walks a step or two now and then. The room behind him and the light on him come from one
//    real 360° photo, through the same lens as his camera, so sizes, horizon and light agree (img/CREDITS.md, tools/jake3d/room).
// If WebGL or the files fail, the drawn TutorStage takes over and the call goes on.
(() => {
  const LIB = "./vendor/three-jake.min.js";
  const MODEL = "jake3d/jake.glb";
  const POSTER = "jake3d/portrait.webp";
  const WORDS = "jake3d/words.txt"; // how English words sound (tools/jake3d/make-words.mjs)
  const LIGHT = "jake3d/room-light.bin"; // the same room as img/jake-room.jpg: 256 x 128, RGBA, half floats
  const LIGHT_W = 256, LIGHT_H = 128;
  // img/jake-room.jpg, as tools/jake3d/room/plate.py makes it: how much it shows in units of the lens, its shape,
  // and how far the back of the room is behind him, in cm (for the size of things when the camera moves).
  const ROOM = { tanV: 0.24, aspect: 2.5, behind: 250, aimY: 143 }; // aimY: where the camera that took the picture was aiming on him
  const CAM_DIST = 242; // cm from him. A closer shot is a longer lens, not a closer camera: no big nose, and the room keeps its true size.

  // Critically damped spring: the same motion at any frame rate.
  class Spring {
    constructor(x = 0, k = 12) { this.x = x; this.v = 0; this.k = k; }
    to(target, dt) {
      const w = this.k, f = 1 + 2 * dt * w, hoo = dt * w * w, det = 1 / (f + dt * hoo);
      const x = (f * this.x + dt * this.v + dt * hoo * target) * det;
      this.v = (this.v + hoo * (target - this.x)) * det;
      this.x = x;
      return x;
    }
  }
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  // A slow movement that never repeats: three speeds that have nothing to do with each other. One sine looks like a machine.
  const drift = (t, seed) => (Math.sin(t * 0.71 + seed * 1.7) + Math.sin(t * 1.33 + seed * 4.1) * 0.6 + Math.sin(t * 0.29 + seed * 7.3) * 0.9) / 2.5;
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const lerp = (a, b, f) => a + (b - a) * f;

  // Clips by situation. The long ones are played in pieces, from a random point, so they never look the same.
  const CLIPS = {
    base: ["idle_neutral_01", "idle_neutral_02", "idle_neutral_03", "idle_neutral_04"],
    talk: ["gestic_talk_neutral_01", "gestic_talk_neutral_02", "gestic_talk_neutral_03", "gestic_talk_relaxed_01", "gestic_talk_relaxed_02", "moderate_01", "moderate_02"],
    talkSide: ["gestic_talk_left_01", "gestic_talk_right_01"],
    talkHappy: ["gestic_talk_excited_01", "gestic_talk_cool", "gestic_talk_relaxed_02"],
    listen: ["gestic_listen_neutral_01", "gestic_listen_neutral_02", "gestic_listen_neutral_03", "gestic_listen_relaxed_01", "idle_neutral_01", "idle_neutral_03"],
    think: ["gestic_thoughtful_01"],
    thinkHand: ["idle_scratch_head_01"], // alone on top of the idle: mixed in, the hand would stop in mid-air
    nod: ["gestic_listen_accept_01", "gestic_listen_accept_02", "gestic_listen_accept_03"],
    no: ["gestic_listen_deny_01", "gestic_listen_deny_02"],
    laugh: ["gestic_laugh_low"],
    hello: ["wave_01"],
    clap: ["claphands_01"],
    shrug: ["gestic_shrug_01", "gestic_shrug_02"],
    walk: "walk_slow_01",
  };
  const BASE_WEIGHT = 0.4; // how much of the quiet idle stays under a gesture: higher = calmer hands
  const JAW_TURN = 0.198; // radians at jawOpen = 1: the lower lip goes down 1.72 cm, 8.7 cm from the hinge
  const ARM_IN = 0.17; // the mocap actor held his arms away from the body: bring them in a little (radians)

  // What the words of a sentence ask the body to do.
  const SAY = {
    mouth: /\b(tongue|teeth|lips|my mouth)\b/i,
    bye: /\b(bye|goodbye|good night|see you|talk soon|take care)\b/i,
    bravo: /\b(well done|nailed it|bravo|great job|awesome job)\b/i,
    no: /^(no|nope|nah|not quite|almost|careful)\b/i,
    unsure: /\b(i guess|who knows|not sure|i don't know|i mean)\b/i,
  };
  const SMALL_WORDS = new Set("that this with have from they them then than were been will would could should what when where which there their about into your just like very some more much really because".split(" "));

  // What the face does for each emotion. Names are the model's morphs (L/R pairs in one word: smile = smileL + smileR).
  const FACE = {
    // This model's smile is small: 1 only curves the lips. Values above 1 were checked picture by picture, from the front (2026-11-05).
    // A real smile also needs the cheeks and the eyes; the upper lip lifts over the teeth on the biggest ones.
    neutral: { smile: 0.85, cheek: 0.42, squint: 0.1, dimple: 0.12 }, // his resting face is friendly
    happy: { smile: 1.9, cheek: 1.2, squint: 0.4, dimple: 0.4, jawOpen: 0.06, upperUp: 0.34, lowerDown: 0.3, browInnerUp: 0.16, browOuter: 0.2 },
    curious: { smile: 0.7, cheek: 0.25, browInnerUp: 0.45, browOuterL: 0.95, squintR: 0.25, browDownR: 0.15 },
    encouraging: { smile: 1.4, cheek: 0.85, squint: 0.28, dimple: 0.3, jawOpen: 0.05, browInnerUp: 0.35, browOuter: 0.15 },
    surprised: { browInnerUp: 1, browOuter: 1, wide: 0.8, jawOpen: 0.2, lowerDown: 0.25, smile: 0.35 },
    empathetic: { browInnerUp: 1, smile: 0.25, frown: 0.25, squint: 0.16, press: 0.12 },
    laugh: { smile: 1.95, cheek: 1.3, squint: 0.55, dimple: 0.35, jawOpen: 0.3, upperUp: 0.42, lowerDown: 0.5, browOuter: 0.3 },
    thinking: { browDownL: 0.6, browOuterR: 0.8, squint: 0.2, press: 0.28, mouthL: 0.3, smile: 0.2 },
  };
  // What the words of one sentence do to his face, on top of the feeling of the whole reply. The first match wins.
  const MOODS = [
    ["laugh", /\b(ha ?ha+|lol|hilarious|so funny|too funny|that's funny|cracks? me up)\b/i],
    ["surprised", /\b(wow|whoa|no way|you're kidding|unbelievable|incredible|oh really|seriously\?|wait, what)/i],
    ["empathetic", /\b(i'm sorry|sorry to hear|oh no|that's (tough|rough|hard)|that sucks|must be hard|i get it|i understand)\b/i],
    ["thinking", /\b(hmm+|let me think|i wonder|good question|i guess|not sure)\b/i],
    ["happy", /\b(hey|hi|hello|great|awesome|amazing|nice|cool|love|perfect|fantastic|excellent|exactly|yes|yeah|fun|glad|happy|congrats|congratulations|well done|nailed|bravo|good (job|one|to see)|welcome|see you|bye)\b/i],
    ["encouraging", /\b(try|again|almost|close|you can|go ahead|keep going|your turn|ready|let's|no problem|no worries|don't worry|you got)\b/i],
    ["curious", /\?\s*$/],
  ];
  const STRONG_FEELING = new Set(["laugh", "empathetic", "surprised", "thinking"]); // a sentence's words do not overrule these
  const CONTRAST = /^(but|not|never|actually|however|don't|can't|wrong|careful)$/;
  const HEAD_TILT = { happy: 0.03, curious: 0.08, encouraging: -0.04, empathetic: -0.09, laugh: 0.05, thinking: 0.05 };
  const PAIRS = { smile: 1, cheek: 1, squint: 1, dimple: 1, browOuter: 1, wide: 1, frown: 1, press: 1, browDown: 1, sneer: 1, upperUp: 1, lowerDown: 1, stretch: 1 };

  // ---------- English spelling -> mouth shapes ----------
  const M = {
    PP: ["v_PP", 1], FF: ["v_FF", 1], TH: ["v_TH", 1], DD: ["v_DD", 0.8], LL: ["v_DD", 0.7], NN: ["v_nn", 0.8], KK: ["v_KK", 0.75], CH: ["v_CH", 0.9], SS: ["v_SS", 0.85], RR: ["v_RR", 0.95],
    AA: ["v_aa", 0.6], UH: ["v_aa", 0.36], HH: ["v_aa", 0.2], EH: ["v_E", 0.85], EE: ["v_I", 0.85], OH: ["v_O", 0.85], OO: ["v_U", 0.95],
  };
  const isVowel = (c) => Boolean(c) && "aeiouy".includes(c);
  // One word -> one shape per letter; a silent letter keeps the shape before it. Spelling rules, not a dictionary: a few
  // words come out a little wrong, and the voice's loudness hides most of that.
  function wordMouth(word) {
    const w = word.toLowerCase();
    const n = w.length;
    const out = new Array(n).fill(null);
    const end = (i) => i >= n || !/[a-z]/.test(w[i]);
    const closedE = (i) => !isVowel(w[i + 1]) && w[i + 2] === "e" && end(i + 3) && !end(i + 1); // make, time, home, use
    for (let i = 0; i < n;) {
      const c = w[i], a = w[i + 1] || "", b = w[i + 2] || "", two = c + a, three = two + b;
      const put = (...shapes) => { shapes.forEach((s, k) => { out[i + k] = s; }); i += shapes.length; };
      if (!/[a-z]/.test(c)) { i++; continue; }
      if (three === "tch") { put(M.CH, M.CH, M.CH); continue; }
      if (three === "igh") { put(M.AA, M.EE, M.EE); continue; }
      if ((three === "tio" || three === "sio") && w[i + 3] === "n") { put(M.CH, M.CH, M.UH); continue; }
      if (w.startsWith("ough", i)) { put(M.OH, M.OH, M.OH, M.OH); continue; }
      if (two === "th") { put(M.TH, M.TH); continue; }
      if (two === "sh" || two === "ch") { put(M.CH, M.CH); continue; }
      if (two === "ph") { put(M.FF, M.FF); continue; }
      if (two === "wh") { put(M.OO, M.OO); continue; }
      if (two === "ck" || two === "ng") { put(M.KK, M.KK); continue; }
      if (two === "qu") { put(M.KK, M.OO); continue; }
      if (i === 0 && (two === "kn" || two === "gn")) { put(null, M.NN); continue; }
      if (i === 0 && two === "wr") { put(M.RR, M.RR); continue; }
      if (two === "mb" && end(i + 2)) { put(M.PP, M.PP); continue; }
      if (two === "ee" || two === "ea" || two === "ie" || two === "ei") { put(M.EE, M.EE); continue; }
      if (two === "oo" || two === "ew" || two === "ue" || two === "ui") { put(M.OO, M.OO); continue; }
      if (two === "oa" || two === "oe" || two === "ow") { put(M.OH, M.OO); continue; }
      if (two === "ou") { if (/^(you|your|yours|through|group|soup)$/.test(w)) put(M.OO, M.OO); else put(M.AA, M.OO); continue; }
      if (two === "ai" || two === "ay" || two === "ey") { put(M.EH, M.EH); continue; }
      if (two === "au" || two === "aw") { put(M.OH, M.OH); continue; }
      if (two === "oi" || two === "oy") { put(M.OH, M.EE); continue; }
      if (two === "er" || two === "ir" || two === "ur") { put(M.RR, M.RR); continue; } // American: the vowel and the r are one sound
      if (two === "ar") { put(M.AA, M.RR); continue; }
      if (two === "or") { put(M.OH, M.RR); continue; }
      if (c === "a") { put(n === 1 ? M.UH : closedE(i) ? M.EH : M.AA); continue; }
      if (c === "e") {
        if (end(i + 1) && i > 1 && !isVowel(w[i - 1]) && n > 3) { i++; continue; } // silent final e
        if (end(i + 1) && /^(be|he|me|she|we)$/.test(w)) { put(M.EE); continue; }
        put(end(i + 1) ? M.UH : M.EH);
        continue;
      }
      if (c === "i") { put(M.EE); continue; }
      if (c === "o") { put(/^(to|do|who|two|into)$/.test(w) ? M.OO : closedE(i) || end(i + 1) ? M.OH : M.AA); continue; }
      if (c === "u") { put(closedE(i) ? M.OO : M.UH); continue; }
      if (c === "y") { put(M.EE); continue; }
      if ("bmp".includes(c)) { put(M.PP); continue; }
      if ("fv".includes(c)) { put(M.FF); continue; }
      if ("dt".includes(c)) { put(M.DD); continue; }
      if (c === "l") { put(M.LL); continue; }
      if (c === "n") { put(M.NN); continue; }
      if ("szx".includes(c)) { put(M.SS); continue; }
      if (c === "c") { put("eiy".includes(a) && a ? M.SS : M.KK); continue; }
      if (c === "g") { put(a === "e" && end(i + 2) ? M.CH : M.KK); continue; }
      if (c === "j") { put(M.CH); continue; }
      if ("kq".includes(c)) { put(M.KK); continue; }
      if (c === "r") { put(M.RR); continue; }
      if (c === "h") { put(M.HH); continue; }
      if (c === "w") { put(M.OO); continue; }
      i++;
    }
    for (let i = 1; i < n; i++) if (!out[i]) out[i] = out[i - 1];
    return out;
  }
  // A whole sentence: for each letter, its shape and the number of its word (-1 between words).
  function sentenceMouth(text) {
    const shape = new Array(text.length).fill(null), word = new Array(text.length).fill(-1), words = [];
    for (const m of text.matchAll(/[A-Za-z][A-Za-z'’]*/g)) {
      const shapes = wordMouth(m[0]);
      for (let k = 0; k < shapes.length; k++) { shape[m.index + k] = shapes[k]; word[m.index + k] = words.length; }
      words.push(m[0]);
    }
    return { text, shape, word, words };
  }

  // ---------- The sounds of English -> the mouth ----------
  // What the lips and the jaw do for each sound. The sculpted shapes are made for 1, but people talking open far less.
  const MIX = {
    rest: {},
    PP: { v_PP: 1 }, FF: { v_FF: 0.95 }, TH: { v_TH: 0.55 },
    DD: { v_DD: 0.34 }, NN: { v_nn: 0.42 }, LL: { v_nn: 0.38, v_aa: 0.06 }, KK: { v_KK: 0.7 },
    SS: { v_SS: 0.95 }, CH: { v_CH: 0.55 }, RR: { v_RR: 0.95 }, WW: { v_U: 1, pucker: 0.45 }, YY: { v_I: 0.6 }, HH: {},
    AA: { v_aa: 0.62 }, AE: { v_aa: 0.4, v_E: 0.35 }, AH: { v_aa: 0.44 }, AO: { v_O: 0.64, v_aa: 0.1, funnel: 0.2 }, EH: { v_E: 0.7, v_aa: 0.1 },
    ER: { v_RR: 0.9, v_aa: 0.06 }, IH: { v_I: 0.48, v_aa: 0.06 }, IY: { v_I: 0.6 }, UH: { v_U: 0.6, v_aa: 0.08 }, UW: { v_U: 1, pucker: 0.5, funnel: 0.2 }, OW: { v_O: 0.68, funnel: 0.25 },
  };
  // How much a sound rules the lips (a), and how fast that fades around it, per ms (th). Closed lips win everything. T, D, N, K are
  // made with the tongue: their lips come from the sounds beside them, which is most of what makes speech look natural.
  const RULE = {
    rest: [0.8, 0.02], PP: [9, 0.05], FF: [6, 0.04], TH: [3, 0.03], CH: [2, 0.022], SS: [1.6, 0.022], WW: [2.5, 0.018], RR: [1.2, 0.02], YY: [1, 0.02],
    DD: [0.55, 0.02], NN: [0.55, 0.02], LL: [0.55, 0.02], KK: [0.55, 0.02], HH: [0.1, 0.03],
    AA: [1.1, 0.016], AE: [1.1, 0.016], AH: [1, 0.016], EH: [1.1, 0.016], ER: [1.1, 0.016], IH: [1, 0.016], IY: [1.2, 0.016],
    AO: [1.6, 0.012], OW: [1.6, 0.012], UH: [1.4, 0.012], UW: [1.8, 0.012],
  };
  const LENGTH = { PP: 0.7, DD: 0.7, KK: 0.7, NN: 0.75, LL: 0.7, FF: 0.95, SS: 1, TH: 0.9, CH: 1, RR: 0.8, WW: 0.65, YY: 0.6, HH: 0.5 }; // vowels: below
  const VOWEL = new Set(["AA", "AE", "AH", "AO", "EH", "ER", "IH", "IY", "UH", "UW", "OW"]);
  const MIX_LIST = Object.fromEntries(Object.entries(MIX).map(([k, v]) => [k, Object.entries(v)]));
  // The letters of words.txt. Two sounds: a vowel that glides.
  const SOUND = {
    a: ["AA"], b: ["AE"], c: ["AH"], d: ["AO"], e: ["AA", "UH"], f: ["AA", "IY"], g: ["EH"], h: ["ER"], i: ["EH", "IY"], j: ["IH"], k: ["IY"], l: ["OW", "UH"], m: ["AO", "IY"], n: ["UH"], o: ["UW"],
    p: ["PP"], q: ["CH"], r: ["DD"], s: ["TH"], t: ["FF"], u: ["KK"], v: ["HH"], w: ["CH"], x: ["KK"], y: ["LL"], z: ["PP"], 1: ["NN"], 2: ["KK"], 3: ["PP"], 4: ["RR"], 5: ["SS"], 6: ["CH"], 7: ["DD"], 8: ["TH"], 9: ["FF"], 0: ["WW"], "-": ["YY"], "+": ["SS"], "=": ["CH"],
  };
  let dictionary = null; // word -> letters
  const shapeSound = new Map([[M.PP, "PP"], [M.FF, "FF"], [M.TH, "TH"], [M.DD, "DD"], [M.LL, "LL"], [M.NN, "NN"], [M.KK, "KK"], [M.CH, "CH"], [M.SS, "SS"], [M.RR, "RR"], [M.AA, "AA"], [M.UH, "AH"], [M.HH, "HH"], [M.EH, "EH"], [M.EE, "IY"], [M.OH, "OW"], [M.OO, "UW"]]);
  // A word -> its sounds: [{ s, stress }]. Unknown word: the spelling rules.
  function wordSounds(word) {
    const w = word.toLowerCase().replace(/’/g, "'");
    let code = dictionary?.get(w);
    if (code == null && dictionary && /'s$/.test(w) && dictionary.has(w.slice(0, -2))) code = `${dictionary.get(w.slice(0, -2))}5`;
    const out = [];
    if (code != null) {
      for (const c of code) {
        const stress = c !== c.toLowerCase();
        const list = SOUND[c.toLowerCase()];
        if (!list) continue;
        list.forEach((s, k) => out.push({ s, stress, glide: list.length > 1 ? (k ? 0.75 : 1.15) : 1 }));
      }
      return out;
    }
    let last = null, first = true;
    for (const shape of wordMouth(word)) {
      if (!shape || shape === last) continue;
      last = shape;
      const s = shapeSound.get(shape);
      if (!s) continue;
      const v = VOWEL.has(s);
      out.push({ s, stress: v && first, glide: 1 });
      if (v) first = false;
    }
    return out;
  }
  // A sentence + when each letter starts (ms) -> segments in time. The voice's own timings give the words; inside a word, typical lengths.
  function buildTimeline(text, chars) {
    const segs = [];
    const known = chars.length;
    const add = (s, start, end, gain = 1) => {
      const r = RULE[s] || RULE.rest;
      segs.push({ start, end, c: (start + end) / 2, hw: (end - start) / 2, a: r[0], th: r[1], mix: MIX_LIST[s] || [], gain, s });
    };
    let prevEnd = -1000, used = 0;
    const words = [...text.matchAll(/[A-Za-z][A-Za-z'’]*/g)];
    for (let n = 0; n < words.length; n++) {
      const m = words[n];
      if (m.index >= known) break;
      const len = m[0].length;
      const start = chars[m.index];
      let end = m.index + len < known ? chars[m.index + len] : start + len * 72;
      if (!(end > start)) continue;
      // The voice's timings give the end of a word to the space after it: "mother" gets 120 ms and its space 80 ms.
      // So a word goes on until the next one starts, or trails off a little before a true pause.
      const next = n + 1 < words.length && words[n + 1].index < known ? chars[words[n + 1].index] : null;
      if (next != null && next > end) end = next - end < 220 ? next : end + Math.min(110, (next - end) * 0.35);
      if (start - prevEnd > 70) add("rest", prevEnd, start);
      const list = wordSounds(m[0]);
      if (list.length) {
        const w = list.map((x) => (VOWEL.has(x.s) ? (x.stress ? 1.6 : 0.8) * x.glide : LENGTH[x.s] || 0.8));
        const total = w.reduce((a, b) => a + b, 0);
        let t = start;
        list.forEach((x, k) => {
          const d = ((end - start) * w[k]) / total;
          add(x.s, t, t + d, VOWEL.has(x.s) ? (x.stress ? 1.08 : 0.72) : 1);
          t += d;
        });
      }
      prevEnd = end;
      used = m.index + len;
    }
    add("rest", prevEnd, prevEnd + 60000); // after the last known word
    return { text, known, segs, used };
  }
  const MOUTH_KEYS = ["v_PP", "v_FF", "v_TH", "v_DD", "v_KK", "v_CH", "v_SS", "v_nn", "v_RR", "v_aa", "v_E", "v_I", "v_O", "v_U", "pucker", "funnel"];
  // The mouth at time t: each sound near t, by how much it rules.
  function mouthAt(tl, t, out) {
    for (const k of MOUTH_KEYS) out[k] = 0;
    let sum = 0;
    for (const s of tl.segs) {
      const over = Math.max(0, Math.abs(t - s.c) - s.hw);
      if (over > 300) continue;
      const d = (s.a * Math.exp(-s.th * over)) ** 2.2; // the sharper power keeps each sound's shape from being lost in its neighbours
      sum += d;
      for (const [n, v] of s.mix) out[n] += d * v * s.gain;
    }
    if (sum > 0) for (const k of MOUTH_KEYS) out[k] /= sum;
    return out;
  }

  // ---------- Real teeth (the model only has a dark drawing of teeth, in its mouth) ----------
  // In the model's own space: cm, x to his left, -y to the front, z up.
  const TEETH_UP = [[0.86, 1.02, 0.62], [0.66, 0.92, 0.55], [0.76, 1, 0.68], [0.68, 0.8, 0.75], [0.66, 0.75, 0.78]]; // width, height, thickness, from the middle
  const TEETH_DOWN = [[0.54, 0.88, 0.5], [0.58, 0.9, 0.52], [0.66, 0.95, 0.62], [0.66, 0.78, 0.7], [0.68, 0.74, 0.75]];
  function archPoint(front, bend, along) { // walks along the arch: x, y and the way it faces
    let x = 0;
    const step = 0.02;
    for (let l = 0; l < along; l += step) x += step / Math.hypot(1, 2 * bend * x);
    const slope = 2 * bend * x, n = Math.hypot(1, slope);
    return { x, y: front + bend * x * x, tx: 1 / n, ty: slope / n };
  }
  function makeArch(T, { list, front, bend, edge, down, gumColor }) {
    const pos = [], col = [], idx = [];
    const SEG = 16, RINGS = 8;
    const push = (x, y, z, r, g, b) => { pos.push(x, y, z); col.push(r, g, b); return pos.length / 3 - 1; };
    for (const side of [1, -1]) {
      let along = 0;
      list.forEach(([w, h, t], n) => {
        const at = archPoint(front, bend, along + w / 2);
        along += w;
        const gap = 1; // they touch: the shading draws the line
        const canine = n === 2;
        const first = pos.length / 3;
        const deep = 1 - 0.68 * Math.min(1, (along - w / 2) / 3.6); // little light comes this far in
        const tx = at.tx * side, ty = at.ty; // along the arch; out = toward the lips
        const ox = at.ty * side, oy = -at.tx;
        for (let r = 0; r <= RINGS; r++) {
          const v = r / RINGS; // 0: the biting edge, 1: the neck in the gum
          const round = Math.pow(Math.min(1, v / 0.12), 0.5); // the edge is rounded
          const width = (w / 2) * gap * (1 - 0.1 * v * v) * (0.9 + 0.1 * round) * (canine ? 0.76 + 0.24 * Math.min(1, v / 0.3) : 1);
          const thick = (t / 2) * (0.38 + 0.62 * Math.min(1, v * 1.5)) * (0.7 + 0.3 * round);
          const bulge = 0.035 * Math.sin(Math.PI * v);
          const z = edge + (down ? -1 : 1) * (v * h - (canine ? 0.06 : 0));
          const shade = 1 - 0.3 * v * v; // the lip shades the top of the tooth
          for (let s = 0; s < SEG; s++) {
            const a = (s / SEG) * Math.PI * 2;
            const ca = Math.cos(a), sa = Math.sin(a);
            const px = width * Math.sign(ca) * Math.pow(Math.abs(ca), 0.24); // nearly square: neighbours touch
            const pt = (thick + (sa > 0 ? bulge : 0)) * Math.sign(sa) * Math.pow(Math.abs(sa), 0.42);
            const between = 1 - 0.3 * Math.pow(Math.abs(ca), 14); // a thin dark line between two teeth
            const back = sa < 0 ? 0.55 : 1;
            const k = shade * deep * between * back;
            // Enamel: a little grey at the thin edge, warmer at the neck.
            const cr = 0.92 - 0.05 * (1 - round) - 0.07 * v, cg = 0.9 - 0.03 * (1 - round) - 0.12 * v, cb = 0.85 + 0.02 * (1 - round) - 0.18 * v;
            push(at.x * side + tx * px + ox * pt, at.y + ty * px + oy * pt, z, cr * k, cg * k, cb * k);
          }
        }
        for (let r = 0; r < RINGS; r++) for (let s = 0; s < SEG; s++) {
          const a = first + r * SEG + s, b = first + r * SEG + (s + 1) % SEG, c = a + SEG, d = b + SEG;
          idx.push(a, b, c, b, d, c);
        }
        // Close the biting edge.
        const centre = push(at.x * side, at.y, edge + (down ? 0.012 : -0.012), 0.8 * deep, 0.79 * deep, 0.75 * deep);
        for (let s = 0; s < SEG; s++) idx.push(centre, first + (s + 1) % SEG, first + s);
      });
    }
    // The gum: a band behind and above the necks, a little wavy.
    const total = list.reduce((a, x) => a + x[0], 0), N = 72;
    const gumFirst = pos.length / 3;
    const levels = [[0.84, -0.02], [0.92, 0.03], [1.05, 0.06], [1.5, 0.06], [2.1, 0.02]];
    for (let i = 0; i <= N; i++) {
      const l = (i / N) * 2 - 1, along = Math.abs(l) * total, side = l < 0 ? -1 : 1;
      const at = archPoint(front, bend, along);
      let run = 0, hgt = list[0][1], wave = 0;
      for (const x of list) { if (along <= run + x[0]) { hgt = x[1]; wave = Math.abs(Math.cos((Math.PI * (along - run)) / x[0])); break; } run += x[0]; }
      const deep = 1 - 0.7 * Math.min(1, along / 3.6);
      levels.forEach(([v, out], k) => {
        const z = edge + (down ? -1 : 1) * (hgt * v - (k === 0 ? 0.1 * wave : 0)); // between two teeth, the gum comes down a little
        const ox = at.ty * side, oy = -at.tx;
        const front = list[0][2] / 2; // the necks' front
        push(at.x * side + ox * (front + out), at.y + oy * (front + out), z, gumColor[0] * deep, gumColor[1] * deep, gumColor[2] * deep);
      });
    }
    for (let i = 0; i < N; i++) for (let k = 0; k < levels.length - 1; k++) {
      const a = gumFirst + i * levels.length + k, b = a + 1, c = a + levels.length, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const g = new T.BufferGeometry();
    g.setAttribute("position", new T.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute("color", new T.BufferAttribute(new Float32Array(col), 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  // The tongue: from its root to its tip, in the same space as the teeth. Its tip lifts and comes forward (see the material in buildTeeth).
  function makeTongue(T) {
    const RINGS = 14, SEG = 16, pos = [], col = [], wgt = [], idx = [];
    const y0 = -11.78, len = 5.2;
    for (let r = 0; r <= RINGS; r++) {
      const u = r / RINGS; // 0: the tip, 1: the root
      const half = 1.72 * Math.pow(Math.sin(Math.min(1, u * 2.6 + 0.04) * Math.PI / 2), 0.55) * (1 - 0.12 * u);
      const thick = 0.55 * Math.pow(Math.min(1, u * 3 + 0.08), 0.5);
      const top = 161.0 + 0.1 * Math.sin(u * Math.PI); // a slight dome, just under the biting edge of the lower teeth
      for (let s = 0; s < SEG; s++) {
        const a = (s / SEG) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
        const groove = sa > 0 ? 0.05 * Math.exp(-((ca * 3) ** 2)) : 0; // the line down its middle
        pos.push(half * Math.sign(ca) * Math.pow(Math.abs(ca), 0.8), y0 + u * len, top - thick + thick * sa - groove);
        const deep = 1 - 0.72 * Math.min(1, u * 1.5);
        const k = deep * (sa > 0 ? 1 : 0.5);
        col.push(0.74 * k, 0.32 * k, 0.32 * k);
        wgt.push((1 - u) ** 2);
      }
    }
    for (let r = 0; r < RINGS; r++) for (let s = 0; s < SEG; s++) {
      const a = r * SEG + s, b = r * SEG + (s + 1) % SEG, c = a + SEG, d = b + SEG;
      idx.push(a, c, b, b, c, d);
    }
    const tip = pos.length / 3;
    pos.push(0, y0 - 0.02, 161.0 - 0.1);
    col.push(0.74, 0.32, 0.32);
    wgt.push(1);
    for (let s = 0; s < SEG; s++) idx.push(tip, s, (s + 1) % SEG);
    const g = new T.BufferGeometry();
    g.setAttribute("position", new T.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute("color", new T.BufferAttribute(new Float32Array(col), 3));
    g.setAttribute("tipShare", new T.BufferAttribute(new Float32Array(wgt), 1));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  // ---------- A smoother model ----------
  // The model is low-poly: at this size, its jaw, forehead and shoulders show straight edges. Each triangle becomes four, at load time, so the
  // file stays small. Each new point is pushed out along the curve the normals describe (Phong tessellation), and the old points do not move,
  // so the face keeps its features. Face shapes and bone weights are carried over to the new points.
  function splitOnce(T, geo, alpha) {
    const old = geo.index.array, N = geo.attributes.position.count;
    const edges = new Map(), mids = [], index = new Uint32Array(old.length * 4);
    // Is an edge the rim of the piece? Points doubled for the picture's seams count as one here, or a seam would show as a crease on the skin.
    const place = new Map(), same = new Int32Array(N);
    const p0 = geo.attributes.position;
    for (let i = 0; i < N; i++) {
      const k = `${Math.round(p0.getX(i) * 500)},${Math.round(p0.getY(i) * 500)},${Math.round(p0.getZ(i) * 500)}`;
      if (!place.has(k)) place.set(k, i);
      same[i] = place.get(k);
    }
    const rim = new Map();
    const look = (a, b) => (same[a] < same[b] ? same[a] * N + same[b] : same[b] * N + same[a]);
    for (let i = 0; i < old.length; i += 3) for (const [a, b] of [[old[i], old[i + 1]], [old[i + 1], old[i + 2]], [old[i + 2], old[i]]]) rim.set(look(a, b), (rim.get(look(a, b)) || 0) + 1);
    const mid = (a, b) => {
      const lo = Math.min(a, b), hi = Math.max(a, b), key = lo * N + hi;
      let m = edges.get(key);
      if (m == null) { m = N + mids.length / 2; edges.set(key, m); mids.push(lo, hi); }
      return m;
    };
    for (let i = 0, k = 0; i < old.length; i += 3) {
      const a = old[i], b = old[i + 1], c = old[i + 2];
      const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
      index.set([a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca], k);
      k += 12;
    }
    const count = N + mids.length / 2;
    const out = new T.BufferGeometry();
    const pos = geo.attributes.position, nor = geo.attributes.normal;
    const P = new Float32Array(count * 3), Q = new Float32Array(count * 3);
    for (let i = 0; i < N; i++) { P.set([pos.getX(i), pos.getY(i), pos.getZ(i)], i * 3); Q.set([nor.getX(i), nor.getY(i), nor.getZ(i)], i * 3); }
    for (let m = 0; m < mids.length / 2; m++) {
      const a = mids[2 * m] * 3, b = mids[2 * m + 1] * 3, to = (N + m) * 3;
      const mx = (P[a] + P[b]) / 2, my = (P[a + 1] + P[b + 1]) / 2, mz = (P[a + 2] + P[b + 2]) / 2;
      const da = (mx - P[a]) * Q[a] + (my - P[a + 1]) * Q[a + 1] + (mz - P[a + 2]) * Q[a + 2];
      const db = (mx - P[b]) * Q[b] + (my - P[b + 1]) * Q[b + 1] + (mz - P[b + 2]) * Q[b + 2];
      // An edge at the rim of a piece stays straight: the next piece meets it there, without a crack.
      const bulge = rim.get(look(mids[2 * m], mids[2 * m + 1])) > 1 ? alpha / 2 : 0;
      P[to] = mx - bulge * (da * Q[a] + db * Q[b]);
      P[to + 1] = my - bulge * (da * Q[a + 1] + db * Q[b + 1]);
      P[to + 2] = mz - bulge * (da * Q[a + 2] + db * Q[b + 2]);
      let nx = Q[a] + Q[b], ny = Q[a + 1] + Q[b + 1], nz = Q[a + 2] + Q[b + 2];
      const len = Math.hypot(nx, ny, nz) || 1;
      Q[to] = nx / len; Q[to + 1] = ny / len; Q[to + 2] = nz / len;
    }
    out.setAttribute("position", new T.BufferAttribute(P, 3));
    out.setAttribute("normal", new T.BufferAttribute(Q, 3));
    const uv = geo.attributes.uv;
    if (uv) {
      const U = new Float32Array(count * 2);
      for (let i = 0; i < N; i++) { U[2 * i] = uv.getX(i); U[2 * i + 1] = uv.getY(i); }
      for (let m = 0; m < mids.length / 2; m++) { const a = mids[2 * m], b = mids[2 * m + 1], to = N + m; U[2 * to] = (U[2 * a] + U[2 * b]) / 2; U[2 * to + 1] = (U[2 * a + 1] + U[2 * b + 1]) / 2; }
      out.setAttribute("uv", new T.BufferAttribute(U, 2));
    }
    const si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
    if (si && sw) {
      const I = new Uint16Array(count * 4), W = new Float32Array(count * 4);
      for (let i = 0; i < N; i++) { I.set([si.getX(i), si.getY(i), si.getZ(i), si.getW(i)], i * 4); W.set([sw.getX(i), sw.getY(i), sw.getZ(i), sw.getW(i)], i * 4); }
      const sum = new Map();
      for (let m = 0; m < mids.length / 2; m++) {
        sum.clear();
        for (const v of [mids[2 * m], mids[2 * m + 1]]) for (let j = 0; j < 4; j++) { const w = W[v * 4 + j]; if (w > 0) sum.set(I[v * 4 + j], (sum.get(I[v * 4 + j]) || 0) + w / 2); }
        const top = [...sum].sort((x, y) => y[1] - x[1]).slice(0, 4);
        const total = top.reduce((a, x) => a + x[1], 0) || 1;
        top.forEach(([bone, w], j) => { I[(N + m) * 4 + j] = bone; W[(N + m) * 4 + j] = w / total; });
      }
      out.setAttribute("skinIndex", new T.BufferAttribute(I, 4));
      out.setAttribute("skinWeight", new T.BufferAttribute(W, 4));
    }
    for (const kind of Object.keys(geo.morphAttributes)) {
      out.morphAttributes[kind] = geo.morphAttributes[kind].map((m0) => {
        const A = new Float32Array(count * 3);
        for (let i = 0; i < N; i++) { A[3 * i] = m0.getX(i); A[3 * i + 1] = m0.getY(i); A[3 * i + 2] = m0.getZ(i); }
        for (let m = 0; m < mids.length / 2; m++) { const a = mids[2 * m] * 3, b = mids[2 * m + 1] * 3, to = (N + m) * 3; A[to] = (A[a] + A[b]) / 2; A[to + 1] = (A[a + 1] + A[b + 1]) / 2; A[to + 2] = (A[a + 2] + A[b + 2]) / 2; }
        return new T.BufferAttribute(A, 3);
      });
    }
    out.morphTargetsRelative = geo.morphTargetsRelative;
    out.setIndex(new T.BufferAttribute(index, 1));
    geo.dispose();
    return out;
  }
  // Points at the same place get the same normal, across the pieces of a material. Otherwise the smoothing pulls them apart: fine cracks on the skin.
  function weldNormals(geos) {
    const sum = new Map();
    const key = (p, i) => `${Math.round(p.getX(i) * 500)},${Math.round(p.getY(i) * 500)},${Math.round(p.getZ(i) * 500)}`;
    for (const g of geos) {
      const p = g.attributes.position, n = g.attributes.normal;
      for (let i = 0; i < p.count; i++) {
        const k = key(p, i), s = sum.get(k) || [0, 0, 0];
        s[0] += n.getX(i); s[1] += n.getY(i); s[2] += n.getZ(i);
        sum.set(k, s);
      }
    }
    for (const g of geos) {
      const p = g.attributes.position, n = g.attributes.normal;
      for (let i = 0; i < p.count; i++) {
        const s = sum.get(key(p, i)), l = Math.hypot(s[0], s[1], s[2]) || 1;
        n.setXYZ(i, s[0] / l, s[1] / l, s[2] / l);
      }
    }
  }
  function smoother(T, geo, levels, alpha = 0.72) {
    for (let i = 0; i < levels; i++) geo = splitOnce(T, geo, alpha);
    return geo;
  }

  // ---------- Files: fetched once, so a new call starts at once ----------
  let libP = null, modelP = null, lightP = null, wordsP = null;
  const wordsFile = () => (wordsP ||= fetch(WORDS).then((r) => (r.ok ? r.text() : "")).then((text) => {
    const map = new Map();
    let at = 0;
    while (at < text.length) {
      const sp = text.indexOf(" ", at), nl = text.indexOf("\n", sp);
      if (sp < 0 || nl < 0) break;
      map.set(text.slice(at, sp), text.slice(sp + 1, nl));
      at = nl + 1;
    }
    if (map.size) dictionary = map;
  }).catch(() => {})); // without it: the spelling rules
  const lib = () => (libP ||= import(LIB));
  const modelBuffer = () => (modelP ||= fetch(MODEL).then((r) => {
    if (!r.ok) throw new Error(`model ${r.status}`);
    return r.arrayBuffer();
  }));
  const lightFile = () => (lightP ||= fetch(LIGHT).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null)); // without it: the panels

  // His soft light and what shines in his eyes: the real room. If that file is missing, a small room of glowing panels.
  function roomLight(T, renderer, data) {
    if (data?.byteLength === LIGHT_W * LIGHT_H * 8) {
      const tex = new T.DataTexture(new Uint16Array(data), LIGHT_W, LIGHT_H, T.RGBAFormat, T.HalfFloatType);
      tex.mapping = T.EquirectangularReflectionMapping;
      tex.magFilter = tex.minFilter = T.LinearFilter;
      tex.needsUpdate = true;
      const pmrem = new T.PMREMGenerator(renderer);
      const env = pmrem.fromEquirectangular(tex).texture;
      pmrem.dispose();
      tex.dispose();
      return env;
    }
    const room = new T.Scene();
    const walls = new T.Mesh(new T.BoxGeometry(24, 14, 24), new T.MeshBasicMaterial({ side: T.BackSide, color: new T.Color(0.6, 0.56, 0.53) }));
    walls.position.y = 2;
    room.add(walls);
    const panel = (w, h, rgb, x, y, z) => {
      const m = new T.Mesh(new T.PlaneGeometry(w, h), new T.MeshBasicMaterial({ side: T.DoubleSide, color: new T.Color(...rgb) }));
      m.position.set(x, y, z);
      m.lookAt(0, 1.5, 0);
      room.add(m);
    };
    panel(10, 9, [6.6, 5.5, 4.6], -11, 3.5, 4); // the window
    panel(12, 7, [1.9, 1.75, 1.6], 0, 8.5, 3); // the ceiling
    panel(3.6, 2.2, [3.1, 3.5, 4.2], 1.2, 0.6, 11); // his screen, in front of him: the light in his eyes
    panel(24, 24, [0.3, 0.22, 0.16], 0, -4.8, 0); // the warm floor
    const pmrem = new T.PMREMGenerator(renderer);
    const env = pmrem.fromScene(room, 0.015).texture;
    pmrem.dispose();
    room.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
    return env;
  }

  class Stage3D {
    // Only Jake has a 3D body, and it needs WebGL 2.
    static ok(id) {
      if (id !== "jake") return false;
      if (Stage3D._gl == null) {
        try {
          const gl = document.createElement("canvas").getContext("webgl2");
          Stage3D._gl = Boolean(gl);
          gl?.getExtension("WEBGL_lose_context")?.loseContext(); // only a test: give the context back
        } catch { Stage3D._gl = false; }
      }
      return Stage3D._gl;
    }
    static preload() {
      if (!Stage3D.ok("jake")) return;
      Promise.all([lib(), modelBuffer(), lightFile()]).catch(() => { libP = modelP = null; });
      wordsFile();
    }

    constructor(id) {
      this.id = id;
      this.art = document.createElement("div");
      this.art.className = "stage-art stage3d";
      this.poster = new Image();
      this.poster.className = "poster";
      this.poster.alt = "";
      this.poster.src = POSTER;
      this.art.append(this.poster);
      this.ready = false;
      this.emotion = "neutral";
      this.emotionUntil = 0;
      this.nodAsked = false;
      this.start();
    }

    async start() {
      try {
        wordsFile();
        const [T, buf, light] = await Promise.all([lib(), modelBuffer(), lightFile()]);
        if (this.disposed) return;
        this.lightData = light;
        const gltf = await new T.GLTFLoader().parseAsync(buf.slice(0), "");
        if (this.disposed) return;
        this.build(T, gltf);
      } catch (e) {
        libP = modelP = null;
        this.takeOver(e);
      }
    }
    // The 3D failed: the drawn Jake takes its place.
    takeOver(e) {
      console.warn("[jake 3d] the drawn Jake takes over:", e?.message || e);
      if (this.disposed || !window.TutorStage) return;
      this.cleanUp();
      this.inner = new window.TutorStage(this.id);
      this.art.replaceChildren(this.inner.art);
      this.art.classList.remove("ready", "stage3d");
    }

    build(T, gltf) {
      this.T = T;
      const renderer = new T.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
      renderer.outputColorSpace = T.SRGBColorSpace;
      renderer.toneMapping = T.NeutralToneMapping; // keeps the real colours of the skin and the shirt
      renderer.setClearColor(0x000000, 0);
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = T.PCFShadowMap;
      this.pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      renderer.setPixelRatio(this.pixelRatio);
      this.renderer = renderer;
      renderer.debug.onShaderError = () => setTimeout(() => this.takeOver(new Error("shader failed")), 0); // some phones
      this.scene = new T.Scene();
      this.camera = new T.PerspectiveCamera(22, 16 / 9, 10, 2000);

      // The room's light: the photo of the room lights him from all sides and gives the eyes and the skin their reflections.
      // The tall window is behind him on the viewer's left: it lights the edge of his body (rim). The key is the soft light
      // beside the camera (also in that photo's file, for his eyes), and it casts the soft shadows (chin on neck, arm on shirt).
      this.scene.environment = roomLight(T, renderer, this.lightData);
      this.scene.environmentIntensity = 0.66;
      const key = new T.DirectionalLight(0xfff4ea, 1.4);
      key.position.set(-150, 300, 240);
      key.castShadow = true;
      key.shadow.mapSize.set(1536, 1536);
      Object.assign(key.shadow.camera, { left: -70, right: 70, top: 70, bottom: -70, near: 50, far: 800 });
      key.shadow.bias = -0.0006;
      key.shadow.normalBias = 0.5;
      key.shadow.radius = 3;
      key.shadow.intensity = 0.72;
      key.target.position.set(0, 150, 0);
      this.scene.add(key, key.target);
      this.key = key;
      const rim = new T.DirectionalLight(0xffeedd, 0.5);
      rim.position.set(-110, 90, -270); // measured on the photo: where the window is
      this.scene.add(rim);

      // root moves him in the room; the model stays inside it.
      this.root = new T.Group();
      this.root.add(gltf.scene);
      this.scene.add(this.root);
      this.morphMeshes = [];
      gltf.scene.traverse((o) => {
        if (!o.isMesh) return;
        o.frustumCulled = false;
        const m = o.material;
        if (m.map) m.map.anisotropy = 8;
        o.castShadow = o.receiveShadow = m.name !== "opacity"; // hair cards would draw sharp dark wedges on the scalp
        if (m.name === "opacity") { // hair: no shine from the window, it looked like plastic
          o.renderOrder = 2; m.alphaTest = 0.08; m.roughness = 0.95;
          m.customProgramCacheKey = () => "hair";
          m.onBeforeCompile = (sh) => {
            sh.fragmentShader = sh.fragmentShader.replace("#include <aomap_fragment>", `#include <aomap_fragment>
              reflectedLight.indirectSpecular *= 0.12;
              reflectedLight.directSpecular *= 0.35;`);
          };
        }
        else {
          // The photo of the skin is very saturated: bring it back toward a natural colour.
          const isHead = m.name === "head";
          m.customProgramCacheKey = () => m.name;
          m.onBeforeCompile = (sh) => {
            sh.fragmentShader = sh.fragmentShader.replace("#include <map_fragment>", `#include <map_fragment>
              diffuseColor.rgb = mix(vec3(dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11))), diffuseColor.rgb, 0.84);
              ${isHead ? `
              // The lips keep their colour.
              float lipMask = 1.0 - smoothstep(0.55, 1.0, length((vMapUv - vec2(0.493, 0.592)) / vec2(0.06, 0.027)));
              diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.02, 0.86, 0.86), lipMask * 0.8);
              // Inside the mouth (and the back of the lip's edge): wet and pink near the lips, dark further in. The model's picture of it
              // has teeth drawn on it, and there are real ones now.
              bool inMouth = (vMapUv.x < 0.215 && vMapUv.y < 0.41) || !gl_FrontFacing;
              float mouthDeep = smoothstep(-13.4, -9.5, vJakeY);
              if (inMouth) diffuseColor.rgb = mix(vec3(0.56, 0.2, 0.2), vec3(0.2, 0.045, 0.05), mouthDeep);
              // Under the hair, the picture has a pale band (the model's cards used to cover it): the scalp is dark there.
              float underHair = smoothstep(168.8, 172.2, vJakeZ) * smoothstep(-7.2, -3.8, vJakeY);
              diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.04, 0.021, 0.011), underHair * 0.92);` : ""}`);
            if (isHead) {
              // Lips are a little wet. Short hair, brows and stubble do not shine like plastic: dark and matt, except the eye itself.
              sh.fragmentShader = sh.fragmentShader.replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
                roughnessFactor = mix(roughnessFactor, 0.36, lipMask * 0.75);
                bool inEye = vMapUv.x > 0.2 && vMapUv.x < 0.36 && vMapUv.y < 0.16;
                float hairy = (inMouth || inEye) ? 0.0 : 1.0 - smoothstep(0.1, 0.3, dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11)));
                roughnessFactor = max(roughnessFactor, 0.86 * hairy);`);
              // The inside of the mouth (top left of the head's map): little light gets there, and it must not mirror the room.
              sh.fragmentShader = sh.fragmentShader.replace("#include <aomap_fragment>", `#include <aomap_fragment>
                // The thin edge of the lips, where they meet: at a grazing angle it mirrored the window as a white line.
                float lipEdge = 1.0 - smoothstep(0.004, 0.0095, abs(vMapUv.y - 0.5955));
                lipEdge *= 1.0 - smoothstep(0.052, 0.066, abs(vMapUv.x - 0.5));
                reflectedLight.indirectSpecular *= 1.0 - 0.94 * lipEdge;
                reflectedLight.directSpecular *= 1.0 - 0.9 * lipEdge;
                reflectedLight.indirectSpecular *= 1.0 - 0.8 * hairy;
                reflectedLight.directSpecular *= 1.0 - 0.7 * hairy;
                // Light goes a little way through skin: where the light fades on a curve, it fades through red, not through grey.
                if (!inMouth && !inEye) {
                  float litSkin = dot(reflectedLight.directDiffuse, vec3(0.3, 0.59, 0.11)) / max(0.02, dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11)));
                  reflectedLight.directDiffuse *= mix(vec3(1.2, 0.84, 0.76), vec3(1.0), smoothstep(0.02, 0.5, litSkin));
                }
                // The upper lid shades the top of the eye: this is what gives eyes their depth.
                if (inEye) {
                  float lid = smoothstep(0.02, 0.5, normal.y);
                  reflectedLight.indirectDiffuse *= 1.0 - 0.62 * lid;
                  reflectedLight.directDiffuse *= 1.0 - 0.75 * lid;
                  reflectedLight.indirectSpecular *= 1.0 - 0.7 * lid;
                }
                if (inMouth) {
                  reflectedLight.indirectSpecular *= 0.06;
                  reflectedLight.directSpecular *= 0.2;
                  reflectedLight.directDiffuse *= 0.16 * (1.0 - mouthDeep);
                  reflectedLight.indirectDiffuse *= mix(0.9, 0.5, mouthDeep);
                }`);
              sh.fragmentShader = sh.fragmentShader.replace("#include <common>", `#include <common>
                varying float vJakeY, vJakeZ;`);
              sh.vertexShader = sh.vertexShader.replace("#include <common>", `#include <common>
                varying float vJakeY, vJakeZ;`).replace("#include <begin_vertex>", `#include <begin_vertex>
                vJakeY = position.y; vJakeZ = position.z;`);
            }
          };
        }
        if (m.name === "head") {
          m.normalScale.set(1, 1); // pores and fine lines
          m.side = T.DoubleSide; // the inside of the mouth is modelled facing away: without this, you see the room through it
          // Light goes through skin and comes back warm: a little red in the shadows of the face.
          m.emissive.setRGB(0.04, 0.016, 0.01);
          m.emissiveMap = m.map;
        }
        if (o.morphTargetDictionary) this.morphMeshes.push(o);
      });
      this.morphs = {}; // name -> spring
      for (const o of this.morphMeshes) {
        for (const name of Object.keys(o.morphTargetDictionary)) this.morphs[name] ||= new Spring(0, name === "v_PP" || name === "v_FF" ? 80 : name.startsWith("v_") ? 50 : /jaw|tongue|lips|pucker|funnel|upperUp|lowerDown/.test(name) ? 30 : 11);
      }
      this.mouthNow = {};
      this.morphTargets = Object.fromEntries(Object.keys(this.morphs).map((n) => [n, 0]));

      const bone = (n) => gltf.scene.getObjectByName(n);
      gltf.scene.updateMatrixWorld(true);
      // In the rest pose he stands upright and looks straight ahead (+Z): the turn of each bone then is "looking ahead, upright".
      const restOf = (b) => b.getWorldQuaternion(new T.Quaternion());
      this.neck = bone("Bip01_Neck");
      this.chest = bone("Bip01_Spine1") || bone("Bip01_Spine");
      this.clavicles = [bone("Bip01_L_Clavicle"), bone("Bip01_R_Clavicle")].filter(Boolean);
      this.head = bone("Bip01_Head");
      this.eyes = [bone("Bip01_LEye"), bone("Bip01_REye")].filter(Boolean);
      this.neckRest = restOf(this.neck);
      this.headRest = restOf(this.head);
      this.eyeRest = this.eyes.map(restOf);
      this.arms = [
        { upper: bone("Bip01_L_UpperArm"), fore: bone("Bip01_L_Forearm"), hand: bone("Bip01_L_Hand"), sign: -1 },
        { upper: bone("Bip01_R_UpperArm"), fore: bone("Bip01_R_Forearm"), hand: bone("Bip01_R_Hand"), sign: 1 },
      ];
      this.buildTeeth(T);
      // A phone gets one level less on the face: the shapes take memory.
      const small = Math.min(screen.width, screen.height) < 500;
      const toSmooth = [];
      gltf.scene.traverse((o) => { if (o.isMesh && o.visible && o.geometry.index && o.material.name !== "opacity" && !o.material.vertexColors && o.geometry.attributes.normal) toSmooth.push(o); });
      weldNormals(toSmooth.filter((o) => o.material.name === "head").map((o) => o.geometry));
      for (const o of toSmooth) {
        const isFace = Boolean(o.morphTargetDictionary);
        o.geometry = smoother(T, o.geometry, isFace ? (small ? 1 : 2) : o.material.name === "head" ? 2 : 1);
      }
      this.buildHair(T, toSmooth.find((o) => o.material.name === "head" && !o.morphTargetDictionary), small);
      this.buildLashes(T, toSmooth.find((o) => o.morphTargetDictionary && o.geometry.attributes.position.count > 500));
      this.ahead = new T.Vector3(0, 0, 1);
      this.axisX = new T.Vector3(1, 0, 0);
      this.axisZ = new T.Vector3(0, 0, 1);
      this.axisY = new T.Vector3(0, 1, 0);
      this.look = new T.Vector3(); this.eyePoint = new T.Vector3(); this.eyeMid = new T.Vector3();
      this.v1 = new T.Vector3(); this.v2 = new T.Vector3();
      this.q1 = new T.Quaternion(); this.q2 = new T.Quaternion(); this.q3 = new T.Quaternion(); this.qExtra = new T.Quaternion();
      this.e1 = new T.Euler();

      // Clips: a quiet base always plays; one gesture at a time goes on top.
      this.mixer = new T.AnimationMixer(gltf.scene);
      this.clips = Object.fromEntries(gltf.animations.map((c) => [c.name, c]));
      this.layers = [];
      this.base = this.mixer.clipAction(this.clips[pick(CLIPS.base)]);
      this.base.setEffectiveWeight(BASE_WEIGHT).play();
      this.baseW = new Spring(BASE_WEIGHT, 5);
      this.baseTo = BASE_WEIGHT;
      this.walkAct = this.mixer.clipAction(this.clips[CLIPS.walk]);
      this.walkAct.setEffectiveWeight(0).play();
      this.walkW = new Spring(0, 4);

      // Slow things that live on their own.
      this.calm = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      this.x = new Spring(0, 1.5); this.z = new Spring(0, 1.2); this.yaw = new Spring(0, 2.2);
      this.xTo = 0; this.zTo = 0;
      this.pitch = new Spring(0, 9); this.roll = new Spring(0, 3.5); this.turn = new Spring(0, 3.5);
      this.lookX = new Spring(0, 6); this.lookY = new Spring(0, 6); // the head turns slowly toward what he looks at
      this.eyeX = new Spring(0, 34); this.eyeY = new Spring(0, 34); // the eyes get there first
      this.chestYaw = new Spring(0, 3); this.chestLean = new Spring(0, 4); this.shoulders = new Spring(0, 6);
      this.beat = new Spring(0, 8.5); this.beatArm = 0;
      this.handLift = new Spring(0, 5); this.handUpUntil = 0; this.lastHandUp = 0;
      this.zoom = new Spring(0, 2.1); this.focusLeft = 0; this.focusHold = 0;
      this.env = 0; this.pulse = 0; this.userEnv = 0; this.levels = [];
      this.t0 = performance.now(); this.last = 0;
      this.kind = ""; this.topEnd = 0; this.oneShotEnd = 0; this.fastFade = 0;
      this.nextBlink = 0; this.blinkAt = 0; this.nextGlance = 0; this.glanceEnd = 0; this.glance = [0, 0];
      this.nextStroll = this.t0 + rand(22000, 40000);
      this.nextShrug = this.t0 + rand(30000, 60000);
      this.lastNod = 0; this.nodClip = 0; this.lastLaugh = 0; this.waved = false; this.lastPulse = 0; this.wasQuiet = true;
      this.lastBeat = 0; this.lastClap = 0; this.lastNo = 0; this.lastThinkHand = 0; this.shakeUntil = 0;
      this.lastWord = -1; this.sentence = null; this.sentYaw = 0; this.sentQuestion = false; this.mouthCache = null;
      this.prevMode = ""; this.waitUntil = 0;
      this.userTalking = false; this.userFrom = 0; this.userQuietAt = 0; this.nextListenNod = 0; this.listenTilt = 0; this.listenYaw = 0;
      this.frames = 0; this.sumDt = 0; this.quality = 0;

      // He glances where your pointer goes on the video.
      this.ptr = { x: 0, y: 0, at: 0 };
      this.onPointer = (e) => {
        const r = this.art.getBoundingClientRect();
        if (e.pointerType === "touch" || e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
        this.ptr.x = ((e.clientX - r.left) / r.width) * 2 - 1;
        this.ptr.y = ((e.clientY - r.top) / r.height) * 2 - 1;
        this.ptr.at = performance.now();
      };
      window.addEventListener("pointermove", this.onPointer, { passive: true });

      // The graphics card can drop us (the Mac sleeps, too many pages): wait for it, or the drawn Jake takes over.
      const canvas = renderer.domElement;
      this.onLost = (e) => {
        e.preventDefault();
        this.lost = true;
        this.lostTimer = setTimeout(() => this.takeOver(new Error("graphics context lost")), 5000);
      };
      this.onRestored = () => {
        clearTimeout(this.lostTimer);
        this.scene.environment = roomLight(T, renderer, this.lightData);
        this.lost = false;
      };
      canvas.addEventListener("webglcontextlost", this.onLost);
      canvas.addEventListener("webglcontextrestored", this.onRestored);

      canvas.className = "stage3d-canvas";
      this.art.append(canvas);
      this.resize();
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(this.art);
      const now = performance.now();
      this.nextTop("listen", now);
      for (const l of this.layers) { l.w = 1; l.act.setEffectiveWeight(1); } // never a frame in the bind pose
      this.mixer.update(0);
      this.ready = true;
      this.frame(now, { mode: "idle", level: 0 });
      this.art.classList.add("ready");
    }

    // Two arches of teeth. The upper one stays with the skull; the lower one turns with the jaw.
    buildTeeth(T) {
      const face = this.morphMeshes.find((o) => o.geometry.attributes.position.count > 500);
      const sk = face?.skeleton, at = sk ? sk.bones.indexOf(this.head) : -1;
      if (at < 0) return;
      const space = new T.Group(); // the model's own space, carried by the head
      space.matrixAutoUpdate = false;
      space.matrix.copy(sk.boneInverses[at]).multiply(face.bindMatrix);
      this.head.add(space);
      const mat = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.34, metalness: 0, side: T.DoubleSide, envMapIntensity: 0.55 });
      const upper = new T.Mesh(makeArch(T, { list: TEETH_UP, front: -12.56, bend: 0.25, edge: 161.64, down: false, gumColor: [0.42, 0.13, 0.13] }), mat);
      const lower = new T.Mesh(makeArch(T, { list: TEETH_DOWN, front: -12.24, bend: 0.27, edge: 161.42, down: true, gumColor: [0.4, 0.12, 0.12] }), mat);
      upper.frustumCulled = lower.frustumCulled = false;
      // The jaw turns around a point in front of the ear.
      const hinge = new T.Group();
      hinge.position.set(0, -3.5, 162.8); // set from the model's jawOpen: the lower lip goes 1.72 cm down and only 0.15 cm back
      lower.position.set(0, 3.5, -162.8);
      hinge.add(lower);
      space.add(upper, hinge);
      this.jaw = hinge;
      this.teethMat = mat;
      // The model's flat tongue gives way to a real one.
      for (const o of this.morphMeshes.slice()) if (o !== face && o.geometry.attributes.position.count < 200) { o.visible = false; this.morphMeshes.splice(this.morphMeshes.indexOf(o), 1); }
      this.tongueU = { lift: { value: 0 }, out: { value: 0 } };
      const tm = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0, side: T.DoubleSide });
      tm.customProgramCacheKey = () => "tongue";
      tm.onBeforeCompile = (sh) => {
        sh.uniforms.tongueLift = this.tongueU.lift;
        sh.uniforms.tongueOut = this.tongueU.out;
        sh.vertexShader = sh.vertexShader.replace("#include <common>", `#include <common>
          attribute float tipShare;
          uniform float tongueLift, tongueOut;`).replace("#include <begin_vertex>", `#include <begin_vertex>
          transformed.z += tipShare * tongueLift;
          transformed.y -= tipShare * tongueOut;`);
      };
      const tongue = new T.Mesh(makeTongue(T), tm);
      tongue.frustumCulled = false;
      tongue.position.set(0, 3.5, -162.8);
      hinge.add(tongue);
      this.tongueMat = tm;
      // How much each shape opens the jaw: what it does to the chin, against jawOpen.
      const geo = face.geometry, dict = face.morphTargetDictionary, morphs = geo.morphAttributes.position, base = geo.attributes.position;
      const jawD = morphs[dict.jawOpen];
      let chin = 0, top = 0;
      for (let i = 0; i < base.count; i++) if (base.getZ(i) < 158 && Math.abs(jawD.getZ(i)) > top) { top = Math.abs(jawD.getZ(i)); chin = i; }
      this.jawShare = [];
      for (const [name, i] of Object.entries(dict)) {
        const s = morphs[i].getZ(chin) / jawD.getZ(chin);
        if (Math.abs(s) > 0.01) this.jawShare.push([name, s]);
      }
    }
    // Real hair: thin strands that grow from the scalp where the skin's picture shows hair, instead of the model's flat cards.
    // They face the camera, get thinner toward the tip, are dark at the root, gather in small tufts, and flow forward on top and
    // down at the sides. They go with the head, so they cost no bone work.
    buildHair(T, scalp, small) {
      const sk = scalp?.skeleton, at = sk ? sk.bones.indexOf(this.head) : -1, img = scalp?.material.map?.image;
      if (at < 0 || !img) return;
      let pix;
      try {
        const c = document.createElement("canvas");
        c.width = c.height = 512;
        const g = c.getContext("2d", { willReadFrequently: true });
        g.drawImage(img, 0, 0, 512, 512);
        pix = g.getImageData(0, 0, 512, 512).data;
      } catch { return; }
      const flipY = scalp.material.map.flipY;
      const texel = (u, v) => {
        const x = Math.min(511, Math.max(0, Math.floor(u * 512))), y = Math.min(511, Math.max(0, Math.floor((flipY ? 1 - v : v) * 512)));
        const k = (y * 512 + x) * 4;
        return [pix[k] / 255, pix[k + 1] / 255, pix[k + 2] / 255];
      };
      const geo = scalp.geometry, idx = geo.index.array, P = geo.attributes.position, N = geo.attributes.normal, U = geo.attributes.uv;
      // Triangles of the scalp, by area.
      const tris = [];
      let total = 0;
      for (let i = 0; i < idx.length; i += 3) {
        const a = idx[i], b = idx[i + 1], c = idx[i + 2];
        if (P.getZ(a) < 161) continue;
        const ux = P.getX(b) - P.getX(a), uy = P.getY(b) - P.getY(a), uz = P.getZ(b) - P.getZ(a), vx = P.getX(c) - P.getX(a), vy = P.getY(c) - P.getY(a), vz = P.getZ(c) - P.getZ(a);
        const area = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
        total += area;
        tris.push([a, b, c, total]);
      }
      if (!tris.length) return;
      let seed = 12345;
      const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      const pickTri = () => { const t = rnd() * total; let lo = 0, hi = tris.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (tris[m][3] < t) lo = m + 1; else hi = m; } return tris[lo]; };
      const smooth = (a, b, x) => { const f = Math.max(0, Math.min(1, (x - a) / (b - a))); return f * f * (3 - 2 * f); };
      const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
      const WANT = small ? 14000 : 42000, SEG = 3;
      const pos = [], tan = [], side = [], along = [], wid = [], col = [], nor = [], index = [];
      // Tufts: strands of the same tuft lean toward one tip.
      const tufts = [];
      for (let i = 0; i < 420; i++) tufts.push([rnd() * 18 - 9, rnd() * 20 - 12, 172 + rnd() * 11, rnd() * 2 - 1, rnd() * 2 - 1, rnd()]);
      const near = (x, y, z) => { let best = null, bd = 1e9; for (const f of tufts) { const d = (f[0] - x) ** 2 + (f[1] - y) ** 2 + (f[2] - z) ** 2; if (d < bd) { bd = d; best = f; } } return best; };
      for (let made = 0, tries = 0; made < WANT && tries < WANT * 12; tries++) {
        const [a, b, c] = pickTri();
        let r1 = rnd(), r2 = rnd();
        if (r1 + r2 > 1) { r1 = 1 - r1; r2 = 1 - r2; }
        const w = 1 - r1 - r2;
        const mix = (A, get) => w * A[get](a) + r1 * A[get](b) + r2 * A[get](c);
        const x = mix(P, "getX"), y = mix(P, "getY"), z = mix(P, "getZ");
        const tex = texel(mix(U, "getX"), mix(U, "getY"));
        const luma = tex[0] * 0.3 + tex[1] * 0.59 + tex[2] * 0.11;
        // Hair is darker than skin: thin out near the painted hairline, rather than stopping along a line.
        // Behind the temples the picture has a pale band (the model's cards used to cover it): hair grows there whatever the picture says.
        const covered = z > 170.5 && y > -4.8;
        if (!covered && (luma > 0.17 + rnd() * 0.17 || tex[0] > tex[1] * 2.2)) continue;
        const edgeHair = covered ? 0 : smooth(0.1, 0.26, luma); // near the hairline: shorter, finer, and not dark at the root, so no comb line on the skin
        if (Math.abs(x) > 8.05 || (Math.abs(x) > 6.2 && z < 171 && y < 3.5)) continue; // not from the dark folds of the ears
        const n = norm([mix(N, "getX"), mix(N, "getY"), mix(N, "getZ")]);
        const top = smooth(172.5, 176.5, z);
        const front = smooth(-3, -9, y);
        // Which way it is combed: down and back at the sides, forward and out on top, turning around the crown.
        const crown = [x - 0, y - 3.5, 0.0];
        const dCrown = Math.hypot(crown[0], crown[1]) || 1;
        const flowTop = norm([x * 0.05 + (crown[0] / dCrown) * 0.5, -0.85 + (crown[1] / dCrown) * 0.45, 0.08 + front * 1.25]);
        const flowSide = norm([x * 0.012, 0.55, -1]);
        const flow = [0, 1, 2].map((i) => flowSide[i] * (1 - top) + flowTop[i] * top);
        const dot = flow[0] * n[0] + flow[1] * n[1] + flow[2] * n[2];
        const along0 = norm([flow[0] - n[0] * dot, flow[1] - n[1] * dot, flow[2] - n[2] * dot]);
        const lift = 0.1 + top * (0.3 + front * 0.42);
        const f = near(x, y, z);
        const len = ((0.32 + rnd() * 0.3) * (1 - top) + top * (1.05 + rnd() * 0.7 + front * 0.45 + f[5] * 0.45)) * (1 - 0.6 * edgeHair);
        // The tip, pulled toward the tuft's own direction.
        const d0 = norm([along0[0] + n[0] * lift + (rnd() - 0.5) * 0.26 + f[3] * 0.2 * top, along0[1] + n[1] * lift + (rnd() - 0.5) * 0.26 + f[4] * 0.2 * top, along0[2] + n[2] * lift + (rnd() - 0.5) * 0.18]);
        const bendDown = 0.04 + top * 0.07; // it curves over a little at the end
        const first = pos.length / 3;
        // The same brown as the picture's short hair, darker at the root and warmer at the tip.
        const tone = 0.7 + rnd() * 0.55;
        let px = x - n[0] * 0.03, py = y - n[1] * 0.03, pz = z - n[2] * 0.03, dx = d0[0], dy = d0[1], dz = d0[2];
        const width = (0.012 + rnd() * 0.009 + top * 0.007) * (small ? 1.7 : 1) * (1 - 0.4 * edgeHair);
        const stepL = len / SEG;
        for (let k = 0; k <= SEG; k++) {
          const t = k / SEG;
          for (const s of [-1, 1]) {
            pos.push(px, py, pz); tan.push(dx, dy, dz); side.push(s); along.push(t); wid.push(width); nor.push(n[0], n[1], n[2]);
            const shade = (0.22 + 0.5 * edgeHair + (0.78 - 0.5 * edgeHair) * smooth(0, 0.8, t)) * tone;
            col.push(0.062 * shade, 0.031 * shade, 0.013 * shade);
          }
          px += dx * stepL; py += dy * stepL; pz += dz * stepL;
          dz -= bendDown; const l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l;
        }
        for (let k = 0; k < SEG; k++) {
          const v = first + k * 2;
          index.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
        }
        made++;
      }
      const g = new T.BufferGeometry();
      g.setAttribute("position", new T.BufferAttribute(new Float32Array(pos), 3));
      g.setAttribute("normal", new T.BufferAttribute(new Float32Array(nor), 3));
      g.setAttribute("color", new T.BufferAttribute(new Float32Array(col), 3));
      g.setAttribute("aTan", new T.BufferAttribute(new Float32Array(tan), 3));
      g.setAttribute("aSide", new T.BufferAttribute(new Float32Array(side), 1));
      g.setAttribute("aAlong", new T.BufferAttribute(new Float32Array(along), 1));
      g.setAttribute("aWidth", new T.BufferAttribute(new Float32Array(wid), 1));
      g.setIndex(new T.BufferAttribute(new Uint32Array(index), 1));
      const mat = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0, side: T.DoubleSide, envMapIntensity: 0.8 });
      mat.customProgramCacheKey = () => "strands";
      mat.onBeforeCompile = (sh) => {
        sh.vertexShader = sh.vertexShader.replace("#include <common>", `#include <common>
          attribute vec3 aTan; attribute float aSide, aAlong, aWidth;
          varying vec3 vStrand;`).replace("#include <project_vertex>", `
          vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
          vec3 viewTan = normalize(normalMatrix * aTan);
          vec3 sideDir = normalize(cross(viewTan, normalize(-mvPosition.xyz)));
          float taper = 1.0 - aAlong * aAlong;
          mvPosition.xyz += sideDir * aSide * aWidth * taper;
          vStrand = viewTan;
          gl_Position = projectionMatrix * mvPosition;`);
        sh.fragmentShader = sh.fragmentShader.replace("#include <common>", `#include <common>
          varying vec3 vStrand;`).replace("#include <aomap_fragment>", `#include <aomap_fragment>
          // Hair shines in a band across the strands, not like a mirror.
          vec3 tang = normalize(vStrand);
          vec3 halfV = normalize(normalize(vec3(-0.45, 0.65, 0.6)) + normalize(vViewPosition));
          float dotTH = dot(tang, halfV);
          float band = pow(max(0.0, sqrt(max(0.0, 1.0 - dotTH * dotTH))), 42.0);
          reflectedLight.directSpecular = reflectedLight.directSpecular * 0.05 + diffuseColor.rgb * 0.8 * band;
          reflectedLight.indirectSpecular *= 0.04;`);
      };
      const hair = new T.Mesh(g, mat);
      hair.frustumCulled = false;
      hair.castShadow = false; hair.receiveShadow = false;
      const space = new T.Group();
      space.matrixAutoUpdate = false;
      space.matrix.copy(sk.boneInverses[at]).multiply(scalp.bindMatrix);
      space.add(hair);
      this.head.add(space);
      this.hair = hair;
      // The model's flat cards go.
      this.root.traverse((o) => { if (o.isMesh && o.material.name === "opacity") o.visible = false; });
    }
    // Upper eyelashes: the model only has a drawing of them, and a look needs them. The edge of each upper lid is where the blink shape moves
    // the skin the most. Each lash takes the bones and the face shapes of the lid point it grows from, so it blinks with the lid.
    buildLashes(T, face) {
      const geo = face?.geometry, dict = face?.morphTargetDictionary;
      if (!geo || !dict) return;
      const P = geo.attributes.position, SI = geo.attributes.skinIndex, SW = geo.attributes.skinWeight;
      const shapes = geo.morphAttributes.position, shapesN = geo.morphAttributes.normal;
      const pos = [], index = [], si = [], sw = [], nor = [];
      const lid = []; // for each new point: the lid point it follows
      let seed = 777;
      const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      for (const name of ["blinkL", "blinkR"]) {
        const d = shapes[dict[name]];
        let top = 0;
        for (let i = 0; i < d.count; i++) top = Math.max(top, -d.getZ(i));
        if (top < 0.1) continue;
        // The edge of the lid: across the eye, the lowest skin that the blink moves. One point per place, from the inner corner to the outer one.
        const seen = new Map();
        for (let i = 0; i < d.count; i++) {
          if (-d.getZ(i) < top * 0.22 || P.getY(i) > -8) continue;
          const k = Math.round(P.getX(i) * 8);
          const old = seen.get(k);
          if (old == null || P.getZ(i) < P.getZ(old)) seen.set(k, i);
        }
        const edge = [...seen.values()].sort((a, b) => P.getX(a) - P.getX(b));
        if (edge.length < 4) continue;
        const inner = Math.abs(P.getX(edge[0])) < Math.abs(P.getX(edge[edge.length - 1])) ? 0 : 1; // which end is near the nose
        const COUNT = 64;
        for (let n = 0; n < COUNT; n++) {
          const f = (n + rnd() * 0.8) / COUNT * (edge.length - 1);
          const a = Math.floor(f), b = Math.min(edge.length - 1, a + 1), w = f - a;
          const near = w < 0.5 ? edge[a] : edge[b];
          const out = inner === 0 ? f / (edge.length - 1) : 1 - f / (edge.length - 1); // 0 near the nose, 1 at the outer corner
          const sx = Math.sign(P.getX(near));
          const x0 = P.getX(edge[a]) * (1 - w) + P.getX(edge[b]) * w, y0 = P.getY(edge[a]) * (1 - w) + P.getY(edge[b]) * w, z0 = P.getZ(edge[a]) * (1 - w) + P.getZ(edge[b]) * w;
          // Longer toward the outer corner, fanning out, curling up.
          const len = (0.42 + 0.3 * Math.sin(Math.min(1, out * 1.25) * Math.PI * 0.62) + rnd() * 0.1);
          const fan = sx * (out - 0.34) * 0.75 + (rnd() - 0.5) * 0.16;
          const half = 0.011 + rnd() * 0.005;
          const first = pos.length / 3;
          const STEPS = 4;
          let x = x0, y = y0 - 0.02, z = z0 - 0.015, dx = fan, dy = -0.92, dz = 0.16;
          for (let k = 0; k <= STEPS; k++) {
            const t = k / STEPS, wid = half * (1 - t * t * 0.96);
            for (const s of [-1, 1]) {
              pos.push(x + s * wid, y, z);
              nor.push(0, -0.7, 0.7);
              lid.push(near);
              si.push(SI.getX(near), SI.getY(near), SI.getZ(near), SI.getW(near));
              sw.push(SW.getX(near), SW.getY(near), SW.getZ(near), SW.getW(near));
            }
            const step = len / STEPS;
            x += dx * step; y += dy * step; z += dz * step;
            dz += 0.32; // the curl
            const l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l;
          }
          for (let k = 0; k < STEPS; k++) { const v = first + k * 2; index.push(v, v + 1, v + 2, v + 1, v + 3, v + 2); }
        }
      }
      if (!pos.length) return;
      const g = new T.BufferGeometry();
      g.setAttribute("position", new T.BufferAttribute(new Float32Array(pos), 3));
      g.setAttribute("normal", new T.BufferAttribute(new Float32Array(nor), 3));
      g.setAttribute("skinIndex", new T.BufferAttribute(new Uint16Array(si), 4));
      g.setAttribute("skinWeight", new T.BufferAttribute(new Float32Array(sw), 4));
      g.setIndex(new T.BufferAttribute(new Uint32Array(index), 1));
      const copy = (list) => list.map((m) => {
        const a = new Float32Array(lid.length * 3);
        lid.forEach((v, i) => { a[3 * i] = m.getX(v); a[3 * i + 1] = m.getY(v); a[3 * i + 2] = m.getZ(v); });
        return new T.BufferAttribute(a, 3);
      });
      g.morphAttributes.position = copy(shapes);
      if (shapesN) g.morphAttributes.normal = copy(shapesN).map((a) => { a.array.fill(0); return a; });
      g.morphTargetsRelative = true;
      const lashes = face.clone();
      lashes.geometry = g;
      lashes.material = new T.MeshStandardMaterial({ color: 0x1a100b, roughness: 0.75, metalness: 0, side: T.DoubleSide, envMapIntensity: 0.25 });
      lashes.material.name = "lashes";
      lashes.morphTargetInfluences = new Array(shapes.length).fill(0);
      lashes.castShadow = lashes.receiveShadow = false;
      lashes.frustumCulled = false;
      face.parent.add(lashes);
      this.morphMeshes.push(lashes);
    }
    // After the shapes: the lower teeth follow the chin, and more light gets in when the mouth opens.
    updateJaw() {
      if (!this.jaw) return;
      let j = 0;
      for (const [name, s] of this.jawShare) j += this.morphs[name].x * s;
      this.jaw.rotation.x = Math.max(-0.02, Math.min(1.5, j)) * JAW_TURN;
      const m = this.morphs;
      const open = Math.min(1, Math.max(0, j) * 1.5 + m.upperUpL.x * 0.5 + m.lipsPart.x * 0.5 + (m.v_E.x + m.v_I.x + m.v_DD.x + m.v_nn.x + m.v_KK.x + m.v_CH.x + m.v_SS.x) * 0.4);
      this.teethMat.color.setScalar(0.9 + 0.2 * open);
      if (this.tongueMat) {
        this.tongueMat.color.setScalar(1 + 0.7 * open);
        // T, D, N, L: the tip goes up behind the upper teeth. TH: it comes forward, between the teeth.
        const up = m.v_DD.x + m.v_nn.x * 1.2;
        const th = m.v_TH.x;
        this.tongueU.lift.value = Math.min(1, up * 1.5) * 1.05 + th * 0.62;
        this.tongueU.out.value = th * 1.75;
      }
    }

    // A webcam shot from the waist up, with the head in the upper part (the subtitles are at the bottom).
    resize() {
      if (!this.renderer) return;
      const w = this.art.clientWidth || 640, h = this.art.clientHeight || 360;
      this.renderer.setSize(w, h, false);
      const aspect = w / Math.max(1, h);
      this.camera.aspect = aspect;
      // From the chest up, like a video call: his face must be big enough to read (2026-11-05: "closer").
      const viewH = aspect >= 1.5 ? 66 : aspect >= 1 ? 64 : 72;
      this.camera.fov = (2 * Math.atan(viewH / 2 / CAM_DIST) * 180) / Math.PI;
      this.camBase = { viewH, closeH: aspect >= 1 ? 34 : 30, top: 190 };
      this.camera.updateProjectionMatrix();
      this.fitRoom(w, h);
    }
    // The picture of the room is made for this lens: its size follows the height of the video, like the size of Jake.
    fitRoom(w, h) {
      this.stageEl ||= this.art.closest(".stage");
      if (!this.stageEl) return;
      const tan = Math.tan((this.camera.fov * Math.PI) / 360);
      const height = (h * ROOM.tanV) / tan;
      const width = Math.max(height * ROOM.aspect, w * 1.2); // a very wide window: never an empty edge
      this.stageEl.style.setProperty("--room-size", `${Math.round(width)}px auto`);
      this.roomPx = h / (2 * tan); // pixels for one unit of the lens
      this.shown = null;
    }

    setEmotion(name, ms = 7000) {
      if (this.inner) return this.inner.setEmotion(name, ms);
      this.emotion = FACE[name] ? name : "neutral";
      this.emotionUntil = performance.now() + ms;
    }

    // Words are being heard. The nods themselves are decided below: not one per word.
    nod() {
      if (this.inner) return this.inner.nod();
      this.nodAsked = true;
    }
    // The learner started to speak over him.
    react(kind) {
      if (this.inner || !this.ready) return;
      const now = performance.now();
      this.pulse = Math.max(this.pulse, 0.3);
      this.pitch.v -= 0.25; // the head comes up, like "yes?"
      this.glanceEnd = 0;
      this.nextGlance = now + 4000;
      this.beat.v = 0;
      if (kind === "interrupted") {
        this.fastFade = now + 900;
        if (this.kind !== "listen") this.nextTop("listen", now);
      }
    }
    // The camera comes close to his mouth, for this sentence and the next.
    focusMouth() {
      if (this.inner || this.calm) return;
      this.focusLeft = 2;
      this.focusHold = performance.now() + 2500;
      this.xTo = this.x.x; // he stops walking
    }

    // ---------- Body ----------
    play(name, { offset = 0, once = false } = {}) {
      const clip = this.clips[name];
      if (!clip) return 0;
      const act = this.mixer.clipAction(clip);
      for (const l of this.layers) l.to = 0;
      let layer = this.layers.find((l) => l.act === act);
      if (!layer) {
        layer = { act, w: 0, to: 1 };
        this.layers.push(layer);
        act.reset();
        act.time = offset;
        act.setLoop(once ? this.T.LoopOnce : this.T.LoopRepeat, Infinity);
        act.clampWhenFinished = once;
        act.setEffectiveWeight(0);
        act.play();
      }
      layer.to = 1;
      return clip.duration;
    }
    // A one-off gesture (hello, nod, laugh…). base: how much of the quiet idle stays under it (a wave must really rise).
    gesture(name, now, { maxS = 99, base = BASE_WEIGHT } = {}) {
      const d = this.play(name, { once: true });
      if (!d) return;
      this.kind = "gesture";
      this.baseTo = base;
      this.oneShotEnd = now + Math.min(maxS, Math.max(0.8, d - 0.7)) * 1000;
    }
    nextTop(kind, now) {
      let list = kind === "talk"
        ? (["happy", "laugh", "surprised"].includes(this.emotion) ? CLIPS.talkHappy : Math.random() < 0.22 ? CLIPS.talkSide : CLIPS.talk)
        : kind === "think" ? CLIPS.think : CLIPS.listen;
      list = list.filter((n) => n !== this.lastTop && this.clips[n]);
      const name = pick(list.length ? list : CLIPS.listen);
      const clip = this.clips[name];
      this.lastTop = name;
      const piece = kind === "talk" ? rand(5, 11) : kind === "think" ? rand(3, 6) : rand(9, 20);
      this.play(name, { offset: rand(0, Math.max(0, clip.duration - piece)) });
      this.kind = kind;
      this.baseTo = BASE_WEIGHT;
      this.topEnd = now + piece * 1000;
      if (kind === "talk") this.beatArm = Math.random() < 0.5 ? 0 : 1;
    }
    updateBody(now, dt, mode, emotion) {
      const want = mode === "speaking" ? "talk" : mode === "thinking" ? "think" : "listen";
      if (this.kind === "gesture") {
        if (now > this.oneShotEnd) this.nextTop(want, now);
      } else if (want === "talk" && !this.waved) {
        // Hello: a small wave the first time he speaks.
        this.waved = true;
        this.gesture(pick(CLIPS.hello), now, { base: 0.06 });
      } else if (emotion === "laugh" && now - this.lastLaugh > 30000) {
        this.lastLaugh = now;
        this.gesture(pick(CLIPS.laugh), now, { maxS: 3.5 });
      } else if (want === "talk" && now > this.nextShrug) {
        this.nextShrug = now + rand(35000, 70000);
        this.gesture(pick(CLIPS.shrug), now);
      } else if (want !== this.kind || now > this.topEnd) {
        this.nextTop(want, now);
      }
      const fade = now < this.fastFade ? 0.28 : 0.65; // the time a gesture takes to fade in or out
      for (let i = this.layers.length - 1; i >= 0; i--) {
        const l = this.layers[i];
        const speed = dt / fade;
        l.w = l.to > l.w ? Math.min(l.to, l.w + speed) : Math.max(l.to, l.w - speed);
        const eased = l.w * l.w * (3 - 2 * l.w);
        if (l.w <= 0 && l.to === 0) { l.act.stop(); this.layers.splice(i, 1); continue; }
        l.act.setEffectiveWeight(eased);
      }
      this.base.setEffectiveWeight(this.baseW.to(this.baseTo, dt));
      // A step or two in the room: not while the learner speaks, not when he shows his mouth, and not often.
      const free = mode !== "listening" || (!this.userTalking && now - this.userQuietAt > 15000); // a long silence: he may move
      if (now > this.nextStroll && free && !this.focusLeft && !this.calm) {
        this.nextStroll = now + rand(26000, 52000);
        this.xTo = pick([-16, -9, 0, 9, 16].filter((x) => Math.abs(x - this.xTo) >= 9));
        this.zTo = pick([-8, -4, 0, 0, 5]);
      }
      const x = this.x.to(this.xTo, dt);
      const gap = this.xTo - x;
      const moving = Math.abs(gap) > 4;
      this.root.position.x = x;
      // He comes a little closer when you speak.
      const lean = mode === "listening" ? (this.userTalking ? 9 : 3) : now < this.waitUntil ? 5 : 0;
      this.root.position.z = this.z.to(this.zTo + lean, dt);
      this.root.rotation.y = this.yaw.to(Math.max(-0.3, Math.min(0.3, gap * 0.022)), dt);
      this.walkAct.setEffectiveWeight(this.walkW.to(moving ? 0.5 : 0, dt));
      this.key.target.position.x = x;
      this.key.position.x = -150 + x;
    }
    // After the clips: people talk with their whole body. The chest turns a little with the head, leans in on strong words and when
    // listening, breathes; the shoulders lift with each breath. All very small: it must not be seen, only felt.
    updateChest(now, dt, st) {
      if (!this.chest || this.calm) return;
      const t = (now - this.t0) / 1000, speaking = st.mode === "speaking";
      const { q1, q2, q3 } = this;
      const breathRate = speaking ? 0.32 : 0.24;
      this.breathPhase = (this.breathPhase || 0) + dt * breathRate * Math.PI * 2;
      const breath = Math.sin(this.breathPhase);
      const yaw = this.chestYaw.to((this.turn.x * 0.3 + this.lookX.x * 0.0022 + drift(t, 5) * (speaking ? 0.022 : 0.012)), dt);
      const lean = this.chestLean.to((st.mode === "listening" ? 0.018 : 0) + (speaking ? this.env * 0.016 : 0) + this.beat.x * 0.01 + drift(t, 6) * 0.008, dt);
      this.e1.set(lean - breath * 0.004, yaw, drift(t, 7) * 0.006);
      q1.setFromEuler(this.e1);
      this.chest.updateWorldMatrix(true, false);
      this.chest.getWorldQuaternion(q2).premultiply(q1);
      this.chest.parent.getWorldQuaternion(q3).invert();
      this.chest.quaternion.copy(q3).multiply(q2);
      this.chest.updateMatrixWorld(true);
      const lift = this.shoulders.to(breath * 0.0065 + this.beat.x * 0.007, dt);
      this.clavicles.forEach((c, i) => {
        this.e1.set(0, 0, (i ? -1 : 1) * lift);
        q1.setFromEuler(this.e1);
        c.quaternion.multiply(q1);
      });
    }
    // After the clips: the elbows closer to the body, and a small beat of one forearm on the strong words.
    updateArms(now, dt) {
      const { v1, v2, q1, q2, q3 } = this;
      const beat = this.beat.x;
      const lift = this.handLift.to(now < this.handUpUntil ? 1 : 0, dt);
      this.arms.forEach((a, n) => {
        const { upper, fore, hand } = a;
        upper.updateWorldMatrix(true, false);
        upper.getWorldPosition(v1);
        fore.updateWorldMatrix(false, false);
        fore.getWorldPosition(v2);
        const down = clamp01((v1.y - v2.y) / Math.max(1, v1.distanceTo(v2))); // 1 when the arm hangs down, 0 when it is raised
        q1.setFromAxisAngle(this.axisZ, a.sign * ARM_IN * down);
        upper.getWorldQuaternion(q2).premultiply(q1);
        const up = lift * down * (n === this.beatArm ? 1 : 0.2);
        q1.setFromAxisAngle(this.axisX, -0.55 * up);
        q2.premultiply(q1);
        upper.parent.getWorldQuaternion(q3).invert();
        upper.quaternion.copy(q3).multiply(q2);
        upper.updateWorldMatrix(false, false);
        // How far the forearm still has to go to bring the hand into the shot, a little above level (the clip may already have raised it).
        fore.updateWorldMatrix(true, false);
        fore.getWorldPosition(v2);
        hand.updateWorldMatrix(true, false);
        hand.getWorldPosition(v1);
        const hang = Math.acos(Math.max(-1, Math.min(1, (v2.y - v1.y) / Math.max(1, v2.distanceTo(v1))))); // 0: hanging, pi/2: level
        const rise = up * Math.max(0, 2.05 - hang);
        const share = (n === this.beatArm ? 1 : 0.22) * beat + rise;
        if (Math.abs(share) < 0.002) return;
        q1.setFromAxisAngle(this.axisX, -share);
        fore.getWorldQuaternion(q2).premultiply(q1);
        if (rise > 0.01) { // a hand that comes up goes toward the middle of his chest, not out to the side
          q1.setFromAxisAngle(this.axisY, -Math.sign(v2.x - this.root.position.x) * 0.36 * rise);
          q2.premultiply(q1);
        }
        fore.parent.getWorldQuaternion(q3).invert();
        fore.quaternion.copy(q3).multiply(q2);
        fore.updateWorldMatrix(false, false);
        q1.setFromAxisAngle(this.axisX, -(share - rise) * 0.7 + 0.35 * rise); // when it comes up, the hand stays relaxed
        hand.updateWorldMatrix(true, false);
        hand.getWorldQuaternion(q2).premultiply(q1);
        hand.parent.getWorldQuaternion(q3).invert();
        hand.quaternion.copy(q3).multiply(q2);
      });
    }

    // ---------- What he says and hears ----------
    onSentence(text, now) {
      this.sentence = text;
      this.lastWord = -1;
      this.sentYaw = rand(-0.05, 0.05);
      this.sentQuestion = /\?\s*$/.test(text);
      this.mood = MOODS.find(([, re]) => re.test(text))?.[0] || null;
      this.moodUntil = now + Math.max(2200, Math.min(7000, text.length * 70));
      if (Math.random() < 0.4) this.nextBlink = now + rand(0, 120);
      if (this.focusLeft) this.focusLeft--;
      if (SAY.mouth.test(text)) this.focusMouth();
      if (this.kind === "gesture") return;
      if (SAY.bye.test(text)) {
        this.gesture(pick(CLIPS.hello), now, { base: 0.06 });
      } else if (SAY.bravo.test(text) && now - this.lastClap > 120000) {
        this.lastClap = now;
        this.gesture(pick(CLIPS.clap), now, { maxS: 2.2, base: 0.1 });
      } else if (SAY.no.test(text) && now - this.lastNo > 25000) {
        this.lastNo = now;
        this.gesture(pick(CLIPS.no), now, { maxS: 2.2, base: 0.2 });
        this.shakeUntil = now + 1000;
      } else if (SAY.unsure.test(text) && now > this.nextShrug - 25000) {
        this.nextShrug = now + rand(30000, 60000);
        this.gesture(pick(CLIPS.shrug), now);
      } else if (this.emotion === "thinking" && now - this.lastThinkHand > 75000) {
        this.lastThinkHand = now;
        this.gesture(pick(CLIPS.thinkHand), now, { maxS: 3.2, base: 0.04 });
      }
    }
    // A strong word: the head, the hand and sometimes the brows go with it, like when people stress a word.
    onWord(word, now) {
      const w = word.toLowerCase();
      if (CONTRAST.test(w)) this.knit = Math.max(this.knit || 0, 0.55); // the brows come together on a "but"
      if (w.length < 4 || SMALL_WORDS.has(w) || now - this.lastBeat < 480 || Math.random() > 0.6) return;
      this.lastBeat = now;
      const force = Math.min(1, 0.55 + w.length * 0.05) * (this.calm ? 0.5 : 1);
      this.nodKick = (this.nodKick || 0) + rand(0.12, 0.26) * force * 0.06; // a soft push: a sudden speed looks like a jolt
      this.beatKick = (this.beatKick || 0) + rand(2.1, 3.6) * force * 0.066;
      // At this distance his resting hands are under the frame: on some strong words, a hand comes up to help.
      if (!this.calm && this.kind === "talk" && now - this.lastHandUp > 2600 && Math.random() < 0.5) {
        this.lastHandUp = now;
        this.handUpUntil = now + rand(1000, 2100);
        this.beatArm = Math.random() < 0.5 ? 0 : 1;
      }
      if (now - this.lastPulse > 900 && Math.random() < 0.75) {
        this.lastPulse = now;
        this.pulse = Math.max(this.pulse, rand(0.3, 0.6) * force);
      }
    }
    // The learner's voice: he leans in, tilts his head at each new phrase, and nods when a phrase ends.
    updateHearing(now, dt, st) {
      const u = st.mode === "listening" ? clamp01(st.userLevel || 0) : 0;
      this.userEnv += (u - this.userEnv) * (1 - Math.exp(-dt / (u > this.userEnv ? 0.05 : 0.3)));
      const loud = this.userEnv > 0.1;
      if (loud) this.userQuietAt = now;
      if (loud && !this.userTalking) {
        this.userTalking = true;
        this.userFrom = now;
        this.listenTilt = rand(-0.055, 0.06);
        this.listenYaw = rand(-0.035, 0.035);
        this.nextListenNod = now + rand(2200, 4500);
      } else if (this.userTalking && now - this.userQuietAt > 500) {
        this.userTalking = false;
        if (now - this.userFrom > 900 && Math.random() < 0.75) {
          this.smallNod(now, rand(0.35, 0.7));
          this.beam = 1; // a phrase ended: a small smile, "I got you"
        }
      }
      if (this.userTalking && now > this.nextListenNod) {
        this.nextListenNod = now + rand(2600, 6400);
        this.smallNod(now, rand(0.2, 0.45));
      }
      // No microphone meter (Safari on iPhone): the words coming in are the only sign.
      if (this.nodAsked) {
        this.nodAsked = false;
        if (!this.userTalking && now - this.lastNod > 3000 && Math.random() < 0.5) this.smallNod(now, rand(0.25, 0.5));
      }
    }
    smallNod(now, force) {
      if (now - this.lastNod < 1200) return;
      this.lastNod = now;
      this.nodKick = (this.nodKick || 0) + force * 0.06;
      this.pulse = Math.max(this.pulse, force * 0.2);
      // Now and then the whole body agrees.
      if (force > 0.5 && this.kind !== "gesture" && now > this.nodClip) {
        this.nodClip = now + rand(14000, 26000);
        this.gesture(pick(CLIPS.nod), now);
      }
    }

    // ---------- Face ----------
    // The sound reaches the ears after we measure it (a lot with Bluetooth): the mouth waits for it.
    heardLevel(now, st) {
      const late = (st.latency || 0) * 1000;
      if (late < 25) return st.level || 0;
      this.levels.push([now, st.level || 0]);
      while (this.levels.length > 2 && this.levels[1][0] <= now - late) this.levels.shift();
      return this.levels[0][1];
    }
    updateFace(now, dt, st, emotion) {
      const T = this.morphTargets;
      for (const k in T) T[k] = 0;
      const put = (name, v) => {
        if (PAIRS[name]) { T[`${name}L`] += v; T[`${name}R`] += v; }
        else if (name in T) T[name] += v;
      };
      for (const [name, v] of Object.entries(FACE[emotion] || FACE.neutral)) put(name, v);
      T.lidDroop += 0.1; // relaxed lids: wide-open eyes look startled
      const speaking = st.mode === "speaking";
      // A face is never still: the smile swells and fades slowly, a little more on one side, and comes back now and then.
      const t = (now - this.t0) / 1000;
      const swell = 0.5 + 0.5 * Math.sin(t * 0.9 + Math.sin(t * 0.37) * 1.5);
      const warm = speaking ? 0.1 + 0.25 * swell : 0.05 + 0.15 * swell;
      put("smile", warm); put("cheek", warm * 0.5);
      const big = clamp01((T.smileL - 1) / 0.6); // on a big smile any difference between the sides reads as a smirk
      const side = 0.06 * Math.sin(t * 0.41) * (1 - big);
      T.smileL += side; T.smileR -= side;
      this.bigSmile = big;
      if (!speaking && st.mode !== "thinking" && now > (this.nextBeam || 0)) {
        this.nextBeam = now + rand(7000, 14000);
        this.beam = Math.max(this.beam || 0, 0.7);
      }
      this.beam = (this.beam || 0) * Math.exp(-dt / 1.5);
      put("smile", this.beam * 0.7); put("cheek", this.beam * 0.45); put("squint", this.beam * 0.14);
      this.knit = (this.knit || 0) * Math.exp(-dt / 0.45);
      put("browDown", this.knit);
      const close = this.zoom.x;
      const mouth = st.mouth;

      // The voice: fast to open, slower to close.
      const lvl = clamp01(this.heardLevel(now, st));
      this.env += (lvl - this.env) * (1 - Math.exp(-dt / (lvl > this.env ? 0.03 : 0.09)));
      const open = Math.pow(clamp01(this.env * 1.5), 0.75);
      if (speaking && mouth) {
        if (this.mouthCache?.text !== mouth.text) this.mouthCache = sentenceMouth(mouth.text);
        const m = this.mouthCache, i = Math.max(0, Math.min(m.shape.length - 1, mouth.i));
        if (m.word[i] >= 0 && m.word[i] !== this.lastWord) {
          this.lastWord = m.word[i];
          this.onWord(m.words[this.lastWord], now);
        }
        // The sounds in time. Without timings (a browser voice): even letters.
        let chars = mouth.chars, ms = mouth.ms;
        if (!chars?.length || ms == null) { ms = mouth.i * 70; chars = this.evenChars(mouth.text); }
        let tl = this.timeline;
        if (tl?.text !== mouth.text || tl.known !== chars.length) tl = this.timeline = buildTimeline(mouth.text, chars);
        const mx = mouthAt(tl, ms + 50, this.mouthNow); // the mouth takes its shape just before the sound, as people do: measured on a whole sentence
        // Louder: a little more open. Close-up: he articulates a little more. Closed lips stay closed.
        const amp = (0.55 + 0.75 * open) * (1 + 0.15 * close);
        for (const k of MOUTH_KEYS) T[k] += k === "v_PP" || k === "v_FF" ? mx[k] : mx[k] * amp;
        const wide = mx.v_aa + mx.v_E * 0.7 + mx.v_O * 0.5 + mx.v_I * 0.45;
        T.upperUpL *= 0.3; T.upperUpR *= 0.3; // the wide smile lets go of the upper lip while he talks, or the mouth never closes between sounds
        put("upperUp", 0.08 * wide * amp); put("lowerDown", 0.1 * wide * amp); // a little teeth show when he talks
        // The lips cannot smile and shape a sound at once: the smile stays in the corners, the cheeks and the eyes, and gives way to round lips.
        const busy = clamp01(mx.v_U + mx.v_O * 0.85 + mx.pucker + mx.funnel + mx.v_PP * 0.7 + mx.v_FF * 0.5 + mx.v_CH * 0.6 + mx.v_RR * 0.5);
        const keep = (0.4 + 0.6 * (1 - busy)) * 0.5;
        T.smileL = Math.min(0.95, T.smileL * keep); T.smileR = Math.min(0.95, T.smileR * keep);
        T.dimpleL *= 0.6; T.dimpleR *= 0.6;
        T.jawOpen *= 0.35;
      } else if (speaking) {
        T.v_aa += 0.34 * open;
      } else {
        T.lipsPart += 0.1 * (1 - this.bigSmile); // a closed mouth at rest looks like a held breath
      }
      if (speaking && st.question && mouth && mouth.progress > 0.55) { put("browOuter", 0.4); T.browInnerUp += 0.3; }
      // The end of what he says is warmer than its middle.
      if (speaking && !st.question && mouth && mouth.progress > 0.7) { const f = (mouth.progress - 0.7) / 0.3; put("smile", 0.12 * f); put("cheek", 0.2 * f); }
      // The lips cannot stretch and shape words at once: while he talks, the smile sits in the corners and the eyes.
      if (speaking) {
        T.lowerDownL *= 0.45; T.lowerDownR *= 0.45;
        T.smileL *= 0.82; T.smileR *= 0.82; T.jawOpen *= 0.4;
      }
      // After a question: brows up, a smile, "your turn".
      if (now < this.waitUntil && !speaking && st.mode !== "thinking") {
        const f = clamp01((this.waitUntil - now) / 500);
        put("browOuter", 0.42 * f); T.browInnerUp += 0.28 * f; put("smile", 0.5 * f); put("cheek", 0.3 * f);
      }
      // While you speak: attentive, and warmer as you go on.
      if (this.userTalking) {
        const f = clamp01((now - this.userFrom) / 4000);
        put("smile", 0.2 + 0.3 * f); put("cheek", 0.12 + 0.2 * f); T.browInnerUp += 0.14; put("wide", 0.06);
      }
      // He looks for his answer.
      if (st.mode === "thinking") { T.browOuterR += 0.35; T.browDownL += 0.18; T.lipsPart += 0.14; } // about to speak: the lips part
      this.pulse *= Math.exp(-dt / 0.35);
      T.browInnerUp += this.pulse;
      put("browOuter", this.pulse * 0.8);

      // Blinks: faster when he thinks, sometimes two in a row. The lids follow the eyes when he looks down.
      if (now > this.nextBlink) {
        this.blinkAt = now;
        const again = Math.random() < 0.14;
        this.nextBlink = now + (again ? 240 : rand(2300, 5600));
      }
      const b = (now - this.blinkAt) / 1000;
      // Lids come down fast and rise slowly, with a soft start and end.
      const blink = b < 0.075 ? (b / 0.075) ** 1.6 : b < 0.095 ? 1 : b < 0.3 ? (1 - (b - 0.095) / 0.205) ** 2.2 : 0;
      T.blinkL += Math.max(0, -this.lookY.x) * 0.012;
      T.blinkR += Math.max(0, -this.lookY.x) * 0.012;

      // The mouth settles slowly when he stops talking: it does not snap shut.
      const mouthK = speaking && mouth ? 50 : 15;
      for (const k of MOUTH_KEYS) if (k.startsWith("v_") && k !== "v_PP" && k !== "v_FF") this.morphs[k].k = mouthK;
      for (const name in this.morphs) {
        const s = this.morphs[name];
        s.to(Math.min(name.startsWith("smile") || name.startsWith("cheek") ? 2.2 : 1.3, Math.max(0, T[name])), dt);
      }
      for (const o of this.morphMeshes) {
        const d = o.morphTargetDictionary, inf = o.morphTargetInfluences;
        for (const name in d) {
          let v = this.morphs[name].x;
          if (name === "blinkL" || name === "blinkR") v = Math.max(v, blink);
          inf[d[name]] = Math.max(0, v);
        }
      }
      this.updateJaw();
    }
    evenChars(text) {
      if (this.even?.text !== text) this.even = { text, chars: Array.from(text, (_, i) => i * 70) };
      return this.even.chars;
    }

    // Takes a bone from where the clip put it toward "looking at this point, upright" (share f of the way), plus an
    // extra turn. So a clip that looks away or tilts the head only shows a little: he keeps eye contact.
    aim(bone, rest, target, f, extra = null) {
      const { v1, q1, q2 } = this;
      bone.updateWorldMatrix(true, false);
      bone.getWorldQuaternion(q2);
      bone.getWorldPosition(v1);
      v1.subVectors(target, v1).normalize();
      q1.setFromUnitVectors(this.ahead, v1).multiply(rest);
      q2.slerp(q1, f);
      if (extra) q2.premultiply(extra);
      bone.parent.getWorldQuaternion(q1).invert();
      bone.quaternion.copy(q1).multiply(q2);
      bone.updateWorldMatrix(false, false);
    }
    updateHead(now, dt, st, emotion) {
      const mode = st.mode, t = (now - this.t0) / 1000;
      const speaking = mode === "speaking", progress = st.mouth?.progress || 0;
      const close = this.zoom.x;
      const hearing = mode === "listening" || now < this.waitUntil;
      const tilt = (HEAD_TILT[emotion] || 0) + (st.question && progress > 0.55 ? 0.05 : 0) + (hearing ? this.listenTilt : 0) + (now < this.waitUntil ? 0.04 : 0) + drift(t, 3) * (speaking ? 0.024 : 0.013);
      // The head falls a little at the end of a statement and rises at the end of a question, like the voice.
      const melody = speaking ? (st.question ? (progress > 0.6 ? -0.03 : 0) : progress > 0.82 ? 0.03 : 0) : 0;
      this.nodKick = (this.nodKick || 0) * Math.exp(-dt / 0.14);
      const pitch = this.pitch.to((mode === "listening" ? 0.015 : 0) + melody + this.env * 0.02 + drift(t, 2) * (speaking ? 0.016 : 0.008) + this.nodKick, dt);
      const roll = this.roll.to(tilt * (1 - close * 0.6), dt);
      const yaw = this.turn.to((drift(t, 1) * (speaking ? 0.04 : 0.018) + (speaking ? this.sentYaw : hearing ? this.listenYaw : 0)) * (1 - close * 0.7), dt)
        + (now < this.shakeUntil ? Math.sin((this.shakeUntil - now) * 0.0125) * 0.07 * clamp01((this.shakeUntil - now) / 400) : 0); // "no": a small shake of the head

      // Where he looks: the learner, with a glance away now and then, and up to the side when he thinks.
      if (now > this.nextGlance) {
        this.nextGlance = now + rand(4500, 9500);
        this.glanceEnd = now + rand(450, 1000);
        this.glance = [rand(-34, 34), rand(-6, 22)];
        this.nextBlink = now + 30; // people blink when their eyes jump
      }
      let gx = 0, gy = 0;
      if (close > 0.3) { /* he shows his mouth: eye contact */ }
      else if (mode === "thinking" || emotion === "thinking") { gx = -30; gy = 22; }
      else if (now < this.glanceEnd && speaking) { gx = this.glance[0]; gy = this.glance[1]; }
      else if (now - this.ptr.at < 1500) { gx = this.ptr.x * 30; gy = -this.ptr.y * 16; } // your pointer on the video
      const lx = this.lookX.to(gx, dt), ly = this.lookY.to(gy, dt);
      const ex = this.eyeX.to(gx, dt), ey = this.eyeY.to(gy, dt);
      const cam = this.camera.position, look = this.look;
      const far = cam.z / 240; // the same angle when the camera is closer
      look.set(cam.x + lx * far, cam.y + ly * far, cam.z);
      this.aim(this.neck, this.neckRest, look, 0.4);
      this.qExtra.setFromEuler(this.e1.set(pitch, yaw, roll));
      this.aim(this.head, this.headRest, look, 0.8 + close * 0.15, this.qExtra);
      // The eyes finish the move: all the way to the point, with tiny saccades.
      // Someone who talks with you looks at one of your eyes, then the other, and now and then at your mouth.
      if (!this.sacAt || now > this.sacAt) {
        this.sacAt = now + rand(700, 2400);
        this.sacSide = -(this.sacSide || 1);
        this.sac = hearing && Math.random() < 0.22 ? [rand(-1, 1), -5.5] : [this.sacSide * rand(1.2, 2.6), rand(-1, 1)];
      }
      this.sacX = (this.sacX || 0) + (this.sac[0] - (this.sacX || 0)) * (1 - Math.exp(-dt / 0.022));
      this.sacY = (this.sacY || 0) + (this.sac[1] - (this.sacY || 0)) * (1 - Math.exp(-dt / 0.022));
      this.eyePoint.set(cam.x + (ex + this.sacX) * far, cam.y + (ey + this.sacY) * far, cam.z);
      this.eyes.forEach((e, i) => this.aim(e, this.eyeRest[i], this.eyePoint, 1));
      this.eyes[0].getWorldPosition(this.eyeMid);
      this.eyes[1].getWorldPosition(this.v1);
      this.eyeMid.add(this.v1).multiplyScalar(0.5);
    }

    // ---------- Every frame ----------
    frame(now, st = {}) {
      if (this.inner) return this.inner.frame(now, st);
      if (!this.ready || this.disposed || this.lost || document.hidden) return;
      const dt = Math.min(0.05, Math.max(0.001, (now - (this.last || now - 16)) / 1000));
      this.last = now;
      if (now > this.emotionUntil) this.emotion = "neutral";
      // The reply's feeling, or what the words of this sentence say when that feeling is a mild one.
      const emotion = !STRONG_FEELING.has(this.emotion) && this.mood && now < this.moodUntil ? this.mood : this.emotion;
      if (this.prevMode === "speaking" && st.mode !== "speaking") {
        this.waitUntil = this.sentQuestion ? now + 2400 : 0;
        this.sentence = null;
      }
      this.prevMode = st.mode;
      if (st.mode === "speaking" && st.mouth && st.mouth.text !== this.sentence) this.onSentence(st.mouth.text, now);
      this.updateHearing(now, dt, st);
      this.updateBody(now, dt, st.mode, emotion);
      this.beatKick = (this.beatKick || 0) * Math.exp(-dt / 0.13);
      this.beat.to(this.beatKick, dt);
      this.mixer.update(dt);
      this.root.updateMatrixWorld(true);
      this.updateChest(now, dt, st);
      this.updateArms(now, dt);
      this.moveCamera(now, dt, st);
      this.updateFace(now, dt, st, emotion);
      this.updateHead(now, dt, st, emotion);
      this.renderer.render(this.scene, this.camera);
      this.watchSpeed(dt);
    }
    // A camera on a stand, about 2.4 m from him: a very small drift. It follows him a little when he walks, and goes to his
    // mouth for a close-up. The room behind moves as a real room would: less than he does, and it grows in the close-up.
    moveCamera(now, dt, st) {
      const t = (now - this.t0) / 1000, c = this.camBase;
      if (this.focusLeft && st.mode !== "speaking" && now > this.focusHold) this.focusLeft = 0;
      const z = this.calm ? 0 : this.zoom.to(this.focusLeft ? 1 : 0, dt);
      const viewH = lerp(c.viewH, c.closeH, z);
      const dist = (viewH / 2) / Math.tan((this.camera.fov * Math.PI) / 360);
      const farY = c.top - c.viewH / 2;
      const mouthY = (this.eyeMid.y || 172) - 8; // the mouth, a little above the middle (the subtitles are at the bottom)
      const cy = lerp(farY, mouthY + viewH * 0.02, z);
      const followX = this.root.position.x * 0.3;
      const cx = lerp(followX, this.eyeMid.x || 0, z);
      const shake = 1 - z * 0.7;
      const dx = (Math.sin(t * 0.23) * 0.5 + Math.sin(t * 0.61) * 0.18) * shake;
      const dy = Math.sin(t * 0.31) * 0.28 * shake;
      const lift = 3 * (1 - z) + dy;
      this.camera.position.set(cx + dx, cy + lift, dist);
      this.camera.lookAt(cx, cy, 0);
      this.camera.updateMatrixWorld(true);
      this.moveRoom(cx, dx, cy, lift, dist);
    }
    // cx, cy: where the camera aims, in his plane. dx, lift: how far the camera is beside and above that line. dist: from him.
    // The picture is a wall ROOM.behind cm behind him, seen from the resting camera: this is where that wall goes now.
    moveRoom(cx, dx, cy, lift, dist) {
      if (this.calm || !this.roomPx) return;
      const c = this.camBase, far = dist + ROOM.behind;
      const rest = (c.viewH / 2) / Math.tan((this.camera.fov * Math.PI) / 360);
      const scale = (rest + ROOM.behind) / far;
      const aim = 1 / dist - 1 / far, aimRest = 1 / rest - 1 / (rest + ROOM.behind);
      const x = (dx * aim - cx / far) * this.roomPx;
      const y = (3 * aimRest * scale - (ROOM.aimY - cy) / far - lift * aim) * this.roomPx;
      const old = this.shown;
      if (old && Math.abs(x - old.x) < 0.08 && Math.abs(y - old.y) < 0.08 && Math.abs(scale - old.scale) < 0.0004) return;
      this.shown = { x, y, scale };
      const s = this.stageEl.style;
      s.setProperty("--room-x", `${x.toFixed(2)}px`);
      s.setProperty("--room-y", `${y.toFixed(2)}px`);
      s.setProperty("--room-s", scale.toFixed(4));
    }
    // A slow machine: fewer pixels, then no cast shadows, rather than a jerky Jake.
    watchSpeed(dt) {
      this.frames++;
      this.sumDt += dt;
      if (this.frames < 100) return;
      const avg = this.sumDt / this.frames;
      this.frames = this.sumDt = 0;
      if (avg < 0.027) { this.slowRuns = 0; return; }
      this.slowRuns = (this.slowRuns || 0) + 1;
      if (this.slowRuns < 2) return; // one slow moment is not a slow machine
      this.slowRuns = 0;
      if (this.quality >= 3) {
        if (avg > 0.045) this.takeOver(new Error("this machine is too slow for 3D"));
        return;
      }
      this.quality++;
      if (this.hair) { const n = this.hair.geometry.index.count; this.hair.geometry.setDrawRange(0, Math.floor((n * (this.quality === 1 ? 0.55 : 0.35)) / 6) * 6); } // fewer strands first: they are in random order
      if (this.quality === 2) {
        this.renderer.shadowMap.enabled = false;
        this.scene.traverse((o) => { if (o.isMesh) o.material.needsUpdate = true; });
        return;
      }
      this.pixelRatio = this.quality === 1 ? Math.min(this.pixelRatio, 1.25) : 1;
      this.renderer.setPixelRatio(this.pixelRatio);
      this.resize();
    }

    cleanUp() {
      this.ready = false;
      clearTimeout(this.lostTimer);
      if (this.onPointer) window.removeEventListener("pointermove", this.onPointer);
      this.ro?.disconnect();
      this.mixer?.stopAllAction();
      this.stageEl?.style.removeProperty("--room-x");
      this.stageEl?.style.removeProperty("--room-y");
      this.stageEl?.style.removeProperty("--room-s");
      this.stageEl?.style.removeProperty("--room-size");
      if (this.renderer) {
        const canvas = this.renderer.domElement;
        canvas.removeEventListener("webglcontextlost", this.onLost);
        canvas.removeEventListener("webglcontextrestored", this.onRestored);
      }
      this.scene?.traverse((o) => {
        if (!o.isMesh) return;
        o.geometry.dispose();
        for (const k of ["map", "normalMap", "roughnessMap", "metalnessMap", "emissiveMap"]) o.material[k]?.dispose();
        o.material.dispose();
      });
      this.scene?.environment?.dispose();
      this.key?.shadow.map?.dispose();
      this.renderer?.dispose();
      this.renderer?.forceContextLoss();
      this.renderer = null;
    }
    dispose() {
      this.disposed = true;
      this.cleanUp();
    }
  }

  // Jake's picture for the small faces (lists, home card): a still image, nothing to animate.
  class JakeStill {
    constructor() {
      this.art = new Image();
      this.art.className = "stage-art jake-still";
      this.art.alt = "";
      this.art.src = POSTER;
    }
    frame() {}
    setEmotion() {}
    nod() {}
  }

  window.Stage3D = Stage3D;
  window.JakeStill = JakeStill;
})();
