// src/routes/newsClips.ts
import { Router, type Request } from "express";
import { prisma } from "../lib/prisma";
import { requireAuth, type AuthedRequest } from "@/middleware/requireAuth";

export const newsClipsRouter = Router();

/* ─────────────────────────────────────────
   공용: engagement(투표 + 댓글) 빌더
───────────────────────────────────────── */
async function buildClipIssueEngagement(clipIssueId: string, req: Request) {
  const sessionId = (req as any).sessionId as string | undefined;
  const userId = (req as any).userId as string | undefined;

  const [groupedVotes, comments] = await Promise.all([
    prisma.vote.groupBy({
      by: ["stance"],
      where: {
        parentType: "clipIssue",
        parentId: clipIssueId,
      },
      _count: { _all: true },
    }),
    prisma.clipIssueComment.findMany({
      where: { clipIssueId, isDeleted: false },
      orderBy: { createdAt: "desc" },
      include: {
        user: {
          select: {
            id: true,
            username: true,
          },
        },
      },
    }),
  ]);

  const stats = {
    agree: 0,
    disagree: 0,
    unsure: 0, // DB의 neutral
  };

  for (const v of groupedVotes) {
    if (v.stance === "agree") stats.agree = v._count._all;
    else if (v.stance === "disagree") stats.disagree = v._count._all;
    else if (v.stance === "neutral") stats.unsure = v._count._all;
  }

  let myVote: "agree" | "disagree" | "unsure" | null = null;
  if (userId || sessionId) {
    const current = await prisma.vote.findFirst({
      where: {
        parentType: "clipIssue",
        parentId: clipIssueId,
        OR: [
          ...(userId ? [{ userId }] : []),
          ...(sessionId ? [{ sessionId }] : []),
        ],
      },
      orderBy: { createdAt: "desc" },
    });

    if (current) {
      if (current.stance === "agree") myVote = "agree";
      else if (current.stance === "disagree") myVote = "disagree";
      else myVote = "unsure";
    }
  }

  const mappedComments = comments.map((c) => ({
    id: c.id,
    authorName: c.user?.username ?? "익명",
    content: c.content,
    createdAt: c.createdAt.toISOString(),
  }));

  return {
    stats,
    myVote,
    comments: mappedComments,
  };
}

/* ─────────────────────────────────────────
   GET /api/news-clips
───────────────────────────────────────── */
// src/routes/newsClips.ts

newsClipsRouter.get("/", async (req, res) => {
    try {
      const items = await prisma.clipIssue.findMany({
        orderBy: { createdAt: "desc" },
        take: 20,
        include: {
          _count: {
            select: {
              comments: true,
            },
          },
          // 🔹 가장 먼저 업로드된 클립 1개 같이 조회 (썸네일 fallback용)
          clips: {
            include: {
              rawClip: true,
            },
            orderBy: {
              rawClip: {
                publishedAt: "asc", // “가장 빨리 업로드된” 기준
              },
            },
            take: 1,
          },
        },
      });
  
      const result = items.map((it) => {
        // 🔹 fallback: clipIssue.thumbnail 없으면 첫 클립 썸네일 사용
        const firstClipThumb = it.clips[0]?.rawClip?.thumbnail ?? "";
  
        return {
          id: it.id,
          title: it.title,
          description: it.description ?? "",
          thumbnail: it.thumbnail ?? firstClipThumb,
          clipCount: it.clipCount,
          totalViews: it.totalViews,
          category: it.category ?? "뉴스",
          isHot: it.isHot,
          uploadedAt: it.createdAt.toISOString().slice(0, 10),
          commentCount: it._count.comments,
          // 🔹 리스트 카드에서 사용할 AI 요약
          aiSummary: it.aiSummary ?? "",
        };
      });
  
      res.json({ items: result });
    } catch (e) {
      console.error("Failed to fetch news clips:", e);
      res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  });
  
  
/* ─────────────────────────────────────────
   GET /api/news-clips/:id
   → 뉴스 클립 이슈 상세 (제목/설명/클립들/AI 요약)
───────────────────────────────────────── */
newsClipsRouter.get("/:id", async (req, res) => {
  const { id } = req.params;

  const clipIssue = await prisma.clipIssue.findUnique({
    where: { id },
    include: {
      clips: {
        include: {
          rawClip: true,
        },
      },
    },
  });

  if (!clipIssue) {
    return res.status(404).json({ error: "NOT_FOUND" });
  }

  // ✅ center + neutral 을 모두 "중립" 그룹으로
  const progressive = clipIssue.clips.filter((c) => c.side === "left");
  const neutral = clipIssue.clips.filter(
    (c) => c.side === "center" || c.side === "neutral"
  );
  const conservative = clipIssue.clips.filter((c) => c.side === "right");

  const mapClip = (c: (typeof progressive)[number]) => {
    const rc = c.rawClip;
    return {
      id: rc.id,
      title: rc.title,
      channel: rc.channel,
      thumbnail: rc.thumbnail ?? "",
      duration: rc.duration ?? "",
      url: rc.url,
      uploadedAt: rc.publishedAt
        ? rc.publishedAt.toISOString().slice(0, 10)
        : "",
    };
  };

  const payload = {
    id: clipIssue.id,
    title: clipIssue.title,
    description: clipIssue.description ?? "",
    category: clipIssue.category ?? "뉴스",
    aiSummary: clipIssue.aiSummary ?? "",
    progressiveClips: progressive.map(mapClip),
    neutralClips: neutral.map(mapClip),
    conservativeClips: conservative.map(mapClip),
    progressiveSummary: clipIssue.progressiveSummary ?? "",
    conservativeSummary: clipIssue.conservativeSummary ?? "",
  };

  res.json(payload);
});

/* ─────────────────────────────────────────
   GET /api/news-clips/:id/engagement
───────────────────────────────────────── */
newsClipsRouter.get("/:id/engagement", async (req, res) => {
  const { id } = req.params;

  const exists = await prisma.clipIssue.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!exists) {
    return res.status(404).json({ error: "NOT_FOUND" });
  }

  const engagement = await buildClipIssueEngagement(id, req);
  res.json(engagement);
});

/* ─────────────────────────────────────────
   POST /api/news-clips/:id/vote
───────────────────────────────────────── */
newsClipsRouter.post("/:id/vote", async (req, res) => {
  const { id } = req.params;
  const { vote } = req.body as {
    vote?: "agree" | "disagree" | "unsure";
  };

  if (!vote || !["agree", "disagree", "unsure"].includes(vote)) {
    return res.status(400).json({ error: "INVALID_VOTE" });
  }

  const sessionId = (req as any).sessionId as string | undefined;
  const userId = (req as any).userId as string | undefined;

  const mappedStance = vote === "unsure" ? "neutral" : vote;

  await prisma.vote.deleteMany({
    where: {
      parentType: "clipIssue",
      parentId: id,
      OR: [
        ...(userId ? [{ userId }] : []),
        ...(sessionId ? [{ sessionId }] : []),
      ],
    },
  });

  await prisma.vote.create({
    data: {
      parentType: "clipIssue",
      parentId: id,
      stance: mappedStance as any,
      userId: userId ?? null,
      sessionId: sessionId ?? null,
    },
  });

  const engagement = await buildClipIssueEngagement(id, req);
  res.json(engagement);
});

/* ─────────────────────────────────────────
   POST /api/news-clips/:id/comments
───────────────────────────────────────── */
newsClipsRouter.post(
  "/:id/comments",
  requireAuth,
  async (req: AuthedRequest, res) => {
    const { id } = req.params;
    const { content } = req.body as { content?: string };

    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: "UNAUTHORIZED" });
    }

    if (!content || !content.trim()) {
      return res.status(400).json({ error: "EMPTY_CONTENT" });
    }

    await prisma.clipIssueComment.create({
      data: {
        clipIssueId: id,
        userId,
        content: content.trim(),
      },
    });

    const engagement = await buildClipIssueEngagement(id, req);
    res.status(201).json(engagement);
  }
);
