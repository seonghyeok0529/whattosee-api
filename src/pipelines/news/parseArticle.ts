// src/pipelines/news/parseArticle.ts
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import prisma from "../../lib/prisma.js";

export async function parseArticles(limit = 100) {
  const { default: got } = await import("got");
  
  const targets = await prisma.rawArticle.findMany({
    where: { status: "FETCHED" },
    take: limit,
    orderBy: { createdAt: "asc" },
  });

  for (const a of targets) {
    try {
      const html = await got(a.url, { timeout: { request: 10000 } }).text();
      const dom = new JSDOM(html, { url: a.url });
      const reader = new Readability(dom.window.document).parse();
      const text = (reader?.textContent || "").trim();
      if (!text || text.length < 300) {
        await prisma.rawArticle.update({
          where: { id: a.id },
          data: { status: "FAILED" },
        });
        continue;
      }
      await prisma.rawArticle.update({
        where: { id: a.id },
        data: { html, text, status: "PARSED" },
      });
    } catch {
      await prisma.rawArticle.update({
        where: { id: a.id },
        data: { status: "FAILED" },
      });
    }
  }
}
