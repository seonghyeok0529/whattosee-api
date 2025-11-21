// src/pipelines/news/cluster.ts

import type { RawArticleLite, Cluster } from './types';

// 아주 가벼운 불용어(한국어/영어 혼합, 필요시 확장)
const STOP = new Set([
  'the','a','an','and','or','but','of','to','in','on','for','with','by','at','from','as','is','are','was','were',
  '및','과','또는','등','대한','에서','으로','에게','에서의','에','를','은','는','이','가','도','만','까지','부터'
]);

function normalizeText(t?: string) {
  const s = (t ?? '')
    .replace(/\[[^\]]*?\]|\([^\)]*?\)|\{[^}]*?\}/g, ' ')  // 괄호 블록 제거
    .replace(/[“”"':\-–—·•|/\\.,!?;~%^&*+=<>{}]/g, ' ')   // 구두점/구분자 제거
    .replace(/\d{2,}/g, ' ')                              // 숫자 덩어리 완화
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  return s;
}

function tokenizeForKey(title?: string, summary?: string, body?: string) {
  const base = normalizeText(`${title ?? ''} ${summary ?? ''} ${body ?? ''}`);
  const tokens = base.split(' ').filter(Boolean);
  // 불용어 제거 + 2자 미만 제거
  const filtered = tokens.filter(w => w.length >= 2 && !STOP.has(w));
  // 빈도순/사전순 섞기: 상위 토큰 14개를 사전순 고정 → 순서 의존성 감소
  const freq = new Map<string, number>();
  for (const w of filtered) freq.set(w, (freq.get(w) ?? 0) + 1);
  const top = Array.from(freq.entries())
    .sort((a,b) => (b[1]-a[1]) || a[0].localeCompare(b[0]))
    .slice(0, 14)
    .map(([w]) => w)
    .sort(); // 최종 사전순 고정
  return top;
}

/** 시간버킷 제거: 런마다 키가 달라지는 걸 방지하기 위해 순수 토큰 서명만 사용 */
function canonicalKey(a: RawArticleLite) {
  if (a.clusterKey) return a.clusterKey; // 외부 키가 있으면 우선
  const sig = tokenizeForKey(a.title, a.summary, a.body);
  return `sig:${sig.join('_')}`;
}

export function clusterArticles(articles: RawArticleLite[]): Cluster[] {
  const buckets = new Map<string, RawArticleLite[]>();

  for (const a of articles) {
    const key = canonicalKey(a);
    const list = buckets.get(key) ?? [];
    list.push(a);
    buckets.set(key, list);
  }

  return Array.from(buckets.entries()).map(([key, items]) => ({
    key,
    articles: items.slice().sort((x, y) => {
      const xt = new Date(x.publishedAt ?? new Date()).getTime();
      const yt = new Date(y.publishedAt ?? new Date()).getTime();
      return yt - xt;
    }),
  }));
}
