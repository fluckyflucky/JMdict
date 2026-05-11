import Database from "better-sqlite3";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { toRomaji } from "wanakana";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DICT_FILE = resolve(__dirname, "../../jmdict-all-3.6.2.json");
const SENTENCES_FILE = resolve(__dirname, "../data/sentences-ja-zh.json");
const ZH_FILE = resolve(__dirname, "../data/glosses-zh.json");
const DB_FILE = resolve(__dirname, "../dist/dict.db");

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
  sentences = JSON.parse(readFileSync(SENTENCES_FILE, "utf-8"));
  console.log(`Loaded ${sentences.length} sentence pairs`);
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
    senses_json TEXT
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

db.close();
console.log(`Database written to ${DB_FILE}`);
