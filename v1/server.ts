import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const PORT = 3456;

interface Word {
  id: string;
  kanji: { text: string; common: boolean }[];
  kana: { text: string; common: boolean }[];
  sense: {
    partOfSpeech: string[];
    gloss: { lang: string; text: string }[];
  }[];
}

interface Entry {
  kanji: string[];
  readings: string[];
  senses: { pos: string[]; glosses: string[] }[];
}

console.log("Loading jmdict-all-3.6.2.json...");
const data = JSON.parse(readFileSync("jmdict-all-3.6.2.json", "utf-8"));
const tags: Record<string, string> = data.tags;
const words: Word[] = data.words;

const entries: Entry[] = words.map((w) => ({
  kanji: w.kanji.map((k) => k.text),
  readings: w.kana.map((k) => k.text),
  senses: w.sense
    .map((s) => ({
      pos: s.partOfSpeech.map((p) => tags[p] || p),
      glosses: s.gloss.filter((g) => g.lang === "eng").map((g) => g.text),
    }))
    .filter((s) => s.glosses.length > 0),
}));

console.log(`Loaded ${entries.length} entries.`);

function search(query: string, limit = 50): Entry[] {
  const q = query.toLowerCase().trim();
  if (!q) return [];

  const exact: Entry[] = [];
  const startsWith: Entry[] = [];
  const contains: Entry[] = [];

  for (const entry of entries) {
    const allTerms = [...entry.kanji, ...entry.readings];
    const allGlosses = entry.senses.flatMap((s) => s.glosses);

    if (allTerms.some((t) => t === q)) {
      exact.push(entry);
    } else if (allTerms.some((t) => t.startsWith(q))) {
      startsWith.push(entry);
    } else if (
      allTerms.some((t) => t.includes(q)) ||
      allGlosses.some((g) => g.toLowerCase().includes(q))
    ) {
      contains.push(entry);
    }

    if (exact.length + startsWith.length + contains.length >= limit) break;
  }

  return [...exact, ...startsWith, ...contains].slice(0, limit);
}

const HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>JMdict Dictionary</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: "Hiragino Sans", "Noto Sans JP", sans-serif; background: #f5f5f5; padding: 20px; }
.container { max-width: 700px; margin: 0 auto; }
h1 { text-align: center; margin-bottom: 20px; color: #333; }
.search-box { display: flex; gap: 8px; margin-bottom: 20px; }
input { flex: 1; padding: 12px 16px; font-size: 18px; border: 2px solid #ddd; border-radius: 8px; outline: none; }
input:focus { border-color: #4a90d9; }
button { padding: 12px 24px; font-size: 16px; background: #4a90d9; color: white; border: none; border-radius: 8px; cursor: pointer; }
button:hover { background: #357abd; }
.entry { background: white; border-radius: 8px; padding: 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
.kanji { font-size: 24px; font-weight: bold; color: #222; }
.reading { font-size: 16px; color: #666; margin-left: 8px; }
.sense { margin-top: 8px; padding-left: 12px; border-left: 3px solid #e0e0e0; }
.pos { font-size: 12px; color: #888; font-style: italic; }
.gloss { font-size: 15px; color: #333; margin-top: 2px; }
.empty { text-align: center; color: #999; margin-top: 40px; }
</style>
</head>
<body>
<div class="container">
<h1>JMdict</h1>
<div class="search-box">
  <input id="q" type="text" placeholder="日本語 or English..." autofocus>
  <button onclick="doSearch()">Search</button>
</div>
<div id="results"></div>
</div>
<script>
const input = document.getElementById('q');
input.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

let timer;
input.addEventListener('input', () => {
  clearTimeout(timer);
  timer = setTimeout(doSearch, 300);
});

async function doSearch() {
  const q = input.value.trim();
  if (!q) { document.getElementById('results').innerHTML = ''; return; }
  const res = await fetch('/api/search?q=' + encodeURIComponent(q));
  const data = await res.json();
  render(data);
}

function render(entries) {
  const el = document.getElementById('results');
  if (!entries.length) { el.innerHTML = '<p class="empty">No results</p>'; return; }
  el.innerHTML = entries.map(e => {
    const head = (e.kanji.length ? '<span class="kanji">' + esc(e.kanji.join(', ')) + '</span>' : '')
      + '<span class="reading">' + esc(e.readings.join(', ')) + '</span>';
    const senses = e.senses.map((s, i) => {
      const pos = s.pos.length ? '<div class="pos">' + esc(s.pos.join(', ')) + '</div>' : '';
      return '<div class="sense">' + pos + '<div class="gloss">' + (i+1) + '. ' + esc(s.glosses.join('; ')) + '</div></div>';
    }).join('');
    return '<div class="entry">' + head + senses + '</div>';
  }).join('');
}

function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
</script>
</body>
</html>`;

const server = createServer((req, res) => {
  const url = new URL(req.url!, `http://localhost:${PORT}`);

  if (url.pathname === "/api/search") {
    const q = url.searchParams.get("q") || "";
    const results = search(q);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(results));
  } else {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HTML);
  }
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
