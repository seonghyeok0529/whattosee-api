// src/routes/adminIngest.ts
import { Router, type Request, type Response } from "express";
import prisma from "../lib/prisma.js";
import { runPipeline } from "../pipelines/news/runPipeline_embeddings.js";
import { scrapeFeeds } from "../pipelines/news/scrapeFeeds.js";
import type { RawArticleLite, SourceSide } from "../pipelines/news/types.js";
import { asDate } from "../pipelines/news/date.js";
import { getOrCreateIssueSummary } from "../services/issueSummary.js";
import { requireAuth } from "../middleware/requireAuth";
import { adminAuth } from "../middleware/adminAuth";

// 진행상태 메모리 저장 (간단 구현)
const clusterProgress = { stage: "idle" as "idle" | "cluster", queued: 0, done: 0 };

/** ─────────────────────────────────────────────────────────
 *  타입: 파이프라인 결과 → 제안 upsert 입력
 * ───────────────────────────────────────────────────────── */
type ClusterArticleInput = {
  url: string;
  title?: string;
  outlet?: string;
  side?: SourceSide;
  publishedAt?: Date | string | null;
  summary?: string;
  // 파이프라인이 제공할 수도 있는 참조키(없으면 무시)
  rawArticleId?: string | null;
  sourceId?: string | null;
};

type ClusterInput = {
  key: string;
  title?: string;           // optional → 저장 시 보정
  summary?: string;
  confidence?: number;
  articles?: ClusterArticleInput[];
};

/** 제안 + 제안기사 upsert */
async function upsertClusterSuggestions(clusters: ClusterInput[]) {
  let suggCreated = 0;
  let artUpserts = 0;

  for (const c of clusters) {
    // 필수값 보정
    const safeTitle =
      c.title?.trim() ||
      c.articles?.[0]?.title?.trim() ||
      "(제목 없음)";

    const suggestion = await prisma.clusterSuggestion.upsert({
      where: { key: c.key },
      create: {
        key: c.key,
        title: safeTitle,
        summary: c.summary ?? undefined,
        confidence: typeof c.confidence === "number" ? c.confidence : 0.8,
        status: "PENDING",
      },
      update: {
        title: safeTitle,
        summary: c.summary ?? undefined,
        confidence: typeof c.confidence === "number" ? c.confidence : undefined,
      },
    });
    if (suggestion.createdAt.getTime() === suggestion.updatedAt.getTime()) {
      suggCreated++;
    }

    // 기사 upsert (복합 유니크: suggestionId + url)
    for (const a of c.articles ?? []) {
      const published =
        a.publishedAt ? new Date(a.publishedAt as any) : undefined;

      await prisma.clusterSuggestionArticle.upsert({
        where: {
          suggestionId_url: { suggestionId: suggestion.id, url: a.url },
        },
        create: {
          suggestionId: suggestion.id,
          url: a.url,
          title: a.title ?? undefined,
          outlet: a.outlet ?? undefined,
          side: (a.side as any) ?? "center",
          publishedAt: published,
          summary: a.summary ?? undefined,
          rawArticleId: a.rawArticleId ?? undefined,
          sourceId: a.sourceId ?? undefined,
        },
        update: {
          title: a.title ?? undefined,
          outlet: a.outlet ?? undefined,
          side: (a.side as any) ?? undefined,
          publishedAt: published,
          summary: a.summary ?? undefined,
          rawArticleId: a.rawArticleId ?? undefined,
          sourceId: a.sourceId ?? undefined,
        },
      });
      artUpserts++;
    }
  }

  return { suggCreated, artUpserts };
}

export const adminIngestRouter = Router();

/** ─────────────────────────────────────────────────────────
 *  시크릿 검증(외부 배치용)
 * ───────────────────────────────────────────────────────── */
function assertAdmin(req: Request, res: Response) {
  const secret = String(req.query.secret ?? req.header("x-admin-secret") ?? "");
  const expected = (process.env.ADMIN_SECRET ?? "").trim();
  if (!expected) { res.status(500).json({ error: "ADMIN_SECRET not set" }); return false; }
  if (secret !== expected) { res.status(403).json({ error: "FORBIDDEN" }); return false; }
  return true;
}

adminIngestRouter.get("/health", (_req, res) => res.json({ ok: true }));

/** ① (시크릿) 자동 인제스트 + (옵션)요약 */
adminIngestRouter.post("/ingest", async (req, res) => {
  if (!assertAdmin(req, res)) return;
  try {
    const doSummarize = String(req.query.summarize ?? "1") !== "0";

    const scraped = await scrapeFeeds();                 // RawArticleLite[]
    const { clusters, issues } = await runPipeline(scraped);

    // ✅ 클러스터 → 제안 저장
    const persist = await upsertClusterSuggestions(
      (clusters ?? []) as unknown as ClusterInput[]
    );

    // (옵션) 이슈 요약 생성
    const pipelineIssueIds = Array.from(new Set(issues.map(x => x.issueId).filter(Boolean)));
    let summarized = 0;
    if (doSummarize && pipelineIssueIds.length) {
      for (const id of pipelineIssueIds) {
        try {
          await getOrCreateIssueSummary(id, { force: true, locale: "ko" });
          summarized++;
        } catch (e) { console.warn("[ingest->summary] failed:", id, e); }
      }
    }

    res.json({
      ok: true,
      counts: { scraped: scraped.length, clusters: clusters.length, issues: issues.length },
      persisted: persist,
      summarized,
    });
  } catch (e: any) {
    console.error("[admin/ingest] error:", e);
    res.status(500).json({ error: "INGEST_ERROR", detail: String(e?.message ?? e) });
  }
});

/** ② (시크릿) 수동 인제스트 + (옵션)요약 */
adminIngestRouter.post("/ingest-news", async (req, res) => {
  if (!assertAdmin(req, res)) return;
  try {
    const doSummarize = String(req.query.summarize ?? "1") !== "0";

    const input = req.body?.articles;
    if (!Array.isArray(input)) return res.status(400).json({ error: "body.articles[] required" });

    const scraped: RawArticleLite[] = input.map((a: any) => {
      const side: SourceSide =
        a?.side === "left" || a?.side === "right" || a?.side === "center" ? a.side : "center";
      const base = {
        url: String(a.url),
        title: String(a.title),
        outlet: String(a.outlet),
        side,
        publishedAt: asDate(a?.publishedAt),
      } satisfies Omit<RawArticleLite, "summary">;

      return a?.summary ? ({ ...base, summary: String(a.summary) } as RawArticleLite) : (base as RawArticleLite);
    });

    const { clusters, issues } = await runPipeline(scraped);

    // ✅ 클러스터 → 제안 저장
    const persist = await upsertClusterSuggestions(
      (clusters ?? []) as unknown as ClusterInput[]
    );

    // (옵션) 요약
    const pipelineIssueIds = Array.from(new Set(issues.map(x => x.issueId).filter(Boolean)));
    let summarized = 0;
    if (doSummarize && pipelineIssueIds.length) {
      for (const id of pipelineIssueIds) {
        try {
          await getOrCreateIssueSummary(id, { force: true, locale: "ko" });
          summarized++;
        } catch (e) { console.warn("[ingest-news->summary] failed:", id, e); }
      }
    }

    res.json({
      ok: true,
      counts: { scraped: scraped.length, clusters: clusters.length, issues: issues.length },
      persisted: persist,
      summarized,
    });
  } catch (e: any) {
    console.error("[admin/ingest-news] error:", e);
    res.status(500).json({ error: "INGEST_NEWS_ERROR", detail: String(e?.message ?? e) });
  }
});

/** ③ (세션) 수집 실행: sinceHours 내 기사 수집만 */
adminIngestRouter.post("/ingest/run", requireAuth, adminAuth, async (req, res) => {
  try {
    const sinceHours = Number(req.body?.sinceHours ?? 24);
    const cutoff = new Date(Date.now() - sinceHours * 3600 * 1000);

    const scrapedAll = await scrapeFeeds(); // 인자 없이 호출
    const scraped = scrapedAll.filter(a => {
      const d = a.publishedAt ? new Date(a.publishedAt as any) : null;
      // 발행일이 없으면 그대로 포함 (크롤러가 발행일 못 찾은 케이스 보호)
      return !d || d >= cutoff;
    });

    res.json({ ok: true, collected: scraped.length });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: String(e?.message ?? e) });
  }
});

/** ④ (세션) 클러스터 실행: 수집→클러스터→제안 upsert */
adminIngestRouter.post("/cluster/run", requireAuth, adminAuth, async (req, res) => {
  try {
    const windowHours = Number(req.body?.windowHours ?? 24);
    const cutoff = new Date(Date.now() - windowHours * 3600 * 1000);

    const scrapedAll = await scrapeFeeds(); // 인자 없이 호출
    const scraped = scrapedAll.filter(a => {
      const d = a.publishedAt ? new Date(a.publishedAt as any) : null;
      return !d || d >= cutoff;
    });

    clusterProgress.stage = "cluster";
    clusterProgress.queued = scraped.length;
    clusterProgress.done = 0;

    // runPipeline 은 옵션 인자 없이 호출 (TS2554 방지)
    const { clusters } = await runPipeline(scraped);

    // 진행률: 단순 완료 처리(세밀한 onStep 미사용)
    clusterProgress.done = clusterProgress.queued;

    const persisted = await upsertClusterSuggestions((clusters ?? []) as any);

    clusterProgress.stage = "idle";
    clusterProgress.queued = 0;
    clusterProgress.done = 0;

    res.json({ ok: true, created: clusters?.length ?? 0, persisted });
  } catch (e: any) {
    clusterProgress.stage = "idle";
    clusterProgress.queued = 0;
    clusterProgress.done = 0;
    res.status(500).json({ ok: false, error: String(e?.message ?? e) });
  }
});

/** ⑤ (세션) 진행상태 조회 */
adminIngestRouter.get("/cluster/progress", requireAuth,  adminAuth, (_req, res) => {
  res.json({ ok: true, ...clusterProgress });
});

export default adminIngestRouter;
