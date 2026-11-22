// Makes public/jake3d/words.txt from CMUdict (BSD licence, https://github.com/cmusphinx/cmudict): how English words sound, for Jake's mouth.
// One line per word: the word, a space, one letter per sound. Capital vowels are stressed. Long and odd words are left out: spelling rules take over.
// usage: node make-words.mjs <cmudict.dict> <out.txt>
import fs from "node:fs";
const [src, out] = process.argv.slice(2);
const CODE = { AA: "a", AE: "b", AH: "c", AO: "d", AW: "e", AY: "f", EH: "g", ER: "h", EY: "i", IH: "j", IY: "k", OW: "l", OY: "m", UH: "n", UW: "o",
  B: "p", CH: "q", D: "r", DH: "s", F: "t", G: "u", HH: "v", JH: "w", K: "x", L: "y", M: "z", N: "1", NG: "2", P: "3", R: "4", S: "5", SH: "6", T: "7", TH: "8", V: "9", W: "0", Y: "-", Z: "+", ZH: "=" };
const lines = [];
for (const line of fs.readFileSync(src, "utf8").split("\n")) {
  const m = line.match(/^([a-z][a-z']*) (.*?)(\s*#.*)?$/);
  if (!m || m[1].length > 12) continue; // no second pronunciations: word(2) does not match
  let code = "";
  let ok = true;
  for (const p of m[2].trim().split(/\s+/)) {
    const base = p.replace(/\d/, ""), c = CODE[base];
    if (!c) { ok = false; break; }
    code += p.endsWith("1") ? c.toUpperCase() : c;
  }
  if (ok && code) lines.push(`${m[1]} ${code}`);
}
fs.writeFileSync(out, lines.join("\n") + "\n");
console.log(`${lines.length} words, ${fs.statSync(out).size} bytes`);
// Then only common words were kept: the 90,000 most frequent ones of Peter Norvig's count_1w.txt (MIT, https://norvig.com/ngrams/), plus contractions.
