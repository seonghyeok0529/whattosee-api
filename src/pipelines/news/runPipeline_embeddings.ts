// src/pipelines/news/runPipeline_embeddings.ts
import prisma from "../../lib/prisma.js";
import { clusterArticles } from "./cluster.js";
import { clusterByEmbedding } from "./clusterByEmbedding.js";
import { attachIssues } from "./attachIssues.js";
import type {
  RawArticleLite,
  Cluster,
  SourceSide as NewsSide,
} from "./types.js";
import {
  ArticleStatus,
  Prisma,
  SourceSide as PrismaSide,
} from "@prisma/client";

// 🔹 추가: HTML 파싱 + 썸네일 추출
import { parseArticles } from "./parseArticle.js";
// 🔹 추가: Issue.thumbnailUrl 채우는 백필
import { backfillIssueThumbnails } from "./backfillIssueThumbnails.js";

/** ───────────────────────────────────────────────────────────────
 *  side 매핑 (문자열/뉴스타입 ↔ Prisma enum)
 *  ───────────────────────────────────────────────────────────── */
function toPrismaSide(s?: string | null): PrismaSide {
  switch ((s ?? "").toLowerCase()) {
    case "left":
      return PrismaSide.left;
    case "right":
      return PrismaSide.right;
    case "neutral":
      return PrismaSide.neutral;
    case "center":
    default:
      return PrismaSide.center;
  }
}
function toNewsSide(s?: string | null): NewsSide {
  switch ((s ?? "").toLowerCase()) {
    case "left":
      return "left";
    case "right":
      return "right";
    case "neutral":
      return "neutral";
    case "center":
    default:
      return "center";
  }
}

/** 날짜/해시 유틸 */
function asDate(x: RawArticleLite["publishedAt"]): Date {
  if (!x) return new Date();
  const d = x instanceof Date ? x : new Date(x);
  return isNaN(d.getTime()) ? new Date() : d;
}
function hashKey(a: RawArticleLite): string {
  const title = (a.title ?? "").slice(0, 120);
  return `${a.url.split("#")[0].split("?")[0]}|${title}`;
}

/** DB row → RawArticleLite */
function dbRowToRawArticleLite(row: {
  outlet: string;
  side: PrismaSide;
  url: string;
  title: string | null;
  publishedAt: Date | null;
  hash: string | null;
  text?: string | null;
}): RawArticleLite {
  const base: RawArticleLite = {
    outlet: row.outlet,
    side: toNewsSide(row.side as unknown as string),
    url: row.url,
    title: row.title ?? "(제목 없음)",
    publishedAt: row.publishedAt ?? new Date(),
    hash: row.hash ?? "",
  };
  const s = (row.text || "").trim();
  if (s) base.summary = s; // 🔹 HTML 파싱된 본문(text)을 summary로 사용
  return base;
}

/** 메인 파이프라인
 *  - scraped를 DB에 upsert(중복 차단)
 *  - HTML 파싱 + 썸네일 추출 (parseArticles)
 *  - 최근 PARSED 기사 포함하여 클러스터링
 *  - 이슈 생성/갱신 + 소스 연결
 *  - 이슈 썸네일 백필(backfillIssueThumbnails)
 */
export async function runPipeline(scraped: RawArticleLite[]) {
  // 0) 룩백 윈도우
  const lookbackHours = Math.min(
    Math.max(Number(process.env.NEWS_CLUSTER_LOOKBACK_HOURS ?? 24), 1),
    168
  );
  const since = new Date(Date.now() - lookbackHours * 3600 * 1000);

  // 1) scraped → DB insert (SQLite는 skipDuplicates 미지원 → 선조회)
  const prepared: Prisma.RawArticleCreateManyInput[] = scraped.map((a) => ({
    outlet: a.outlet,
    side: toPrismaSide((a as any).side),
    url: a.url,
    title: a.title ?? "(제목 없음)",
    publishedAt: asDate(a.publishedAt),
    hash: (a as any).hash ?? hashKey(a),
    status: ArticleStatus.FETCHED,
  }));

  const urls = prepared.map((p) => p.url);
  if (urls.length) {
    const existing = await prisma.rawArticle.findMany({
      where: { url: { in: urls } },
      select: { url: true },
    });
    const existSet = new Set(existing.map((e) => e.url));
    const toInsert = prepared.filter((p) => !existSet.has(p.url));
    if (toInsert.length > 0) {
      await prisma.rawArticle.createMany({ data: toInsert });
    }
  }

  // 1.5) 🔥 HTML 파싱 + 썸네일 추출 실행
  //  - status = FETCHED 인 RawArticle 대상으로
  //  - html, text, thumbnail 채우고 status=PARSED 로 바꿈
  try {
    const parseLimit = Number(process.env.NEWS_PARSE_LIMIT ?? 200);
    await parseArticles(parseLimit);
  } catch (e) {
    console.warn("[runPipeline] parseArticles failed:", e);
    // 파싱 실패해도 클러스터링 자체는 계속 진행
  }

  // 2) 최근 DB 기사 로드 (🔹 PARSED 된 것만 사용해도 충분)
  const recentFromDB = await prisma.rawArticle.findMany({
    where: {
      createdAt: { gte: since },
      status: ArticleStatus.PARSED,
      url: { not: "" },
    },
    select: {
      outlet: true,
      side: true,
      url: true,
      title: true,
      publishedAt: true,
      hash: true,
      text: true,
    },
    orderBy: { createdAt: "asc" },
    take: Math.min(Number(process.env.NEWS_MAX_RECENT_DB ?? 500), 1000),
  });

  // 3) 클러스터링 입력 생성: scraped + recentDB → News 타입 통일 + URL dedup
  const normalizedScraped: RawArticleLite[] = scraped.map((a) => {
    const base: RawArticleLite = {
      outlet: a.outlet,
      side: toNewsSide((a as any).side),
      url: a.url,
      title: a.title ?? "(제목 없음)",
      publishedAt: asDate(a.publishedAt),
      hash: (a as any).hash ?? hashKey(a),
    };
    if ((a as any).summary) base.summary = String((a as any).summary);
    return base;
  });
  const normalizedDB: RawArticleLite[] = recentFromDB.map(dbRowToRawArticleLite);

  const merged = [...normalizedScraped, ...normalizedDB];
  const dedupMap = new Map<string, RawArticleLite>();
  for (const a of merged) {
    if (!/^https?:\/\//i.test(a.url)) continue;
    const key = a.url.split("#")[0].split("?")[0];
    if (!dedupMap.has(key)) dedupMap.set(key, a);
  }
  const inputForClustering = Array.from(dedupMap.values());

  // 4) 클러스터링 (ENV: NEWS_CLUSTER_METHOD = "embed" | "tokens")
  const method = String(process.env.NEWS_CLUSTER_METHOD ?? "embed").toLowerCase();
  const clustered: Cluster[] =
    method === "tokens"
      ? clusterArticles(inputForClustering)
      : await clusterByEmbedding(inputForClustering);

  // 5) 이슈 생성/갱신 + 소스 연결(기존 이슈 보존 규칙 포함)
  const issues = await attachIssues(clustered);

  // 6) 🔥 이슈 썸네일 백필
  try {
    const backfillLimit = Number(process.env.NEWS_BACKFILL_ISSUES_LIMIT ?? 50);
    await backfillIssueThumbnails(backfillLimit);
  } catch (e) {
    console.warn("[runPipeline] backfillIssueThumbnails failed:", e);
  }

  return { clusters: clustered, issues };
}
