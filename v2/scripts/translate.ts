import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INPUT_FILE = resolve(__dirname, "../../jmdict-all-*.json");
const OUTPUT_FILE = resolve(__dirname, "../data/glosses-zh.json");

interface TranslatedEntry {
  id: string;
  zh: string[][];
}

// Resolve the actual jmdict JSON file (glob for wildcard)
import { readdirSync } from "node:fs";
const dictDir = resolve(__dirname, "../../");
const dictFiles = readdirSync(dictDir).filter(f => f.startsWith("jmdict-all-") && f.endsWith(".json"));
if (dictFiles.length === 0) {
  console.error("No jmdict-all-*.json found in", dictDir);
  process.exit(1);
}
const DICT_FILE = resolve(dictDir, dictFiles[0]);

const client = new Anthropic();

const data = JSON.parse(readFileSync(DICT_FILE, "utf-8"));
const tags: Record<string, string> = data.tags;
const words = data.words;

// Load existing translations
const results: TranslatedEntry[] = existsSync(OUTPUT_FILE)
  ? JSON.parse(readFileSync(OUTPUT_FILE, "utf-8"))
  : [];
const resultMap = new Map(results.map((r) => [r.id, r]));

// === Build list of what needs translating ===

interface PendingEntry {
  id: string;
  word: string;
  reading: string;
  senses: { pos: string[]; en: string[] }[];
}

interface PendingSense {
  id: string;
  word: string;
  senseIdx: number;
  enText: string;
}

const missingEntries: PendingEntry[] = [];
const missingSenses: PendingSense[] = [];

for (const w of words) {
  const senses = w.sense
    .map((s: any) => ({
      pos: s.partOfSpeech.map((p: string) => tags[p] || p),
      en: s.gloss.filter((g: any) => g.lang === "eng").map((g: any) => g.text),
    }))
    .filter((s: any) => s.en.length > 0);

  if (senses.length === 0) continue;

  const kanji = (w.kanji || []).map((k: any) => k.text).join("、");
  const reading = (w.kana || []).map((k: any) => k.text).join("、");
  const word = kanji || reading || w.id;

  const existing = resultMap.get(w.id);

  if (!existing) {
    missingEntries.push({ id: w.id, word, reading, senses });
  } else {
    for (let i = 0; i < senses.length; i++) {
      const zhSense = existing.zh[i];
      if (!zhSense || !zhSense[0]) {
        missingSenses.push({
          id: w.id,
          word,
          senseIdx: i,
          enText: senses[i].en.join("; "),
        });
      }
    }
  }
}

console.log("=== Translation Status ===");
console.log(`Complete entries missing: ${missingEntries.length}`);
console.log(`Individual senses to patch: ${missingSenses.length}`);
if (missingEntries.length === 0 && missingSenses.length === 0) {
  console.log("All entries are fully translated. Nothing to do.");
  process.exit(0);
}

// === Phase 1: Translate entire missing entries ===

async function translateEntries(batch: PendingEntry[]): Promise<TranslatedEntry[]> {
  const prompt = batch
    .map((e, i) => {
      const sensesStr = e.senses
        .map((s, si) => `  ${si + 1}. [${s.pos.join(", ")}] ${s.en.join("; ")}`)
        .join("\n");
      return `${i + 1}. ${e.word}（${e.reading}）\n${sensesStr}`;
    })
    .join("\n\n");

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 4096,
    messages: [{
      role: "user",
      content: `Translate the following Japanese dictionary entries' English definitions into concise Chinese (简体中文).
For each entry, provide Chinese translations for each sense, separated by "|" between senses.
Format: one line per entry, numbered.

${prompt}`,
    }],
    system: "You are a Japanese-Chinese dictionary translator. Provide concise, natural Chinese translations. Output ONLY the numbered translations.",
  });

  const text = response.content[0].type === "text" ? response.content[0].text : "";
  const lines = text.trim().split("\n").filter(Boolean);
  const translated: TranslatedEntry[] = [];

  for (let i = 0; i < batch.length; i++) {
    const line = lines[i] || "";
    const cleaned = line.replace(/^\d+\.\s*/, "");
    const senses = cleaned.split("|").map((s) => s.trim());
    translated.push({ id: batch[i].id, zh: senses.map((s) => [s]) });
  }

  return translated;
}

// === Phase 2: Patch missing senses ===

async function translateSenses(batch: PendingSense[]): Promise<Map<string, Map<number, string>>> {
  const prompt = batch
    .map((p, i) => `${i + 1}. ${p.word} (sense ${p.senseIdx + 1}): ${p.enText}`)
    .join("\n");

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 2048,
    messages: [{
      role: "user",
      content: `Translate the following English definitions into concise Chinese (简体中文).
Output format: one line per entry, just "number. ChineseTranslation".

${prompt}`,
    }],
    system: "You are a Japanese-Chinese dictionary translator. Output ONLY the numbered translations.",
  });

  const text = response.content[0].type === "text" ? response.content[0].text : "";
  const result = new Map<string, Map<number, string>>();
  const lines = text.trim().split("\n").filter(Boolean);

  for (const line of lines) {
    const match = line.match(/^(\d+)\.\s*(.+)/);
    if (match) {
      const idx = parseInt(match[1]) - 1;
      const translation = match[2].trim();
      if (idx >= 0 && idx < batch.length) {
        const p = batch[idx];
        if (!result.has(p.id)) result.set(p.id, new Map());
        result.get(p.id)!.set(p.senseIdx, translation);
      }
    }
  }
  return result;
}

// === Safe wrappers ===

async function safeTranslateEntries(batch: PendingEntry[]) {
  try {
    return await translateEntries(batch);
  } catch {
    return [] as TranslatedEntry[];
  }
}

async function safeTranslateSenses(batch: PendingSense[]) {
  try {
    return await translateSenses(batch);
  } catch {
    return new Map<string, Map<number, string>>();
  }
}

function save() {
  writeFileSync(OUTPUT_FILE, JSON.stringify(results));
}

// === Main ===

async function main() {
  // Phase 1: complete missing entries
  if (missingEntries.length > 0) {
    console.log(`\n=== Translating ${missingEntries.length} missing entries ===`);
    const BATCH_SIZE = 50;
    const CONCURRENCY = 20;
    let done = 0;

    for (let i = 0; i < missingEntries.length; i += BATCH_SIZE * CONCURRENCY) {
      const chunks: PendingEntry[][] = [];
      for (let j = 0; j < CONCURRENCY && i + j * BATCH_SIZE < missingEntries.length; j++) {
        chunks.push(missingEntries.slice(i + j * BATCH_SIZE, i + (j + 1) * BATCH_SIZE));
      }

      const batchResults = await Promise.all(chunks.map(safeTranslateEntries));
      for (const translated of batchResults) {
        for (const t of translated) {
          if (t.zh.length > 0 && t.zh[0][0]) {
            results.push(t);
            resultMap.set(t.id, t);
          }
        }
      }

      done += chunks.flat().length;
      save();
      console.log(`Entries: ${done}/${missingEntries.length}`);
    }
  }

  // Phase 2: patch missing senses
  if (missingSenses.length > 0) {
    console.log(`\n=== Patching ${missingSenses.length} missing senses ===`);
    const BATCH_SIZE = 30;
    const CONCURRENCY = 10;
    let done = 0;

    for (let i = 0; i < missingSenses.length; i += BATCH_SIZE * CONCURRENCY) {
      const chunks: PendingSense[][] = [];
      for (let j = 0; j < CONCURRENCY && i + j * BATCH_SIZE < missingSenses.length; j++) {
        chunks.push(missingSenses.slice(i + j * BATCH_SIZE, i + (j + 1) * BATCH_SIZE));
      }

      const allResults = await Promise.all(chunks.map(safeTranslateSenses));

      for (const idResults of allResults) {
        for (const [id, senseMap] of idResults) {
          let entry = resultMap.get(id);
          if (!entry) {
            entry = { id, zh: [] };
            results.push(entry);
            resultMap.set(id, entry);
          }
          for (const [senseIdx, zhText] of senseMap) {
            if (senseIdx < entry.zh.length) {
              entry.zh[senseIdx] = [zhText];
            } else {
              while (entry.zh.length < senseIdx) entry.zh.push([]);
              entry.zh.push([zhText]);
            }
          }
        }
      }

      done += chunks.flat().length;
      save();
      console.log(`Senses: ${done}/${missingSenses.length}`);
    }
  }

  save();
  console.log("\nDone! All translations up to date.");
}

main().catch(console.error);
