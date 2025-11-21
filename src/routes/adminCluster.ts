// adminCluster.ts

import { Router } from "express";
import {
  PrismaClient,
  Prisma,
  ClusterSuggestionStatus,
  IssueStatus,
} from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";
import { adminAuth } from "../middleware/adminAuth";

const prisma = new PrismaClient();
const r = Router();

// 인증 → 어드민 체크(이미 index.ts 에서 묶여 있으면 중복 무해)
r.use(requireAuth as any, adminAuth as any);

/** 유틸: "createdAt:desc" → { createdAt: 'desc' } */
function parseOrder(
  sort?: string
): Prisma.ClusterSuggestionOrderByWithRelationInput {
  const fallback: Prisma.ClusterSuggestionOrderByWithRelationInput = {
    createdAt: "desc",
  };
  if (!sort) return fallback;

  // 예: "createdAt-desc", "createdAt:desc", "latest", "titleAsc" 등
  const raw = String(sort).toLowerCase();

  // 1) 별칭 처리
  if (raw === "latest") return { createdAt: "desc" };
  if (raw === "oldest") return { createdAt: "asc" };
  if (raw === "titleasc") return { title: "asc" };
  if (raw === "titledesc") return { title: "desc" };

  // 2) 구분자(: 또는 -) 통일
  const normalized = raw.replace("-", ":");
  const [fieldRaw, dirRaw] = normalized.split(":");

  const dir: Prisma.SortOrder = dirRaw === "asc" ? "asc" : "desc";

  switch (fieldRaw) {
    case "title":
      return { title: dir };
    case "confidence":
      return { confidence: dir };
    case "createdat":
    case "created_at":
    case "createdatdesc":
    default:
      return { createdAt: dir };
  }
}

/** 유틸: status 문자열 → Prisma Enum */
function toStatusEnum(s?: string): ClusterSuggestionStatus | undefined {
  if (!s) return undefined;
  const key = s.toUpperCase() as keyof typeof ClusterSuggestionStatus;
  return ClusterSuggestionStatus[key] ?? undefined;
}

function toIssueStatusEnum(s?: string): IssueStatus | undefined {
  if (!s) return undefined;
  switch (s.toLowerCase()) {
    case "suggested":
      return IssueStatus.SUGGESTED;
    case "draft":
      return IssueStatus.DRAFT;
    case "published":
      return IssueStatus.PUBLISHED;
    case "archived":
      return IssueStatus.ARCHIVED;
    default:
      return undefined;
  }
}

/** 통계: 상태별 개수 */
r.get("/suggestions/stats", async (_req, res) => {
  const groups = await prisma.clusterSuggestion.groupBy({
    by: ["status"],
    _count: { _all: true },
  });
  const stats: Record<string, number> = {
    PENDING: 0,
    APPROVED: 0,
    REJECTED: 0,
    MERGED: 0,
    SPLIT: 0,
  };
  for (const g of groups) stats[g.status] = g._count._all;
  res.json({ ok: true, stats });
});

/** 목록 (검색/정렬/커서) */
r.get("/suggestions", async (req, res) => {
  const status = toStatusEnum(String(req.query.status ?? "PENDING"));
  const q = (req.query.q as string | undefined)?.trim();
  const sortStr = String(req.query.sort ?? "createdAt:desc");
  const take = Math.min(100, Math.max(1, Number(req.query.take ?? 30)));
  const cursor = (req.query.cursor as string | undefined) ?? null;

  // 정렬 파싱
  const [sortField, sortDir] = sortStr.split(":");
  const orderBy = { [sortField]: sortDir === "asc" ? "asc" : "desc" } as any;

  // 검색 조건
  const ors: Prisma.ClusterSuggestionWhereInput[] = [];
  if (q) {
    ors.push({ title: { contains: q } });
    ors.push({ summary: { contains: q } });
  }
  const where: Prisma.ClusterSuggestionWhereInput = {
    ...(status ? { status } : {}),
    ...(q ? { OR: ors } : {}),
  };

  let items;
  let nextCursor: string | null = null;

  const canUseCursorPaging = sortField === "createdAt";

  if (canUseCursorPaging) {
    // createdAt 정렬에서만 cursor 페이징 사용
    items = await prisma.clusterSuggestion.findMany({
      where,
      orderBy,
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        key: true,
        title: true,
        summary: true,
        confidence: true,
        windowStart: true,
        windowEnd: true,
        status: true,
        createdAt: true,
        _count: { select: { articles: true } },
      },
    });

    if (items.length > take) {
      const last = items.pop()!;
      nextCursor = last.id;
    }
  } else {
    // title/confidence 정렬에서는 cursor 페이징 X
    items = await prisma.clusterSuggestion.findMany({
      where,
      orderBy,
      take,
      select: {
        id: true,
        key: true,
        title: true,
        summary: true,
        confidence: true,
        windowStart: true,
        windowEnd: true,
        status: true,
        createdAt: true,
        _count: { select: { articles: true } },
      },
    });

    nextCursor = null;
  }

  const shaped = items.map((i) => ({
    ...i,
    articlesCount: i._count.articles,
  }));

  res.json({ ok: true, items: shaped, nextCursor });
});

/** 상세 */
r.get("/suggestions/:id", async (req, res) => {
  const s = await prisma.clusterSuggestion.findUnique({
    where: { id: req.params.id },
    include: {
      articles: {
        orderBy: { createdAt: "asc" },
        include: { raw: true, source: true },
      },
      issue: true,
    },
  });
  if (!s) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
  res.json({ ok: true, item: s });
});

/** 승인 (이슈 생성/연결) */
r.post("/suggestions/:id/approve", async (req, res) => {
  const id = req.params.id;
  const { issueId, title, summary } = (req.body ?? {}) as {
    issueId?: string;
    title?: string;
    summary?: string;
  };

  const sug = await prisma.clusterSuggestion.findUnique({
    where: { id },
    include: { issue: true, articles: { include: { raw: true, source: true } } },
  });
  if (!sug) return res.status(404).json({ ok: false, error: "NOT_FOUND" });

  let targetIssueId = issueId ?? sug.issueId ?? null;

  if (!targetIssueId) {
    const created = await prisma.issue.create({
      data: {
        title: title ?? sug.title ?? "(제목 없음)",
        summary: summary ?? sug.summary ?? undefined,
      },
    });
    targetIssueId = created.id;
  }

  const updated = await prisma.clusterSuggestion.update({
    where: { id },
    data: { status: "APPROVED", issueId: targetIssueId },
    include: { issue: true },
  });

  // 기사들을 Source로 동기화(있는 경우 upsert)
  const arts = await prisma.clusterSuggestionArticle.findMany({
    where: { suggestionId: id },
  });
  for (const a of arts) {
    await prisma.source.upsert({
      where: { url: a.url },
      update: {
        issueId: targetIssueId,
        outlet: a.outlet ?? "언론",
        title: a.title ?? "(제목 없음)",
        side: a.side ?? "center",
      },
      create: {
        url: a.url,
        issueId: targetIssueId,
        outlet: a.outlet ?? "언론",
        title: a.title ?? "(제목 없음)",
        side: a.side ?? "center",
      },
    });
  }

  await prisma.clusterDecisionLog.create({
    data: { suggestionId: id, action: "APPROVE", detail: { issueId: targetIssueId } },
  });

  res.json({ ok: true, suggestion: updated, issueId: targetIssueId });
});

/** 기각 */
r.post("/suggestions/:id/reject", async (req, res) => {
  const id = req.params.id;
  const { reason } = (req.body ?? {}) as { reason?: string };

  const updated = await prisma.clusterSuggestion.update({
    where: { id },
    data: { status: "REJECTED" },
  });

  await prisma.clusterDecisionLog.create({
    data: { suggestionId: id, action: "REJECT", detail: reason ? { reason } : undefined },
  });

  res.json({ ok: true, suggestion: updated });
});

/** 분할 (선택 기사만 새 제안으로 이동) */
r.post("/suggestions/:id/split", async (req, res) => {
  const id = req.params.id;
  const { articleIds = [], title, summary, confidence = 0.8 } =
    (req.body ?? {}) as {
      articleIds?: string[];
      title?: string;
      summary?: string;
      confidence?: number;
    };

  const base = await prisma.clusterSuggestion.findUnique({ where: { id } });
  if (!base) return res.status(404).json({ ok: false, error: "NOT_FOUND" });

  const created = await prisma.clusterSuggestion.create({
    data: {
      key: `${base.key}-split-${Date.now()}`,
      title: title ?? base.title ?? "(제목 없음)",
      summary: summary ?? base.summary ?? undefined,
      confidence,
      status: "PENDING",
    },
  });

  if (articleIds.length) {
    await prisma.clusterSuggestionArticle.updateMany({
      where: { suggestionId: base.id, id: { in: articleIds } },
      data: { suggestionId: created.id },
    });
  }

  await prisma.clusterSuggestion.update({
    where: { id },
    data: { status: "SPLIT" },
  });
  await prisma.clusterDecisionLog.create({
    data: {
      suggestionId: id,
      action: "SPLIT",
      detail: { newId: created.id, articleIds },
    },
  });

  res.json({ ok: true, newId: created.id });
});

/** 병합 */
r.post("/suggestions/:id/merge", async (req, res) => {
  const id = req.params.id;
  const { targetId } = (req.body ?? {}) as { targetId: string };
  if (!targetId)
    return res.status(400).json({ ok: false, error: "targetId required" });

  const [from, to] = await Promise.all([
    prisma.clusterSuggestion.findUnique({
      where: { id },
      include: { articles: true },
    }),
    prisma.clusterSuggestion.findUnique({
      where: { id: targetId },
      include: { articles: true },
    }),
  ]);
  if (!from || !to)
    return res.status(404).json({ ok: false, error: "NOT_FOUND" });

  for (const a of from.articles) {
    await prisma.clusterSuggestionArticle.upsert({
      where: { suggestionId_url: { suggestionId: to.id, url: a.url } },
      create: {
        suggestionId: to.id,
        url: a.url,
        title: a.title,
        outlet: a.outlet,
        side: a.side,
        publishedAt: a.publishedAt,
        summary: a.summary,
        rawArticleId: a.rawArticleId ?? undefined,
        sourceId: a.sourceId ?? undefined,
      },
      update: {},
    });
  }

  await prisma.clusterSuggestion.update({
    where: { id: from.id },
    data: { status: "MERGED" },
  });
  await prisma.clusterDecisionLog.create({
    data: { suggestionId: from.id, action: "MERGE", detail: { targetId: to.id } },
  });

  res.json({ ok: true });
});

/** 일괄 승인/기각 */
r.post("/suggestions/bulk-approve", async (req, res) => {
  const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!ids.length) return res.json({ ok: true, updated: [] });

  const updated = await prisma.clusterSuggestion.updateMany({
    where: { id: { in: ids } },
    data: { status: "APPROVED" },
  });

  res.json({ ok: true, updated: ids, count: updated.count });
});

r.post("/suggestions/bulk-reject", async (req, res) => {
  const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!ids.length) return res.json({ ok: true, updated: [] });

  const updated = await prisma.clusterSuggestion.updateMany({
    where: { id: { in: ids } },
    data: { status: "REJECTED" },
  });

  res.json({ ok: true, updated: ids, count: updated.count });
});

/* ─────────────────────────────────────────────
   Issues: 검색 / 상세 / 연관 이슈 관리
───────────────────────────────────────────── */

/**
 * GET /api/admin/issues/search
 * query: q, status, take
 */
r.get("/issues/search", async (req, res) => {
  const q = (req.query.q as string | undefined)?.trim();
  const status = toIssueStatusEnum(req.query.status as string | undefined);
  const take = Math.min(50, Math.max(1, Number(req.query.take ?? 20)));

  const where: Prisma.IssueWhereInput = {
    ...(status ? { status } : {}),
    ...(q
      ? {
          OR: [{ title: { contains: q } }, { summary: { contains: q } }],
        }
      : {}),
  };

  const items = await prisma.issue.findMany({
    where,
    take,
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      title: true,
      summary: true,
      status: true,
      createdAt: true,
      _count: {
        select: {
          sources: true,
          comments: true,
        },
      },
    },
  });

  res.json({
    ok: true,
    items: items.map((i) => ({
      id: i.id,
      title: i.title,
      summary: i.summary,
      status: i.status,
      createdAt: i.createdAt,
      sourcesCount: i._count.sources,
      commentsCount: i._count.comments,
    })),
  });
});

/**
 * GET /api/admin/cluster/issues/recommended
 */
/**
 * GET /api/admin/issues/recommended
 */
r.get("/issues/recommended", async (req, res) => {
  const take = Math.min(50, Math.max(1, Number(req.query.take ?? 1000)));

  const suggestions = await prisma.clusterSuggestion.findMany({
    where: { status: "PENDING", issueId: null },
    orderBy: { createdAt: "desc" },
    take,
    include: {
      articles: {
        include: {
          raw: true,   // rawArticle
          // ⚠ 여기에는 실제로 source 관계가 없을 수도 있으니, 아래 매핑에서 a.source는 쓰지 않음
        },
      },
      _count: { select: { articles: true } },
    },
  });

  // 🔹 서로 다른 언론사(outlet)가 2개 이상인 것만 필터링
  const filtered = suggestions.filter((s) => {
    const outlets = new Set(
      s.articles
        .map((a) => a.outlet) // clusterSuggestionArticle.outlet
        .filter((o): o is string => !!o)
    );
    return outlets.size >= 2;
  });

  const items = filtered.map((s) => ({
    id: s.id,
    title: s.title ?? "(제목 없음)",
    confidence: s.confidence ?? undefined,
    articleCount: s._count.articles,
    dateRange:
      s.windowStart && s.windowEnd
        ? `${s.windowStart.toISOString().slice(0, 10)} ~ ${s.windowEnd
            .toISOString()
            .slice(0, 10)}`
        : undefined,
    articles: s.articles.map((a) => {
      // ✅ 언론사명 최대한 살려서 가져오기 (a.source는 타입에 없으니 쓰지 않음)
      const resolvedOutlet =
        a.outlet ??
        a.raw?.outlet ??
        // 혹시 다른 필드명으로 들어갔을 가능성 대비
        (typeof (a as any).media === "string" ? (a as any).media : undefined) ??
        (typeof (a.raw as any)?.source === "string"
          ? (a.raw as any).source
          : undefined) ??
        "언론";

      const rawDate = a.publishedAt ?? a.raw?.publishedAt ?? null;

      return {
        id: a.rawArticleId ?? a.sourceId ?? a.id,
        title: a.title ?? a.raw?.title ?? "(제목 없음)",
        source: resolvedOutlet,
        date: rawDate
          ? new Date(rawDate as any).toISOString().slice(0, 10)
          : "",
        url: a.url ?? a.raw?.url ?? "",
      };
    }),
    keywords: [],
  }));

  res.json({ ok: true, items, nextCursor: null });
});


/**
 * GET /api/admin/issues/:id
 * - 이슈 상세 + 출처 + 연관 이슈
 */
r.get("/issues/:id", async (req, res) => {
  const id = req.params.id;
  const issue = await prisma.issue.findUnique({
    where: { id },
    include: {
      sources: {
        orderBy: { createdAt: "asc" },
      },
      relatedFrom: {
        include: { to: true },
      },
      relatedTo: {
        include: { from: true },
      },
    },
  });

  if (!issue) return res.status(404).json({ ok: false, error: "NOT_FOUND" });

  const related: Array<{
    id: string;
    title: string;
    status: IssueStatus;
    relationId: string;
    relationType: string | null;
    confidence: number | null;
    direction: "FROM" | "TO";
    createdAt: Date;
  }> = [];

  for (const rItem of issue.relatedFrom) {
    related.push({
      id: rItem.to.id,
      title: rItem.to.title,
      status: rItem.to.status,
      relationId: rItem.id,
      relationType: rItem.relationType,
      confidence: rItem.confidence ?? null,
      direction: "FROM",
      createdAt: rItem.createdAt,
    });
  }

  for (const rItem of issue.relatedTo) {
    related.push({
      id: rItem.from.id,
      title: rItem.from.title,
      status: rItem.from.status,
      relationId: rItem.id,
      relationType: rItem.relationType,
      confidence: rItem.confidence ?? null,
      direction: "TO",
      createdAt: rItem.createdAt,
    });
  }

  // Source → AdminArticle 형태로 변환
  const articles = issue.sources.map((s) => ({
    id: String(s.id),
    title: s.title ?? "(제목 없음)",
    source: s.outlet ?? "언론",
    date: s.createdAt.toISOString().slice(0, 10),
    url: s.url,
    summary: "",
    keywords: [] as string[],
  }));
  const articleIds = articles.map((a) => a.id);

  res.json({
    ok: true,
    item: {
      id: issue.id,
      title: issue.title,
      summary: issue.summary,
      status: issue.status,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      articles,
      articleIds,
      relatedIssues: related,
    },
  });
});

/**
 * PATCH /api/admin/issues/:id
 * body: { title?, summary?, status? }
 */
r.patch("/issues/:id", async (req, res) => {
  const id = req.params.id;
  const { title, summary, status } = req.body ?? {};

  const data: Prisma.IssueUpdateInput = {};
  if (typeof title === "string") data.title = title;
  if (typeof summary === "string" || summary === null) data.summary = summary;
  if (typeof status === "string") {
    const st = toIssueStatusEnum(status);
    if (st) data.status = st;
  }

  if (Object.keys(data).length === 0) {
    return res.json({ ok: true }); // 변경 없음
  }

  const updated = await prisma.issue.update({
    where: { id },
    data,
    select: {
      id: true,
      title: true,
      summary: true,
      status: true,
      updatedAt: true,
    },
  });

  res.json({ ok: true, item: updated });
});

/**
 * POST /api/admin/issues/:id/sources
 * body: { rawArticleId? , url?, title?, outlet?, side? }
 */
r.post("/issues/:id/sources", async (req, res) => {
  const id = req.params.id;
  const { rawArticleId, url, title, outlet, side } = req.body ?? {};

  let targetUrl = url as string | undefined;
  let targetTitle = title as string | undefined;
  let targetOutlet = outlet as string | undefined;
  let targetSide = side as any;

  // rawArticleId가 있으면 RawArticle 기준으로 가져오기
  if (rawArticleId) {
    const raw = await prisma.rawArticle.findUnique({ where: { id: rawArticleId } });
    if (!raw) return res.status(404).json({ ok: false, error: "RAW_NOT_FOUND" });

    targetUrl = raw.url;
    targetTitle = raw.title;
    targetOutlet = raw.outlet;
    targetSide = raw.side;
  }

  if (!targetUrl) {
    return res.status(400).json({ ok: false, error: "url or rawArticleId required" });
  }

  const source = await prisma.source.upsert({
    where: { url: targetUrl },
    update: {
      issueId: id,
      outlet: targetOutlet ?? "언론",
      title: targetTitle ?? "(제목 없음)",
      side: targetSide ?? "center",
    },
    create: {
      issueId: id,
      url: targetUrl,
      outlet: targetOutlet ?? "언론",
      title: targetTitle ?? "(제목 없음)",
      side: targetSide ?? "center",
    },
  });

  res.json({ ok: true, item: source });
});

/**
 * GET /api/admin/issues/:id/related-suggestions
 * - 간단한 heuristic 기반 연관 이슈 추천
 */
r.get("/issues/:id/related-suggestions", async (req, res) => {
  const id = req.params.id;

  const base = await prisma.issue.findUnique({
    where: { id },
    include: {
      sources: true,
      relatedFrom: true,
      relatedTo: true,
    },
  });
  if (!base) return res.status(404).json({ ok: false, error: "NOT_FOUND" });

  const alreadyIds = new Set<string>([id]);
  base.relatedFrom.forEach((r) => alreadyIds.add(r.toIssueId));
  base.relatedTo.forEach((r) => alreadyIds.add(r.fromIssueId));

  const baseOutlets = new Set(base.sources.map((s) => s.outlet));
  const baseTags = (Array.isArray(base.tags) ? (base.tags as any[]) : []).map(
    (t) => String(t)
  );

  const candidates = await prisma.issue.findMany({
    where: {
      id: { notIn: Array.from(alreadyIds) },
    },
    include: {
      sources: true,
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  const scored = candidates
    .map((iss) => {
      const outlets = new Set(iss.sources.map((s) => s.outlet));
      let outletOverlap = 0;
      baseOutlets.forEach((o) => {
        if (outlets.has(o)) outletOverlap += 1;
      });

      const tags = (Array.isArray(iss.tags) ? (iss.tags as any[]) : []).map(
        (t) => String(t)
      );
      const tagOverlap = baseTags.filter((t) => tags.includes(t)).length;

      let titleScore = 0;
      if (base.title && iss.title) {
        const b = base.title;
        const t = iss.title;
        const long = b.length > t.length ? b : t;
        const short = b.length > t.length ? t : b;
        if (short.length >= 6 && long.includes(short.slice(0, 6))) {
          titleScore = 1;
        }
      }

      const score = outletOverlap * 0.5 + tagOverlap * 0.7 + titleScore * 1.0;

      return {
        id: iss.id,
        title: iss.title,
        status: iss.status,
        createdAt: iss.createdAt,
        score,
        outletsCount: iss.sources.length,
      };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);

  res.json({ ok: true, items: scored });
});

r.get("/issues/:id/available-articles", async (req, res) => {
  const id = req.params.id;
  const q = (req.query.q as string | undefined)?.trim();
  const take = Math.min(50, Math.max(1, Number(req.query.take ?? 20)));

  const issue = await prisma.issue.findUnique({
    where: { id },
    include: { sources: true },
  });

  if (!issue) return res.status(404).json({ ok: false, error: "NOT_FOUND" });

  const usedUrls = issue.sources.map((s) => s.url);

  const where: Prisma.RawArticleWhereInput = {
    ...(q
      ? {
          OR: [{ title: { contains: q } }, { url: { contains: q } }],
        }
      : {}),
    NOT: {
      url: { in: usedUrls },
    },
  };

  const items = await prisma.rawArticle.findMany({
    where,
    take,
    orderBy: { publishedAt: "desc" },
    select: {
      id: true,
      outlet: true,
      side: true,
      title: true,
      url: true,
      publishedAt: true,
    },
  });

  res.json({ ok: true, items });
});

/**
 * POST /api/admin/issues/:id/related
 * body: { targetIssueId, relationType?, confidence? }
 */
r.post("/issues/:id/related", async (req, res) => {
  const id = req.params.id;
  const { targetIssueId, relationType, confidence } = req.body ?? {};
  if (!targetIssueId || targetIssueId === id) {
    return res
      .status(400)
      .json({ ok: false, error: "targetIssueId required" });
  }

  // 이미 존재하면 업데이트, 없으면 생성
  const existing = await prisma.issueRelation.findFirst({
    where: {
      OR: [
        { fromIssueId: id, toIssueId: targetIssueId },
        { fromIssueId: targetIssueId, toIssueId: id },
      ],
    },
  });

  let rel;
  if (existing) {
    rel = await prisma.issueRelation.update({
      where: { id: existing.id },
      data: {
        relationType:
          typeof relationType === "string"
            ? relationType
            : existing.relationType,
        confidence:
          typeof confidence === "number" ? confidence : existing.confidence,
      },
    });
  } else {
    rel = await prisma.issueRelation.create({
      data: {
        fromIssueId: id,
        toIssueId: targetIssueId,
        relationType:
          typeof relationType === "string" ? relationType : "RELATED",
        confidence: typeof confidence === "number" ? confidence : 1.0,
      },
    });
  }

  res.json({ ok: true, relationId: rel.id });
});

/**
 * DELETE /api/admin/issues/:id/related/:targetId
 */
r.delete("/issues/:id/related/:targetId", async (req, res) => {
  const { id, targetId } = req.params;

  await prisma.issueRelation.deleteMany({
    where: {
      OR: [
        { fromIssueId: id, toIssueId: targetId },
        { fromIssueId: targetId, toIssueId: id },
      ],
    },
  });

  res.json({ ok: true });
});

export default r;
