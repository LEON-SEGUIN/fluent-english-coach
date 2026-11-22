// Today's news in English (American radio, culture, tech and world news), from free public RSS feeds. Used for "Actualité" calls.
// No key, no account. Headlines are cached for 30 minutes.

const FEEDS = [
  { id: "npr", name: "NPR News", url: "https://feeds.npr.org/1001/rss.xml" },
  { id: "nprarts", name: "NPR Arts", url: "https://feeds.npr.org/1008/rss.xml" },
  { id: "bbctech", name: "BBC Technology", url: "https://feeds.bbci.co.uk/news/technology/rss.xml" },
  { id: "bbcworld", name: "BBC World", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
];
const PER_FEED = 12;
const TTL = 30 * 60_000;

let cache = { at: 0, items: [] };
let pending = null;

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", laquo: "«", raquo: "»", ndash: "–", mdash: "—",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", iquest: "¿", iexcl: "¡", euro: "€", deg: "°", middot: "·",
  aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú", ntilde: "ñ", uuml: "ü", ccedil: "ç",
  Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú", Ntilde: "Ñ", Uuml: "Ü", Ccedil: "Ç",
};
const entities = (s) => s
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n] ?? ENTITIES[n.toLowerCase()] ?? m);
function decode(s) {
  // Some feeds escape their HTML twice, so decode and strip tags two times.
  let out = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  for (let i = 0; i < 2; i++) out = entities(out.replace(/<[^>]+>/g, " "));
  return out.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decode(m[1]) : "";
}

async function readFeed(feed) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 7000);
  try {
    const res = await fetch(feed.url, { signal: ctrl.signal, headers: { "user-agent": "Mozilla/5.0 (Macintosh) Fluent/1.0" } });
    if (!res.ok) return [];
    const xml = await res.text();
    const items = [];
    for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) {
      const block = m[0];
      const title = tag(block, "title");
      if (!title) continue;
      let summary = tag(block, "description");
      if (summary.length > 320) summary = summary.slice(0, 317).replace(/\s\S*$/, "") + "…";
      const date = Date.parse(tag(block, "pubDate")) || null;
      items.push({ title, summary, link: tag(block, "link"), date, source: feed.name, category: tag(block, "category") });
      if (items.length >= PER_FEED) break;
    }
    return items;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// Mixed list of fresh headlines, newest first, one id per headline.
export async function headlines() {
  if (Date.now() - cache.at < TTL && cache.items.length) return cache.items;
  if (pending) return pending;
  pending = (async () => {
    const lists = await Promise.all(FEEDS.map(readFeed));
    const seen = new Set();
    const all = [];
    // Interleave the feeds so one source does not take the whole list.
    for (let i = 0; i < PER_FEED; i++) {
      for (const list of lists) {
        const it = list[i];
        if (!it) continue;
        const key = it.title.toLowerCase().slice(0, 60);
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(it);
      }
    }
    const items = all.slice(0, 40).map((it, i) => ({ id: `n${i}-${Buffer.from(it.title).toString("base64url").slice(0, 10)}`, ...it }));
    if (items.length) cache = { at: Date.now(), items };
    return items.length ? items : cache.items;
  })();
  try { return await pending; } finally { pending = null; }
}
