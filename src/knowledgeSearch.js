/**
 * Dependency-free TF-IDF search over the local knowledge/ corpus.
 * This is the same retrieval technique used in the docuchat-rag project,
 * repurposed here as a "tool" the researcher agent can call — either
 * directly (demo mode) or via Claude's function-calling / tool-use
 * mechanism (live mode).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KNOWLEDGE_DIR = path.join(__dirname, "..", "knowledge");

const STOPWORDS = new Set([
  "the","a","an","is","are","was","were","be","been","being","to","of","in",
  "on","for","with","and","or","but","this","that","these","those","it","its",
  "as","at","by","from","into","about","than","then","so","such","not","no",
]);

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !STOPWORDS.has(t));
}

function loadCorpus() {
  const docs = [];
  for (const fname of fs.readdirSync(KNOWLEDGE_DIR)) {
    const text = fs.readFileSync(path.join(KNOWLEDGE_DIR, fname), "utf-8");
    // split into paragraphs so results are focused, not whole-file dumps
    const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 20);
    paragraphs.forEach((p, i) => {
      docs.push({ docName: fname, paraIndex: i, text: p.trim() });
    });
  }
  return docs;
}

const CORPUS = loadCorpus();
const TOKENIZED = CORPUS.map((d) => tokenize(d.text));
const N = CORPUS.length;
const DOC_FREQ = new Map();
for (const tokens of TOKENIZED) {
  for (const term of new Set(tokens)) {
    DOC_FREQ.set(term, (DOC_FREQ.get(term) || 0) + 1);
  }
}
function vectorize(tokens) {
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  const vec = new Map();
  for (const [term, freq] of tf) {
    const df = DOC_FREQ.get(term) || 1;
    const idf = Math.log((N + 1) / df) + 1;
    vec.set(term, freq * idf);
  }
  return vec;
}
const CORPUS_VECTORS = TOKENIZED.map(vectorize);

function cosineSim(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (const [term, w] of a) {
    magA += w * w;
    if (b.has(term)) dot += w * b.get(term);
  }
  for (const [, w] of b) magB += w * w;
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

export function searchKnowledge(query, topK = 3) {
  const queryVec = vectorize(tokenize(query));
  const scored = CORPUS_VECTORS.map((vec, i) => ({
    ...CORPUS[i],
    score: cosineSim(queryVec, vec),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).filter((s) => s.score > 0);
}
