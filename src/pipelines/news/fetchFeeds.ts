// src/pipelines/news/fetchFeeds.ts
import Parser from "rss-parser";
import prisma from "../../lib/prisma.js";
import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { normalizeUrl } from "./utils/normalizeUrl.js";

type FeedCfg = { outlet: string; url: string; side: "left" | "center" | "right" | "neutral" };

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function isUniqueViolation(e: unknown) {
  // Prisma unique constraint violation
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

export async function fetchFeeds() {
  const parser = new Parser();
  const feeds: FeedCfg[] = safeJsonParse(process.env.NEWS_FEEDS ?? "[]", []);
  const results: string[] = [];

  for (const f of feeds) {
    let feed;
    try {
      feed = await parser.parseURL(f.url);
    } catch (e) {
      console.warn("[fetchFeeds] parse fail:", f.url, e);
      continue;
    }

    for (const item of feed.items ?? []) {
      const rawUrl = String(item.link || item.guid || "").trim();
      const title = String(item.title || "").trim();
      if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) continue;
      if (!title) continue;

      // ✅ 핵심: 정규화 URL로 중복을 막음 (utm 등 제거)
      const url = normalizeUrl(rawUrl);
      if (!url || !/^https?:\/\//i.test(url)) continue;

      // (선택) hash를 url|title 로 유지하되, url 정규화 이후로 생성
      const hash = crypto.createHash("sha1").update(`${url}|${title}`).digest("hex");

      try {
        const a = await prisma.rawArticle.create({
          data: {
            outlet: f.outlet,
            side: f.side as any,
            url, // ✅ 정규화 URL 저장
            title,
            publishedAt: (item as any).isoDate ? new Date((item as any).isoDate) : null,
            hash,
            status: "FETCHED",
          },
          select: { id: true },
        });
        results.push(a.id);
      } catch (e) {
        // ✅ 유니크 충돌(=이미 존재)만 조용히 스킵
        if (isUniqueViolation(e)) continue;

        // ❗ 그 외 에러는 숨기지 말고 로그 남겨서 운영에서 잡히게
        console.error("[fetchFeeds] create fail:", { outlet: f.outlet, url, title }, e);
        throw e;
      }
    }
  }

  return results;
}
