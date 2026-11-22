"use strict";
// Animated tutor avatars for the video-call stage, drawn in SVG.
//
// One TutorStage = one <svg>. The app calls frame(now, state) every animation frame:
//  - lips follow the real voice: loudness envelope (fast attack, slower release), spectral bands
//    (bright = wide/flat lips, dark = round lips) and viseme hints from the text (m/b/p press, f/v tuck, a/o/u…);
//  - the upper eyelids really come down to blink; eyes make saccades and hold, look at the learner while listening;
//  - the head drifts on layered smooth noise, breathes, bobs on syllable onsets, nods, tilts on questions.
// Every animated value goes through a critically damped spring, driven by the frame time (dt clamped to 50 ms),
// and the DOM is only touched when a value really moved.
(() => {
  const LOOKS = {
    emma: {
      skin: { hi: "#FFEADB", base: "#F7D3BC", mid: "#EEC0A3", shade: "#DCA083", deep: "#BF8064" },
      neck: "#EDBB9C",
      hair: { hi: "#D98A4E", base: "#9C4A22", dark: "#5E2610", line: "#3E180A" },
      brow: "#7A3D1E",
      iris: { hi: "#8DB07A", base: "#4E7346", rim: "#22351E" },
      lash: "#2E160C",
      lips: { up: "#B44D57", low: "#CC6671", line: "#7C2D38", hi: "#F8BBBE", inner: "#3E1219", tongue: "#CB636D" },
      blush: "#F28C7D", blushK: 1,
      lid: "#C4826B", lidK: 0.55,
      top: { hi: "#4FC1C0", base: "#1F9A9A", shade: "#137474", fold: "#0B5454" },
      gold: { base: "#D7A034", hi: "#FFE7A6" },
      // London flat, big windows behind her: cool daylight rims both sides.
      rim: { side: 0, color: "#EEF4FF", k: 0.2 },
    },
    jake: {
      skin: { hi: "#F8D9C2", base: "#EDC0A2", mid: "#E2AE8D", shade: "#C98E6C", deep: "#A86E50" },
      neck: "#DDA888",
      hair: { hi: "#9C7656", base: "#5C412B", dark: "#36251A", line: "#22170F" },
      brow: "#4A3322",
      iris: { hi: "#7FA6CC", base: "#40678F", rim: "#1A2C40" },
      lash: "#2A1D14",
      lips: { up: "#9A5148", low: "#AF665A", line: "#66322B", hi: "#E5AB9E", inner: "#36120F", tongue: "#BE5D61" },
      blush: "#D0705B", blushK: 0.5,
      lid: "#9D6446", lidK: 0.38,
      top: { hi: "#5A6F95", base: "#33466B", shade: "#22314F", fold: "#162139" },
      beard: "#5A4030", frame: "#2B2420",
      // Home office, sunset window on the viewer's left: warm light on that side.
      rim: { side: -1, color: "#FFD2A0", k: 0.6 },
    },
  };

  // Face outline (M + 6 cubic segments) and anchor points per tutor. The jaw opens by pulling the chin down.
  const GEO = {
    emma: {
      face: [200, 104, 246, 104, 274, 136, 275, 190, 276, 232, 262, 266, 241, 286, 228, 298, 214, 304, 200, 304, 186, 304, 172, 298, 159, 286, 138, 266, 124, 232, 125, 190, 126, 136, 154, 104, 200, 104],
      chinY: 304, mouthY: 272, eyeY: 206, browY: 178, neck: 29, iris: 7.6, lip: { w: 21.5, thU: 5.6, thL: 7.8, teeth: 5.2 },
    },
    jake: {
      face: [200, 102, 250, 102, 277, 136, 277, 192, 277, 236, 269, 268, 249, 289, 235, 302, 219, 308, 200, 308, 181, 308, 165, 302, 151, 289, 131, 268, 123, 236, 123, 192, 123, 136, 150, 102, 200, 102],
      chinY: 308, mouthY: 276, eyeY: 206, browY: 182, neck: 33, iris: 7.2, lip: { w: 22, thU: 4.5, thL: 6.6, teeth: 5 },
    },
  };

  // Emotion targets. smile: mouth corners; bIn/bOut: inner/outer brow raise; eye: upper lid opening;
  // sq: lower lid/cheek raise; tilt: head roll (deg); open: jaw; round: lips; asym: one brow/corner; shift: mouth sideways.
  const EMOTIONS = {
    neutral: { smile: 0.34, bIn: 0, bOut: 0, eye: 1, sq: 0.08, tilt: 0, open: 0, round: 0, asym: 0, shift: 0 },
    happy: { smile: 0.95, bIn: 0.25, bOut: 0.32, eye: 0.93, sq: 0.55, tilt: 2.5, open: 0.08, round: 0, asym: 0, shift: 0 },
    curious: { smile: 0.4, bIn: 0.35, bOut: 0.6, eye: 1.08, sq: 0.02, tilt: 5, open: 0, round: 0, asym: 0.6, shift: 0 },
    encouraging: { smile: 0.78, bIn: 0.45, bOut: 0.25, eye: 0.97, sq: 0.36, tilt: -3, open: 0, round: 0, asym: 0, shift: 0 },
    surprised: { smile: 0.08, bIn: 1, bOut: 1, eye: 1.22, sq: 0, tilt: 0, open: 0.32, round: 0.45, asym: 0, shift: 0 },
    empathetic: { smile: 0.3, bIn: 0.9, bOut: -0.25, eye: 0.93, sq: 0.12, tilt: -5.5, open: 0, round: 0, asym: 0, shift: 0 },
    laugh: { smile: 1.15, bIn: 0.3, bOut: 0.45, eye: 0.55, sq: 1, tilt: 4, open: 0.5, round: 0, asym: 0, shift: 0 },
    thinking: { smile: 0.14, bIn: -0.35, bOut: 0.25, eye: 0.84, sq: 0.15, tilt: 3, open: 0, round: 0, asym: 0.7, shift: -2.5 },
  };

  // Mouth shape bias for the letter being pronounced (open: jaw scale, wid: lip width, round, press: m/b/p, tuck: f/v).
  const VISEMES = {
    a: { open: 1, wid: 1.04 }, e: { open: 0.62, wid: 1.12 }, i: { open: 0.4, wid: 1.17 }, y: { open: 0.4, wid: 1.14 },
    o: { open: 0.8, wid: 0.86, round: 0.7 }, u: { open: 0.5, wid: 0.74, round: 1 }, w: { open: 0.45, wid: 0.78, round: 0.85 },
    m: { press: 1 }, b: { press: 1 }, p: { press: 1 }, f: { tuck: 1 }, v: { tuck: 1 },
    s: { open: 0.3, wid: 1.08 }, z: { open: 0.3, wid: 1.08 }, c: { open: 0.34, wid: 1.06 }, t: { open: 0.34, wid: 1.04 },
    d: { open: 0.36, wid: 1.03 }, n: { open: 0.34, wid: 1.03 }, l: { open: 0.42, wid: 1.02 }, r: { open: 0.44, wid: 1 },
    "ñ": { open: 0.38, wid: 1.04 }, j: { open: 0.5, wid: 1 }, g: { open: 0.48, wid: 1 }, k: { open: 0.46, wid: 1 },
    q: { open: 0.46, wid: 0.96, round: 0.25 }, x: { open: 0.4, wid: 1.04 }, h: { open: 0.55, wid: 1 },
  };
  const VOWELS = "aeiouy";
  const ACCENTS = { "á": "a", "à": "a", "â": "a", "é": "e", "è": "e", "ê": "e", "í": "i", "ì": "i", "ó": "o", "ò": "o", "ô": "o", "ú": "u", "ù": "u", "ü": "u" };

  // Large stage: head + shoulders. The live stage recomputes it for the box's real aspect (see stageViewBox).
  const STAGE_VIEWBOX = "-136 40 672 420";
  const FACE_VIEWBOX = "78 84 244 244";

  const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const f = (v) => Math.round(v * 100) / 100;
  let uid = 0;

  // Frame the head and shoulders for a box of the given aspect (w/h): about 420 units tall on wide boxes,
  // at least ~285 units wide on tall ones; the face stays centred, the shoulders always reach the bottom edge.
  function stageViewBox(aspect) {
    const a = clamp(aspect || 1.6, 0.3, 4);
    const h = Math.max(420, 285 / a);
    const w = h * a;
    const top = 40 - (h - 420) * 0.22;
    return `${f(200 - w / 2)} ${f(top)} ${f(w)} ${f(h)}`;
  }

  // Mirror a path (absolute M/L/C/Q/Z only) around x = 200.
  function mirror(d) {
    let n = 0;
    return d.replace(/[A-Za-z]|-?\d*\.?\d+/g, (tok) => {
      if (/[A-Za-z]/.test(tok)) { n = 0; return tok; }
      const out = n % 2 === 0 ? String(f(400 - parseFloat(tok))) : tok;
      n++;
      return out;
    });
  }

  // Smooth layered 1D gradient noise, about -1..1.
  function makeNoise(seed) {
    let a = seed >>> 0;
    const rnd = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const g = new Float32Array(256);
    for (let i = 0; i < 256; i++) g[i] = rnd() * 2 - 1;
    const n1 = (x) => {
      const i = Math.floor(x), fr = x - i;
      const u = fr * fr * fr * (fr * (fr * 6 - 15) + 10);
      const a0 = g[i & 255] * fr, a1 = g[(i + 1) & 255] * (fr - 1);
      return (a0 + (a1 - a0) * u) * 2;
    };
    return (x) => n1(x) * 0.62 + n1(x * 2.13 + 17.3) * 0.28 + n1(x * 4.37 + 41.9) * 0.1;
  }

  // A small tile of soft noise, made once: skin pores, fabric weave. It is a plain image pattern, not an SVG filter
  // (a filter would be recomputed on every animation frame). Half the dots lighten, half darken, so colours stay true.
  let grain = null;
  function grainTile() {
    if (grain !== null) return grain;
    grain = "";
    try {
      const c = document.createElement("canvas");
      c.width = c.height = 96;
      const g = c.getContext("2d"), img = g.createImageData(96, 96);
      for (let i = 0; i < img.data.length; i += 4) {
        const v = Math.random(), up = v > 0.5, a = Math.abs(v - 0.5) * 2;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = up ? 255 : 0;
        img.data[i + 3] = Math.round(a * a * 70);
      }
      g.putImageData(img, 0, 0);
      grain = c.toDataURL("image/png");
    } catch { grain = ""; }
    return grain;
  }

  // Critically damped spring (exact solution, stable for any dt).
  class Sp {
    constructor(x, w) { this.x = x; this.v = 0; this.w = w; }
    to(target, dt) {
      const w = this.w, x = this.x - target, e = Math.exp(-w * dt), q = (this.v + w * x) * dt;
      this.x = target + (x + q) * e;
      this.v = (this.v - w * q) * e;
      return this.x;
    }
    snap(v) { this.x = v; this.v = 0; }
  }

  // ---------------------------------------------------------------- drawing

  function facePath(F, drop, chinY) {
    let d = `M${F[0]} ${F[1]}`;
    for (let i = 2; i < F.length; i += 6) {
      d += "C";
      for (let j = 0; j < 6; j += 2) {
        const y = F[i + j + 1];
        const k = y > 236 ? Math.pow(Math.min(1, (y - 236) / (chinY - 236)), 1.4) : 0;
        d += (j ? " " : "") + F[i + j] + " " + f(y + drop * k);
      }
    }
    return d + "Z";
  }

  // Eye shapes for an upper-lid opening u (1 = open, <0 = shut) and lower-lid raise sq (0..1).
  // dir = +1 for the eye on the viewer's right (outer corner towards +x).
  function eyeGeom(cx, cy, dir, u, sq, lashes) {
    const ox = cx + dir * 15.5, oy = cy - 1.3; // outer corner
    const ix = cx - dir * 13.5, iy = cy + 1.3; // inner corner
    const yL = cy + 6.4 - 8.6 * sq;
    let yU = cy - 8.3 * u;
    if (yU > yL) yU = yL;
    const close = clamp(1 - (yL - yU) / 3.5);
    const cU = (4 * yU - cy) / 3, cL = (4 * yL - cy) / 3;
    const u1x = lerp(cx + dir * 5.5, cx + dir * 7, close), u2x = lerp(cx - dir * 8, cx - dir * 6.5, close);
    const l1x = cx - dir * 6.5, l2x = cx + dir * 7;
    const crY = cy - 12.6 - Math.max(0, u - 1) * 2.2 + close * 2.4 + (1 - clamp(u)) * 1.2;
    const cC = (4 * crY - cy) / 3;
    const margin = `M${f(ox)} ${f(oy)}C${f(u1x)} ${f(cU)} ${f(u2x)} ${f(cU)} ${f(ix)} ${f(iy)}`;
    const white = `${margin}C${f(l1x)} ${f(cL)} ${f(l2x)} ${f(cL)} ${f(ox)} ${f(oy)}Z`;
    const lid = `M${f(ox)} ${f(oy)}C${f(cx + dir * 6)} ${f(cC)} ${f(cx - dir * 8)} ${f(cC)} ${f(ix)} ${f(iy)}C${f(u2x)} ${f(cU)} ${f(u1x)} ${f(cU)} ${f(ox)} ${f(oy)}Z`;
    const crease = `M${f(ox - dir * 2)} ${f(oy - 3.4)}C${f(cx + dir * 5)} ${f(cC - 0.4)} ${f(cx - dir * 7)} ${f(cC - 0.4)} ${f(ix + dir * 2.5)} ${f(iy - 3.6)}`;
    const lower = `M${f(ix + dir * 1.5)} ${f(iy + 0.3)}C${f(l1x)} ${f(cL)} ${f(l2x)} ${f(cL)} ${f(ox - dir * 1.5)} ${f(oy + 0.6)}`;
    let lash = margin, fine = "";
    if (lashes) {
      lash += `M${f(ox)} ${f(oy)}L${f(ox + dir * 4.2)} ${f(oy - 2.4)}`;
      const up = clamp((cy - yU) / 6, -1, 1);
      for (let k = 0; k < 3; k++) {
        const t = 0.1 + k * 0.13, mt = 1 - t;
        const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, e = t * t * t;
        const px = a * ox + b * u1x + c * u2x + e * ix, py = a * oy + b * cU + c * cU + e * iy;
        const len = 2.7 - k * 0.55;
        fine += `M${f(px)} ${f(py)}Q${f(px + dir * 0.6)} ${f(py - up * len * 0.7)} ${f(px + dir * (1.9 - k * 0.4))} ${f(py - up * len)}`;
      }
    }
    return { white, lid, crease, lower, lash, fine, margin };
  }

  // Lips, teeth, tongue in mouth-local units (0,0 = mouth centre).
  function mouthGeom(m, P) {
    const s = m.smile, r = clamp(m.round), p = clamp(m.press), t = clamp(m.tuck), jaw = Math.max(0, m.jaw);
    const w = P.w * m.wid * (1 + 0.07 * s) * (1 - 0.27 * r);
    const cyL = -s * 4.6 - m.asym * 1.6, cyR = -s * 4.6 + m.asym * 1.6, cyM = (cyL + cyR) / 2;
    const y0 = 0.9 + s * 0.15;
    const g = jaw * 15 * (1 - p) * (1 - p) * (1 - 0.85 * t);
    const yU = y0 - jaw * 2.1 * (1 - p) * (1 - 0.6 * t) - t * 1.1 + p * 0.3;
    const yLo = yU + g + t * 3.4;
    const wi = w * (0.93 - 0.12 * r);
    const k = 0.58 + 0.34 * r + 0.06 * jaw;
    const thU = P.thU * (1 + 0.28 * r - 0.42 * p - 0.15 * Math.max(0, s));
    const thL = P.thL * (1 + 0.24 * r - 0.42 * p - 0.1 * Math.max(0, s) - 0.28 * t);
    const cU = (4 * yU - cyM) / 3, cLo = (4 * yLo - cyM) / 3;
    const pk = yU - thU - 0.5, dip = yU - thU + 1.15;
    const yB = yLo + thL, cB = (4 * yB - cyM) / 3;
    const wk = wi * k;
    const upIn = `C${f(-wk)} ${f(cU)} ${f(wk)} ${f(cU)} ${f(wi)} ${f(cyR)}`; // from (-wi,cyL)
    const upInRev = `C${f(wk)} ${f(cU)} ${f(-wk)} ${f(cU)} ${f(-wi)} ${f(cyL)}`; // from (wi,cyR)
    const loIn = `C${f(-wk)} ${f(cLo)} ${f(wk)} ${f(cLo)} ${f(wi)} ${f(cyR)}`;
    const loInRev = `C${f(wk)} ${f(cLo)} ${f(-wk)} ${f(cLo)} ${f(-wi)} ${f(cyL)}`;
    const inner = `M${f(-wi)} ${f(cyL)}${upIn}${loInRev}Z`;
    const upper = `M${f(-w)} ${f(cyL)}C${f(-w * 0.8)} ${f(cyL + (pk - cyL) * 0.25 - 0.4)} ${f(-w * 0.55)} ${f(pk)} ${f(-w * 0.3)} ${f(pk)}` +
      `C${f(-w * 0.17)} ${f(pk)} ${f(-w * 0.07)} ${f(dip)} 0 ${f(dip)}C${f(w * 0.07)} ${f(dip)} ${f(w * 0.17)} ${f(pk)} ${f(w * 0.3)} ${f(pk)}` +
      `C${f(w * 0.55)} ${f(pk)} ${f(w * 0.8)} ${f(cyR + (pk - cyR) * 0.25 - 0.4)} ${f(w)} ${f(cyR)}L${f(wi)} ${f(cyR)}${upInRev}Z`;
    const lower = `M${f(-w)} ${f(cyL)}L${f(-wi)} ${f(cyL)}${loIn}L${f(w)} ${f(cyR)}C${f(w * 0.6)} ${f(cB)} ${f(-w * 0.6)} ${f(cB)} ${f(-w)} ${f(cyL)}Z`;
    // upper teeth: narrower than the mouth (dark corners), rounded canines, hidden more by rounded lips
    const th = (P.teeth + Math.max(0, s) * 0.8) * (1 - 0.45 * r), tw = wi * (0.74 - 0.12 * r);
    const tyL = cyL + (yU - cyL) * 0.55, tyR = cyR + (yU - cyR) * 0.55, tyC = (4 * (yU + th) - (tyL + tyR) / 2 - th * 0.6) / 3;
    const teeth = `M${f(-tw)} ${f(tyL - 5)}L${f(tw)} ${f(tyR - 5)}L${f(tw)} ${f(tyR + th * 0.25)}Q${f(tw)} ${f(tyR + th * 0.62)} ${f(tw * 0.82)} ${f(tyR + th * 0.66)}` +
      `C${f(tw * 0.4)} ${f(tyC)} ${f(-tw * 0.4)} ${f(tyC)} ${f(-tw * 0.82)} ${f(tyL + th * 0.66)}Q${f(-tw)} ${f(tyL + th * 0.62)} ${f(-tw)} ${f(tyL + th * 0.25)}Z`;
    const tl = wi * (0.56 - 0.1 * r), tlk = tl * 0.7;
    const lteeth = `M${f(-tl)} ${f(yLo + 6)}L${f(-tl)} ${f(yLo - 1)}C${f(-tlk)} ${f(yLo - 3.6)} ${f(tlk)} ${f(yLo - 3.6)} ${f(tl)} ${f(yLo - 1)}L${f(tl)} ${f(yLo + 6)}Z`;
    const seam = `M${f(-w)} ${f(cyL)}C${f(-wk)} ${f(cU)} ${f(wk)} ${f(cU)} ${f(w)} ${f(cyR)}`;
    const corners = `M${f(-w - 1.6)} ${f(cyL - 1.8)}Q${f(-w - 0.6)} ${f(cyL + 0.4)} ${f(-w + 2.2)} ${f(cyL + 1)}` +
      `M${f(w + 1.6)} ${f(cyR - 1.8)}Q${f(w + 0.6)} ${f(cyR + 0.4)} ${f(w - 2.2)} ${f(cyR + 1)}`;
    const folds = `M${f(-w - 4)} ${f(cyL - 15)}C${f(-w - 8.6)} ${f(cyL - 9)} ${f(-w - 8)} ${f(cyL - 2)} ${f(-w - 4.6)} ${f(cyL + 4)}` +
      `M${f(w + 4)} ${f(cyR - 15)}C${f(w + 8.6)} ${f(cyR - 9)} ${f(w + 8)} ${f(cyR - 2)} ${f(w + 4.6)} ${f(cyR + 4)}`;
    // f/v: upper incisors resting on the tucked lower lip
    const bw = wi * 0.42, bt = yU - 2.5, bb = yU + t * 5;
    const bite = t > 0.02 ? `M${f(-bw)} ${f(bt)}L${f(bw)} ${f(bt)}L${f(bw)} ${f(bb - 1.2)}Q${f(bw)} ${f(bb)} ${f(bw - 1.6)} ${f(bb)}L${f(-bw + 1.6)} ${f(bb)}Q${f(-bw)} ${f(bb)} ${f(-bw)} ${f(bb - 1.2)}Z` : "M0 0Z";
    const shadow = `M${f(-w * 0.46)} ${f(yB + 0.7)}Q0 ${f(yB + 5.4)} ${f(w * 0.46)} ${f(yB + 0.7)}Q0 ${f(yB + 2.6)} ${f(-w * 0.46)} ${f(yB + 0.7)}Z`;
    return {
      inner, upper, lower, teeth, lteeth, seam, corners, folds, shadow, bite, biteOp: clamp(t * 1.6),
      seamOp: clamp(1 - g / 2.2) * (1 - t) * 0.9,
      foldOp: clamp((s - 0.4) * 0.75, 0, 0.42),
      lteethOp: clamp((jaw - 0.45) * 3) * (1 - r),
      hi: [0, f(yLo + thL * 0.42), f(w * 0.3), f(Math.max(0.6, thL * 0.17))],
      tongue: [0, f(yLo - 0.3), f(wi * 0.6), f(Math.max(0.4, g * 0.34))],
    };
  }

  // Body silhouette for a neck half-width n (neck + shoulders, runs well below any stage framing).
  const sil = (n) => `M${200 - n} 262 L${200 - n} 324 C${194 - n} 348 130 362 92 372 C40 386 8 420 -2 476 L-24 820 L424 820 L402 476 C392 420 360 386 308 372 C270 362 ${206 + n} 348 ${200 + n} 324 L${200 + n} 262 Z`;

  const HAIR = {
    emma: {
      back: "M200 66 C264 66 306 110 306 178 C306 236 300 276 308 318 C314 350 326 380 324 424 L302 486 L98 486 L76 424 C74 380 86 350 92 318 C100 276 94 236 94 178 C94 110 136 66 200 66 Z",
      front: "M121 207 C109 150 126 101 163 85 C190 73 231 73 257 89 C289 109 299 158 283 209 C279 193 273 179 263 169 C247 143 214 121 178 112 C160 126 146 148 139 172 C135 184 128 197 121 207 Z",
      lock: "M262 238 C280 256 294 290 298 328 C302 364 294 402 304 440 C308 456 302 470 290 476 C294 460 286 446 280 432 C270 404 274 372 270 338 C266 302 258 272 252 252 Z",
    },
    jake: {
      front: "M126 199 C116 160 118 118 146 98 C160 84 180 73 205 73 C238 73 268 86 281 119 C288 150 285 177 276 199 C273 183 270 167 261 155 C251 142 233 135 214 135 C200 135 190 132 176 134 C158 138 145 150 137 166 C132 177 129 188 128 199 Z",
    },
  };

  function buildSVG(id, s, viewBox, par) {
    const L = LOOKS[id], G = GEO[id], isL = id === "emma";
    const K = L.skin, H = L.hair, Tp = L.top;
    const u = (n) => `url(#${n}${s})`;
    const HA = HAIR[id];
    const stroke = (d, color, width, op, extra = "") => `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" stroke-opacity="${op}" stroke-linecap="round"${extra}/>`;
    const pair = (d, color, width, op, opR = op) => stroke(d, color, width, op) + stroke(mirror(d), color, width, opR);
    // A soft light or shadow line: three strokes from wide and faint to thin, instead of a blur filter.
    const soft = (d, color, width, op) => stroke(d, color, width * 2.6, op * 0.3) + stroke(d, color, width * 1.6, op * 0.45) + stroke(d, color, width, op * 0.6);
    const rim = L.rim || { side: 0, color: "#FFFFFF", k: 0.25 }, rimSide = rim.side;
    // the rim light on the window side (both sides when the windows are behind)
    const rimOn = (d, width, op) => (rimSide <= 0 ? soft(d, rim.color, width, op * rim.k) : "") + (rimSide >= 0 ? soft(mirror(d), rim.color, width, op * rim.k * (rimSide ? 1 : 1)) : "");
    const tile = grainTile();
    const tex = (d, op) => (tile ? `<path d="${d}" fill="${u("gn")}" opacity="${op}"/>` : "");

    const defs = `
      <radialGradient id="sk${s}" gradientUnits="userSpaceOnUse" cx="190" cy="182" r="134" fx="176" fy="160">
        <stop offset="0" stop-color="${K.hi}"/><stop offset="0.5" stop-color="${K.base}"/><stop offset="0.82" stop-color="${K.mid}"/><stop offset="1" stop-color="${K.shade}"/></radialGradient>
      <linearGradient id="nk${s}" gradientUnits="userSpaceOnUse" x1="0" y1="262" x2="0" y2="400">
        <stop offset="0" stop-color="${K.shade}"/><stop offset="0.42" stop-color="${L.neck}"/><stop offset="1" stop-color="${K.mid}"/></linearGradient>
      <linearGradient id="hr${s}" gradientUnits="userSpaceOnUse" x1="0" y1="66" x2="0" y2="${isL ? 480 : 210}">
        <stop offset="0" stop-color="${H.base}"/><stop offset="1" stop-color="${H.dark}"/></linearGradient>
      <linearGradient id="tp${s}" gradientUnits="userSpaceOnUse" x1="0" y1="340" x2="0" y2="720">
        <stop offset="0" stop-color="${Tp.hi}"/><stop offset="0.3" stop-color="${Tp.base}"/><stop offset="1" stop-color="${Tp.shade}"/></linearGradient>
      <radialGradient id="ts${s}" gradientUnits="userSpaceOnUse" cx="168" cy="450" r="330">
        <stop offset="0.48" stop-color="${Tp.fold}" stop-opacity="0"/><stop offset="1" stop-color="${Tp.fold}" stop-opacity="0.6"/></radialGradient>
      <radialGradient id="hd${s}"><stop offset="0" stop-color="${H.dark}" stop-opacity="0.75"/><stop offset="1" stop-color="${H.dark}" stop-opacity="0"/></radialGradient>
      <radialGradient id="bl${s}"><stop offset="0" stop-color="${L.blush}" stop-opacity="${0.42 * L.blushK}"/><stop offset="1" stop-color="${L.blush}" stop-opacity="0"/></radialGradient>
      <radialGradient id="wh${s}"><stop offset="0" stop-color="#FFFFFF" stop-opacity="0.26"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></radialGradient>
      <radialGradient id="sc${s}" cx="0.5" cy="0.62" r="0.62"><stop offset="0" stop-color="#FFFDFB"/><stop offset="0.7" stop-color="#F6EEE9"/><stop offset="1" stop-color="#E0CFC6"/></radialGradient>
      <radialGradient id="ir${s}" cx="0.42" cy="0.36" r="0.64"><stop offset="0" stop-color="${L.iris.hi}"/><stop offset="0.55" stop-color="${L.iris.base}"/><stop offset="1" stop-color="${L.iris.rim}"/></radialGradient>
      <radialGradient id="ao${s}"><stop offset="0.5" stop-color="#05040A" stop-opacity="0.26"/><stop offset="1" stop-color="#05040A" stop-opacity="0"/></radialGradient>
      <linearGradient id="kl${s}" gradientUnits="userSpaceOnUse" x1="${rimSide < 0 ? 118 : 282}" y1="0" x2="${rimSide < 0 ? 282 : 118}" y2="0">
        <stop offset="0" stop-color="#FFFFFF" stop-opacity="${rimSide ? 0.13 : 0.04}"/><stop offset="0.5" stop-color="#FFFFFF" stop-opacity="0"/><stop offset="1" stop-color="${K.deep}" stop-opacity="${rimSide ? 0.27 : 0.1}"/></linearGradient>
      <radialGradient id="cs${s}"><stop offset="0" stop-color="${Tp.fold}" stop-opacity="0.42"/><stop offset="1" stop-color="${Tp.fold}" stop-opacity="0"/></radialGradient>
      <radialGradient id="dk${s}"><stop offset="0" stop-color="${K.deep}" stop-opacity="0.3"/><stop offset="1" stop-color="${K.deep}" stop-opacity="0"/></radialGradient>
      <radialGradient id="ws${s}"><stop offset="0" stop-color="${L.blush}" stop-opacity="0.32"/><stop offset="1" stop-color="${L.blush}" stop-opacity="0"/></radialGradient>
      <radialGradient id="pu${s}"><stop offset="0.6" stop-color="#0A0604"/><stop offset="1" stop-color="#1E140E"/></radialGradient>
      <linearGradient id="lu${s}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${L.lips.up}"/><stop offset="0.7" stop-color="${L.lips.up}"/><stop offset="1" stop-color="${L.lips.line}" stop-opacity="0.9"/></linearGradient>
      <linearGradient id="ll${s}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${L.lips.line}" stop-opacity="0.85"/><stop offset="0.3" stop-color="${L.lips.low}"/><stop offset="1" stop-color="${L.lips.up}"/></linearGradient>
      <linearGradient id="gl${s}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFFFFF" stop-opacity="0.16"/><stop offset="0.45" stop-color="#FFFFFF" stop-opacity="0.02"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0.08"/></linearGradient>
      ${tile ? `<pattern id="gn${s}" width="48" height="48" patternUnits="userSpaceOnUse"><image href="${tile}" width="48" height="48"/></pattern>` : ""}
      <clipPath id="fc${s}"><path class="av-fclip"/></clipPath>
      <clipPath id="ecL${s}"><path class="av-eclip-L"/></clipPath>
      <clipPath id="ecR${s}"><path class="av-eclip-R"/></clipPath>
      <clipPath id="mc${s}"><path class="av-mclip"/></clipPath>
      ${isL ? "" : `<linearGradient id="st${s}" gradientUnits="userSpaceOnUse" x1="0" y1="236" x2="0" y2="300"><stop offset="0" stop-color="${L.beard}" stop-opacity="0.02"/><stop offset="1" stop-color="${L.beard}" stop-opacity="0.24"/></linearGradient>
      <pattern id="stp${s}" width="7" height="7" patternUnits="userSpaceOnUse"><g fill="${L.beard}"><circle cx="1" cy="1.4" r="0.5"/><circle cx="4.3" cy="0.7" r="0.45"/><circle cx="2.7" cy="4.1" r="0.5"/><circle cx="5.8" cy="3.5" r="0.42"/><circle cx="0.7" cy="5.6" r="0.4"/><circle cx="4.6" cy="6.1" r="0.45"/></g></pattern>`}`;

    // ---- hair behind everything
    const hairBack = isL ? `
      <path d="${HA.back}" fill="${u("hr")}"/>
      <ellipse cx="200" cy="304" rx="86" ry="74" fill="${u("hd")}"/>
      ${pair("M106 240 C100 290 96 330 92 380", H.line, 1.4, 0.35)}
      ${pair("M118 280 C112 320 108 350 108 384", H.hi, 2.4, 0.18)}
      ${pair("M112 300 C106 336 100 370 98 410", H.line, 1, 0.3)}
      ${rimOn("M94 178 C94 236 100 276 92 318 C86 350 74 380 76 424", 3, 0.8)}` : "";

    // ---- neck, shoulders, clothes
    const n = G.neck, a = 200 - n, b = 200 + n, cyb = G.chinY;
    const neck = `
      <path d="${sil(n)}" fill="${u("nk")}"/>
      <path d="M${a} 262 L${b} 262 L${b} ${cyb - 6} C${200 + n * 0.55} ${cyb + 9} ${200 + n * 0.25} ${cyb + 15} 200 ${cyb + 15} C${200 - n * 0.25} ${cyb + 15} ${200 - n * 0.55} ${cyb + 9} ${a} ${cyb - 6} Z" fill="${K.deep}" fill-opacity="0.42"/>
      <path d="M${b - 13} 262 L${b} 262 L${b} 324 C${b - 2} 336 ${b - 6} 344 ${b - 13} 350 C${b - 10} 320 ${b - 11} 290 ${b - 13} 262 Z" fill="${K.deep}" fill-opacity="0.18"/>`;
    let body;
    if (isL) {
      const top = "M146 352 C128 358 108 366 92 372 C40 386 8 420 -2 476 L-24 820 L424 820 L402 476 C392 420 360 386 308 372 C292 366 272 358 254 352 C246 386 226 404 200 404 C174 404 154 386 146 352 Z";
      body = `${neck}
        ${pair("M158 374 C168 377.5 180 379 191 377", K.deep, 1.8, 0.28)}
        ${stroke("M195 369 Q200 373 205 369", K.deep, 1.5, 0.22)}
        ${stroke("M173 334 C177 366 188 384 200 387 C212 384 223 366 227 334", L.gold.base, 1.3, 0.95)}
        <circle cx="200" cy="390.5" r="3" fill="${L.gold.base}"/><circle cx="199" cy="389.4" r="1.1" fill="${L.gold.hi}"/>
        <path d="${top}" fill="${u("tp")}"/>
        <path d="${top}" fill="${u("ts")}"/>
        ${tex(top, 0.4)}
        ${soft("M146 352 C154 386 174 404 200 404 C226 404 246 386 254 352", Tp.shade, 2.4, 0.9)}
        ${stroke("M141 356 C150 392 172 410 200 410 C228 410 250 392 259 356", Tp.fold, 1.1, 0.18)}
        ${pair("M62 540 C78 500 102 476 134 462", Tp.fold, 9, 0.09)}
        ${pair("M96 640 C106 590 124 560 152 546", Tp.fold, 8, 0.08)}
        ${pair("M150 470 C166 482 182 488 198 490", Tp.fold, 6, 0.06)}
        ${pair("M26 440 C44 410 72 392 108 382", Tp.hi, 9, 0.24, 0.1)}
        ${rimOn("M-2 476 C8 420 40 386 92 372 C110 366 128 358 146 352", 3, 0.7)}`;
    } else {
      // A soft navy crew-neck tee: rib collar, the head's shadow on the chest, wide faint folds, fabric weave.
      const tee = "M150 343 C130 355 112 363 92 372 C40 386 8 420 -2 476 L-24 820 L424 820 L402 476 C392 420 360 386 308 372 C288 363 270 355 250 343 C240 366 223 379 200 379 C177 379 160 366 150 343 Z";
      const rib = "M150 343 C160 366 177 379 200 379 C223 379 240 366 250 343";
      body = `${neck}
        <ellipse cx="200" cy="354" rx="40" ry="14" fill="${u("dk")}"/>
        <path d="${tee}" fill="${u("tp")}"/>
        <path d="${tee}" fill="${u("ts")}"/>
        ${tex(tee, 0.45)}
        <ellipse cx="200" cy="398" rx="78" ry="26" fill="${u("cs")}"/>
        ${stroke(rib, Tp.shade, 5.5, 0.72)}
        ${stroke(rib, Tp.hi, 1.3, 0.35, ' transform="translate(0 -3)"')}
        ${stroke(rib, Tp.fold, 1.2, 0.5, ' transform="translate(0 3.6)"')}
        ${pair("M118 474 C134 456 150 448 170 444", Tp.fold, 8, 0.1)}
        ${pair("M58 548 C72 512 96 488 126 476", Tp.fold, 10, 0.1)}
        ${pair("M150 572 C160 540 174 518 190 506", Tp.fold, 7, 0.07)}
        ${pair("M96 380 C88 404 84 430 84 462", Tp.shade, 1.3, 0.3)}
        ${pair("M26 440 C44 410 72 392 108 382", Tp.hi, 9, 0.3, 0.1)}
        ${rimOn("M-2 476 C8 420 40 386 92 372 C112 364 132 354 150 343", 3, 0.75)}`;
    }

    // ---- head
    const earD = isL ? "M126 202 C117 197 109 203 110 214 C111 227 117 238 127 241 Z" : "M126 200 C115 194 107 201 108 214 C109 228 115 240 126 243 Z";
    const earIn = isL ? "M123 208 C117.5 206 115.5 213 117 221 C118.5 226 121 229 124 230" : "M123 207 C116.5 205 114 212 115.5 221 C117 227 120 231 123.5 232";
    const earring = (x) => `<g class="av-earring-${x < 200 ? "L" : "R"}">
        <circle cx="${x}" cy="249" r="7" fill="none" stroke="${L.gold.base}" stroke-width="2.4"/>
        <path d="M${x - 5.9} ${246.5} Q${x - 4.5} 242.6 ${x} 242" fill="none" stroke="${L.gold.hi}" stroke-width="1.1" stroke-linecap="round"/>
        <circle cx="${x}" cy="239.6" r="2.2" fill="${L.gold.hi}"/></g>`;
    const ears = `<g class="av-ears">
        <path d="${earD}" fill="${K.mid}"/><path d="${mirror(earD)}" fill="${K.mid}"/>
        <ellipse cx="117" cy="222" rx="7" ry="11" fill="${u("ws")}"/><ellipse cx="283" cy="222" rx="7" ry="11" fill="${u("ws")}"/>
        ${pair(earIn, K.deep, 1.6, 0.34)}
        ${isL ? earring(118.5) + earring(281.5) : ""}</g>`;

    const lock = isL ? `<path d="${HA.lock}" fill="${u("hr")}"/>
      ${stroke("M276 270 C286 310 284 360 290 420", H.line, 1.3, 0.45)}${stroke("M266 262 C276 300 278 350 280 400", H.line, 1.2, 0.35)}
      ${stroke("M286 296 C292 330 290 364 294 400", H.hi, 2.5, 0.35)}` : "";

    const faceShade = `<g clip-path="${u("fc")}">
        <rect x="100" y="80" width="200" height="300" fill="${u("kl")}"/>
        <ellipse cx="192" cy="148" rx="52" ry="28" fill="url(#wh${s})" opacity="0.75"/>
        <ellipse cx="131" cy="186" rx="17" ry="36" fill="${u("dk")}" opacity="0.6"/><ellipse cx="269" cy="186" rx="17" ry="36" fill="${u("dk")}" opacity="0.6"/>
        <ellipse cx="146" cy="262" rx="21" ry="15" fill="${u("dk")}" opacity="0.42"/><ellipse cx="254" cy="262" rx="21" ry="15" fill="${u("dk")}" opacity="0.42"/>
        <ellipse cx="166" cy="219" rx="19" ry="8" fill="${u("dk")}" opacity="0.3"/><ellipse cx="234" cy="219" rx="19" ry="8" fill="${u("dk")}" opacity="0.3"/>
        <ellipse cx="200" cy="${G.chinY + 8}" rx="80" ry="24" fill="${u("dk")}" opacity="0.55"/>
        ${tile ? `<rect x="100" y="80" width="200" height="300" fill="${u("gn")}" opacity="0.13"/>` : ""}
        ${rimOn("M127 160 C121 190 123 222 131 248 C139 270 151 286 168 296", 4, 0.8)}
        <path d="M262 150 C292 200 282 270 236 318 L300 330 L300 140 Z" fill="${K.shade}" fill-opacity="${rimSide < 0 ? 0.26 : 0.16}"/>
        <path class="av-fshadow" d="${HA.front}" fill="${K.deep}" fill-opacity="${isL ? 0.3 : 0.26}" transform="translate(2 7)"/>
      </g>`;

    const noseL = `
      <path d="M205 220 C208.6 229 211.4 237 212.2 245 C210.2 240 207.4 232 203.6 222 Z" fill="${K.shade}" fill-opacity="0.5"/>
      ${stroke("M196.4 224 C195.8 231 195.8 236 196.6 240", "#FFFFFF", 2, 0.14)}
      <ellipse cx="200" cy="257.6" rx="8" ry="2" fill="${K.deep}" fill-opacity="0.2"/>
      <ellipse cx="200" cy="248" rx="8" ry="5.5" fill="${u("ws")}"/>
      ${pair("M188.5 247 C186.5 251 189 254.5 193.5 254", K.deep, 2, 0.48)}
      ${stroke("M193.5 254 C196.5 256.2 203.5 256.2 206.5 254", K.deep, 1.5, 0.28)}
      <ellipse cx="198.6" cy="245.6" rx="3.4" ry="2.4" fill="#FFFFFF" fill-opacity="0.34"/>`;
    const noseM = `
      <path d="M206 220 C209.6 230 212.6 239 213.6 248 C211.2 242 208.2 233 204.4 222 Z" fill="${K.shade}" fill-opacity="0.5"/>
      ${stroke("M196.4 225 C195.8 232 195.8 238 196.6 243", "#FFFFFF", 2, 0.12)}
      <ellipse cx="200" cy="260.6" rx="9.5" ry="2.2" fill="${K.deep}" fill-opacity="0.22"/>
      <ellipse cx="200" cy="250" rx="9" ry="6" fill="${u("ws")}"/>
      ${pair("M186.5 249 C184 253.5 187.5 257.5 192.5 256.5", K.deep, 2.2, 0.46)}
      ${stroke("M192.5 256.5 C196 258.6 204 258.6 207.5 256.5", K.deep, 1.6, 0.28)}
      <ellipse cx="198.5" cy="247.6" rx="3.8" ry="2.6" fill="#FFFFFF" fill-opacity="0.3"/>`;

    // Iris fibres: thin rays from the pupil to the rim. The catchlight is the window, on the light's side.
    const irisFibres = (cx, cy) => Array.from({ length: 16 }, (_, k) => {
      const a = (k / 16) * Math.PI * 2 + 0.1, r0 = 4, r1 = G.iris - 1.2;
      return `M${f(cx + Math.cos(a) * r0)} ${f(cy + Math.sin(a) * r0)}L${f(cx + Math.cos(a) * r1)} ${f(cy + Math.sin(a) * r1)}`;
    }).join("");
    const glint = rimSide < 0 ? -2.6 : 2.6;
    const eye = (side) => {
      const cx = side === "L" ? 166 : 234, cy = G.eyeY + 0.4;
      return `<g class="av-eye-${side}">
        <path class="av-lid" fill="${L.lid}" fill-opacity="${L.lidK}"/>
        <path class="av-crease" fill="none" stroke="${K.deep}" stroke-opacity="0.32" stroke-width="1.4" stroke-linecap="round"/>
        <path class="av-white" fill="${u("sc")}"/>
        <g clip-path="${u("ec" + side)}">
          <g class="av-iris">
            <circle cx="${cx}" cy="${cy}" r="${G.iris}" fill="${u("ir")}"/>
            <path d="${irisFibres(cx, cy)}" fill="none" stroke="${L.iris.hi}" stroke-opacity="0.32" stroke-width="0.45"/>
            <circle cx="${cx}" cy="${cy}" r="${G.iris - 0.5}" fill="none" stroke="${L.iris.rim}" stroke-width="1.3" stroke-opacity="0.8"/>
            <circle cx="${cx}" cy="${cy}" r="3.5" fill="${u("pu")}"/>
            <rect x="${cx + glint - 1.3}" y="${cy - 4.5}" width="2.7" height="3.3" rx="0.7" fill="#FFFFFF" fill-opacity="0.92" transform="rotate(-6 ${cx + glint} ${cy - 3})"/>
            <circle cx="${cx - glint * 0.9}" cy="${cy + 2.6}" r="0.8" fill="#FFFFFF" fill-opacity="0.4"/>
          </g>
          <path class="av-lidshade" fill="none" stroke="#3A1E14" stroke-opacity="0.24" stroke-width="5"/>
        </g>
        <path class="av-lower" fill="none" stroke="${K.deep}" stroke-opacity="0.3" stroke-width="1.1" stroke-linecap="round"/>
        <path class="av-wet" fill="none" stroke="#FFFFFF" stroke-opacity="0.4" stroke-width="0.8" stroke-linecap="round" transform="translate(0 -0.9)"/>
        <path class="av-lash" fill="none" stroke="${L.lash}" stroke-width="${isL ? 2.6 : 2.3}" stroke-linecap="round" stroke-linejoin="round"/>
        ${isL ? `<path class="av-lashes" fill="none" stroke="${L.lash}" stroke-width="1.3" stroke-linecap="round"/>` : ""}
      </g>`;
    };

    const browD = isL
      ? "M185 183 C181 175.5 172 171.5 162 171.5 C154 171.5 148 174.5 142.5 180.5 C149.5 177.5 156 176.8 162 177 C170 177.3 177 179.5 184 186 Z"
      : "M187 187 C182 178 170 175.5 160 175.5 C152 175.5 146 177.5 140.5 182.5 C147.5 181.2 154 181 161 181.3 C170 181.6 179 183.5 186 189 Z";

    const mouth = `<g class="av-mouth" transform="translate(200 ${G.mouthY})">
        <path class="av-lipshadow" fill="${K.deep}" fill-opacity="0.3"/>
        <path class="av-folds" fill="none" stroke="${K.deep}" stroke-width="1.5" stroke-linecap="round"/>
        <path class="av-inner" fill="${L.lips.inner}"/>
        <g clip-path="${u("mc")}">
          <ellipse class="av-tongue" fill="${L.lips.tongue}"/>
          <path class="av-lteeth" fill="#EDE5DD"/>
          <path class="av-teeth" fill="#FBF8F4"/>
        </g>
        <path class="av-lowlip" fill="${u("ll")}"/>
        <ellipse class="av-liphi" fill="${L.lips.hi}" fill-opacity="0.5"/>
        <path class="av-bite" fill="#F8F4EF"/>
        <path class="av-uplip" fill="${u("lu")}"/>
        <path class="av-seam" fill="none" stroke="${L.lips.line}" stroke-width="1.4" stroke-linecap="round"/>
        <path class="av-corners" fill="none" stroke="${K.deep}" stroke-opacity="0.34" stroke-width="1.4" stroke-linecap="round"/>
      </g>`;

    const chinY = G.chinY;
    const chin = `<g class="av-chin">
        ${isL ? `<ellipse cx="200" cy="${chinY - 7}" rx="9" ry="3.2" fill="url(#wh${s})" opacity="0.55"/>` : ""}
        ${stroke(`M192 ${chinY - 13.5} Q200 ${chinY - 10.5} 208 ${chinY - 13.5}`, K.shade, 1.3, 0.3)}</g>`;

    const cheeks = `
      <ellipse cx="150" cy="226" rx="17" ry="10" fill="url(#wh${s})"/>
      <ellipse cx="250" cy="226" rx="15" ry="9" fill="url(#wh${s})" opacity="0.5"/>
      <g class="av-blush"><ellipse cx="157" cy="248" rx="19" ry="11" fill="${u("bl")}"/><ellipse cx="243" cy="248" rx="19" ry="11" fill="${u("bl")}"/></g>`;

    const fringe = isL ? `
      <path d="${HA.front}" fill="${u("hr")}"/>
      ${stroke("M180 111 C181 100 183 90 186 80", K.mid, 1.6, 0.55)}
      ${stroke("M194 92 C224 96 252 116 268 146", H.hi, 6.5, 0.32)}
      ${stroke("M163 94 C150 106 139 126 133 148", H.hi, 4, 0.22)}
      ${stroke("M190 82 C216 88 246 110 264 152", H.line, 1.3, 0.5)}
      ${stroke("M200 78 C234 82 264 106 282 150", H.line, 1.3, 0.42)}
      ${stroke("M186 98 C208 106 236 126 254 154", H.line, 1.2, 0.4)}
      ${stroke("M180 82 C160 92 140 120 130 160", H.line, 1.3, 0.42)}
      ${stroke("M174 100 C160 112 147 134 140 162", H.line, 1.2, 0.36)}
      ${stroke("M196 86 C222 92 248 112 262 140", H.hi, 1.1, 0.3)}
      ${stroke("M170 92 C152 106 140 128 134 152", H.hi, 1, 0.26)}
      ${stroke("M206 96 C230 104 252 124 266 156", H.line, 0.9, 0.36)}
      ${tile ? `<path d="${HA.front}" fill="${u("gn")}" opacity="0.3"/>` : ""}
      ${rimOn("M121 207 C111 172 113 134 130 110", 2.4, 0.9)}` : `
      <path d="${HA.front}" fill="${u("hr")}"/>
      ${pair("M125 197 C124.6 204 125.4 211 127 217", H.base, 3.2, 0.45)}
      ${stroke("M150 110 C164 94 186 84 210 82", H.hi, 4.5, 0.34)}
      ${stroke("M216 82 C240 84 260 98 271 118", H.hi, 3, 0.22)}
      ${stroke("M158 122 C170 104 190 94 214 92", H.line, 1.3, 0.55)}
      ${stroke("M182 132 C194 114 214 104 238 104", H.line, 1.3, 0.5)}
      ${stroke("M224 134 C238 120 254 114 268 120", H.line, 1.2, 0.45)}
      ${stroke("M140 150 C146 132 158 118 172 110", H.line, 1.2, 0.45)}
      ${stroke("M200 80 C222 80 246 88 262 104", H.line, 1.2, 0.4)}
      ${stroke("M146 118 C160 100 182 90 206 87", H.hi, 1.1, 0.34)}
      ${stroke("M152 130 C166 112 188 101 212 98", H.line, 0.9, 0.42)}
      ${stroke("M166 140 C178 122 198 112 222 110", H.hi, 1, 0.26)}
      ${stroke("M196 138 C210 124 228 118 248 120", H.line, 0.9, 0.38)}
      ${stroke("M212 96 C236 96 256 106 270 124", H.hi, 1.1, 0.28)}
      ${stroke("M228 108 C246 110 262 120 274 138", H.line, 0.9, 0.36)}
      ${stroke("M132 170 C134 150 142 134 154 122", H.hi, 1, 0.24)}
      ${stroke("M134 186 C136 164 144 146 158 134", H.line, 0.9, 0.34)}
      ${stroke("M262 150 C266 160 270 172 272 186", H.line, 0.9, 0.34)}
      ${stroke("M176 86 C190 80 206 78 222 80", H.hi, 1.4, 0.3)}
      ${tile ? `<path d="${HA.front}" fill="${u("gn")}" opacity="0.3"/>` : ""}
      ${rimOn("M126 199 C116 162 117 128 134 108", 2.4, 0.9)}`;

    // Static soft shade around the person: the room behind gets a little darker, so the tutor sits in it.
    const aura = `<ellipse cx="200" cy="212" rx="170" ry="190" fill="${u("ao")}"/><ellipse cx="200" cy="560" rx="360" ry="230" fill="${u("ao")}"/>`;

    return `<svg class="av-svg" viewBox="${viewBox}" preserveAspectRatio="${par}" aria-hidden="true" focusable="false">
      <defs>${defs}</defs>
      <g class="av-aura">${aura}</g>
      <g class="av-hairback">${hairBack}</g>
      <g class="av-body">${body}</g>
      <g class="av-head">
        ${lock}
        ${ears}
        <path class="av-face" fill="${u("sk")}"/>
        ${faceShade}
        <g class="av-feat">
          ${cheeks}
          ${isL ? noseL : noseM}
          ${chin}
          ${eye("L")}${eye("R")}
          <path class="av-brow-L" d="${browD}" fill="${L.brow}"/>
          <path class="av-brow-R" d="${mirror(browD)}" fill="${L.brow}"/>
          ${mouth}
        </g>
        <g class="av-fringe">${fringe}</g>
      </g>
    </svg>`;
  }

  // ---------------------------------------------------------------- stage

  class TutorStage {
    constructor(tutorId, opts = {}) {
      const id = LOOKS[tutorId] ? tutorId : "emma";
      this.tutor = tutorId;
      this.still = !!(opts && opts.still);
      const s = `av${++uid}${Math.random().toString(36).slice(2, 6)}`;
      const custom = opts && typeof opts.viewBox === "string" && opts.viewBox.trim() ? opts.viewBox.trim() : "";
      this.art = document.createElement("div");
      this.art.className = "stage-art";
      this.art.innerHTML = buildSVG(id, s, custom || STAGE_VIEWBOX, custom ? "xMidYMid slice" : "xMidYMax slice");
      this.svg = this.art.firstElementChild;
      const q = (c) => this.art.querySelector("." + c);
      const eyeEls = (side) => {
        const g = q("av-eye-" + side);
        const e = (c) => g.querySelector("." + c);
        return { lid: e("av-lid"), crease: e("av-crease"), white: e("av-white"), clip: q("av-eclip-" + side), iris: e("av-iris"), shade: e("av-lidshade"), lower: e("av-lower"), wet: e("av-wet"), lash: e("av-lash"), fine: e("av-lashes") };
      };
      this.el = {
        hairBack: q("av-hairback"), body: q("av-body"), head: q("av-head"), feat: q("av-feat"), fringe: q("av-fringe"), fshadow: q("av-fshadow"),
        ears: q("av-ears"), face: q("av-face"), fclip: q("av-fclip"), chin: q("av-chin"), blush: q("av-blush"),
        browL: q("av-brow-L"), browR: q("av-brow-R"), eyeL: eyeEls("L"), eyeR: eyeEls("R"),
        mouth: q("av-mouth"), inner: q("av-inner"), mclip: q("av-mclip"), upper: q("av-uplip"), lower: q("av-lowlip"), liphi: q("av-liphi"),
        teeth: q("av-teeth"), lteeth: q("av-lteeth"), bite: q("av-bite"), tongue: q("av-tongue"), seam: q("av-seam"), corners: q("av-corners"), folds: q("av-folds"), lipshadow: q("av-lipshadow"),
        stache: q("av-stache"), glasses: q("av-glasses"), earL: q("av-earring-L"), earR: q("av-earring-R"),
      };
      this.L = LOOKS[id];
      this.G = GEO[id];
      this.isL = id === "emma";
      this.noise = makeNoise((Math.random() * 4294967296) >>> 0);
      this._c = new Float64Array(96).fill(NaN); // last written values, to skip unchanged attributes

      const sp = (x, w) => new Sp(x, w);
      this.sp = {
        jaw: sp(0, 80), vfac: sp(1, 26), wid: sp(1, 20), round: sp(0, 18), press: sp(0, 55), tuck: sp(0, 30),
        smile: sp(EMOTIONS.neutral.smile, 7), asym: sp(0, 6), shift: sp(0, 6),
        bIn: sp(0, 8), bOut: sp(0, 8), bAsym: sp(0, 6), bPulse: sp(0, 10),
        eye: sp(1, 12), sq: sp(EMOTIONS.neutral.sq, 8),
        gx: sp(0, 38), gy: sp(0, 38),
        roll: sp(0, 3.5), yaw: sp(0, 4.5), pitch: sp(0, 6.5), tx: sp(0, 3), ty: sp(0, 3),
        lean: sp(0, 3), laugh: sp(0, 4), q: sp(0, 2.6),
      };
      this.t = Math.random() * 100; // noise clock (s)
      this._last = undefined;
      this.emotion = "neutral";
      this._emoMs = null; this._emoUntil = 0;
      this._mode = "idle";
      this.env = 0; this.envSlow = 0; this.peak = 0.3; this._lvlAt = -1e9; this._pulse = 0;
      this._vis = null; this._visAt = 0; this._turnLevel = false; this._onsetAt = -1e9; this._bobAt = -1e9; this._loudAt = -1e9;
      this.userEnv = 0; this._userTalk = 0; this._autoNodGap = 2000;
      this._nodReq = 0; this._lastNod = -1e9; this._qUntil = -1e9;
      this._gx = 0; this._gy = 0; this._nextSac = 0;
      this._blinkAt = null; this._nextBlink = null; this._double = false;
      this.breath = Math.random() * 6.28;
      this.ear = 0; this.earV = 0;
      this.P = {};
      this._eyes = [[this.el.eyeL, 166, -1], [this.el.eyeR, 234, 1]];

      if (!custom && typeof ResizeObserver === "function") {
        this._aspect = 0;
        this._ro = new ResizeObserver((entries) => {
          const r = entries[0] && entries[0].contentRect;
          if (r && r.width > 0 && r.height > 0) this._reframe(r.width / r.height);
        });
        this._ro.observe(this.art);
      }
      this._rest();
    }

    setEmotion(name, ms = 7000) {
      this.emotion = EMOTIONS[name] ? name : "neutral";
      this._emoMs = Math.max(0, +ms || 0); // the clock starts on the next frame (frame time base)
      if (this.still) this._rest();
    }

    nod() { this._nodReq = 1; }

    // Extras (not required by the app): force a blink, stop watching the element size.
    blink() { this._blinkAt = null; this._nextBlink = -1e12; }
    destroy() { if (this._ro) this._ro.disconnect(); this._ro = null; }

    _reframe(aspect) {
      if (Math.abs(aspect - this._aspect) < 0.003) return;
      this._aspect = aspect;
      this.svg.setAttribute("viewBox", stageViewBox(aspect));
    }

    // Resting pose: eyes open, soft smile, head straight.
    _rest() {
      const E = EMOTIONS[this.emotion] || EMOTIONS.neutral;
      const sp = this.sp;
      for (const k in sp) sp[k].snap(0);
      sp.wid.snap(1); sp.eye.snap(E.eye); sp.sq.snap(E.sq); sp.smile.snap(Math.max(E.smile, this.still && this.emotion === "neutral" ? 0.42 : 0));
      sp.bIn.snap(E.bIn); sp.bOut.snap(E.bOut); sp.bAsym.snap(E.asym); sp.roll.snap(this.still ? 0 : E.tilt);
      sp.jaw.snap(E.open); sp.round.snap(E.round); sp.shift.snap(E.shift);
      Object.assign(this.P, { breath: 0, bounce: 0, blink: 0, laughRoll: 0 });
      this._apply();
    }

    frame(now, st) {
      if (this.still) return;
      st = st || {};
      let dt = this._last === undefined ? 1 / 60 : (now - this._last) / 1000;
      this._last = now;
      if (!(dt >= 0)) dt = 0; else if (dt > 0.05) dt = 0.05;
      this.t += dt;
      const T = this.t, sp = this.sp, N = this.noise, P = this.P;
      const mode = st.mode === "speaking" || st.mode === "listening" || st.mode === "thinking" ? st.mode : "idle";
      const speaking = mode === "speaking", listening = mode === "listening", thinking = mode === "thinking";
      if (mode !== this._mode) { this._mode = mode; this._nextSac = now + 60; if (speaking) this._turnLevel = false; }
      if (this._nextBlink === null) this._nextBlink = now + 900 + Math.random() * 2500;

      // emotion clock
      if (this._emoMs !== null) { this._emoUntil = now + this._emoMs; this._emoMs = null; }
      if (this.emotion !== "neutral" && now >= this._emoUntil) this.emotion = "neutral";
      let E = EMOTIONS[this.emotion];
      if (thinking && this.emotion === "neutral") E = EMOTIONS.thinking;

      // ---- voice envelope: fast attack (~30 ms), slower release (~90 ms), auto-gain on a slow peak
      const lvl = speaking ? clamp(+st.level || 0) : 0;
      this.env += (lvl - this.env) * (1 - Math.exp(-dt / (lvl > this.env ? 0.03 : 0.09)));
      this.envSlow += (lvl - this.envSlow) * (1 - Math.exp(-dt / 0.28));
      this.peak = Math.max(lvl, this.peak * Math.exp(-dt / 3), 0.2);
      if (lvl > 0.02) { this._lvlAt = now; this._turnLevel = true; }
      if (lvl > 0.035) this._loudAt = now;
      const norm = clamp(this.env / (this.peak * 0.85));

      // ---- viseme hint
      let v = st.viseme ? String(st.viseme).toLowerCase().charAt(0) : null;
      if (v) { v = ACCENTS[v] || v; if (!VISEMES[v]) v = "_"; }
      // no audio analysis in this turn (level stays 0): fall back to animating from the text timing
      const noLevel = !this._turnLevel && now - this._lvlAt > 450;
      if (v !== this._vis) {
        this._vis = v; this._visAt = now;
        if (speaking && noLevel && v && v !== "_") this._pulse = VOWELS.includes(v) ? 0.35 + 0.3 * (VISEMES[v].open || 0.5) : 0.22;
      }
      const V = v && v !== "_" ? VISEMES[v] : null;
      const vAge = now - this._visAt;
      this._pulse *= Math.exp(-dt / 0.16);

      // ---- mouth targets
      let jawT = 0, widT = 1, roundT = 0, pressT = 0, tuckT = 0;
      let smileT = E.smile;
      if (listening) smileT = Math.max(smileT, 0.44);
      if (speaking) {
        let jawS = 0;
        const hush = clamp((now - this._loudAt - 40) / 80); // real silence (between words): let the lips meet
        if (this.env > 0.02 && hush < 1) { const gate = clamp((norm - 0.1) / 0.16); jawS = (1 - hush) * gate * gate * (3 - 2 * gate) * (0.13 + 0.67 * Math.pow(clamp((norm - 0.06) / 0.94), 0.85)); }
        else if (noLevel) jawS = this._pulse;
        let fac = 1, vw = 1, vr = 0;
        if (V) {
          if (V.open !== undefined) fac = clamp(V.open / 0.6, 0.5, 1.45);
          vw = V.wid || 1; vr = V.round || 0;
          if (V.press && vAge < 140) pressT = 1 - 0.15 * norm;
          if (V.tuck && vAge < 180) tuckT = 1;
        }
        let bw = 0, br = 0;
        const B = st.bands;
        if (B && jawS > 0) {
          const lo = +B.low || 0, mi = +B.mid || 0, hi = +B.high || 0, tot = lo + mi + hi;
          if (tot > 0.03) {
            bw = clamp((hi / tot - 0.2) * 3.2, -0.4, 1);
            br = clamp((lo / tot - 0.5) * 3) * clamp(1.4 - Math.abs(norm - 0.5) * 2.4);
          }
        }
        const wB = V ? 0.6 : 1;
        jawT = jawS * sp.vfac.to(fac, dt);
        widT = 1 + (vw - 1) * 0.9 + bw * 0.11 * wB;
        roundT = Math.max(vr, br * 0.75 * wB) * (jawS > 0 ? 1 : 0.3);
        jawT = Math.max(jawT, E.open * 0.45);
        smileT = Math.min(smileT, 0.9) * (1 - 0.5 * roundT) * (1 - 0.4 * tuckT);

        // syllable onsets → small head bobs, bigger on stressed syllables, sometimes a brow flick
        const rise = this.env - this.envSlow;
        if (rise > 0.09 * Math.max(this.peak, 0.3) && now - this._onsetAt > 170) {
          this._onsetAt = now;
          const k = clamp(rise / this.peak * 2.5);
          const big = k > 0.45 && now - this._bobAt > 380;
          if (big) this._bobAt = now;
          const amp = big ? 5 + 11 * k : 1.5 + 2.5 * k;
          sp.pitch.v += (Math.random() < 0.75 ? 1 : -0.7) * amp;
          sp.roll.v += (Math.random() - 0.5) * (big ? 9 : 3) * k;
          sp.yaw.v += (Math.random() - 0.5) * (big ? 6 : 2) * k;
          if (big && Math.random() < 0.35) sp.bPulse.v += 10 * k;
        }
      } else {
        jawT = E.open; roundT = E.round;
      }

      sp.jaw.to(jawT, dt); sp.wid.to(widT, dt); sp.round.to(roundT, dt); sp.press.to(pressT, dt); sp.tuck.to(tuckT, dt);
      sp.smile.to(smileT, dt); sp.asym.to(E.asym * 0.5, dt); sp.shift.to(E.shift, dt);

      // ---- question / lean / laugh
      // question: tilt + raised brows build up through the sentence and linger ~1 s after it (waiting for the answer)
      if (speaking && st.question) this._qUntil = now + 1100;
      sp.q.to(now < this._qUntil && mode !== "thinking" ? 1 : 0, dt);
      sp.lean.to(listening ? 1 : speaking ? 0.25 : 0, dt);
      sp.laugh.to(this.emotion === "laugh" ? 1 : 0, dt);
      const qW = sp.q.x;

      // ---- brows, lids
      sp.bIn.to(E.bIn + qW * 0.38 + (listening ? 0.12 : 0), dt);
      sp.bOut.to(E.bOut + qW * 0.3 + (listening ? 0.1 : 0), dt);
      sp.bAsym.to(E.asym + qW * 0.25, dt);
      sp.bPulse.to(0, dt);
      let eyeT = E.eye + (listening ? 0.03 : 0);
      if (thinking) eyeT = Math.min(eyeT, 0.86);
      sp.eye.to(eyeT, dt);
      sp.sq.to(Math.max(E.sq, (sp.smile.x - 0.55) * 0.6), dt);

      // ---- listening: nods on learner speech bursts; nod() requests
      const ul = listening ? clamp(+st.userLevel || 0) : 0;
      this.userEnv += (ul - this.userEnv) * (1 - Math.exp(-dt / (ul > this.userEnv ? 0.05 : 0.35)));
      this._userTalk = this.userEnv > 0.12 ? this._userTalk + dt : Math.max(0, this._userTalk - dt * 2);
      let nodK = 0;
      if (this._nodReq) { nodK = 1; this._nodReq = 0; }
      else if (listening && this._userTalk > 0.6 && this.userEnv > 0.15 && now - this._lastNod > this._autoNodGap) nodK = 0.75;
      if (nodK && now - this._lastNod >= 1200) {
        this._lastNod = now;
        this._autoNodGap = 1700 + Math.random() * 1800;
        sp.pitch.v += 30 * nodK;
        sp.smile.v += 1.2 * nodK;
      }

      // ---- head: layered noise + emotion tilt + question tilt, springs on top
      const act = speaking ? 1.45 : listening ? 0.75 : thinking ? 0.6 : 1;
      sp.roll.to(E.tilt + N(T * 0.31 + 3.1) * 1.5 * act + qW * 3.5 + (listening ? 1.2 : 0), dt);
      sp.yaw.to(N(T * 0.27 + 11.7) * 0.8 * act + sp.gx.x * 0.1 + (thinking ? -0.5 : 0), dt);
      sp.pitch.to(N(T * 0.37 + 23.3) * 0.55 * act - qW * 0.5 + (thinking ? -0.45 : 0) + (listening ? 0.25 : 0), dt);
      sp.tx.to(N(T * 0.21 + 37.9) * 1.6 * act, dt);
      sp.ty.to(N(T * 0.33 + 51.1) * 0.9 * act, dt);

      // breathing ~0.25 Hz with a little irregularity; laugh = quick shoulder bounce
      this.breath += dt * Math.PI * 2 * 0.25 * (1 + 0.18 * N(T * 0.1 + 71.3));
      P.breath = Math.sin(this.breath);
      const lw = sp.laugh.x;
      P.bounce = lw > 0.01 ? Math.abs(Math.sin(T * Math.PI * 4.4)) * -2.4 * lw * (0.6 + 0.4 * Math.abs(N(T * 0.9 + 5.5))) : 0;
      P.laughRoll = lw > 0.01 ? Math.sin(T * Math.PI * 2.2) * 0.9 * lw : 0;

      // ---- gaze: saccade, hold 0.8–3 s; listening = mostly at the viewer; thinking = up-left
      if (now >= this._nextSac) this._planGaze(now, this.emotion === "thinking" ? "thinking" : mode);
      sp.gx.to(this._gx, dt); sp.gy.to(this._gy, dt);

      // ---- blink: ~110 ms close, 30 ms hold, ~180 ms open; sometimes double
      if (this._blinkAt === null && now >= this._nextBlink) this._startBlink(now, mode);
      let b = 0;
      if (this._blinkAt !== null) {
        const e = now - this._blinkAt;
        if (e < 0) b = 0;
        else if (e < 110) { const x = e / 110; b = x * x * (3 - 2 * x); }
        else if (e < 140) b = 1;
        else if (e < 320) { const x = (e - 140) / 180; b = (1 - x) * (1 - x) * (1 + 2 * x) * (1 - 0.35 * x); }
        else { this._blinkAt = null; if (this._double) { this._double = false; this._blinkAt = now + 70; } }
      }
      P.blink = b;

      // earrings swing a little against the head roll
      if (this.el.earL) {
        const target = -(sp.roll.x + P.laughRoll) * 0.9;
        let rem = dt;
        while (rem > 0) { const h = Math.min(rem, 0.016); this.earV += (-(this.ear - target) * 70 - this.earV * 4.5) * h; this.ear += this.earV * h; rem -= h; }
      }

      this._apply();
    }

    _planGaze(now, mode) {
      const R = Math.random;
      const ox = this._gx, oy = this._gy;
      let gx, gy, hold = 800 + R() * 2200;
      if (mode === "thinking") { gx = -3.5 + R() * 0.9; gy = -2.6 + R() * 0.6; hold = 900 + R() * 1600; }
      else if (mode === "listening") {
        if (R() < 0.84) { gx = (R() - 0.5) * 0.9; gy = (R() - 0.5) * 0.6; hold = 1200 + R() * 1800; }
        else { gx = (R() < 0.5 ? -1 : 1) * (1.6 + R() * 1.4); gy = (R() - 0.6) * 1.6; hold = 450 + R() * 500; }
      } else if (mode === "speaking") {
        if (R() < 0.6) { gx = (R() - 0.5) * 1; gy = (R() - 0.5) * 0.7; }
        else { gx = (R() < 0.5 ? -1 : 1) * (1.4 + R() * 2.2); gy = -1.8 + R() * 2.8; hold = 600 + R() * 1400; }
      } else {
        if (R() < 0.5) { gx = (R() - 0.5) * 1.2; gy = (R() - 0.5) * 0.8; }
        else { gx = (R() - 0.5) * 7; gy = (R() - 0.55) * 4; }
      }
      this._gx = clamp(gx, -4.2, 4.2); this._gy = clamp(gy, -2.8, 2.6);
      this._nextSac = now + hold;
      const jump = Math.hypot(this._gx - ox, this._gy - oy);
      if (jump > 3.2 && this._blinkAt === null && R() < 0.65) this._startBlink(now, mode);
    }

    _startBlink(now, mode) {
      this._blinkAt = now;
      const [a, b] = mode === "speaking" ? [1800, 2700] : mode === "listening" ? [2600, 3400] : [2000, 4000];
      this._nextBlink = now + a + Math.random() * b;
      this._double = Math.random() < 0.18;
    }

    // ---- write the pose to the SVG (only what changed)
    _chg(i, a, b, c, d) {
      const C = this._c, E = 0.004;
      if (Math.abs(C[i] - a) < E && Math.abs(C[i + 1] - b) < E && Math.abs(C[i + 2] - c) < E && Math.abs(C[i + 3] - d) < E) return false;
      C[i] = a; C[i + 1] = b; C[i + 2] = c; C[i + 3] = d;
      return true;
    }

    _apply() {
      const sp = this.sp, P = this.P, el = this.el, G = this.G;
      const breath = P.breath || 0, bounce = P.bounce || 0, blink = P.blink || 0;
      const roll = sp.roll.x + (P.laughRoll || 0), yaw = sp.yaw.x, pitch = sp.pitch.x, lean = sp.lean.x;
      const jaw = Math.max(0, sp.jaw.x), press = clamp(sp.press.x), tuck = clamp(sp.tuck.x);

      // head
      const hx = sp.tx.x + yaw * 1.2, hy = sp.ty.x - breath * 0.9 + pitch * 1.2 + bounce + lean * 2.5, sc = 1 + lean * 0.028;
      if (this._chg(0, hx, hy, roll, sc * 10)) {
        const tr = `translate(${f(hx + 200)} ${f(hy + 330)}) rotate(${f(roll)}) scale(${Math.round(sc * 10000) / 10000}) translate(-200 -330)`;
        el.head.setAttribute("transform", tr);
        if (this.isL) el.hairBack.setAttribute("transform", tr);
      }
      const by = -breath * 1.4 + bounce * 0.6, bs = 1 + lean * 0.01;
      if (this._chg(4, by, bs * 10, 0, 0)) el.body.setAttribute("transform", `translate(0 ${f(by)}) translate(200 700) scale(${Math.round(bs * 10000) / 10000}) translate(-200 -700)`);
      // 2.5D parallax: features move more than the outline when the head turns or nods
      const fx = yaw * 3.2, fy = pitch * 2.4;
      if (this._chg(8, fx, fy, 0, 0)) el.feat.setAttribute("transform", `translate(${f(fx)} ${f(fy)})`);
      const rx = yaw * 1.4, ry = pitch * 0.6;
      if (this._chg(12, rx, ry, 0, 0)) {
        el.fringe.setAttribute("transform", `translate(${f(rx)} ${f(ry)})`);
        el.fshadow.setAttribute("transform", `translate(${f(rx + 2)} ${f(ry + 7)})`);
      }
      const ex = -yaw * 0.9, ey = -pitch * 1.2;
      if (this._chg(16, ex, ey, 0, 0)) el.ears.setAttribute("transform", `translate(${f(ex)} ${f(ey)})`);
      if (el.earL && this._chg(20, this.ear, 0, 0, 0)) {
        el.earL.setAttribute("transform", `rotate(${f(this.ear)} 118.5 239.6)`);
        el.earR.setAttribute("transform", `rotate(${f(this.ear)} 281.5 239.6)`);
      }
      if (el.glasses && this._chg(24, yaw * 0.8, pitch * 0.4, 0, 0)) el.glasses.setAttribute("transform", `translate(${f(yaw * 0.8)} ${f(pitch * 0.4)})`);

      // face outline follows the jaw
      const drop = jaw * 9 * (1 - press) * (1 - 0.7 * tuck) + tuck * 1.5;
      if (this._chg(28, drop, 0, 0, 0)) {
        const d = facePath(G.face, drop, G.chinY);
        el.face.setAttribute("d", d);
        el.fclip.setAttribute("d", d);
        el.chin.setAttribute("transform", `translate(0 ${f(drop)})`);
      }

      // mouth
      const smile = sp.smile.x, wid = sp.wid.x, round = sp.round.x, asym = sp.asym.x, shift = sp.shift.x;
      const c1 = this._chg(32, jaw, wid, smile, round), c2 = this._chg(36, press, tuck, asym, 0);
      if (c1 || c2) {
        const m = mouthGeom({ jaw, wid, smile, round, press, tuck, asym }, G.lip);
        el.inner.setAttribute("d", m.inner); el.mclip.setAttribute("d", m.inner);
        el.upper.setAttribute("d", m.upper); el.lower.setAttribute("d", m.lower);
        el.teeth.setAttribute("d", m.teeth); el.lteeth.setAttribute("d", m.lteeth);
        el.lteeth.setAttribute("opacity", f(m.lteethOp));
        el.seam.setAttribute("d", m.seam); el.seam.setAttribute("stroke-opacity", f(m.seamOp));
        el.corners.setAttribute("d", m.corners);
        el.folds.setAttribute("d", m.folds); el.folds.setAttribute("stroke-opacity", f(m.foldOp));
        el.lipshadow.setAttribute("d", m.shadow);
        el.bite.setAttribute("d", m.bite); el.bite.setAttribute("opacity", f(m.biteOp));
        el.liphi.setAttribute("cy", m.hi[1]); el.liphi.setAttribute("rx", m.hi[2]); el.liphi.setAttribute("ry", m.hi[3]);
        el.tongue.setAttribute("cy", m.tongue[1]); el.tongue.setAttribute("rx", m.tongue[2]); el.tongue.setAttribute("ry", m.tongue[3]);
      }
      if (this._chg(40, shift, 0, 0, 0)) el.mouth.setAttribute("transform", `translate(${f(200 + shift)} ${G.mouthY})`);
      if (el.stache && this._chg(44, shift, jaw, tuck, 0)) el.stache.setAttribute("transform", `translate(${f(shift * 0.8)} ${f(-jaw * 2.1 * (1 - press) - tuck * 1.1)})`);

      // eyes
      const sq = sp.sq.x + blink * 0.08;
      const uOpen = sp.eye.x - sp.gy.x * 0.045;
      const ue = uOpen * (1 - blink) - 0.3 * blink;
      if (this._chg(48, ue, sq, 0, 0)) {
        const cy = G.eyeY;
        for (const [E, cx, dir] of this._eyes) {
          const g = eyeGeom(cx, cy, dir, ue, sq, this.isL);
          E.white.setAttribute("d", g.white); E.clip.setAttribute("d", g.white);
          E.lid.setAttribute("d", g.lid); E.crease.setAttribute("d", g.crease);
          E.lower.setAttribute("d", g.lower); E.lash.setAttribute("d", g.lash); E.shade.setAttribute("d", g.margin);
          if (E.wet) E.wet.setAttribute("d", g.lower);
          if (E.fine) E.fine.setAttribute("d", g.fine);
        }
      }
      const gx = sp.gx.x, gy = sp.gy.x;
      if (this._chg(52, gx, gy, 0, 0)) {
        const tr = `translate(${f(gx)} ${f(gy)})`;
        el.eyeL.iris.setAttribute("transform", tr); el.eyeR.iris.setAttribute("transform", tr);
      }
      const cheek = sq * 3 + Math.max(0, smile - 0.4) * 3;
      if (this._chg(56, cheek, 0, 0, 0)) el.blush.setAttribute("transform", `translate(0 ${f(-cheek)})`);

      // brows: raise + inner/outer rotation; furrow pulls inner ends down and together
      const bIn = sp.bIn.x, bOut = sp.bOut.x, ba = sp.bAsym.x;
      const raise = (bIn + bOut) * 3.6 + sp.bPulse.x * 4 - blink * 0.8;
      const rot = (bIn - bOut) * 7, furrow = Math.max(0, -bIn) * 1.4;
      if (this._chg(60, raise, rot, furrow, ba)) {
        const by0 = G.browY;
        el.browL.setAttribute("transform", `translate(${f(furrow)} ${f(-raise - ba * 3.2)}) rotate(${f(-rot + ba * 4)} 163 ${by0})`);
        el.browR.setAttribute("transform", `translate(${f(-furrow)} ${f(-raise)}) rotate(${f(rot)} 237 ${by0})`);
      }
    }
  }

  TutorStage.FACE_VIEWBOX = FACE_VIEWBOX;
  TutorStage.STAGE_VIEWBOX = STAGE_VIEWBOX;
  TutorStage.stageViewBox = stageViewBox;
  window.TutorStage = TutorStage;
})();
