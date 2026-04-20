// src/pipelines/news/clusterByEmbedding.ts

import OpenAI from "openai";
import crypto from "crypto";
import type { RawArticleLite, Cluster } from "./types.js";

/**
 * ENV
 * - UPSTAGE_API_KEY
 * - NEWS_CLUSTER_EMBED_MODEL (default: "text-embedding-3-small")
 * - NEWS_CLUSTER_BATCH (default: 64, 8~256)
 * - NEWS_CLUSTER_SIM_THRESHOLD (default: 0.82, 0.5~0.99)
 * - NEWS_CLUSTER_MAX_ARTICLES (default: 1000, hard cap 5000)
 */
const MODEL =
  process.env.NEWS_CLUSTER_EMBED_MODEL?.trim() || "text-embedding-3-small";
const BATCH = Math.min(Math.max(Number(process.env.NEWS_CLUSTER_BATCH ?? 64), 8), 256);
const MAX_N = Math.min(Number(process.env.NEWS_CLUSTER_MAX_ARTICLES ?? 1000), 5000);
const SIM_T = Math.min(Math.max(Number(process.env.NEWS_CLUSTER_SIM_THRESHOLD ?? 0.82), 0.5), 0.99);

const client = new OpenAI({
  apiKey: process.env.UPSTAGE_API_KEY,
  baseURL: "https://api.upstage.ai/v1",
});

/** 안전한 텍스트 구성: 제목 + (요약 또는 본문 일부), 과도한 길이 제한 */
function articleText(a: RawArticleLite): string {
  const title = (a.title ?? "").trim();
  const body  = (a.summary ?? a.body ?? "").trim();
  const limited = body.length > 2000 ? body.slice(0, 2000) : body; // 비용/속도 보호
  const t = title ? `제목: ${title}\n` : "";
  const b = limited ? `본문: ${limited}` : "";
  const joined = `${t}${b}`.trim();
  return joined.length ? joined : (title || "(내용 없음)");
}

/** 코사인 유사도 */
function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    dot += x * y; na += x * x; nb += y * y;
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

/** 연결요소 → 클러스터 */
function connectedComponents(adj: Uint8Array[], n: number): number[][] {
  const visited = new Uint8Array(n);
  const clusters: number[][] = [];
  for (let i = 0; i < n; i++) {
    if (visited[i]) continue;
    const stack = [i];
    visited[i] = 1;
    const comp: number[] = [];
    while (stack.length) {
      const v = stack.pop()!;
      comp.push(v);
      const row = adj[v];
      for (let u = 0; u < n; u++) {
        if (row[u] === 1 && !visited[u]) {
          visited[u] = 1;
          stack.push(u);
        }
      }
    }
    clusters.push(comp);
  }
  return clusters;
}

/** 클러스터 키(표시용) */
function clusterKey(arts: RawArticleLite[]): string {
  const head = arts.slice(0, 3).map(a => (a.title ?? "").slice(0, 40)).join(" | ");
  const h = crypto.createHash("sha1")
    .update(arts.map(a => a.url.split("#")[0].split("?")[0]).join("|"))
    .digest("hex")
    .slice(0, 10);
  return `${head} :: ${h}`;
}

/** OpenAI 임베딩 배치 호출 */
async function embedBatch(texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const chunk = texts.slice(i, i + BATCH);
    const resp = await client.embeddings.create({ model: MODEL, input: chunk });
    for (const d of resp.data) out.push(d.embedding as unknown as number[]);
  }
  return out;
}

/** 임베딩 기반 클러스터링 */
export async function clusterByEmbedding(input: RawArticleLite[]): Promise<Cluster[]> {
  const docs = input.slice(0, MAX_N);
  if (docs.length === 0) return [];

  const texts = docs.map(articleText);
  const embs  = await embedBatch(texts);
  const n = embs.length;

  const adj: Uint8Array[] = Array.from({ length: n }, () => new Uint8Array(n));
  for (let i = 0; i < n; i++) {
    adj[i][i] = 1;
    for (let j = i + 1; j < n; j++) {
      const sim = cosine(embs[i], embs[j]);
      if (sim >= SIM_T) { adj[i][j] = 1; adj[j][i] = 1; }
    }
  }

  const comps = connectedComponents(adj, n);

  const clusters: Cluster[] = comps
    .map(idx => idx.map(i => docs[i]))
    .map(arts => ({ key: clusterKey(arts), articles: arts }));

  return clusters;
}
