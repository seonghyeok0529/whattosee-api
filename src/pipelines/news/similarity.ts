// src/pipelines/news/similarity.ts
export function norm(s: string) {
    return (s || '')
      .toLowerCase()
      .replace(/[【】\[\]\(\)'"“”‘’·•…!?.,:;~]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  export function tokenize(s: string) {
    return new Set(norm(s).split(' ').filter(w => w.length >= 2));
  }
  export function jaccard(a: Set<string>, b: Set<string>) {
    const inter = new Set([...a].filter(x => b.has(x))).size;
    const union = a.size + b.size - inter;
    return union ? inter / union : 0;
  }
  