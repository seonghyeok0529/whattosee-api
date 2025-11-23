// src/pipelines/news/extractThumbnail.ts
import { JSDOM } from "jsdom";

export function extractThumbnailFromHtml(html: string, pageUrl: string): string | null {
  if (!html) return null;

  const dom = new JSDOM(html, { url: pageUrl });
  const doc = dom.window.document;

  // 1) og:image 우선
  const ogImage =
    doc
      .querySelector('meta[property="og:image"], meta[name="og:image"]')
      ?.getAttribute("content")
      ?.trim() || null;

  if (ogImage) {
    return absolutizeUrl(ogImage, pageUrl);
  }

  // 2) 없으면 첫 번째 img 태그
  const img = doc.querySelector("img");
  if (img) {
    const src = img.getAttribute("src")?.trim();
    if (src) return absolutizeUrl(src, pageUrl);
  }

  return null;
}

function absolutizeUrl(src: string, baseUrl: string): string {
  try {
    // 이미 절대 URL이면 그대로
    const u = new URL(src, baseUrl);
    return u.toString();
  } catch {
    return src;
  }
}
