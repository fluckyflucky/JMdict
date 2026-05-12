import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { toRomaji } from "wanakana";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DICT_FILE = resolve(__dirname, "../jmdict-all-3.6.2.json");
const SENTENCES_FILE = resolve(__dirname, "../data/sentences-ja-zh.json");
const ZH_FILE = resolve(__dirname, "../data/glosses-zh.json");

const OUT_DIR = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(__dirname, "../../aoinatsu-web/public/jmdict");

interface CompactSense { p: string[]; e: string[]; z: string[] }
interface CompactExample { j: string; c: string }
interface CompactEntry {
  k: string[];
  r: string[];
  o: string[];
  s: CompactSense[];
  x: CompactExample[];
}

console.log("Loading data...");
const data = JSON.parse(readFileSync(DICT_FILE, "utf-8"));
const tags: Record<string, string> = data.tags;
const words = data.words;

let zhMap = new Map<string, string[][]>();
if (existsSync(ZH_FILE)) {
  const zhData: { id: string; zh: string[][] }[] = JSON.parse(readFileSync(ZH_FILE, "utf-8"));
  for (const item of zhData) zhMap.set(item.id, item.zh);
  console.log(`Loaded ${zhMap.size} Chinese translations`);
}

let sentences: { ja: string; zh: string }[] = [];
if (existsSync(SENTENCES_FILE)) {
  const raw: { ja: string; zh: string }[] = JSON.parse(readFileSync(SENTENCES_FILE, "utf-8"));
  const seen = new Set<string>();
  for (const s of raw) {
    const key = s.ja + "\0" + s.zh;
    if (!seen.has(key)) { seen.add(key); sentences.push(s); }
  }
  console.log(`Loaded ${raw.length} sentence pairs, deduped to ${sentences.length}`);
}

interface Entry {
  id: string;
  kanji: string[];
  readings: string[];
  romaji: string[];
  senses: CompactSense[];
}

const allEntries: Entry[] = [];

for (const w of words) {
  const kanji = w.kanji.map((k: any) => k.text).filter((t: string) => t.length > 0);
  const readings = w.kana.map((k: any) => k.text).filter((t: string) => t.length > 0);
  const romaji = w.kana.map((k: any) => toRomaji(k.text)).filter((t: string) => t.length > 0);
  const zhSenses = zhMap.get(w.id) || [];

  const senses: CompactSense[] = w.sense
    .map((s: any, i: number) => ({
      p: s.partOfSpeech.map((p: string) => tags[p] || p),
      e: s.gloss.filter((g: any) => g.lang === "eng").map((g: any) => g.text),
      z: zhSenses[i] || [],
    }))
    .filter((s: CompactSense) => s.e.length > 0);

  allEntries.push({ id: w.id, kanji, readings, romaji, senses });
}

console.log(`Built ${allEntries.length} entries`);

// ── Kuromoji ─────────────────────────────────────────────────────────

import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);
const buildKuromoji: any = _require("./kuromoji-init.cjs");

async function main() {
  console.log("Initializing Kuromoji for examples...");
  const tokenizer: any = await buildKuromoji();
  console.log("Tokenizing sentences...");

  function toHiragana(s: string): string {
    return s.replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
  }

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
      const hasKanji = /[一-鿿]/.test(sf);
      if (!hasKanji && !seenReading.has(rd)) {
        seenReading.add(rd);
        if (!readingIdx.has(rd)) readingIdx.set(rd, new Set());
        readingIdx.get(rd)!.add(si);
      }
    }
    if (si > 0 && si % 10000 === 0) console.log(`  Tokenized: ${si}/${sentences.length}`);
  }
  console.log(`  Tokenized ${sentences.length} sentences`);

  const entryExamples = new Map<string, CompactExample[]>();

  function getExamples(sentenceHits: Set<number>): CompactExample[] {
    return [...sentenceHits]
      .sort((a, b) => a - b)
      .slice(0, 3)
      .map(si => ({ j: sentences[si].ja, c: sentences[si].zh }));
  }

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
    if (rows.length > 0) entryExamples.set(w.id, rows);

    if (i > 0 && i % 25000 === 0) console.log(`  Examples: ${i}/${words.length}`);
  }
  console.log(`Matched examples for ${entryExamples.size} entries`);

  // ── Build indexes ──────────────────────────────────────────────────
  // ro/{prefix}.json — romaji prefix, min(2, len) chars, full entries
  // kanji-map.json  — kanji char → romaji prefixes (for kanji input)
  // examples.json   — all entries with examples (for flashcard)

  const roIdx = new Map<string, CompactEntry[]>();
  const roSeen = new Map<string, Set<string>>();
  const kanjiMap = new Map<string, Set<string>>(); // kanji char → set of romaji prefixes

  for (const e of allEntries) {
    const ex = entryExamples.get(e.id) || [];
    const entry: CompactEntry = { k: e.kanji, r: e.readings, o: e.romaji, s: e.senses, x: ex };
    const dedupKey = e.kanji.join(",") + "|" + e.readings.join(",");

    for (const o of e.romaji) {
      const key = o.slice(0, 2).toLowerCase().replace(/[^a-z]/g, "");
      if (key.length < 1) continue;
      if (!roSeen.has(key)) roSeen.set(key, new Set());
      if (!roSeen.get(key)!.has(dedupKey)) {
        roSeen.get(key)!.add(dedupKey);
        if (!roIdx.has(key)) roIdx.set(key, []);
        roIdx.get(key)!.push(entry);
      }
    }

    // Kanji → romaji prefix mapping
    for (const k of e.kanji) {
      for (const ch of k) {
        if (!/[\p{Script=Han}]/u.test(ch)) continue;
        if (!kanjiMap.has(ch)) kanjiMap.set(ch, new Set());
        for (const o of e.romaji) {
          const prefix = o.slice(0, 2).toLowerCase().replace(/[^a-z]/g, "");
          if (prefix.length >= 1) kanjiMap.get(ch)!.add(prefix);
        }
      }
    }
  }

  // ── Write ──────────────────────────────────────────────────────────

  mkdirSync(OUT_DIR, { recursive: true });

  // Romaji index
  const roDir = join(OUT_DIR, "ro");
  mkdirSync(roDir, { recursive: true });
  for (const [key, entries] of roIdx) {
    writeFileSync(join(roDir, `${key}.json`), JSON.stringify(entries));
  }
  console.log(`  ro: ${roIdx.size} files`);

  // Kanji map
  const kmap: Record<string, string[]> = {};
  for (const [k, v] of kanjiMap) kmap[k] = [...v];
  writeFileSync(join(OUT_DIR, "kanji-map.json"), JSON.stringify(kmap));
  console.log(`  kanji-map.json: ${Object.keys(kmap).length} chars`);

  // Examples (flashcard)
  const examplesEntries: CompactEntry[] = [];
  for (const e of allEntries) {
    const ex = entryExamples.get(e.id) || [];
    if (ex.length > 0) {
      examplesEntries.push({
        k: e.kanji, r: e.readings, o: e.romaji, s: e.senses,
        x: ex,
      });
    }
  }
  writeFileSync(join(OUT_DIR, "examples.json"), JSON.stringify(examplesEntries));
  console.log(`  examples.json: ${examplesEntries.length} entries`);

  // Stats
  let totalFiles = 0;
  let totalSize = 0;
  function countFiles(dir: string) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const s = statSync(p);
      if (s.isDirectory()) { countFiles(p); } else { totalFiles++; totalSize += s.size; }
    }
  }
  countFiles(OUT_DIR);
  console.log(`\nDone: ${totalFiles} files, ${(totalSize / 1024 / 1024).toFixed(1)} MB total`);
}

main().catch(console.error);
