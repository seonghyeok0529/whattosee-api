// src/pipelines/news/parseArticle.ts
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import prisma from "../../lib/prisma.js";
import { extractThumbnailFromHtml } from "./extractThumbnail.js";
import axios from "axios";  // 🔹 여기에 정적 import

export async function parseArticles(limit = 100) {
  const targets = await prisma.rawArticle.findMany({
    where: { status: "FETCHED" },
    take: limit,
    orderBy: { createdAt: "asc" },
  });

  for (const a of targets) {
    try {
      const resp = await axios.get<string>(a.url, {
        timeout: 10000,
        responseType: "text",
        validateStatus: () => true,
      });

      const html = resp.data || "";
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

      const thumbnail = extractThumbnailFromHtml(html, a.url);

      await prisma.rawArticle.update({
        where: { id: a.id },
        data: {
          html,
          text,
          status: "PARSED",
          thumbnail: thumbnail ?? undefined,
        },
      });
    } catch {
      await prisma.rawArticle.update({
        where: { id: a.id },
        data: { status: "FAILED" },
      });
    }
  }
}
