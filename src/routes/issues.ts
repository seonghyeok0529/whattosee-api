// src/routes/issues.ts
import { Router } from "express";
import prisma from "../lib/prisma.js";
import { IssueStatus, type SourceSide } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";
import { getOrCreateIssueSummary } from "../services/issueSummary.js";
import { generateSideSummary } from "@/services/generateSideSummary.js";
import { getOrCreateIssueFrameGroups } from "@/services/issueFrameGroups.js";
import { OpenAI } from "openai";

export const issuesRouter = Router();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

type SimpleSource = {
  outlet: string;
  side: SourceSide;
  createdAt?: Date | null;
};

type SimplePerson = {
  id: string;
  name: string;
  role: string | null;
};

//
// 🔥 리스트에서 사용하는 타입 확장: 여러 언론사
//
type IssueListItem = {
  id: string;
  title: string;
  summary: string;
  tags: string[];
  updatedAt: string;
  leftSources: string[];
  rightSources: string[];
  firstSource?: string;
  thumbnailUrl: string | null;

  /** 추가됨: 전체 언론사 목록 */
  sourceOutlets: string[];
};

/** 유니크 보장 + 정렬 + 상한 */
function uniqueTop(items: SimpleSource[], side: SourceSide, limit: number) {
  const seen = new Set<string>();
  const picked: string[] = [];

  items
    .filter((s) => s.side === side)
    .sort(
      (a, b) =>
        (b.createdAt?.getTime() ?? 0) -
        (a.createdAt?.getTime() ?? 0)
    )
    .forEach((s) => {
      const name = s.outlet?.trim();
      if (!name) return;
      if (!seen.has(name)) {
        seen.add(name);
        picked.push(name);
      }
    });

  return picked.slice(0, limit);
}

/** 최초 보도(가장 이른 createdAt) */
function firstSourceName(items: { outlet: string; createdAt?: Date | null }[]) {
  if (!items.length) return undefined;

  return items
    .filter((x) => !!x.outlet)
    .sort(
      (a, b) =>
        (a.createdAt?.getTime() ?? 0) -
        (b.createdAt?.getTime() ?? 0)
    )[0]?.outlet;
}

/**
 * Issue + sources → 리스트에 맞는 형태로 변환
 * 🔥 sourceOutlets(언론사 전체 목록) 추가됨
 */
function toIssueListItem(
  i: {
    id: string;
    title: string;
    summary: string | null;
    tags: any;
    createdAt: Date;
    updatedAt: Date;
    thumbnailUrl: string | null;
  },
  srcs: SimpleSource[]
): IssueListItem {
  const leftSources = uniqueTop(srcs, "left", 4);
  const rightSources = uniqueTop(srcs, "right", 4);
  const firstSource = firstSourceName(srcs);

  const latest = srcs
    .map((s) => s.createdAt?.getTime() ?? 0)
    .reduce((a, b) => Math.max(a, b), 0);

  // 🔥 전체 언론사 목록(최신순 + 유니크)
  const outletSet = new Set<string>();
  srcs
    .slice()
    .sort(
      (a, b) =>
        (b.createdAt?.getTime() ?? 0) -
        (a.createdAt?.getTime() ?? 0)
    )
    .forEach((s) => {
      const name = s.outlet?.trim();
      if (!name) return;
      outletSet.add(name);
    });

  const sourceOutlets = Array.from(outletSet);

  return {
    id: i.id,
    title: i.title,
    summary: i.summary ?? "",
    tags: Array.isArray(i.tags) ? i.tags : [],
    updatedAt: latest
      ? new Date(latest).toISOString()
      : i.updatedAt.toISOString(),
    leftSources,
    rightSources,
    firstSource,
    thumbnailUrl: i.thumbnailUrl ?? null,

    // 🔥 리스트 UI에서 썸네일 대체로 사용할 언론사 배열
    sourceOutlets,
  };
}

/**
 * GET /api/issues/top-today
 * 오늘의 TOP 이슈 목록
 */
issuesRouter.get("/top-today", async (_req, res) => {
  try {
    const start = new Date();
    start.setHours(0, 0, 0, 0);

    const end = new Date();
    end.setHours(23, 59, 59, 999);

    const raw = await prisma.issue.findMany({
      where: {
        createdAt: { gte: start, lte: end },
        status: IssueStatus.PUBLISHED,
      },
      select: {
        id: true,
        title: true,
        summary: true,
        tags: true,
        createdAt: true,
        updatedAt: true,
        thumbnailUrl: true,
        sources: {
          select: {
            outlet: true,
            side: true,
            createdAt: true,
          },
        },
      },
    });

    const scored = raw.map((i) => {
      const srcs = i.sources as SimpleSource[];

      const base = toIssueListItem(
        {
          id: i.id,
          title: i.title,
          summary: i.summary,
          tags: i.tags,
          createdAt: i.createdAt,
          updatedAt: i.updatedAt,
          thumbnailUrl: i.thumbnailUrl,
        },
        srcs
      );

      const total = srcs.length;
      const left = srcs.filter((s) => s.side === "left").length;
      const right = srcs.filter((s) => s.side === "right").length;

      const diversity = (left > 0 ? 1 : 0) + (right > 0 ? 1 : 0);

      return {
        ...base,
        score: total + diversity * 1.5,
      };
    });

    const ranked = scored.sort((a, b) => b.score - a.score).slice(0, 5);

    res.json(ranked);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load top issues" });
  }
});

/**
 * GET /api/issues
 * 전체 이슈 리스트 (커서 기반)
 */
issuesRouter.get("/", async (req, res) => {
  const take = Math.min(Number(req.query.take ?? 50), 100);
  const cursor = req.query.cursor as string | undefined;

  const raw = await prisma.issue.findMany({
    where: { status: IssueStatus.PUBLISHED },
    orderBy: { createdAt: "desc" },
    take: take + 1,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    select: {
      id: true,
      title: true,
      summary: true,
      tags: true,
      createdAt: true,
      updatedAt: true,
      thumbnailUrl: true,
      sources: {
        orderBy: { createdAt: "asc" },
        select: {
          outlet: true,
          side: true,
          createdAt: true,
        },
      },
    },
  });

  const items = raw.map((i) =>
    toIssueListItem(
      {
        id: i.id,
        title: i.title,
        summary: i.summary,
        tags: i.tags,
        createdAt: i.createdAt,
        updatedAt: i.updatedAt,
        thumbnailUrl: i.thumbnailUrl,
      },
      i.sources as SimpleSource[]
    )
  );

  const hasNext = items.length > take;
  const sliced = hasNext ? items.slice(0, take) : items;
  const nextCursor = hasNext ? raw[take].id : null;

  res.json({ items: sliced, nextCursor });
});

async function handleIssueFrameGroups(req: any, res: any, method: "GET" | "POST") {
  try {
    const { issueId } = req.params;
    const force = String(req.query.force ?? "false").toLowerCase() === "true";

    const data = await getOrCreateIssueFrameGroups(issueId, force);
    return res.json(data);
  } catch (err: any) {
    if (String(err?.message ?? "") === "ISSUE_NOT_FOUND") {
      return res.status(404).json({ error: "NOT_FOUND" });
    }

    console.error(`${method} /issues/:issueId/frame-groups error`, err);
    return res.status(500).json({ error: "INTERNAL_ERROR" });
  }
}

issuesRouter.post("/:issueId/frame-groups", async (req, res) => {
  return handleIssueFrameGroups(req, res, "POST");
});

issuesRouter.get("/:issueId/frame-groups", async (req, res) => {
  return handleIssueFrameGroups(req, res, "GET");
});

/**
 * GET /api/issues/:id
 * 상세 페이지
 * 🔥 여기서 쟁점 리스트 + 센스메이킹 포함
 */
issuesRouter.get("/:id", async (req, res) => {
  const issue = await prisma.issue.findFirst({
    where: {
      id: req.params.id,
      status: IssueStatus.PUBLISHED,
    },
    select: {
      id: true,
      title: true,
      summary: true,
      leftSummary: true,
      rightSummary: true,
      tags: true,
      createdAt: true,
      updatedAt: true,
      body: true,
      thumbnailUrl: true,
      sources: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          outlet: true,
          title: true,
          url: true,
          side: true,
          createdAt: true,
        },
      },
      persons: { select: { id: true, name: true, role: true } },
      relatedFrom: {
        include: {
          to: {
            select: {
              id: true,
              title: true,
              summary: true,
              thumbnailUrl: true,
              status: true,
              updatedAt: true,
            },
          },
        },
      },
      relatedTo: {
        include: {
          from: {
            select: {
              id: true,
              title: true,
              summary: true,
              thumbnailUrl: true,
              status: true,
              updatedAt: true,
            },
          },
        },
      },
      // 🔥 쟁점 리스트
      talkingPoints: {
        orderBy: { order: "asc" },
        select: {
          id: true,
          order: true,
          title: true,
          body: true,
          kind: true,
        },
      },
      // 🔥 센스메이킹 패널
      sensemaking: {
        select: {
          importance: true,
          impactAreas: true,
          difficultyLevel: true,
          whyImportant: true,
          everydayImpact: true,
          keyQuestions: true,
        },
      },
    },
  });

  if (!issue) return res.status(404).json({ error: "NOT_FOUND" });

  const rawSrcs = issue.sources as any[];
  const persons = issue.persons as SimplePerson[];

  const urls = rawSrcs.map((s) => s.url).filter(Boolean);

  // RawArticle 매핑
  const thumbMap = new Map<string, string | null>();
  const publishedMap = new Map<string, string | null>();

  if (urls.length > 0) {
    const raws = await prisma.rawArticle.findMany({
      where: { url: { in: urls } },
      select: { url: true, thumbnail: true, publishedAt: true },
    });

    for (const r of raws) {
      thumbMap.set(r.url, r.thumbnail ?? null);
      publishedMap.set(
        r.url,
        r.publishedAt ? r.publishedAt.toISOString() : null
      );
    }
  }

  // left/right 계산
  const simpleSrcs: SimpleSource[] = rawSrcs.map((s) => ({
    outlet: s.outlet,
    side: s.side,
    createdAt: s.createdAt,
  }));

  const leftSources = uniqueTop(simpleSrcs, "left", 6);
  const rightSources = uniqueTop(simpleSrcs, "right", 6);
  const firstSource = firstSourceName(simpleSrcs);

  const latest = simpleSrcs
    .map((s) => s.createdAt?.getTime() ?? 0)
    .reduce((a, b) => Math.max(a, b));

  // 🔥 전체 언론사 목록 (상세에서도 제공)
  const outletSet = new Set<string>();
  simpleSrcs
    .slice()
    .sort(
      (a, b) =>
        (b.createdAt?.getTime() ?? 0) -
        (a.createdAt?.getTime() ?? 0)
    )
    .forEach((s) => {
      const name = s.outlet?.trim();
      if (name) outletSet.add(name);
    });
  const sourceOutlets = Array.from(outletSet);

  // 관련 이슈
  const relatedMap = new Map<string, any>();

  for (const r of (issue as any).relatedFrom ?? []) {
    const other = r.to;
    if (!other) continue;
    if (other.status !== IssueStatus.PUBLISHED) continue;

    relatedMap.set(other.id, {
      id: other.id,
      title: other.title,
      summary: other.summary ?? "",
      thumbnailUrl: other.thumbnailUrl ?? null,
      direction: "from",
      updatedAt: other.updatedAt?.toISOString?.() ?? null,
    });
  }

  for (const r of (issue as any).relatedTo ?? []) {
    const other = r.from;
    if (!other) continue;
    if (other.status !== IssueStatus.PUBLISHED) continue;

    relatedMap.set(other.id, {
      id: other.id,
      title: other.title,
      summary: other.summary ?? "",
      thumbnailUrl: other.thumbnailUrl ?? null,
      direction: "to",
      updatedAt: other.updatedAt?.toISOString?.() ?? null,
    });
  }

  const relatedIssues = Array.from(relatedMap.values());

  // 🔥 쟁점 리스트 / 센스메이킹 매핑
  const talkingPoints = (issue as any).talkingPoints ?? [];
  const senseRaw = (issue as any).sensemaking ?? null;

  res.json({
    issue: {
      id: issue.id,
      title: issue.title,
      summary: issue.summary ?? "",
      leftSummary: issue.leftSummary ?? "",
      rightSummary: issue.rightSummary ?? "",
      tags: Array.isArray(issue.tags) ? issue.tags : [],
      body: issue.body ?? "",
      updatedAt: latest
        ? new Date(latest).toISOString()
        : issue.updatedAt.toISOString(),

      leftSources,
      rightSources,
      firstSource,
      thumbnailUrl: issue.thumbnailUrl,
      sourceOutlets, // 🔥 추가됨

      sources: rawSrcs.map((s) => ({
        id: s.id,
        outlet: s.outlet,
        title: s.title,
        url: s.url,
        side: s.side,
        createdAt: s.createdAt?.toISOString?.() ?? null,
        publishedAt: publishedMap.get(s.url) ?? null,
        thumbnail: thumbMap.get(s.url) ?? null,
        thumbnailUrl: thumbMap.get(s.url) ?? null,
      })),

      persons: persons.map((p) => ({
        id: p.id,
        name: p.name,
        role: p.role,
      })),

      relatedIssues,

      // 🔥 쟁점 리스트
      talkingPoints: talkingPoints.map((tp: any) => ({
        id: tp.id,
        order: tp.order,
        title: tp.title,
        body: tp.body,
        kind: tp.kind ?? null,
      })),

      // 🔥 센스메이킹 패널
      sensemaking: senseRaw
        ? {
            importance: senseRaw.importance,
            impactAreas: Array.isArray(senseRaw.impactAreas)
              ? senseRaw.impactAreas
              : [],
            difficultyLevel: senseRaw.difficultyLevel ?? null,
            whyImportant: senseRaw.whyImportant,
            everydayImpact: senseRaw.everydayImpact ?? null,
            keyQuestions: Array.isArray(senseRaw.keyQuestions)
              ? senseRaw.keyQuestions
              : [],
          }
        : null,
    },
  });
});

issuesRouter.get("/:id/side-summary", async (req, res) => {
  try {
    const { id } = req.params;
    const sideParam = String(req.query.side || "left").toLowerCase();
    const side: "left" | "right" = sideParam === "right" ? "right" : "left";

    const issue = await prisma.issue.findUnique({
      where: { id },
      select: {
        leftSummary: true,
        rightSummary: true,
      },
    });

    if (!issue) {
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }

    const summary =
      side === "left" ? issue.leftSummary : issue.rightSummary;

    if (!summary || summary.trim().length === 0) {
      return res.status(404).json({
        ok: false,
        error: "SUMMARY_NOT_READY",
      });
    }

    return res.json({
      ok: true,
      side,
      summary,
      cached: true,
    });
  } catch (e: any) {
    console.error("GET /issues/:id/side-summary error", e);
    return res.status(500).json({
      ok: false,
      error: "INTERNAL_ERROR",
      detail: String(e?.message ?? e),
    });
  }
});

// Fact check (placeholder)
issuesRouter.get("/:id/fact-check", async (_req, res) => {
  res.json({ items: [] });
});

// Glossary (DB 저장본 우선)
issuesRouter.get("/:id/glossary", async (req, res) => {
  try {
    const { id } = req.params;

    const issue = await prisma.issue.findUnique({
      where: { id },
      select: { glossaryText: true },
    });

    if (!issue) return res.status(404).json({ error: "NOT_FOUND" });

    const text = (issue.glossaryText ?? "").trim();

    if (!text) {
      // ✅ 404 대신 200으로 “아직 준비 안됨”을 명시
      return res.json({ ok: false, error: "NOT_READY", items: [] });
    }

    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return res.json({ ok: true, items: parsed, text });
      if (parsed?.items && Array.isArray(parsed.items))
        return res.json({ ok: true, items: parsed.items, text });
    } catch {}

    return res.json({ ok: true, text });
  } catch (err) {
    console.error("GET /issues/:id/glossary error:", err);
    return res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});



// Related people (별도 personRef 테이블용)
issuesRouter.get("/:id/people", async (req, res) => {
  const { id } = req.params;
  const persons = await prisma.personRef.findMany({
    where: { issueId: id },
    select: { name: true, role: true },
  });
  res.json({
    items: persons.map((p) => ({
      name: p.name,
      role: p.role ?? "",
    })),
  });
});

// News sources (raw list by side, 그대로 유지해도 됨)
issuesRouter.get("/:id/news-sources", async (req, res) => {
  const { id } = req.params;
  const srcs = await prisma.source.findMany({
    where: { issueId: id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      outlet: true,
      url: true,
      side: true,
      title: true,
      createdAt: true,
    },
  });
  res.json({
    progressive: srcs.filter((s) => s.side === "left"),
    conservative: srcs.filter((s) => s.side === "right"),
  });
});

// 댓글 삭제
issuesRouter.delete(
  "/:issueId/comments/:commentId",
  requireAuth as any,
  async (req: any, res) => {
    try {
      const { issueId, commentId } = req.params;
      const userId = req.userId;

      const comment = await prisma.issueComment.findUnique({
        where: { id: commentId },
        select: {
          id: true,
          issueId: true,
          userId: true,
          isDeleted: true,
        },
      });

      if (!comment || comment.issueId !== issueId)
        return res.status(404).json({ error: "NOT_FOUND" });
      if (comment.userId !== userId)
        return res.status(403).json({ error: "FORBIDDEN" });
      if (comment.isDeleted) return res.json({ ok: true });

      await prisma.issueComment.update({
        where: { id: commentId },
        data: {
          isDeleted: true,
          deletedAt: new Date(),
          content: "[삭제된 댓글입니다]",
        },
      });

      return res.json({ ok: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

// 댓글 신고
issuesRouter.post(
  "/:issueId/comments/:commentId/report",
  requireAuth as any,
  async (req: any, res) => {
    try {
      const { issueId, commentId } = req.params;
      const { reason } = req.body ?? {};
      const userId = req.userId;

      const comment = await prisma.issueComment.findUnique({
        where: { id: commentId },
        select: { id: true, issueId: true },
      });

      if (!comment || comment.issueId !== issueId)
        return res.status(404).json({ error: "NOT_FOUND" });

      const existed = await prisma.commentReport
        .findUnique({
          where: {
            parentType_commentId_userId: {
              parentType: "issue",
              commentId,
              userId,
            },
          } as any,
        })
        .catch(() => null);

      if (existed) return res.status(409).json({ error: "ALREADY_REPORTED" });

      await prisma.$transaction(async (tx) => {
        await tx.commentReport.create({
          data: {
            parentType: "issue",
            commentId,
            userId,
            reason: reason?.slice(0, 500) ?? null,
          },
        });
        await tx.issueComment.update({
          where: { id: commentId },
          data: { reportedCount: { increment: 1 } },
        });
      });

      return res.json({ ok: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

export default issuesRouter;
