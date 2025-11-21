// src/services/generateIssueSummary.ts
import { prisma } from "../lib/prisma";
import { summarizeCluster } from "../pipelines/news/summarize";
import type { Issue, Source } from "@prisma/client";

export async function generateIssueSummary(
  issue: Issue & { sources: Source[] }
): Promise<string> {
  if (!issue.sources || issue.sources.length === 0) {
    return issue.summary ?? "";
  }

  // URL → rawArticle 매핑
  const rawArticles = await prisma.rawArticle.findMany({
    where: {
      url: { in: issue.sources.map(s => s.url).filter(Boolean) }
    },
    select: {
      title: true,
      outlet: true,
      url: true,
      text: true,
    },
  });

  if (rawArticles.length === 0) {
    return issue.summary ?? "";
  }

  const result = await summarizeCluster(
    rawArticles.map(r => ({
      title: r.title,
      outlet: r.outlet,
      url: r.url,
      text: r.text ?? ""
    }))
  );

  // summarizeCluster 반환 구조:
  // { title, summary, tags, persons }
  return result.summary;
}