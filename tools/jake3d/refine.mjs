// Polishes jake.glb without any library (2026-11-05: "the mouth looks twisted").
//  - The sculpted face shapes are not even: pressR moved almost twice as far as pressL, upperUp and lowerDown twist the lips.
//    Each shape becomes exactly symmetric: a single shape with its own mirror image, a left/right pair with each other's.
//  - The shapes only moved points, so the light on the skin never changed with the mouth. Each shape now also moves the normals.
//  - Shapes are stored sparsely: most of them touch few points.
// usage: node refine.mjs <in.glb> <out.glb>
import fs from "node:fs";

const [inFile, outFile] = process.argv.slice(2);
const buf = fs.readFileSync(inFile);
const jsonLen = buf.readUInt32LE(12);
const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString("utf8"));
const binStart = 20 + jsonLen + 8;
const NUM = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const viewBytes = (i) => { const v = gltf.bufferViews[i]; const s = binStart + (v.byteOffset || 0); return buf.subarray(s, s + v.byteLength); };
const readInts = (bytes, type, count, off = 0) => { const o = new Uint32Array(count); for (let i = 0; i < count; i++) o[i] = type === 5125 ? bytes.readUInt32LE(off + 4 * i) : type === 5123 ? bytes.readUInt16LE(off + 2 * i) : bytes.readUInt8(off + i); return o; };
function readFloats(index) {
  const a = gltf.accessors[index], c = NUM[a.type], out = new Float32Array(a.count * c);
  if (a.bufferView != null) {
    const b = viewBytes(a.bufferView), off = a.byteOffset || 0;
    for (let i = 0; i < out.length; i++) out[i] = b.readFloatLE(off + 4 * i);
  }
  if (a.sparse) {
    const ids = readInts(viewBytes(a.sparse.indices.bufferView), a.sparse.indices.componentType, a.sparse.count, a.sparse.indices.byteOffset || 0);
    const vals = viewBytes(a.sparse.values.bufferView), off = a.sparse.values.byteOffset || 0;
    ids.forEach((id, k) => { for (let j = 0; j < c; j++) out[id * c + j] = vals.readFloatLE(off + 4 * (k * c + j)); });
  }
  return out;
}
function readIndices(index) { const a = gltf.accessors[index]; return readInts(viewBytes(a.bufferView), a.componentType, a.count, a.byteOffset || 0); }

// New data goes in fresh buffer views; the file is packed again at the end with only what is still used.
const fresh = new Map(); // view number -> Buffer
function addView(bytes) { const i = gltf.bufferViews.length; gltf.bufferViews.push({ buffer: 0, byteLength: bytes.length }); fresh.set(i, bytes); return i; }
function floatsBuffer(a) { const b = Buffer.alloc(a.length * 4); a.forEach((v, i) => b.writeFloatLE(v, i * 4)); return b; }
// A sparse VEC3 accessor: only the points that move.
function sparseVec3(data, threshold) {
  const n = data.length / 3, ids = [];
  for (let i = 0; i < n; i++) if (Math.hypot(data[3 * i], data[3 * i + 1], data[3 * i + 2]) > threshold) ids.push(i);
  if (!ids.length) ids.push(0);
  const vals = new Float32Array(ids.length * 3), min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  ids.forEach((id, k) => { for (let j = 0; j < 3; j++) { const v = data[3 * id + j]; vals[3 * k + j] = v; min[j] = Math.min(min[j], v); max[j] = Math.max(max[j], v); } });
  const idx = Buffer.alloc(ids.length * 2);
  ids.forEach((id, k) => idx.writeUInt16LE(id, k * 2));
  gltf.accessors.push({ componentType: 5126, count: n, type: "VEC3", min, max, sparse: { count: ids.length, indices: { bufferView: addView(idx), componentType: 5123 }, values: { bufferView: addView(floatsBuffer(vals)) } } });
  return gltf.accessors.length - 1;
}

const PAIRS = ["smile", "cheek", "dimple", "frown", "press", "stretch", "upperUp", "lowerDown", "squint", "wide", "blink", "browOuter", "browDown", "sneer", "mouth"];
const report = [];
for (const mesh of gltf.meshes) for (const p of mesh.primitives) {
  if (!p.targets?.length) continue;
  const names = mesh.extras?.targetNames || [];
  const base = readFloats(p.attributes.POSITION), n = base.length / 3;
  const tris = readIndices(p.indices);
  const baseNormal = readFloats(p.attributes.NORMAL);
  // The point on the other side of the face.
  const cell = 0.5, grid = new Map(), gk = (x, y, z) => `${Math.round(x / cell)},${Math.round(y / cell)},${Math.round(z / cell)}`;
  for (let i = 0; i < n; i++) { const k = gk(base[3 * i], base[3 * i + 1], base[3 * i + 2]); (grid.get(k) || grid.set(k, []).get(k)).push(i); }
  const mirror = new Int32Array(n);
  let gap = 0, worst = 0;
  for (let i = 0; i < n; i++) {
    const x = -base[3 * i], y = base[3 * i + 1], z = base[3 * i + 2];
    let best = i, bd = Infinity;
    for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) for (let c = -2; c <= 2; c++) {
      for (const j of grid.get(`${Math.round(x / cell) + a},${Math.round(y / cell) + b},${Math.round(z / cell) + c}`) || []) {
        const d = (base[3 * j] - x) ** 2 + (base[3 * j + 1] - y) ** 2 + (base[3 * j + 2] - z) ** 2;
        if (d < bd) { bd = d; best = j; }
      }
    }
    mirror[i] = best;
    const g = Math.sqrt(bd); gap += g; worst = Math.max(worst, g);
  }
  report.push(`mesh of ${n} points: mirror gap mean ${(gap / n).toFixed(3)} cm, worst ${worst.toFixed(3)} cm`);
  const raw = {};
  p.targets.forEach((t, i) => { raw[names[i]] = readFloats(t.POSITION); });
  const mirrored = (d) => { const o = new Float32Array(d.length); for (let i = 0; i < n; i++) { const j = mirror[i]; o[3 * i] = -d[3 * j]; o[3 * i + 1] = d[3 * j + 1]; o[3 * i + 2] = d[3 * j + 2]; } return o; };
  const out = {};
  const pairOf = (name) => { for (const b of PAIRS) if (name === `${b}L`) return [b, "L"]; else if (name === `${b}R`) return [b, "R"]; return null; };
  for (const name of names) {
    const pr = pairOf(name);
    if (!pr) { const m = mirrored(raw[name]); out[name] = raw[name].map((v, i) => (v + m[i]) / 2); continue; }
    if (out[name]) continue;
    const L = `${pr[0]}L`, R = `${pr[0]}R`;
    const mR = mirrored(raw[R]);
    const newL = raw[L].map((v, i) => (v + mR[i]) / 2);
    out[L] = newL; out[R] = mirrored(newL);
  }
  // What each shape does to the normals, smoothing across the seams of the texture as the model's normals do.
  const key = new Int32Array(n), ids = new Map();
  for (let i = 0; i < n; i++) { const k = `${Math.round(base[3 * i] * 50)},${Math.round(base[3 * i + 1] * 50)},${Math.round(base[3 * i + 2] * 50)}`; if (!ids.has(k)) ids.set(k, ids.size); key[i] = ids.get(k); }
  const normalsOf = (delta) => {
    const sum = new Float64Array(ids.size * 3);
    const P = (i, a) => base[3 * i + a] + (delta ? delta[3 * i + a] : 0);
    for (let t = 0; t + 2 < tris.length; t += 3) {
      const [a, b, c] = [tris[t], tris[t + 1], tris[t + 2]];
      const ux = P(b, 0) - P(a, 0), uy = P(b, 1) - P(a, 1), uz = P(b, 2) - P(a, 2), vx = P(c, 0) - P(a, 0), vy = P(c, 1) - P(a, 1), vz = P(c, 2) - P(a, 2);
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (const i of [a, b, c]) { const k = key[i]; sum[3 * k] += nx; sum[3 * k + 1] += ny; sum[3 * k + 2] += nz; }
    }
    const nor = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { const k = key[i], l = Math.hypot(sum[3 * k], sum[3 * k + 1], sum[3 * k + 2]) || 1; nor[3 * i] = sum[3 * k] / l; nor[3 * i + 1] = sum[3 * k + 1] / l; nor[3 * i + 2] = sum[3 * k + 2] / l; }
    return nor;
  };
  const rest = normalsOf(null);
  let moved = 0, nmoved = 0;
  names.forEach((name, i) => {
    const d = out[name];
    const N = normalsOf(d), dn = new Float32Array(n * 3);
    for (let v = 0; v < n; v++) {
      // Only where the shape moves something nearby.
      for (let a = 0; a < 3; a++) dn[3 * v + a] = N[3 * v + a] - rest[3 * v + a];
    }
    const pos = sparseVec3(d, 0.0015), nor = sparseVec3(dn, 0.004);
    moved += gltf.accessors[pos].sparse.count; nmoved += gltf.accessors[nor].sparse.count;
    p.targets[i] = { POSITION: pos, NORMAL: nor };
  });
  report.push(`  ${names.length} shapes, ${moved} point moves, ${nmoved} normal moves`);
  // Report: how even are the shapes now?
  for (const b of ["smile", "upperUp", "lowerDown", "press", "frown", "stretch"]) {
    const top = (d) => { let m = 0; for (let i = 0; i < d.length; i += 3) m = Math.max(m, Math.hypot(d[i], d[i + 1], d[i + 2])); return m.toFixed(3); };
    if (raw[`${b}L`]) report.push(`  ${b}: was L ${top(raw[`${b}L`])} R ${top(raw[`${b}R`])}, now L ${top(out[`${b}L`])} R ${top(out[`${b}R`])}`);
  }
}

// Pack the file again: only the views still in use.
const used = new Set();
const mark = (v) => { if (v != null) used.add(v); };
for (const a of gltf.accessors) { mark(a.bufferView); if (a.sparse) { mark(a.sparse.indices.bufferView); mark(a.sparse.values.bufferView); } }
for (const im of gltf.images || []) mark(im.bufferView);
const remap = new Map(), newViews = [], chunks = [];
let offset = 0;
gltf.bufferViews.forEach((v, i) => {
  if (!used.has(i)) return;
  const bytes = fresh.get(i) || viewBytes(i);
  const pad = (4 - (offset % 4)) % 4;
  if (pad) { chunks.push(Buffer.alloc(pad)); offset += pad; }
  const nv = { ...v, byteOffset: offset, byteLength: bytes.length };
  remap.set(i, newViews.length);
  newViews.push(nv);
  chunks.push(bytes);
  offset += bytes.length;
});
for (const a of gltf.accessors) { if (a.bufferView != null) a.bufferView = remap.get(a.bufferView); if (a.sparse) { a.sparse.indices.bufferView = remap.get(a.sparse.indices.bufferView); a.sparse.values.bufferView = remap.get(a.sparse.values.bufferView); } }
for (const im of gltf.images || []) if (im.bufferView != null) im.bufferView = remap.get(im.bufferView);
// Accessors nothing refers to any more are dropped too.
const refs = new Set();
const markA = (i) => { if (i != null) refs.add(i); };
for (const m of gltf.meshes) for (const p of m.primitives) { Object.values(p.attributes).forEach(markA); markA(p.indices); (p.targets || []).forEach((t) => Object.values(t).forEach(markA)); }
for (const s of gltf.skins || []) markA(s.inverseBindMatrices);
for (const an of gltf.animations || []) for (const s of an.samplers) { markA(s.input); markA(s.output); }
const aMap = new Map(), newAcc = [];
gltf.accessors.forEach((a, i) => { if (refs.has(i)) { aMap.set(i, newAcc.length); newAcc.push(a); } });
gltf.accessors = newAcc;
for (const m of gltf.meshes) for (const p of m.primitives) {
  for (const k of Object.keys(p.attributes)) p.attributes[k] = aMap.get(p.attributes[k]);
  if (p.indices != null) p.indices = aMap.get(p.indices);
  (p.targets || []).forEach((t) => { for (const k of Object.keys(t)) t[k] = aMap.get(t[k]); });
}
for (const s of gltf.skins || []) if (s.inverseBindMatrices != null) s.inverseBindMatrices = aMap.get(s.inverseBindMatrices);
for (const an of gltf.animations || []) for (const s of an.samplers) { s.input = aMap.get(s.input); s.output = aMap.get(s.output); }
// Views only used by dropped accessors stay: the second run of this tool removes them. Keep it simple: pack once more below.
gltf.bufferViews = newViews;
const usedAfter = new Set();
for (const a of gltf.accessors) { if (a.bufferView != null) usedAfter.add(a.bufferView); if (a.sparse) { usedAfter.add(a.sparse.indices.bufferView); usedAfter.add(a.sparse.values.bufferView); } }
for (const im of gltf.images || []) if (im.bufferView != null) usedAfter.add(im.bufferView);
const bin = Buffer.concat(chunks);
const map2 = new Map(), views2 = [], chunks2 = [];
let off2 = 0;
newViews.forEach((v, i) => {
  if (!usedAfter.has(i)) return;
  const bytes = bin.subarray(v.byteOffset, v.byteOffset + v.byteLength);
  const pad = (4 - (off2 % 4)) % 4;
  if (pad) { chunks2.push(Buffer.alloc(pad)); off2 += pad; }
  map2.set(i, views2.length);
  views2.push({ ...v, byteOffset: off2 });
  chunks2.push(bytes);
  off2 += bytes.length;
});
for (const a of gltf.accessors) { if (a.bufferView != null) a.bufferView = map2.get(a.bufferView); if (a.sparse) { a.sparse.indices.bufferView = map2.get(a.sparse.indices.bufferView); a.sparse.values.bufferView = map2.get(a.sparse.values.bufferView); } }
for (const im of gltf.images || []) if (im.bufferView != null) im.bufferView = map2.get(im.bufferView);
gltf.bufferViews = views2;
const binAll = Buffer.concat(chunks2);
const binPad = Buffer.alloc((4 - (binAll.length % 4)) % 4);
gltf.buffers = [{ byteLength: binAll.length + binPad.length }];
const json = Buffer.from(JSON.stringify(gltf));
const jsonPad = Buffer.alloc((4 - (json.length % 4)) % 4, 0x20);
const head = Buffer.alloc(12);
head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + json.length + jsonPad.length + 8 + binAll.length + binPad.length, 8);
const c1 = Buffer.alloc(8); c1.writeUInt32LE(json.length + jsonPad.length, 0); c1.writeUInt32LE(0x4e4f534a, 4);
const c2 = Buffer.alloc(8); c2.writeUInt32LE(binAll.length + binPad.length, 0); c2.writeUInt32LE(0x004e4942, 4);
fs.writeFileSync(outFile, Buffer.concat([head, c1, json, jsonPad, c2, binAll, binPad]));
console.log(report.join("\n"));
console.log(`glb: ${buf.length} -> ${fs.statSync(outFile).size} bytes`);
