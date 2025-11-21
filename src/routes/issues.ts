// src/routes/issues.ts
import { Router } from "express";
import prisma from "../lib/prisma.js";
import { IssueStatus, type SourceSide } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";
import { getOrCreateIssueSummary } from "../services/issueSummary.js";
import { generateSideSummary } from "@/services/generateSideSummary.js";

export const issuesRouter = Router();

/** 주요 언론 화이트리스트(원하는 대로 추가/수정) */
const MAJOR_OUTLETS = new Set<string>([
  "연합뉴스",
  "한겨레",
  "경향신문",
  "오마이뉴스",
  "조선일보",
  "중앙일보",
  "동아일보",
  "JTBC",
  "KBS",
  "MBC",
  "SBS",
]);

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

/** 유니크 보장 + 정렬 + 상한 */
function uniqueTop(
  items: SimpleSource[],
  side: SourceSide,
  limit: number
): string[] {
  const seen = new Set<string>();
  const picked: string[] = [];

  items
    .filter((s: SimpleSource) => s.side === side)
    .sort(
      (a: SimpleSource, b: SimpleSource) =>
        (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0)
    )
    .forEach((s: SimpleSource) => {
      const name = s.outlet?.trim();
      if (!name) return;
      // “주요 언론만” 보여주려면 MAJOR_OUTLETS 체크
      if (!seen.has(name)) {
        seen.add(name);
        picked.push(name);
      }
    });

  return picked.slice(0, limit);
}

/** 최초 보도(가장 이른 createdAt)한 언론 */
function firstSourceName(items: { outlet: string; createdAt?: Date | null }[]) {
  if (!items.length) return undefined;

  const sorted = items
    .filter((x) => !!x.outlet)
    .sort(
      (
        a: { outlet: string; createdAt?: Date | null },
        b: { outlet: string; createdAt?: Date | null }
      ) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0)
    );

  return sorted[0]?.outlet;
}

/**
 * GET /api/issues/top-today
 * 오늘의 TOP 이슈 (서버 랭킹)
 * ※ /:id 보다 위에 둬야 라우팅이 안 잡아먹힘
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
        status: IssueStatus.PUBLISHED, // ✅ 공개 이슈만
      },
      select: {
        id: true,
        title: true,
        summary: true,
        createdAt: true,
        updatedAt: true,
        sources: {
          select: {
            outlet: true,
            side: true,
            createdAt: true,
          },
        },
      },
    });

    const ranked = raw
      .map((i) => {
        const total = i.sources.length;
        const left = i.sources.filter((s) => s.side === "left").length;
        const right = i.sources.filter((s) => s.side === "right").length;
        const diversity = (left > 0 ? 1 : 0) + (right > 0 ? 1 : 0);
        const score = total + diversity * 1.5;

        const leftSources = uniqueTop(
          i.sources as SimpleSource[],
          "left",
          4
        );
        const rightSources = uniqueTop(
          i.sources as SimpleSource[],
          "right",
          4
        );
        const firstSource = firstSourceName(i.sources);
        const latest = i.sources
          .map((s: SimpleSource) => s.createdAt?.getTime() ?? 0)
          .reduce((a: number, b: number) => Math.max(a, b), 0);

        return {
          id: i.id,
          title: i.title,
          summary: i.summary ?? "",
          updatedAt: latest
            ? new Date(latest).toISOString()
            : i.updatedAt.toISOString(),
          leftSources,
          rightSources,
          firstSource,
          score,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    res.json(ranked);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load top issues" });
  }
});

/**
 * GET /api/issues?cursor=uuid&take=20
 * 리스트: 공개(PUBLISHED) 이슈만
 */
issuesRouter.get("/", async (req, res) => {
  const take = Math.min(Number(req.query.take ?? 50), 1000);
  const cursor = req.query.cursor as string | undefined;

  const raw = await prisma.issue.findMany({
    where: {
      status: IssueStatus.PUBLISHED, // ✅ 공개 이슈만
    },
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

  const items = raw.map((i) => {
    const srcs = i.sources as SimpleSource[];

    const leftSources = uniqueTop(srcs, "left", 4);
    const rightSources = uniqueTop(srcs, "right", 4);
    const firstSource = firstSourceName(srcs);
    const latest = srcs
      .map((s: SimpleSource) => s.createdAt?.getTime() ?? 0)
      .reduce((a: number, b: number) => Math.max(a, b), 0);

    return {
      id: i.id,
      title: i.title,
      summary: i.summary ?? "",
      tags: Array.isArray(i.tags) ? (i.tags as string[]) : [],
      updatedAt: latest
        ? new Date(latest).toISOString()
        : i.updatedAt.toISOString(),
      leftSources,
      rightSources,
      firstSource,
    };
  });

  const hasNext = items.length > take;
  const sliced = hasNext ? items.slice(0, take) : items;
  const nextCursor = hasNext ? raw[take].id : null;

  res.json({ items: sliced, nextCursor });
});

/**
 * GET /api/issues/:id
 * 상세: 공개(PUBLISHED) 이슈만
 */
issuesRouter.get("/:id", async (req, res) => {
  const issue = await prisma.issue.findFirst({
    where: {
      id: req.params.id,
      status: IssueStatus.PUBLISHED, // ✅ 비공개 이슈는 404
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
      persons: {
        select: { id: true, name: true, role: true },
      },
    },
  });

  if (!issue) return res.status(404).json({ error: "NOT_FOUND" });

  const srcs = issue.sources as SimpleSource[];
  const persons = issue.persons as SimplePerson[];

  const leftSources = uniqueTop(srcs, "left", 6);
  const rightSources = uniqueTop(srcs, "right", 6);
  const firstSource = firstSourceName(srcs);
  const latest = srcs
    .map((s: SimpleSource) => s.createdAt?.getTime() ?? 0)
    .reduce((a: number, b: number) => Math.max(a, b), 0);

  res.json({
    issue: {
      id: issue.id,
      title: issue.title,
      summary: issue.summary ?? "",
      leftSummary: issue.leftSummary ?? "",
      rightSummary: issue.rightSummary ?? "",
      tags: Array.isArray(issue.tags) ? (issue.tags as string[]) : [],
      body: issue.body ?? "",
      updatedAt: latest
        ? new Date(latest).toISOString()
        : issue.updatedAt.toISOString(),
      leftSources,
      rightSources,
      firstSource,
      sources: srcs.map((s) => ({
        id: (s as any).id,
        outlet: s.outlet,
        title: (s as any).title,
        url: (s as any).url,
        side: s.side,
      })),
      persons: persons.map((p) => ({
        id: p.id,
        name: p.name,
        role: p.role,
      })),
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
      // ⛔ 여기서는 더 이상 제목 기반 generateSideSummary 안 쓰고,
      // 관리자에서 아직 요약을 안 돌린 상태라는 걸 알려줌
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

// Glossary (placeholder)
issuesRouter.get("/:id/glossary", async (_req, res) => {
  res.json({ items: [] });
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
