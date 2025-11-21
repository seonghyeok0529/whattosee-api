// src/utils/textSim.ts
const natural = await import('natural');
const { TfIdf } = natural;

export function buildTfidfVectors(docs: string[]) {
  const tfidf = new TfIdf();
  docs.forEach(d => tfidf.addDocument(d));

  return docs.map((_, i) => {
    const vector: Record<string, number> = {};
    tfidf.listTerms(i).forEach((t: { term: string; tfidf: number }) => {
      vector[t.term] = t.tfidf;
    });
    return vector;
  });
}

export function cosineSim(
  a: Record<string, number>,
  b: Record<string, number>
) {
  const terms = new Set([...Object.keys(a), ...Object.keys(b)]);
  let dot = 0, na = 0, nb = 0;

  for (const t of terms) {
    const x = a[t] ?? 0;
    const y = b[t] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }

  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
