// src/utils/textSim.ts

let naturalPromise: Promise<any> | null = null;

async function loadNatural() {
  // 최초 1번만 import 하고 이후엔 캐싱
  if (!naturalPromise) {
    naturalPromise = import("natural");
  }
  return naturalPromise;
}

async function getTfIdf() {
  const natural = await loadNatural();
  return natural.TfIdf;
}

export async function buildTfidfVectors(docs: string[]) {
  const TfIdf = await getTfIdf();

  const tfidf = new TfIdf();
  docs.forEach((d) => tfidf.addDocument(d));

  return docs.map((_, i) => {
    const vector: Record<string, number> = {};
    tfidf.listTerms(i).forEach(
      (t: { term: string; tfidf: number }) => {
        vector[t.term] = t.tfidf;
      }
    );
    return vector;
  });
}

export function cosineSim(
  a: Record<string, number>,
  b: Record<string, number>
) {
  const terms = new Set([...Object.keys(a), ...Object.keys(b)]);
  let dot = 0,
    na = 0,
    nb = 0;

  for (const t of terms) {
    const x = a[t] ?? 0;
    const y = b[t] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }

  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
