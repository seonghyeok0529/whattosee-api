// src/pipelines/news/attachIssues.ts
import prisma from "../../lib/prisma.js";
import type { Cluster, RawArticleLite } from "./types.js";
import { createHash } from "crypto";
import { SourceSide } from "@prisma/client";

function normTitle(t?: string) {
  const s = (t ?? "").trim();
  return s ? s.slice(0, 180) : "(제목 없음)";
}
function toSideEnum(side?: string): SourceSide {
  switch ((side ?? "").toLowerCase()) {
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

/** 대표 기사(정보량 추정) */
function pickRepresentative(articles: RawArticleLite[]) {
  return articles
    .slice()
    .sort((a, b) => {
      const la =
        (a.title?.length ?? 0) +
        (a.summary?.length ?? 0) +
        (a.body?.length ?? 0);
      const lb =
        (b.title?.length ?? 0) +
        (b.summary?.length ?? 0) +
        (b.body?.length ?? 0);
      return lb - la;
    })[0];
}

/** 새 이슈 생성 시 사용할 dedupKey(백업키 성격) */
function makeIssueDedupKey(articles: RawArticleLite[]) {
  const tokens = new Set<string>();
  for (const a of articles) {
    const text = `${a.title ?? ""} ${a.summary ?? ""} ${a.body ?? ""}`
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
    for (const w of text.split(" ")) if (w.length >= 2) tokens.add(w);
  }
  const bag = Array.from(tokens).sort().slice(0, 64).join("|");
  const firstTime =
    articles
      .map((a) => new Date(a.publishedAt ?? 0).getTime())
      .filter(Number.isFinite)
      .sort((x, y) => x - y)[0] ?? 0;
  const base = `${bag}|${firstTime}`;
  return createHash("sha1").update(base).digest("hex").slice(0, 16);
}

/** 클러스터의 URL들이 이미 어떤 이슈에 묶여있는지 확인하여 "정본 이슈" 결정 */
async function resolveCanonicalIssueId(
  urls: string[]
): Promise<string | null> {
  if (urls.length === 0) return null;
  const srcs = await prisma.source.findMany({
    where: { url: { in: urls } },
    select: { id: true, issueId: true, url: true },
  });
  if (srcs.length === 0) return null;

  // 가장 많이 등장하는 issueId(최빈값)를 정본으로 선택
  const counts = new Map<string, number>();
  for (const s of srcs)
    counts.set(s.issueId, (counts.get(s.issueId) ?? 0) + 1);
  let best: string | null = null;
  let bestCnt = -1;
  for (const [id, c] of counts.entries()) {
    if (c > bestCnt) {
      best = id;
      bestCnt = c;
    }
  }
  return best;
}

export async function attachIssues(clusters: Cluster[]) {
  const results: Array<{ issueId: string }> = [];

  for (const cluster of clusters) {
    const arts = Array.isArray(cluster.articles) ? cluster.articles : [];
    if (arts.length === 0) continue;

    const rep = pickRepresentative(arts);
    const title = normTitle((cluster as any).title ?? rep?.title);
    const body = (((cluster as any).summary ??
      rep?.summary ??
      rep?.body ??
      "") as string).trim();
    const tags = (Array.isArray((cluster as any).tags)
      ? (cluster as any).tags
      : []) as string[];

    // 🔹 대표 썸네일 하나 고르기 (대표 기사 우선, 없으면 아무 기사나)
    const thumbnailFromRep = rep?.thumbnail?.trim() || null;
    const thumbnailFallback =
      arts.find((a) => a.thumbnail && a.thumbnail.trim())?.thumbnail?.trim() ||
      null;
    const thumbnailUrl = thumbnailFromRep || thumbnailFallback || null;

    // ① URL 들 중 기존 이슈가 있으면 그것을 정본으로 사용
    const urls = arts
      .map((a) => (a.url ?? "").trim())
      .filter(Boolean);
    const canonicalId = await resolveCanonicalIssueId(urls);

    let issueId: string;

    if (canonicalId) {
      // 이미 존재하는 이슈 → 최신 정보로 가볍게 보정만
      await prisma.issue.update({
        where: { id: canonicalId },
        data: {
          ...(title ? { title } : {}),
          ...(body ? { body } : {}),
          ...(tags.length ? { tags } : {}),
          // 🔹 새로 잡은 썸네일이 있으면 채워줌
          ...(thumbnailUrl ? { thumbnailUrl } : {}),
        },
      });
      issueId = canonicalId;
    } else {
      // ② 기존 연결이 전혀 없을 때만 새 이슈 생성 (dedupKey backup)
      const dedupKey = makeIssueDedupKey(arts);
      const existed = await prisma.issue.findFirst({
        where: { dedupKey },
        select: { id: true },
      });
      if (existed) {
        issueId = existed.id;
        await prisma.issue.update({
          where: { id: issueId },
          data: {
            ...(title ? { title } : {}),
            ...(body ? { body } : {}),
            ...(tags.length ? { tags } : {}),
            ...(thumbnailUrl ? { thumbnailUrl } : {}),
          },
        });
      } else {
        const created = await prisma.issue.create({
          data: {
            dedupKey,
            title,
            body,
            ...(tags.length ? { tags } : {}),
            ...(thumbnailUrl ? { thumbnailUrl } : {}), // 🔹 새 이슈는 바로 썸네일 세팅
          },
          select: { id: true },
        });
        issueId = created.id;
      }
    }

    // ③ Source 동기화
    for (const a of arts) {
      const url = a?.url?.trim();
      if (!url) continue;

      const existed = await prisma.source.findFirst({
        where: { url },
        select: { id: true, issueId: true },
      });

      const data = {
        issueId,
        outlet: a.outlet ?? "언론",
        title: normTitle(a.title),
        side: toSideEnum(a.side as any),
        // publishedAt 을 붙이고 싶으면 여기에 추가 가능
        // publishedAt: new Date(a.publishedAt ?? new Date()),
      };

      if (existed) {
        if (existed.issueId === issueId) {
          await prisma.source.update({ where: { id: existed.id }, data });
        }
      } else {
        await prisma.source.create({ data: { url, ...data } });
      }
    }

    results.push({ issueId });
  }

  return results;
}
