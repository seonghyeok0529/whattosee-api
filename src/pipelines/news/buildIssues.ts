// src/pipelines/news/buildIssues.ts
import prisma from "../../lib/prisma.js";
import type { RawArticleLite } from "./types.js";
import { SourceSide } from "@prisma/client";

function normTitle(t?: string) {
  const s = (t ?? "").trim();
  return s ? s.slice(0, 180) : "(제목 없음)";
}

function toSideEnum(side?: string): SourceSide {
  switch (side) {
    case "left":
      return SourceSide.left;
    case "right":
      return SourceSide.right;
    case "neutral":
      return SourceSide.neutral;
    case "center":
    default:
      return SourceSide.center;
  }
}

function pickRepresentative(articles: RawArticleLite[]) {
  return articles
    .slice()
    .sort((a, b) => (b.title?.length ?? 0) - (a.title?.length ?? 0))[0];
}

/**
 * 단일 클러스터(기사 배열) → Issue upsert + Sources 연결
 * (프로젝트에 따라 안 쓰일 수도 있지만, ts 빌드 에러 방지용으로 안전 구현)
 */
export async function upsertIssues(clusters: RawArticleLite[][]) {
  const createdIds: string[] = [];

  for (const group of clusters) {
    if (!Array.isArray(group) || group.length === 0) continue;

    const rep = pickRepresentative(group);
    const title = normTitle(rep?.title);
    const body = (rep?.summary ?? "").trim();

    let issue = await prisma.issue.findFirst({
      where: { title },
      select: { id: true },
    });

    if (!issue) {
      issue = await prisma.issue.create({
        data: {
          title,
          body,
          tags: [],
        },
        select: { id: true },
      });
    } else {
      await prisma.issue.update({
        where: { id: issue.id },
        data: { body },
      });
    }

    // Source sync
    for (const a of group) {
      const url = a?.url?.trim();
      if (!url) continue;

      const existed = await prisma.source.findFirst({
        where: { url },
        select: { id: true, issueId: true },
      });

      if (existed) {
        await prisma.source.update({
          where: { id: existed.id },
          data: {
            issueId: issue.id,
            outlet: a.outlet ?? "언론",
            title: normTitle(a.title),
            side: toSideEnum(a.side as any),
          },
        });
      } else {
        await prisma.source.create({
          data: {
            issueId: issue.id,
            url,
            outlet: a.outlet ?? "언론",
            title: normTitle(a.title),
            side: toSideEnum(a.side as any),
          },
        });
      }
    }

    createdIds.push(issue.id);
  }

  return createdIds;
}
