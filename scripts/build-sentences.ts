import { createReadStream } from "node:fs";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as OpenCC from "opencc-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SENTENCES_FILE = resolve(__dirname, "../data/sentences.csv");
const LINKS_FILE = resolve(__dirname, "../data/links.csv");
const OUTPUT_FILE = resolve(__dirname, "../data/sentences-ja-zh.json");

const converter = OpenCC.Converter({ from: "tw", to: "cn" });

interface Sentence {
  id: number;
  lang: string;
  text: string;
}

async function main() {
  console.log("Reading Japanese and Chinese sentences...");

  const jpnSentences = new Map<number, string>();
  const cmnSentences = new Map<number, string>();

  const rl1 = createInterface({ input: createReadStream(SENTENCES_FILE) });
  for await (const line of rl1) {
    const [idStr, lang, text] = line.split("\t");
    const id = parseInt(idStr);
    if (lang === "jpn") jpnSentences.set(id, text);
    else if (lang === "cmn") cmnSentences.set(id, text);
  }

  console.log(`Japanese sentences: ${jpnSentences.size}`);
  console.log(`Chinese sentences: ${cmnSentences.size}`);

  console.log("Reading links...");
  const pairs: { ja: string; zh: string }[] = [];

  const rl2 = createInterface({ input: createReadStream(LINKS_FILE) });
  for await (const line of rl2) {
    const [id1Str, id2Str] = line.split("\t");
    const id1 = parseInt(id1Str);
    const id2 = parseInt(id2Str);

    if (jpnSentences.has(id1) && cmnSentences.has(id2)) {
      pairs.push({ ja: jpnSentences.get(id1)!, zh: converter(cmnSentences.get(id2)!) });
    } else if (cmnSentences.has(id1) && jpnSentences.has(id2)) {
      pairs.push({ ja: jpnSentences.get(id2)!, zh: converter(cmnSentences.get(id1)!) });
    }
  }

  console.log(`Japanese-Chinese pairs: ${pairs.length}`);
  writeFileSync(OUTPUT_FILE, JSON.stringify(pairs));
  console.log(`Written to ${OUTPUT_FILE}`);
}

main();
