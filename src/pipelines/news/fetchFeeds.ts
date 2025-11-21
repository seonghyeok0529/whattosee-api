// src/pipelines/news/fetchFeeds.ts
import Parser from "rss-parser";
import prisma from "../../lib/prisma.js";
import crypto from "crypto";

type FeedCfg = { outlet: string; url: string; side: "left"|"center"|"right"|"neutral" };

export async function fetchFeeds() {
  const parser = new Parser();
  const feeds: FeedCfg[] = JSON.parse(process.env.NEWS_FEEDS ?? "[]");
  const results: string[] = [];

  for (const f of feeds) {
    const feed = await parser.parseURL(f.url);
    for (const item of feed.items ?? []) {
      const url = (item.link || "").trim();
      const title = (item.title || "").trim();
      if (!url || !title) continue;

      const hash = crypto.createHash("sha1").update(`${url}|${title}`).digest("hex");
      try {
        const a = await prisma.rawArticle.create({
          data: {
            outlet: f.outlet,
            side: f.side as any,
            url,
            title,
            publishedAt: item.isoDate ? new Date(item.isoDate) : null,
            hash,
            status: "FETCHED",
          },
        });
        results.push(a.id);
      } catch (e) {
        // unique(url) 충돌은 이미 존재 → 스킵
      }
    }
  }
  return results;
}
