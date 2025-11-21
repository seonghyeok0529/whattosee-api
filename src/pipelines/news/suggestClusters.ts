// src/pipelines/news/suggestClusters.ts
import prisma from "../../lib/prisma.js";
import type { RawArticleLite } from "./types.js";
import { extractKeywords, normalizeTitle } from "./util/keywords.js";

/** 제안 한 묶음의 입력 타입 */
export type SuggestionInput = {
  key: string;
  title: string;
  summary?: string;
  confidence: number;   // 0~1
  windowStart?: Date;
  windowEnd?: Date;
  articles: Array<{
    url: string;
    title?: string;
    outlet?: string;
    side?: "left" | "center" | "right" | "neutral";
    publishedAt?: Date;
    summary?: string;
    rawArticleId?: string; // 있으면 연결
    sourceId?: string;     // 있으면 연결
  }>;
};

/** 제안 생성 (배치) */
export async function suggestClusters(payloads: SuggestionInput[]) {
  if (!Array.isArray(payloads) || payloads.length === 0) return [];

  const created = [];
  for (const p of payloads) {
    const title = normalizeTitle(p.title);
    const summary = p.summary ?? extractKeywords(`${p.title} ${p.summary ?? ""}`).join(", ");

    const suggestion = await prisma.clusterSuggestion.upsert({
      where: { key: p.key },
      update: {
        title,
        summary,
        confidence: p.confidence,
        windowStart: p.windowStart,
        windowEnd: p.windowEnd,
        status: "PENDING",
      },
      create: {
        key: p.key,
        title,
        summary,
        confidence: p.confidence,
        windowStart: p.windowStart,
        windowEnd: p.windowEnd,
        status: "PENDING",
        articles: {
          create: p.articles.map(a => ({
            url: a.url,
            title: a.title ? normalizeTitle(a.title) : null,
            outlet: a.outlet ?? null,
            side: a.side ?? null,
            publishedAt: a.publishedAt ?? null,
            summary: a.summary ?? null,
            // 연결 가능한 원본이 있으면 연결
            ...(a.rawArticleId ? { raw: { connect: { id: a.rawArticleId } } } : {}),
            ...(a.sourceId     ? { source: { connect: { id: a.sourceId } } }   : {}),
          })),
        },
      },
      select: { id: true, key: true, status: true },
    });

    created.push(suggestion);
  }
  return created;
}

/** 간단 검색 (반환 타입 any 방지) */
export async function findSuggestions(opts: {
  status?: "PENDING" | "APPROVED" | "REJECTED" | "MERGED" | "SPLIT";
  take?: number;
}) : Promise<Array<{ id: string; key: string; title: string; status: string; createdAt: Date }>> {
  const rows = await prisma.clusterSuggestion.findMany({
    where: opts.status ? { status: opts.status } : undefined,
    take: opts.take ?? 50,
    orderBy: { createdAt: "desc" },
    select: { id: true, key: true, title: true, status: true, createdAt: true },
  });
  return rows;
}
