// src/pipelines/news/backfillIssueThumbnails.ts
import prisma from "../../lib/prisma.js";
import { extractThumbnailFromHtml } from "./extractThumbnail.js";

export async function backfillIssueThumbnails(limit = 50) {
  // 썸네일 없는 공개 이슈만
  const issues = await prisma.issue.findMany({
    where: {
      thumbnailUrl: null,
      status: "PUBLISHED",
    },
    take: limit,
    include: {
      sources: {
        orderBy: { createdAt: "asc" }, // 오래된 기사 우선
      },
    },
  });

  if (!issues.length) {
    console.log("No issues to backfill.");
    return;
  }

  for (const issue of issues) {
    if (!issue.sources.length) continue;

    // 대표 Source 하나 고르기 (가장 오래된 or 주요 매체)
    const source = issue.sources[0];

    // 1️⃣ RawArticle 찾기
    const raw = await prisma.rawArticle.findUnique({
      where: { url: source.url },
      select: {
        id: true,
        url: true,
        thumbnail: true,
        html: true,
      },
    });

    let thumb: string | null = null;

    if (raw?.thumbnail) {
      thumb = raw.thumbnail;
    } else if (raw?.html) {
      // html은 있는데 thumbnail이 비어 있으면, 여기서 다시 추출
      thumb = extractThumbnailFromHtml(raw.html, raw.url);
      if (thumb) {
        await prisma.rawArticle.update({
          where: { id: raw.id },
          data: { thumbnail: thumb },
        });
      }
    }

    // RawArticle에서 못 구했으면 여기서 포기 (필요하면 got으로 다시 긁어와도 됨)
    if (!thumb) continue;

    await prisma.issue.update({
      where: { id: issue.id },
      data: { thumbnailUrl: thumb },
    });

    console.log(`Updated Issue(${issue.id}) thumbnail -> ${thumb}`);
  }
}
