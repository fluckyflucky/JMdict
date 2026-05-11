import Database from "better-sqlite3";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { toRomaji } from "wanakana";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);
const buildKuromoji = _require("./kuromoji-init.cjs");
const DICT_FILE = resolve(__dirname, "../jmdict-all-3.6.2.json");
const SENTENCES_FILE = resolve(__dirname, "../data/sentences-ja-zh.json");
const ZH_FILE = resolve(__dirname, "../data/glosses-zh.json");
const DB_FILE = resolve(__dirname, "../dist/dict.db");

function toHiragana(s: string): string {
  return s.replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

console.log("Loading data...");
const data = JSON.parse(readFileSync(DICT_FILE, "utf-8"));
const tags: Record<string, string> = data.tags;
const words = data.words;

let zhMap = new Map<string, string[][]>();
if (existsSync(ZH_FILE)) {
  const zhData: { id: string; zh: string[][] }[] = JSON.parse(
    readFileSync(ZH_FILE, "utf-8")
  );
  for (const item of zhData) {
    zhMap.set(item.id, item.zh);
  }
  console.log(`Loaded ${zhMap.size} Chinese translations`);
}

let sentences: { ja: string; zh: string }[] = [];
if (existsSync(SENTENCES_FILE)) {
  const raw: { ja: string; zh: string }[] = JSON.parse(
    readFileSync(SENTENCES_FILE, "utf-8")
  );
  const seen = new Set<string>();
  for (const s of raw) {
    const key = s.ja + "\0" + s.zh;
    if (!seen.has(key)) {
      seen.add(key);
      sentences.push(s);
    }
  }
  console.log(
    `Loaded ${raw.length} sentence pairs, deduped to ${sentences.length}`
  );
}

import { unlinkSync } from "node:fs";

if (existsSync(DB_FILE)) unlinkSync(DB_FILE);

const db = new Database(DB_FILE);
db.pragma("journal_mode = OFF");
db.pragma("synchronous = OFF");

db.exec(`
  DROP TABLE IF EXISTS entries;
  DROP TABLE IF EXISTS sentences;
  CREATE TABLE entries (
    id TEXT PRIMARY KEY,
    kanji TEXT,
    readings TEXT,
    romaji TEXT,
    senses_json TEXT,
    examples_json TEXT
  );
  CREATE TABLE sentences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ja TEXT,
    zh TEXT
  );
  CREATE INDEX idx_entries_kanji ON entries(kanji);
  CREATE INDEX idx_entries_readings ON entries(readings);
  CREATE INDEX idx_entries_romaji ON entries(romaji);
  CREATE VIRTUAL TABLE entries_fts USING fts5(
    kanji, readings, glosses_en, glosses_zh,
    content=entries, content_rowid=rowid
  );
`);

console.log("Inserting entries...");
const insertEntry = db.prepare(
  "INSERT INTO entries (id, kanji, readings, romaji, senses_json) VALUES (?, ?, ?, ?, ?)"
);
const insertFts = db.prepare(
  "INSERT INTO entries_fts (rowid, kanji, readings, glosses_en, glosses_zh) VALUES (?, ?, ?, ?, ?)"
);

const insertEntries = db.transaction(() => {
  let rowid = 0;
  for (const w of words) {
    rowid++;
    const kanji = w.kanji.map((k: any) => k.text).join(",");
    const readings = w.kana.map((k: any) => k.text).join(",");
    const romaji = w.kana.map((k: any) => toRomaji(k.text)).join(",");
    const zhSenses = zhMap.get(w.id) || [];

    const senses = w.sense
      .map((s: any, i: number) => ({
        pos: s.partOfSpeech.map((p: string) => tags[p] || p),
        en: s.gloss
          .filter((g: any) => g.lang === "eng")
          .map((g: any) => g.text),
        zh: zhSenses[i] || [],
      }))
      .filter((s: any) => s.en.length > 0);

    const glossesEn = senses.flatMap((s: any) => s.en).join(" ");
    const glossesZh = senses.flatMap((s: any) => s.zh).join(" ");

    insertEntry.run(w.id, kanji, readings, romaji, JSON.stringify(senses));
    insertFts.run(rowid, kanji, readings, glossesEn, glossesZh);
  }
});
insertEntries();
console.log(`Inserted ${words.length} entries`);

console.log("Inserting sentences...");
const insertSentence = db.prepare(
  "INSERT INTO sentences (ja, zh) VALUES (?, ?)"
);
const insertSentences = db.transaction(() => {
  for (const s of sentences) {
    insertSentence.run(s.ja, s.zh);
  }
});
insertSentences();
console.log(`Inserted ${sentences.length} sentences`);

async function main() {

console.log("Computing example sentences...");
console.log("  Initializing Kuromoji...");
const tokenizer: any = await buildKuromoji();
console.log("  Tokenizing sentences...");

// Build inverted index: token text → sentence indices
const surfaceIdx = new Map<string, Set<number>>();
const readingIdx = new Map<string, Set<number>>();

for (let si = 0; si < sentences.length; si++) {
  const tokens = tokenizer.tokenize(sentences[si].ja);
  const seenSurface = new Set<string>();
  const seenReading = new Set<string>();
  for (const t of tokens) {
    const sf = t.surface_form;
    const bf = t.basic_form && t.basic_form !== "*" ? t.basic_form : sf;
    const rd = toHiragana(t.reading && t.reading !== "*" ? t.reading : sf);

    for (const f of [sf, bf]) {
      if (!seenSurface.has(f)) {
        seenSurface.add(f);
        if (!surfaceIdx.has(f)) surfaceIdx.set(f, new Set());
        surfaceIdx.get(f)!.add(si);
      }
    }
    // Only index readings for kana-surface tokens (no kanji).
    // This avoids false positives where a kana entry's reading matches
    // a kanji token's reading (e.g. "イタメ"←nuisance mail matching
    // "痛めた"←hurt/injure, which has reading イタメタ).
    const hasKanji = /[一-鿿]/.test(sf);
    if (!hasKanji && !seenReading.has(rd)) {
      seenReading.add(rd);
      if (!readingIdx.has(rd)) readingIdx.set(rd, new Set());
      readingIdx.get(rd)!.add(si);
    }
  }

  if (si > 0 && si % 10000 === 0) {
    console.log(`  Tokenized: ${si}/${sentences.length}`);
  }
}
console.log(`  Tokenized ${sentences.length} sentences`);

const updateEx = db.prepare("UPDATE entries SET examples_json = ? WHERE id = ?");

// Sort sentences by index, keep top 3
function getExamples(sentenceHits: Set<number>): { ja: string; zh: string }[] {
  return [...sentenceHits]
    .sort((a, b) => a - b)
    .slice(0, 3)
    .map(si => ({ ja: sentences[si].ja, zh: sentences[si].zh }));
}

const computeExamples = db.transaction(() => {
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const kanji = w.kanji.map((k: any) => k.text).filter((t: string) => t.length > 0);
    const readings = w.kana.map((k: any) => k.text).filter((t: string) => t.length > 0);
    const hits = new Set<number>();

    if (kanji.length > 0) {
      for (const k of kanji) {
        const set = surfaceIdx.get(k);
        if (set) set.forEach(si => hits.add(si));
      }
    } else {
      for (const r of readings) {
        const h = toHiragana(r);
        const s1 = surfaceIdx.get(h);
        if (s1) s1.forEach(si => hits.add(si));
        const s2 = readingIdx.get(h);
        if (s2) s2.forEach(si => hits.add(si));
      }
    }

    const rows = getExamples(hits);
    if (rows.length > 0) {
      updateEx.run(JSON.stringify(rows), w.id);
    }

    if (i > 0 && i % 25000 === 0) {
      console.log(`  Examples: ${i}/${words.length}`);
    }
  }
});
computeExamples();
console.log("Example sentences computed");

db.close();
console.log(`Database written to ${DB_FILE}`);
}

main().catch(console.error);
