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

      // ✅ 본문 길이와 상관없이 썸네일은 먼저 뽑아둔다
      const thumbnail = extractThumbnailFromHtml(html, a.url);

      // 🔻 짧은 기사 처리 로직 수정
      if (!text || text.length < 300) {
        await prisma.rawArticle.update({
          where: { id: a.id },
          data: {
            // 👉 필요하면 html도 저장해 두는 게 나중에 다시 파싱할 때 유리
            html,
            thumbnail: thumbnail ?? undefined,
            status: "FAILED",   // 또는 "SHORT" 같은 새 상태를 만들어도 됨
          },
        });
        continue;
      }

      // 🔹 정상 길이 기사 → PARSED + 썸네일 저장
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
