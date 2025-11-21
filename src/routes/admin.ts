// src/routes/admin.ts
import { Router } from "express";
import { PrismaClient, ClusterSuggestionStatus, IssueStatus } from "@prisma/client";
import type { Request, Response } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { adminAuth } from "../middleware/adminAuth";

const prisma = new PrismaClient();
const router = Router();

function toCSV(rows: any[]): string {
  if (!rows || rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const esc = (v: any) => {
    if (v === null || v === undefined) return "";
    const s = String(v).replace(/"/g, '""');
    return /[",\n]/.test(s) ? `"${s}"` : s;
  };
  const headerLine = headers.join(",");
  const body = rows.map(r => headers.map(h => esc(r[h])).join(",")).join("\n");
  return `${headerLine}\n${body}`;
}




/** GET /admin/suggestions?status=PENDING&take=20&cursor=... */
router.get("/suggestions", requireAuth, adminAuth, async (req, res) => {
  const status = (req.query.status as string | undefined) as keyof typeof ClusterSuggestionStatus | undefined;
  const take = Math.min(parseInt((req.query.take as string) ?? "20", 10), 100);
  const cursor = (req.query.cursor as string | undefined) ?? undefined;

  const where = status ? { status: ClusterSuggestionStatus[status] } : undefined;

  const items = await prisma.clusterSuggestion.findMany({
    where,
    take: take + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    orderBy: { createdAt: "desc" },
    include: {
      articles: { include: { raw: true, source: true } },
      issue: true,
    },
  });

  let nextCursor: string | null = null;
  if (items.length > take) {
    const last = items.pop()!;
    nextCursor = last.id;
  }

  res.json({ items, nextCursor });
});

/** GET /admin/suggestions/:id */
router.get("/suggestions/:id", requireAuth, async (req, res) => {
  const id = req.params.id;
  const item = await prisma.clusterSuggestion.findUnique({
    where: { id },
    include: {
      articles: { include: { raw: true, source: true } },
      issue: true,
    },
  });
  if (!item) return res.status(404).json({ error: "NOT_FOUND" });
  res.json({ item });
});

/** POST /admin/suggestions/:id/approve  { title?, summary?, issueId? } */
router.post("/suggestions/:id/approve", requireAuth, async (req, res) => {
  const id = req.params.id;
  const body = (req.body ?? {}) as { title?: string; summary?: string; issueId?: string };

  const sug = await prisma.clusterSuggestion.findUnique({
    where: { id },
    include: { issue: true, articles: { include: { raw: true, source: true } } },
  });
  if (!sug) return res.status(404).json({ error: "NOT_FOUND" });

  let issueId = body.issueId ?? sug.issueId ?? null;

  // 이슈 없으면 생성
  if (!issueId) {
    const title = body.title ?? sug.title;
    const summary = body.summary ?? (sug.summary ?? undefined);

    const created = await prisma.issue.create({
      data: { title, summary },
    });
    issueId = created.id;
  }

  const updated = await prisma.clusterSuggestion.update({
    where: { id },
    data: { status: ClusterSuggestionStatus.APPROVED, issueId },
    include: { issue: true },
  });

  await prisma.clusterDecisionLog.create({
    data: { suggestionId: id, action: "APPROVE", detail: { issueId } },
  });

  res.json({ ok: true, suggestion: updated });
});

/** POST /admin/suggestions/:id/reject { reason? } */
router.post("/suggestions/:id/reject", requireAuth, async (req, res) => {
  const id = req.params.id;
  const { reason } = (req.body ?? {}) as { reason?: string };

  const updated = await prisma.clusterSuggestion.update({
    where: { id },
    data: { status: ClusterSuggestionStatus.REJECTED },
  });

  await prisma.clusterDecisionLog.create({
    data: { suggestionId: id, action: "REJECT", detail: reason ? { reason } : undefined },
  });

  res.json({ ok: true, suggestion: updated });
});

/** POST /admin/suggestions/:id/split { articleIds: string[] } */
router.post("/suggestions/:id/split", requireAuth, async (req, res) => {
  const id = req.params.id;
  const { articleIds } = (req.body ?? {}) as { articleIds: string[] };
  if (!Array.isArray(articleIds) || articleIds.length === 0) {
    return res.status(400).json({ error: "articleIds required" });
  }

  const sug = await prisma.clusterSuggestion.findUnique({
    where: { id },
    include: { articles: true },
  });
  if (!sug) return res.status(404).json({ error: "NOT_FOUND" });

  const newSuggestion = await prisma.clusterSuggestion.create({
    data: {
      key: `${sug.key}-split-${Date.now()}`,
      title: `${sug.title} (분할)`,
      summary: sug.summary ?? undefined,
      confidence: sug.confidence,
      windowStart: sug.windowStart ?? undefined,
      windowEnd: sug.windowEnd ?? undefined,
      status: ClusterSuggestionStatus.PENDING,
    },
  });

  await prisma.$transaction(async (tx) => {
    await Promise.all(
      articleIds.map((aid) =>
        tx.clusterSuggestionArticle.update({
          where: { id: aid },
          data: { suggestionId: newSuggestion.id },
        })
      )
    );
    await tx.clusterSuggestion.update({
      where: { id },
      data: { status: ClusterSuggestionStatus.SPLIT },
    });
    await tx.clusterDecisionLog.create({
      data: {
        suggestionId: id,
        action: "SPLIT",
        detail: { movedTo: newSuggestion.id, movedArticles: articleIds },
      },
    });
  });

  res.json({ ok: true, movedTo: newSuggestion.id });
});

/** ─────────────────────────────────────────────────────────
 * 추가: 메타 업데이트, 병합, 기사 추가/삭제, 재클러스터, 일괄 승인/기각,
 *      이슈 검색, CSV 내보내기, 수동 이슈 생성
 * ───────────────────────────────────────────────────────── */

/** POST /admin/suggestions/:id/update { title?, summary?, confidence? } */
router.post("/suggestions/:id/update", requireAuth, async (req, res) => {
  const id = req.params.id;
  const { title, summary, confidence } = (req.body ?? {}) as {
    title?: string; summary?: string; confidence?: number;
  };
  const updated = await prisma.clusterSuggestion.update({
    where: { id },
    data: {
      ...(typeof title === "string" ? { title } : {}),
      ...(typeof summary === "string" ? { summary } : {}),
      ...(typeof confidence === "number" ? { confidence } : {}),
    },
  });
  res.json({ ok: true, item: updated });
});

/** POST /admin/suggestions/:id/merge { targetId } */
router.post("/suggestions/:id/merge", requireAuth, async (req, res) => {
  const id = req.params.id;
  const { targetId } = (req.body ?? {}) as { targetId: string };
  if (!targetId) return res.status(400).json({ error: "targetId required" });

  const [src, dst] = await Promise.all([
    prisma.clusterSuggestion.findUnique({ where: { id }, include: { articles: true } }),
    prisma.clusterSuggestion.findUnique({ where: { id: targetId }, include: { articles: true } }),
  ]);
  if (!src || !dst) return res.status(404).json({ error: "NOT_FOUND" });

  await prisma.$transaction(async (tx) => {
    for (const a of src.articles) {
      await tx.clusterSuggestionArticle.upsert({
        where: { suggestionId_url: { suggestionId: dst.id, url: a.url } },
        create: {
          suggestionId: dst.id,
          url: a.url,
          title: a.title ?? undefined,
          outlet: a.outlet ?? undefined,
          side: a.side ?? undefined,
          publishedAt: a.publishedAt ?? undefined,
          summary: a.summary ?? undefined,
          rawArticleId: a.rawArticleId ?? undefined,
          sourceId: a.sourceId ?? undefined,
        },
        update: {},
      });
    }
    await tx.clusterSuggestion.update({ where: { id }, data: { status: "MERGED" } });
    await tx.clusterDecisionLog.create({
      data: { suggestionId: id, action: "MERGE", detail: { targetId } },
    });
  });

  res.json({ ok: true, mergedInto: targetId });
});

/** POST /admin/suggestions/:id/article { url, title?, outlet?, side?, publishedAt?, summary? } */
router.post("/suggestions/:id/article", requireAuth, async (req, res) => {
  const id = req.params.id;
  const { url, title, outlet, side, publishedAt, summary } = (req.body ?? {}) as any;
  if (!url) return res.status(400).json({ error: "url required" });

  const sug = await prisma.clusterSuggestion.findUnique({ where: { id } });
  if (!sug) return res.status(404).json({ error: "NOT_FOUND" });

  await prisma.clusterSuggestionArticle.upsert({
    where: { suggestionId_url: { suggestionId: id, url } },
    create: {
      suggestionId: id, url, title, outlet, side,
      publishedAt: publishedAt ? new Date(publishedAt) : undefined, summary,
    },
    update: {
      title, outlet, side,
      publishedAt: publishedAt ? new Date(publishedAt) : undefined,
      summary,
    },
  });

  res.json({ ok: true });
});

/** DELETE /admin/suggestions/:id/article/:articleId */
router.delete("/suggestions/:id/article/:articleId", requireAuth, async (req, res) => {
  const { id, articleId } = req.params;
  const exists = await prisma.clusterSuggestionArticle.findFirst({ where: { id: articleId, suggestionId: id } });
  if (!exists) return res.status(404).json({ error: "NOT_FOUND" });
  await prisma.clusterSuggestionArticle.delete({ where: { id: articleId } });
  res.json({ ok: true });
});

/** POST /admin/suggestions/:id/recluster { expandHours? } */
router.post("/suggestions/:id/recluster", requireAuth, async (req, res) => {
  const id = req.params.id;
  const expandHours = Number(req.body?.expandHours ?? 12);
  const sug = await prisma.clusterSuggestion.findUnique({
    where: { id }, include: { articles: true }
  });
  if (!sug) return res.status(404).json({ error: "NOT_FOUND" });

  // 실제 재클러스터링은 파이프라인 연동 필요. 일단 운영 로그만 남김.
  await prisma.clusterDecisionLog.create({
    data: { suggestionId: id, action: "RECLUSTER", detail: { expandHours } },
  });
  res.json({ ok: true });
});

/** POST /admin/suggestions/bulk-approve { ids: string[], toIssueId? } */
router.post("/suggestions/bulk-approve", requireAuth, async (req, res) => {
  const { ids, toIssueId } = (req.body ?? {}) as { ids: string[], toIssueId?: string };
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: "ids required" });

  const updated: string[] = [];
  await prisma.$transaction(async (tx) => {
    let sharedIssueId: string | null = toIssueId ?? null;

    for (const sid of ids) {
      const sug = await tx.clusterSuggestion.findUnique({ where: { id: sid } });
      if (!sug) continue;

      let useIssueId = sharedIssueId;
      if (!useIssueId) {
        const created = await tx.issue.create({ data: { title: sug.title, summary: sug.summary ?? undefined } });
        useIssueId = created.id;
        if (toIssueId) sharedIssueId = useIssueId; // 요청에 따라 공용 이슈 하나에 붙이기 가능
      }
      await tx.clusterSuggestion.update({
        where: { id: sid },
        data: { status: "APPROVED", issueId: useIssueId },
      });
      await tx.clusterDecisionLog.create({
        data: { suggestionId: sid, action: "APPROVE", detail: { issueId: useIssueId } },
      });
      updated.push(sid);
    }
  });
  res.json({ ok: true, updated });
});

/** POST /admin/suggestions/bulk-reject { ids: string[], reason? } */
router.post("/suggestions/bulk-reject", requireAuth, async (req, res) => {
  const { ids, reason } = (req.body ?? {}) as { ids: string[], reason?: string };
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: "ids required" });

  await prisma.$transaction(async (tx) => {
    await tx.clusterSuggestion.updateMany({
      where: { id: { in: ids } },
      data: { status: "REJECTED" },
    });
    for (const sid of ids) {
      await tx.clusterDecisionLog.create({
        data: { suggestionId: sid, action: "REJECT", detail: reason ? { reason } : undefined },
      });
    }
  });
  res.json({ ok: true, updated: ids });
});

/** GET /admin/issues/search?q=... */
router.get("/issues/search", requireAuth, adminAuth, async (req, res) => {
  const q = (req.query.q as string | undefined)?.trim() ?? "";
  const take = Math.min(parseInt((req.query.take as string) ?? "20", 10), 100);

  const where = q
    ? { title: { contains: q } }
    : {}; // q 없으면 전체(최신 순) 조회

  const items = await prisma.issue.findMany({
    where,
    take,
    orderBy: { createdAt: "desc" },
    // 필요하면 include 로 관련 정보 더 붙일 수 있음 (ex: _count)
  });

  res.json({ ok: true, items });
});

router.get("/issues/:id", requireAuth, adminAuth, async (req, res) => {
  const id = req.params.id;

  const issue = await prisma.issue.findUnique({
    where: { id },
    include: {
      _count: {
        select: {
          sources: true,
          //agendas: true,
          comments: true, // 모델에 comments 관계 있으면
        },
      },
      // 필요하면 실제 소스/아젠다 목록도 include 가능
      // sources: true,
      // agendas: { take: 5, orderBy: { createdAt: "desc" } },
    },
  });

  if (!issue) return res.status(404).json({ error: "NOT_FOUND" });

  res.json({ ok: true, item: issue });
});

router.post("/issues/:id/update", requireAuth, adminAuth, async (req, res) => {
  const id = req.params.id;
  const { title, summary } = (req.body ?? {}) as {
    title?: string;
    summary?: string;
  };

  if (!title && typeof summary === "undefined") {
    return res.status(400).json({ error: "NO_FIELDS" });
  }

  const data: any = {};
  if (typeof title === "string") data.title = title;
  if (typeof summary === "string") data.summary = summary;

  try {
    const updated = await prisma.issue.update({
      where: { id },
      data,
    });
    res.json({ ok: true, item: updated });
  } catch (e) {
    console.error("[admin/issues/:id/update] error:", e);
    res.status(500).json({ error: "UPDATE_ERROR" });
  }
});

/** GET /admin/suggestions/export?status=PENDING */
router.get("/suggestions/export", requireAuth, async (req, res) => {
  const status = (req.query.status as string | undefined) as keyof typeof ClusterSuggestionStatus | undefined;
  const where = status ? { status: ClusterSuggestionStatus[status] } : undefined;

  const items = await prisma.clusterSuggestion.findMany({
    where,
    include: { articles: true },
    orderBy: { createdAt: "desc" },
    take: 1000,
  });

  const rows = items.flatMap(s =>
    (s.articles ?? []).map(a => ({
      id: s.id,
      status: s.status,
      title: s.title,
      summary: s.summary ?? "",
      confidence: s.confidence,
      createdAt: s.createdAt,
      articleUrl: a.url,
      articleTitle: a.title ?? "",
      outlet: a.outlet ?? "",
      publishedAt: a.publishedAt ?? "",
    }))
  );

  const csv = toCSV(rows);
  res.header("Content-Type", "text/csv; charset=utf-8");
  res.attachment(`suggestions_${status ?? "ALL"}.csv`);
  res.send(csv);
});

/** POST /admin/issues/from-articles { title, summary?, articleUrls: string[] } */
router.post("/issues/from-articles", requireAuth, async (req, res) => {
  const { title, summary, articleUrls } = (req.body ?? {}) as {
    title: string; summary?: string; articleUrls: string[];
  };
  if (!title || !Array.isArray(articleUrls) || !articleUrls.length) {
    return res.status(400).json({ error: "title & articleUrls[] required" });
  }
  const issue = await prisma.issue.create({ data: { title, summary: summary ?? undefined } });

  // Source 저장 (간단 버전 — 메타추출 모듈 붙이면 보강)
  for (const url of articleUrls) {
    try {
      await prisma.source.create({
        data: { issueId: issue.id, outlet: "", title: "", url, side: "center" },
      });
    } catch { /* 중복 URL 등은 무시 */ }
  }
  res.json({ ok: true, issueId: issue.id });
});


/** ─────────────────────────────────────────────────────────
 *  Articles 검색 (IssuesTab의 "전체 기사" 탭용)
 *  GET /admin/articles/search?q=...
 *  응답: { ok: true, items: [...] }
 *  - adminApi.fetchAdminArticles() 와 호환
 * ───────────────────────────────────────────────────────── */
router.get("/articles/search", requireAuth, adminAuth, async (req, res) => {
  const q = (req.query.q as string | undefined)?.trim() ?? "";
  const take = Math.min(parseInt((req.query.take as string) ?? "50", 10), 200);

  try {
    const where: any = {
      url: { not: "" },
    };

    if (q) {
      where.OR = [
        { title: { contains: q } },
        { text:  { contains: q } },
        { outlet:{ contains: q } },
      ];
    }

    const rows = await prisma.rawArticle.findMany({
      where,
      take,
      orderBy: {
        publishedAt: "desc",
      },
      select: {
        id: true,
        outlet: true,
        url: true,
        title: true,
        publishedAt: true,
        text: true,
        side: true,
      },
    });

    // 프론트에서 기대하는 형태로 매핑
    const items = rows.map(r => ({
      id: String(r.id),                                 // 식별자
      title: r.title ?? "(제목 없음)",                 // 기사 제목
      source: r.outlet ?? "언론",                      // 언론사
      date: r.publishedAt
        ? r.publishedAt.toISOString().slice(0, 10)
        : "",
      url: r.url,
      summary: (r.text ?? "").slice(0, 300),           // 간단 요약
      side: r.side ?? "center",                        // 'left' | 'right' | ...
      keywords: [] as string[],                        // 나중에 키워드 추출 붙일 수 있음
    }));

    res.json({ ok: true, items, nextCursor: null });
  } catch (e) {
    console.error("[admin/articles/search] error:", e);
    res.status(500).json({ error: "SEARCH_ERROR" });
  }
});



/** ─────────────────────────────────────────────────────────
 *  추천 이슈 목록 (IssuesTab의 "추천 이슈" 탭용)
 *  GET /admin/issues/recommended
 *  응답: { ok: true, items: [...] }
 *  - adminApi.fetchAdminRecommendedIssues() 와 호환
 * ───────────────────────────────────────────────────────── */
router.get("/issues/recommended", requireAuth, adminAuth, async (req, res) => {
  const take = Math.min(parseInt((req.query.take as string) ?? "20", 10), 100);

  try {
    const suggestions = await prisma.clusterSuggestion.findMany({
      where: { status: ClusterSuggestionStatus.PENDING },
      take,
      orderBy: { createdAt: "desc" },
      include: {
        articles: true,
      },
    });

    const items = suggestions.map((sug) => {
      const articles = sug.articles ?? [];

      // 날짜 범위 계산
      let minDate: Date | null = null;
      let maxDate: Date | null = null;
      for (const a of articles) {
        if (!a.publishedAt) continue;
        const d = a.publishedAt;
        if (!minDate || d < minDate) minDate = d;
        if (!maxDate || d > maxDate) maxDate = d;
      }
      const dateRange =
        minDate && maxDate
          ? `${minDate.toISOString().slice(0, 10)} ~ ${maxDate
              .toISOString()
              .slice(0, 10)}`
          : "";

      // 키워드: 일단 summary를 쉼표 기준으로 잘라서 사용 (없으면 빈 배열)
      const keywords =
        (sug.summary ?? "")
          .split(/[,\s]+/)
          .map((k) => k.trim())
          .filter(Boolean)
          .slice(0, 8) || [];

      // 프론트에서 쓰는 형태로 매핑
      return {
        id: sug.id,
        title: sug.title,
        confidence: sug.confidence ?? 0,
        articleCount: articles.length,
        dateRange,
        keywords,
        articles: articles.map((a) => ({
          id: a.id,
          title: a.title ?? "(제목 없음)",
          source: a.outlet ?? "언론",
          date: a.publishedAt
            ? a.publishedAt.toISOString().slice(0, 10)
            : "",
          url: a.url,
          summary: a.summary ?? "",
          side: a.side ?? "center",
        })),
      };
    });

    res.json({ ok: true, items, nextCursor: null });
  } catch (e) {
    console.error("[admin/issues/recommended] error:", e);
    res.status(500).json({ error: "RECOMMENDED_ERROR" });
  }
});


export default router;